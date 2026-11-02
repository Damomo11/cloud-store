'use strict'

const { equipmentUseDecision, listOwnedItems } = require('./equipment-safety')

const EQUIP_MODE_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.PREPARATION_EQUIP_MODE_TIMEOUT_MS || 12_000),
)
const EQUIP_CONVERGE_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.PREPARATION_EQUIP_CONVERGE_TIMEOUT_MS || 1_500),
)
const EQUIP_CONVERGE_POLL_MS = 50

const ARMOR = Object.freeze([
  ['head', 'netherite_helmet'],
  ['torso', 'netherite_chestplate'],
  ['legs', 'netherite_leggings'],
  ['feet', 'netherite_boots'],
])

function unsafeFullArmor (bot) {
  if (!bot || !bot.inventory || typeof bot.getEquipmentDestSlot !== 'function') {
    return ['equipment_api_unavailable']
  }
  const issues = []
  for (const [dest, expected] of ARMOR) {
    const item = bot.inventory.slots?.[bot.getEquipmentDestSlot(dest)]
    if (!item || item.name !== expected) {
      issues.push(`${expected}:missing`)
      continue
    }
    const decision = equipmentUseDecision(item)
    if (!decision.safe) issues.push(`${expected}:${decision.reason}`)
  }
  return issues
}

function hasExpectedArmorInInventory (bot) {
  const names = new Set(listOwnedItems(bot).map(item => item && item.name).filter(Boolean))
  return ARMOR.every(([, expected]) => names.has(expected))
}

async function waitForFullArmor (bot, timeoutMs = EQUIP_CONVERGE_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  let issues = unsafeFullArmor(bot)
  while (issues.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(EQUIP_CONVERGE_POLL_MS, deadline - Date.now())))
    issues = unsafeFullArmor(bot)
  }
  return issues
}

async function enterFullArmor (bot) {
  const savedMode = typeof bot?._equipMode === 'function' ? bot._equipMode() : null
  if (typeof bot?._setEquipMode !== 'function') {
    // Standalone executor tests may construct the inventory plugin before the
    // station plugin. Production bots always install station-executor first.
    return { savedMode, changed: false, skipped: true }
  }
  // 站库无货缺件的降级口径要传给命令内所有下游满甲闸（地面转场/interact 等），
  // 否则订单起点降级放行、半路又被同一缺件秒杀（0906 实录：milk_bucket 与
  // 短距地面转场都卡 netherite_leggings:missing）。
  bot._unfillableArmorMissing = null
  const changed = savedMode !== 'full_armor'
  await changeEquipModeBounded(bot, 'full_armor')
  let issues = unsafeFullArmor(bot)
  const onlyMissingIssues = issues.length > 0 && issues.every(issue => issue.endsWith(':missing'))
  if (onlyMissingIssues && hasExpectedArmorInInventory(bot)) {
    issues = await waitForFullArmor(bot)
  }
  if (issues.length > 0 && issues.every(issue => issue.endsWith(':missing')) && hasExpectedArmorInInventory(bot)) {
    await changeEquipModeBounded(bot, 'full_armor')
    issues = await waitForFullArmor(bot)
  }
  if (issues.length > 0 && typeof bot?._maintainPreparationArmor === 'function') {
    const maintenance = await bot._maintainPreparationArmor({ issues: [...issues] })
    if (!maintenance?.ok) {
      const reason = maintenance?.reason || 'unknown'
      const error = new Error(`full_armor_maintenance_failed:${reason}`)
      error.reason = error.message
      throw error
    }
    await changeEquipModeBounded(bot, 'full_armor')
    issues = await waitForFullArmor(bot)
    // 站库无货的缺件（维护方已确认补不上）不阻塞订单：降级带残缺装备继续。
    const unfillable = Array.isArray(maintenance?.unfillableMissing) ? maintenance.unfillableMissing : null
    if (unfillable && issues.length > 0 && issues.every(issue =>
      issue.endsWith(':missing') && unfillable.includes(issue.split(':')[0]))) {
      bot._unfillableArmorMissing = new Set([...unfillable])
      return { savedMode, changed, degraded: true, unfillableMissing: [...unfillable] }
    }
    // 维护流程整趟跑完（ok:true）却仍剩纯 missing 缺口＝站库根本没货
    // （0906 实录：「补给完成但标准装备仍缺失」后 ok:true 漏过降级闸，
    // egg/milk 在 3s/21s 内被 full_armor_preflight_failed 秒杀）。
    if (issues.length > 0 && issues.every(issue => issue.endsWith(':missing'))) {
      bot._unfillableArmorMissing = new Set(issues.map(i => i.split(':')[0]))
      return { savedMode, changed, degraded: true, unfillableMissing: issues.map(i => i.split(':')[0]) }
    }
  }
  if (issues.length > 0) {
    if (changed && savedMode) {
      try { await bot._setEquipMode(savedMode) } catch (_) { /* keep fail-closed state */ }
    }
    const error = new Error(`full_armor_preflight_failed:${issues.join(',')}`)
    error.reason = error.message
    throw error
  }
  return { savedMode, changed }
}

/**
 * 下游满甲闸（采集转场 / interact 等）共用的降级过滤：本命令 enterFullArmor 已确认
 * 「站库无货」的缺件不重复阻塞。低耐久等非 missing 问题一律保留（护甲性能闸不放松）。
 * 没有降级记录（null/非 Set）时原样返回，保持 fail-closed。
 */
function filterDegradableArmorIssues (bot, issues) {
  const list = Array.isArray(issues) ? issues : []
  if (list.length === 0) return []
  const unfillable = bot && bot._unfillableArmorMissing
  if (!(unfillable instanceof Set) || unfillable.size === 0) return [...list]
  const blocking = list.filter(issue => {
    if (!String(issue).endsWith(':missing')) return true
    return !unfillable.has(String(issue).split(':')[0])
  })
  return blocking
}

async function restoreEquipMode (bot, state, log = null) {
  if (!state || typeof bot?._setEquipMode !== 'function') return null
  try {
    // Preparation stages converge to armor at every boundary. Replaying a
    // pre-command elytra mode would preserve an earlier failed-flight leak and
    // create an unarmored gap between inventory/crafting/collection stages.
    await changeEquipModeBounded(bot, 'full_armor')
    return null
  } catch (error) {
    if (typeof log === 'function') log(error)
    return error
  }
}

function equipModeTimeoutError (mode) {
  const error = new Error(`equip_mode_change_timeout:${mode}`)
  error.reason = error.message
  return error
}

async function changeEquipModeBounded (bot, mode, timeoutMs = EQUIP_MODE_TIMEOUT_MS) {
  const pending = Promise.resolve().then(() => bot._setEquipMode(mode))
  // The mineflayer inventory transaction may receive its final slot packet late.
  // Keep its rejection observed after this caller has failed fast.
  pending.catch(() => {})
  let timer = null
  try {
    await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(equipModeTimeoutError(mode)), timeoutMs)
      }),
    ])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

module.exports = {
  ARMOR,
  EQUIP_MODE_TIMEOUT_MS,
  EQUIP_CONVERGE_TIMEOUT_MS,
  unsafeFullArmor,
  hasExpectedArmorInInventory,
  waitForFullArmor,
  changeEquipModeBounded,
  enterFullArmor,
  filterDegradableArmorIssues,
  restoreEquipMode,
}

'use strict'

const DEFAULT_TOOL_MIN_REMAINING = Math.max(
  1,
  Number(process.env.EQUIPMENT_TOOL_MIN_REMAINING || process.env.COLLECT_TOOL_BREAK_THRESHOLD || 32),
)
const DEFAULT_TOOL_MIN_PCT = Math.min(
  90,
  Math.max(1, Number(process.env.EQUIPMENT_TOOL_MIN_PCT || process.env.COLLECT_TOOL_BREAK_PCT || 10)),
)
const DEFAULT_ELYTRA_MIN_PCT = Math.min(
  90,
  Math.max(0, Number(process.env.EQUIPMENT_ELYTRA_MIN_PCT || 0)),
)

const DURABLE_EQUIPMENT_PATTERNS = Object.freeze([
  /_(helmet|chestplate|leggings|boots)$/,
  /_(sword|pickaxe|axe|shovel|hoe)$/,
  /^(elytra|shield|bow|crossbow|trident|fishing_rod|flint_and_steel|shears)$/,
])

const STANDARD_LOADOUT_COUNTS = Object.freeze({
  netherite_helmet: 1,
  netherite_chestplate: 1,
  netherite_leggings: 1,
  netherite_boots: 1,
  netherite_pickaxe: 2,
  netherite_axe: 1,
  netherite_shovel: 1,
  netherite_sword: 1,
  elytra: 4,
  // 激流三叉戟:riptide 助推模式的核心装备(ELYTRA_PROPULSION=riptide)。
  // gear-guard PROTECTED_PATTERNS 与 trash 保护名单均已含 trident,进标准装备是为了
  // 让缺装巡检/补给 top-up 感知它(0/1 时报 standard_gear_missing:trident)。
  trident: 1,
})

function normalizeEquipmentName (name) {
  return String(name || '').replace(/^minecraft:/, '').toLowerCase()
}

/**
 * 玩家实际持有的全部物品(穿戴槽 + 副手 + 热键栏 + 主背包 + heldItem 兜底)。
 * mineflayer 的 inventory.items() 只覆盖 inventoryStart..inventoryEnd,看不到头/胸/腿/脚/副手;
 * 鞘翅穿在胸甲上、三叉戟拿在手上时,只扫 items() 会报「装备丢了」,人眼一看就在身上(0901 用户指令)。
 * 装备识别/缺装巡检/激流三叉戟查找一律走这里,禁止再用 items() 当持有量。
 *
 * slots 覆盖全时(真实 mineflayer 恒为全槽)以 slots 为准;slots 为空壳(测试桩/兼容对象)
 * 时合并 items() 兜底,避免把真实持有误读成空。
 */
function listOwnedItems (bot) {
  const result = []
  const seen = new Set()
  const add = (item) => {
    if (!item || typeof item.name !== 'string') return
    const slot = Number(item.slot)
    const key = Number.isInteger(slot)
      ? `slot:${slot}`
      : `loose:${normalizeEquipmentName(item.name)}:${Number(item.type) || 0}:${Number(item.count) || 0}`
    if (seen.has(key)) return
    seen.add(key)
    result.push(item)
  }
  const slots = bot && bot.inventory && Array.isArray(bot.inventory.slots) ? bot.inventory.slots : []
  for (const item of slots) add(item)
  // 真实 mineflayer 的 items() 是 slots 的子集,dedup 后自然并入;测试桩/兼容对象的
  // slots 可能缺穿戴槽,items() 里反而有 —— 并进去只会更接近真实持有,不会虚增。
  const itemsFn = bot && bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items : null
  if (itemsFn) {
    try { for (const item of (itemsFn.call(bot.inventory) || [])) add(item) } catch (_) { /* ignore */ }
  }
  add(bot && bot.heldItem)
  return result
}

function countOwnedByName (bot, name) {
  const wanted = normalizeEquipmentName(name)
  let total = 0
  for (const item of listOwnedItems(bot)) {
    if (normalizeEquipmentName(item.name) !== wanted) continue
    total += Math.max(1, Number(item.count) || 1)
  }
  return total
}

function isDurableEquipmentName (name) {
  const normalized = normalizeEquipmentName(name)
  return Boolean(normalized && DURABLE_EQUIPMENT_PATTERNS.some(pattern => pattern.test(normalized)))
}

function finiteNonNegative (value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null
}

function componentDamage (item) {
  try {
    const component = item && item.componentMap && item.componentMap.get('damage')
    const raw = component && component.data
    if (typeof raw === 'number') return finiteNonNegative(raw)
    if (raw && typeof raw.value === 'number') return finiteNonNegative(raw.value)
  } catch (_) { /* fall through */ }
  return null
}

function nbtDamage (item) {
  try {
    return finiteNonNegative(item && item.nbt && item.nbt.value && item.nbt.value.Damage && item.nbt.value.Damage.value)
  } catch (_) {
    return null
  }
}

/**
 * Reads durability without treating an absent/throwing field as a pristine item.
 * Unknown durable equipment is deliberately unsafe: continuing to use it would
 * recreate the exact failure mode where a missing Damage component looked like 0.
 */
function readDurability (item) {
  const name = normalizeEquipmentName(item && item.name)
  const durable = isDurableEquipmentName(name)
  if (!item) {
    return { name, durable: false, known: false, max: null, used: null, remaining: null, pct: null, reason: 'missing_item' }
  }

  const max = finiteNonNegative(item.maxDurability)
  let used = null
  try { used = finiteNonNegative(item.durabilityUsed) } catch (_) { used = null }
  if (used === null) used = componentDamage(item)
  if (used === null) used = nbtDamage(item)

  if (!max || max <= 0 || used === null) {
    return {
      name,
      durable,
      known: false,
      max: max && max > 0 ? max : null,
      used,
      remaining: null,
      pct: null,
      reason: durable ? 'durability_unknown' : 'not_durable',
    }
  }

  const remaining = Math.max(0, max - used)
  return {
    name,
    durable,
    known: true,
    max,
    used,
    remaining,
    pct: (remaining / max) * 100,
    reason: null,
  }
}

function minimumRemainingFor (status, opts = {}) {
  const absolute = Math.max(0, Number(opts.minRemaining ?? DEFAULT_TOOL_MIN_REMAINING) || 0)
  const pct = Math.max(0, Number(opts.minPct ?? DEFAULT_TOOL_MIN_PCT) || 0)
  if (!status || !status.known || !status.max) return absolute
  return Math.max(absolute, Math.ceil(status.max * pct / 100))
}

function equipmentUseDecision (item, opts = {}) {
  const status = readDurability(item)
  if (!status.durable) return { safe: true, reason: status.reason, status, minimumRemaining: 0 }
  if (!status.known) {
    return { safe: false, reason: 'durability_unknown', status, minimumRemaining: null }
  }
  const minimumRemaining = minimumRemainingFor(status, opts)
  if (status.remaining <= minimumRemaining) {
    return { safe: false, reason: 'low_durability', status, minimumRemaining }
  }
  return { safe: true, reason: null, status, minimumRemaining }
}

function formatDurabilityDecision (decision) {
  if (!decision || !decision.status) return 'durability_unknown'
  const { status } = decision
  if (!status.known) return `${status.name || 'item'} durability_unknown`
  return `${status.name || 'item'} ${status.remaining}/${status.max}=${status.pct.toFixed(1)}% min>${decision.minimumRemaining}`
}

// 激流三叉戟可用判定:剩余 > max×5% 红线才算可用(与 elytra-pilot riptideDurabilityFloor
// 同一红线)。数量达标但全部跌破红线 → 触发补给换新(旧把保留在背包,绝不丢弃)。
function hasUsableTrident (itemsOrBot) {
  const items = itemsOrBot && typeof itemsOrBot === 'object' && itemsOrBot.inventory
    ? listOwnedItems(itemsOrBot)
    : (itemsOrBot || [])
  for (const item of items) {
    if (normalizeEquipmentName(item && item.name) !== 'trident') continue
    const durability = readDurability(item)
    if (!durability.known) return true // 读不到耐久按可用(不误触发补给)
    const floor = Math.ceil((durability.max || 250) * 0.05)
    if (durability.remaining > floor) return true
  }
  return false
}

function missingStandardLoadout (itemsOrBot) {
  const items = itemsOrBot && typeof itemsOrBot === 'object' && itemsOrBot.inventory
    ? listOwnedItems(itemsOrBot)
    : (itemsOrBot || [])
  const counts = new Map()
  for (const item of items) {
    const name = normalizeEquipmentName(item && item.name)
    if (!name) continue
    counts.set(name, (counts.get(name) || 0) + Math.max(1, Number(item.count) || 1))
  }
  const missing = []
  for (const [name, required] of Object.entries(STANDARD_LOADOUT_COUNTS)) {
    const have = counts.get(name) || 0
    if (have < required) missing.push({ name, have, required })
  }
  return missing
}

function durableEquipmentCounts (items) {
  const counts = new Map()
  for (const item of (items || [])) {
    const name = normalizeEquipmentName(item && item.name)
    if (!isDurableEquipmentName(name)) continue
    counts.set(name, (counts.get(name) || 0) + Math.max(1, Number(item.count) || 1))
  }
  return counts
}

function missingDurableEquipmentSince (baseline, items) {
  const before = baseline instanceof Map ? baseline : new Map(Object.entries(baseline || {}))
  const now = durableEquipmentCounts(items)
  const missing = []
  for (const [name, rawRequired] of before.entries()) {
    const required = Math.max(0, Math.trunc(Number(rawRequired) || 0))
    const have = now.get(name) || 0
    if (have < required) missing.push({ name, have, required })
  }
  return missing
}

function hasUsableElytra (itemsOrBot) {
  const items = itemsOrBot && typeof itemsOrBot === 'object' && itemsOrBot.inventory
    ? listOwnedItems(itemsOrBot)
    : (itemsOrBot || [])
  return items.some(item => {
    if (normalizeEquipmentName(item && item.name) !== 'elytra') return false
    const durability = readDurability(item)
    return durability.known && durability.remaining > 0
  })
}

module.exports = {
  DEFAULT_TOOL_MIN_REMAINING,
  DEFAULT_TOOL_MIN_PCT,
  DEFAULT_ELYTRA_MIN_PCT,
  STANDARD_LOADOUT_COUNTS,
  normalizeEquipmentName,
  listOwnedItems,
  countOwnedByName,
  isDurableEquipmentName,
  readDurability,
  minimumRemainingFor,
  equipmentUseDecision,
  formatDurabilityDecision,
  missingStandardLoadout,
  durableEquipmentCounts,
  missingDurableEquipmentSince,
  hasUsableElytra,
  hasUsableTrident,
}

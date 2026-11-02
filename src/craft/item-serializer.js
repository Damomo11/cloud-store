// ─────────────────────────────────────────────────────────────────────────────
// 物品序列化共享模块（material-preparation 阶段1 · 任务 5.2）
//
// 抽自 station-executor.js 的 serializeItem（读 name/count/耐久/附魔，走 1.21.4 数据
// 组件 + bot.registry 翻译），并【扩展】潜影盒嵌套内容解析（shulkerContents），
// 使 station-executor.js 与 inventory-executor.js（任务 5.1 扫描分支）可复用同一份逻辑。
//
// 潜影盒解析依据 S0 静默 spike 结论（见 .kiro/specs/material-preparation/
// S0-shulker-spike-findings.md §2 事实 / §3 定死结构 / §3 字段来源映射）：
//   - 是否潜影盒：item.name.endsWith('shulker_box')
//   - 组件入口：item.componentMap.get('container')（1.21.4 枚举名无 minecraft: 前缀）
//   - 内层清单：containerComp.data.contents（protodef Slot 数组，itemCount===0 为空槽占位）
//   - 内层物品：Item.fromNotch(rawEl) → .name / .count（Item = prismarine-item(bot.registry)）
//   - 内层附魔：inner.enchants → 复用 registry id→name 翻译
//
// 需求约束（Req 5.1~5.4）：
//   5.1 最多 27 个内部物品（内层槽 0..26）填 shulkerContents
//   5.2 非潜影盒 / container 组件缺失 / 为空 / 不含物品 → shulkerContents = null
//   5.3 只解析一层，不对盒内嵌套潜影盒递归（ShulkerSlot 无 shulkerContents 字段）
//   5.4 container 组件数据无法解析 → shulkerContents = null + 打印错误 + 不中断外层遍历
// ─────────────────────────────────────────────────────────────────────────────

const { readDurability } = require('./equipment-safety')
// Offline fallback only. The live server may append plugin enchantments, so the
// configuration-stage registry captured by protocol-registry is authoritative.
const ENCHANT_ID_MAP_1211 = require('./enchant-map-1211')

// 附魔数字 ID → 名称映射(1.21.x)。registry 翻不出时的兜底表。
const ENCHANT_ID_MAP = {
  0: 'protection', 1: 'fire_protection', 2: 'feather_falling', 3: 'blast_protection',
  4: 'projectile_protection', 5: 'respiration', 6: 'aqua_affinity', 7: 'thorns',
  8: 'depth_strider', 9: 'frost_walker', 10: 'binding_curse', 11: 'soul_speed',
  12: 'swift_sneak', 13: 'sharpness', 14: 'smite', 15: 'bane_of_arthropods',
  16: 'knockback', 17: 'fire_aspect', 18: 'looting', 19: 'sweeping',
  20: 'efficiency', 21: 'silk_touch', 22: 'fortune', 23: 'power',
  24: 'punch', 25: 'flame', 26: 'infinity', 27: 'luck_of_the_sea',
  28: 'lure', 29: 'loyalty', 30: 'impaling', 31: 'riptide',
  32: 'channeling', 33: 'multishot', 34: 'quick_charge', 35: 'piercing',
  36: 'mending', 37: 'vanishing_curse', 38: 'unbreaking', 39: 'binding_curse',
  40: 'sweeping_edge', 48: 'multishot', 49: 'piercing', 50: 'quick_charge',
  65: 'protection', 66: 'fire_protection', 67: 'feather_falling',
  68: 'blast_protection', 69: 'projectile_protection', 70: 'respiration',
  71: 'aqua_affinity', 72: 'thorns', 73: 'depth_strider', 74: 'frost_walker',
  75: 'sharpness', 76: 'smite', 77: 'bane_of_arthropods', 78: 'knockback',
  79: 'fire_aspect', 80: 'looting', 81: 'sweeping_edge', 82: 'efficiency',
  83: 'silk_touch', 84: 'fortune', 85: 'power', 86: 'punch',
  87: 'flame', 88: 'infinity', 90: 'luck_of_the_sea', 91: 'lure',
  95: 'unbreaking', 96: 'mending', 97: 'vanishing_curse',
}

// 原版所有颜色潜影盒 item 名都以 shulker_box 结尾（含无色 'shulker_box'）
function isShulkerBoxItem (item) {
  return !!item && typeof item.name === 'string' && item.name.endsWith('shulker_box')
}

function normalizeItemName (name) {
  return typeof name === 'string' ? name.replace(/^minecraft:/, '') : name
}

// 附魔翻译：1.21.4 数据组件体系下 item.enchants getter 返回
// { enchantments:[{id,level}], showTooltip }。id 是 registry 动态分配的数字,
// 优先用 bot.registry 翻译成名字,翻不出(zenoxs 第三方附魔插件自定义 id)回退 id_N。
function translateEnchants (bot, raw) {
  let enchants = []
  try {
    const dynamicNames = bot && bot._olelaEnchantmentRegistryNames
    const reg = bot && bot.registry && bot.registry.enchantments
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.enchantments) ? raw.enchantments : [])
    enchants = list.map(e => {
      let name = e && e.name
      if (!name && typeof (e && e.id) === 'number') {
        name = (Array.isArray(dynamicNames) && dynamicNames[e.id]) ||
          (reg && reg[e.id] && reg[e.id].name) ||
          ENCHANT_ID_MAP_1211[e.id] ||
          ENCHANT_ID_MAP[e.id] ||
          `id_${e.id}`
      }
      if (!name) name = (typeof (e && e.id) === 'string' ? e.id.replace('minecraft:', '') : `id_${e && e.id}`)
      return { name, level: (e && (e.level ?? e.lvl)) ?? 0 }
    })
  } catch (_) { /* 附魔翻译失败不影响主字段 */ }
  return enchants
}

// prismarine-item 加载器缓存：按 version 缓存 Item 类，避免每次 require 重复构造。
let _cachedItem = null
let _cachedVersion = null
function getItemClass (bot) {
  const version = bot && (bot.version || (bot.registry && bot.registry.version && bot.registry.version.minecraftVersion))
  if (_cachedItem && _cachedVersion === version) return _cachedItem
  const registry = bot && bot.registry
  if (!registry) return null
  const Item = require('prismarine-item')(registry)
  _cachedItem = Item
  _cachedVersion = version
  return Item
}

// 解析潜影盒 item 的内部内容 → ShulkerSlot[] | null
// 一层不递归、最多 27 项；非潜影盒/组件缺失/为空/无物品 → null；解析失败 → null + 打印错误。
function parseShulkerContents (bot, item, opts = {}) {
  const logTag = opts.tag || '[item-serializer]'
  if (!isShulkerBoxItem(item)) return null

  let containerComp
  try {
    containerComp = item.componentMap ? item.componentMap.get('container') : undefined
  } catch (_) {
    // componentMap 访问异常也视为不可解析（Req 5.4）
    console.warn(`${logTag} 潜影盒 ${item.name} componentMap 访问异常, shulkerContents 置 null`)
    return null
  }

  // container 组件缺失 / contents 缺失或非数组 / 为空 → null（Req 5.2）
  if (!containerComp || !containerComp.data || !Array.isArray(containerComp.data.contents)) return null
  const contents = containerComp.data.contents
  if (contents.length === 0) return null

  let Item
  try {
    Item = getItemClass(bot)
  } catch (e) {
    console.warn(`${logTag} 加载 prismarine-item 失败, 潜影盒 ${item.name} 解析跳过: ${e && (e.message || e)}`)
    return null
  }
  if (!Item) return null

  // 整块 contents 解析包在 try 内：任一环节抛错 → 该盒 shulkerContents=null + 打印错误 + 不中断外层遍历（Req 5.4）
  try {
    const result = []
    // Req 5.1: 最多 27 项（内层槽 0..26）。下标即内层槽位（S0 §2 ★，须 prod 核对）。
    for (let innerSlot = 0; innerSlot < contents.length && result.length < 27; innerSlot++) {
      const raw = contents[innerSlot]
      if (!raw || raw.itemCount === 0) continue   // itemCount===0 为空槽占位
      const inner = Item.fromNotch(raw)
      if (!inner) continue
      // Req 5.3: 只解析一层——盒内嵌套潜影盒不再展开（ShulkerSlot 不含 shulkerContents 字段）
      result.push({
        name: normalizeItemName(inner.name) || `itemId_${raw.itemId}`,
        slot: innerSlot,
        count: inner.count,
        enchants: translateEnchants(bot, inner.enchants),
      })
    }
    // 组件存在但无有效物品 → null（Req 5.2）
    return result.length > 0 ? result : null
  } catch (e) {
    console.warn(`${logTag} 潜影盒 ${item.name} container 组件解析失败, shulkerContents 置 null: ${e && (e.message || e)}`)
    return null
  }
}

// 序列化单个 item：name/slot/count/耐久/附魔 + 潜影盒嵌套内容（shulkerContents）。
// bot 用于 registry 附魔翻译与 prismarine-item 加载；opts.tag 用于日志前缀。
function serializeItem (bot, item, opts = {}) {
  const durability = readDurability(item)

  return {
    name: item.name,
    slot: item.slot,
    count: item.count,
    durabilityKnown: durability.known,
    durabilityUsed: durability.used,
    maxDurability: durability.max,
    remaining: durability.remaining,
    pct: durability.pct === null ? null : Math.round(durability.pct),
    enchants: translateEnchants(bot, item.enchants),
    // ★ 阶段1 新增：仅当该 item 本身是潜影盒且内含物品时填充，否则 null
    shulkerContents: parseShulkerContents(bot, item, opts),
  }
}

module.exports = {
  ENCHANT_ID_MAP_1211,
  ENCHANT_ID_MAP,
  isShulkerBoxItem,
  normalizeItemName,
  translateEnchants,
  parseShulkerContents,
  serializeItem,
}

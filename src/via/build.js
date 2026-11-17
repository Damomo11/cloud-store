// 用生成数据（data/via/26.3/*.json，由 scripts/gen-via-26x.js 产出）把
// minecraft-data 26.1 条目改造成 26.3 条目。

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'via', '26.3')

function loadData () {
  const read = name => JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'))
  return {
    items: read('items.json'),
    blocks: read('blocks.json'),
    entities: read('entities.json'),
    components: read('data_component_type.json'),
    chain: read('id-chain-26.1-to-26.3.json').registries,
    newBlockStates: read('new-block-states.json'),
    blockProps: read('new-block-props.json').blocks
  }
}

// 名字 → 26.1 条目索引
function indexByName (list) {
  const map = new Map()
  for (const entry of list) map.set(entry.name, entry)
  return map
}

// 新物品的真实 stackSize（2026-11 从 26.3 客户端 Items.java 反编译核对；
// 旧逻辑全按 64，会导致仓库/背包把 16 叠的 cushion、1 叠的船当 64 叠处理）
const NEW_ITEM_STACK_SIZES = {
  poplar_boat: 1,
  poplar_chest_boat: 1,
  poplar_sign: 16,
  poplar_hanging_sign: 16,
  sulfur_cube_bucket: 1,
  music_disc_bounce: 1,
  sulfur_cube_spawn_egg: 64
}
function newItemStackSize (name) {
  if (/_cushion$/.test(name)) return 16 // ColorCollection.registerItems 统一 stacksTo(16)（white_cushion 等）
  return NEW_ITEM_STACK_SIZES[name] ?? 64
}

// items：26.3 全表按 id 重排；旧物品沿用 26.1 条目字段，新物品造最小条目
function rebuildItems (data, base) {
  const byName = indexByName(base.items)
  const out = data.items.names263.map((name, id) => {
    const old = byName.get(name)
    if (old) return { ...old, id }
    const stack = newItemStackSize(name)
    return {
      id,
      name,
      displayName: name,
      stackSize: stack,
      maxStackSize: stack,
      hideInCommands: false,
      isBrandingItem: false
    }
  })
  return out
}

// blocks：26.3 全表重排；状态段用链式映射平移；新方块用分配的空闲状态段
function rebuildBlocks (data, base) {
  const byName = indexByName(base.blocks)
  const stateChain = data.chain.blockstates
  const newStates = data.newBlockStates.blocks
  return data.blocks.names263.map((name, id) => {
    const old = byName.get(name)
    if (old) {
      const entry = { ...old, id }
      // 状态段平移：minStateId/maxStateId 查 26.1→26.3 链
      if (typeof entry.minStateId === 'number') {
        const shifted = stateChain.map[entry.minStateId]
        const span = (entry.maxStateId ?? entry.minStateId) - entry.minStateId
        if (shifted !== undefined && shifted >= 0) {
          entry.minStateId = shifted
          entry.maxStateId = shifted + span
        }
      }
      return entry
    }
    // 新方块：状态段来自空闲 id 分配；hardness/boundingBox/transparent 用 26.3 真实属性
    // （旧逻辑全填 hardness:0 + diggable:false + boundingBox:'empty'，bot 会拒绝挖白杨木、
    //  把树当空气穿过。2026-11 审计修正）
    // 注意 gen 数据的键带 minecraft: 前缀而 names263 无前缀——旧代码直接 newStates[name]
    // 永远 undefined，状态段/属性从未生效过（minStateId 一直 -1）
    const seg = newStates[name] ?? newStates['minecraft:' + name]
    const minStateId = seg && seg.firstStateId >= 0 ? seg.firstStateId : -1
    const p = data.blockProps[name] ?? data.blockProps['minecraft:' + name]
    return {
      id,
      name,
      displayName: name,
      hardness: p ? p.hardness : 0,
      stackSize: 64,
      diggable: p ? p.hardness >= 0 : false,
      boundingBox: p && p.noCollision ? 'empty' : 'block',
      drops: [],
      transparent: p ? !!(p.noOcclusion || p.noCollision) : true,
      emitLight: 0,
      filterLight: 0,
      shapes: [], // prismarine-block/movements 直接读 shapes.length，缺了就炸
      minStateId,
      maxStateId: seg && seg.firstStateId >= 0 ? seg.firstStateId + seg.count - 1 : -1,
      states: [],
      newVia26x: true
    }
  })
}

// entities：26.3 全表重排
// 新实体的真实碰撞箱（26.3 客户端 EntityTypes / VFP Mortis ContentRegistry 反编译核对；
// 旧逻辑全填 0.5×0.5 type:mob，cushion 的垫子碰撞和船的尺寸都会失真）
const NEW_ENTITY_SIZES = {
  sulfur_cube: { type: 'mob', height: 0.49, width: 0.49 },
  cushion: { type: 'object', height: 0.25, width: 1.0 },
  poplar_boat: { type: 'object', height: 0.5625, width: 1.375 },
  poplar_chest_boat: { type: 'object', height: 0.5625, width: 1.375 }
}

function rebuildEntities (data, base) {
  const byName = indexByName(base.entities)
  return data.entities.names263.map((name, id) => {
    const old = byName.get(name)
    if (old) return { ...old, id }
    const known = NEW_ENTITY_SIZES[name] ?? { type: 'mob', height: 0.5, width: 0.5 }
    return { id, name, displayName: name, ...known, newVia26x: true }
  })
}

// 26.3 version 条目（协议号 777 与 Via ProtocolVersion.java:75 对齐）
function buildVersion (base) {
  const v = { ...(base.version || {}) }
  v.minecraftVersion = '26.3'
  v.majorVersion = '26.3'
  v.version = 777
  v.dataVersion = v.dataVersion !== undefined ? v.dataVersion + 200 : 4700
  return v
}

// 组装 26.3 完整数据条目
function build263 (base) {
  const data = loadData()
  const out = { ...base }
  out.items = rebuildItems(data, base)
  out.blocks = rebuildBlocks(data, base)
  out.entities = rebuildEntities(data, base)
  // 新方块补进 blockCollisionShapes：prismarine-block 按名字查这张表，
  // 查不到会把 block.shapes 覆盖成 undefined（movements 读 .length 就炸）。
  // 1 = 全方块碰撞（保守值，寻路绕开新方块；0 是空碰撞会让 bot 走进树里被服务器卡住）。
  // 深拷贝 blocks —— base 的表是 data.js 共享对象，不能污染 26.1。
  const bcs = base.blockCollisionShapes
  if (bcs && bcs.blocks) {
    const blocks = { ...bcs.blocks }
    for (const b of out.blocks) {
      if (b.newVia26x && blocks[b.name] === undefined) blocks[b.name] = 1
    }
    out.blockCollisionShapes = { blocks, shapes: bcs.shapes }
  }
  out.version = buildVersion(base)
  out.protocol = require('./protocol-patch').patchProtocol(
    JSON.parse(JSON.stringify(base.protocol)),
    data.components
  )
  // recipes/entityLoot 等沿用 26.1（bot 不依赖其 26.3 增量）
  return out
}

module.exports = { build263, loadData }

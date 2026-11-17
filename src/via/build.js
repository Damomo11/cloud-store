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
    newBlockStates: read('new-block-states.json')
  }
}

// 名字 → 26.1 条目索引
function indexByName (list) {
  const map = new Map()
  for (const entry of list) map.set(entry.name, entry)
  return map
}

// items：26.3 全表按 id 重排；旧物品沿用 26.1 条目字段，新物品造最小条目
function rebuildItems (data, base) {
  const byName = indexByName(base.items)
  const out = data.items.names263.map((name, id) => {
    const old = byName.get(name)
    if (old) return { ...old, id }
    return {
      id,
      name,
      displayName: name,
      stackSize: 64,
      maxStackSize: 64,
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
    // 新方块：状态段来自空闲 id 分配
    const seg = newStates[name]
    const minStateId = seg && seg.firstStateId >= 0 ? seg.firstStateId : -1
    return {
      id,
      name,
      displayName: name,
      hardness: 0,
      stackSize: 64,
      diggable: false,
      boundingBox: 'empty',
      drops: [],
      transparent: true,
      emitLight: 0,
      filterLight: 0,
      minStateId,
      maxStateId: seg && seg.firstStateId >= 0 ? seg.firstStateId + seg.count - 1 : -1,
      states: [],
      newVia26x: true
    }
  })
}

// entities：26.3 全表重排
function rebuildEntities (data, base) {
  const byName = indexByName(base.entities)
  return data.entities.names263.map((name, id) => {
    const old = byName.get(name)
    if (old) return { ...old, id }
    return { id, name, displayName: name, type: 'mob', height: 0.5, width: 0.5, newVia26x: true }
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
  out.version = buildVersion(base)
  out.protocol = require('./protocol-patch').patchProtocol(
    JSON.parse(JSON.stringify(base.protocol)),
    data.components
  )
  // recipes/entityLoot 等沿用 26.1（bot 不依赖其 26.3 增量）
  return out
}

module.exports = { build263, loadData }

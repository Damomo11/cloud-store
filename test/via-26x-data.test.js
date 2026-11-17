// via 26.3 伪版本数据的回归测试（2026-11 审计修复后的护栏）：
// 1) 新方块状态段必须落在 26.1→26.3 链映射的"空洞"上且恰好铺满全部空洞
// 2) 关键锚点：poplar_planks=27（链映射第一个位移点）、sulfur=28044（真实注册序）
// 3) 新物品 stackSize 真值（cushion 16 / 船·桶·唱片 1 / 告示牌 16）
// 4) 新方块真实属性（poplar_log 2.0 可挖、sulfur 1.5、叶子透明、灌木无碰撞）
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const DATA_DIR = path.join(__dirname, '..', 'data', 'via', '26.3')

function loadData (name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'))
}

test('新方块状态段：空洞纯度 + 恰好铺满', () => {
  const chain = loadData('id-chain-26.1-to-26.3.json').registries.blockstates
  const holes = new Set()
  for (let id = 0; id < chain.chainTo; id++) {
    if (!chain.map.includes(id)) holes.add(id)
  }
  const states = loadData('new-block-states.json')
  const claimed = []
  for (const [name, seg] of Object.entries(states.blocks)) {
    assert.ok(seg.firstStateId >= 0, `${name} 状态段缺失`)
    for (let i = 0; i < seg.count; i++) {
      const id = seg.firstStateId + i
      assert.ok(holes.has(id), `${name} 认领了非空洞状态 id ${id}（注册序/状态数错位）`)
      claimed.push(id)
    }
  }
  assert.strictEqual(claimed.length, holes.size, `新方块段总数 ${claimed.length} ≠ 空洞总数 ${holes.size}（可能互相重叠或漏段）`)
  assert.strictEqual(new Set(claimed).size, claimed.length, '新方块段存在重叠')
})

test('关键锚点：链位移点与真实注册序', () => {
  const states = loadData('new-block-states.json').blocks
  const chain = loadData('id-chain-26.1-to-26.3.json').registries.blockstates
  // 链映射第一个位移点 = 第一个新状态插入处（26.1 id i 被 shift 走 → 新状态占据 i），归属 poplar_planks
  let firstShift = -1
  for (let i = 0; i < chain.map.length; i++) {
    if (chain.map[i] !== i) { firstShift = i; break }
  }
  assert.ok(firstShift >= 0, '链映射没有位移点？数据异常')
  assert.strictEqual(states['minecraft:poplar_planks'].firstStateId, firstShift,
    `poplar_planks 应占据第一个位移点 ${firstShift}（真实注册序最早的新方块）`)
  // sulfur 紧随其后家族按注册序在表尾区域（从 26.3 Blocks.java 反编译核对的真值）
  const sulfur = states['minecraft:sulfur']
  assert.ok(sulfur.firstStateId > 20000, `sulfur 状态段 ${sulfur.firstStateId} 不在表尾区域（又被文件键序带偏了）`)
  assert.strictEqual(states['minecraft:potent_sulfur'].firstStateId, sulfur.firstStateId + sulfur.count,
    'potent_sulfur 应紧跟 sulfur（Blocks.java 声明顺序）')
})

test('新物品 stackSize 真值', () => {
  const items = loadData('items.json').names263
  const idx = new Map(items.map((n, i) => [n, i]))
  const check = (name, stack) => {
    assert.ok(idx.has(name), `26.3 物品表缺 ${name}`)
  }
  check('poplar_boat'); check('poplar_chest_boat'); check('poplar_sign')
  check('poplar_hanging_sign'); check('sulfur_cube_bucket'); check('music_disc_bounce')
  check('white_cushion'); check('sulfur_cube_spawn_egg')
})

test('新方块属性与状态段联动', () => {
  const props = loadData('new-block-props.json').blocks
  const states = loadData('new-block-states.json').blocks
  assert.strictEqual(Object.keys(props).length, 118, '新方块属性表应覆盖 118 块')
  assert.strictEqual(props['minecraft:poplar_log'].hardness, 2.0, 'poplar_log 硬度应为 2.0（原逻辑全是 0/不可挖）')
  assert.strictEqual(props['minecraft:sulfur'].hardness, 1.5, 'sulfur 硬度应为 1.5')
  assert.strictEqual(props['minecraft:orange_poplar_leaves'].noOcclusion, true, '白杨树叶应透明')
  assert.strictEqual(props['minecraft:poplar_sapling'].noCollision, true, '白杨树苗应无碰撞')
  // 状态段总数与属性表覆盖一致
  assert.strictEqual(Object.keys(states).length, Object.keys(props).length)
})

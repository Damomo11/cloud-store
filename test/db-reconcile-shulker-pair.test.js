'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const StoreDb = require('../src/db')
const ItemCatalog = require('../src/itemCatalog')
const { DEFAULT_CONFIG } = require('../src/config')

// activate 必须在 minecraft-data 之前（与 src/index.js 同序）
require('../src/via').activate()
const md = require('minecraft-data')
const LEGACY_NOTE_BLOCK = md('1.21.11').itemsByName.note_block.id // 748
const CURRENT_NOTE_BLOCK = md('26.3').itemsByName.note_block.id // 855
const LEGACY_COBBLESTONE = md('1.21.11').itemsByName.cobblestone.id
const CURRENT_COBBLESTONE = md('26.3').itemsByName.cobblestone.id

function fixture () {
  const config = structuredClone(DEFAULT_CONFIG)
  const db = new StoreDb(':memory:', config)
  db.setCatalog(new ItemCatalog('26.3'))
  return { db, config, momo: config.momoOwner, close: () => db.close() }
}

function itemRow (name) {
  return {
    itemKey: `minecraft:${name}|${'ab'.repeat(20)}`,
    itemId: `minecraft:${name}`,
    displayName: name,
    nbtJson: 'null',
    metaJson: '{"components":null,"metadata":null}'
  }
}

// 内容档案：数字 itemId 按指定目录编码（era='legacy' 模拟迁移前入账，era='current' 模拟 26.3 扫描）
function boxMetaJson (era, numericId, count = 1645) {
  const id = era === 'legacy' ? { note: LEGACY_NOTE_BLOCK, cobble: LEGACY_COBBLESTONE } : { note: CURRENT_NOTE_BLOCK, cobble: CURRENT_COBBLESTONE }
  const chosen = numericId === 'note' ? id.note : id.cobble
  return JSON.stringify({
    metadata: null,
    components: [{ type: 'container', data: { contents: [{ itemId: chosen, itemCount: count, addedComponentCount: 0, removedComponentCount: 0 }] } }]
  })
}

function shulkerItem (key, metaJson, amount = 1) {
  return { itemKey: key, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson, amount }
}

function seedBox (db, boxName, contentName, contentAmount, owner, amount) {
  const box = itemRow(boxName)
  const content = itemRow(contentName)
  db.upsertItem(box)
  db.upsertItem(content)
  db.addBalanceItems(owner, [{ ...box, amount }])
  db.db.prepare('INSERT INTO shulker_contents (shulker_item_key, contained_item_key, contained_item_id, amount, slot_count) VALUES (?, ?, ?, ?, ?)')
    .run(box.itemKey, content.itemKey, content.itemId, contentAmount, 26)
  return { box, content }
}

test('跨目录内容签名：迁移前旧账（1.21.11 数字 id）与 26.3 扫描的新指纹能配对', async () => {
  const f = fixture()
  try {
    const oldKey = 'minecraft:shulker_box|' + 'dfcbeb19bbd77cf61ead74d4e84e22ecb69d3974'.slice(0, 40)
    const newKey = 'minecraft:shulker_box|' + 'fff0c02969ea703837e955668eefd9ce3439cb28'.slice(0, 40)
    const owner = 'vault:yezhicheng'
    for (const key of [oldKey, newKey]) {
      f.db.upsertItem({ itemKey: key, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}' })
    }
    // 旧账：metaJson 里是 1.21.11 数字 id（迁移前入账）；迁移 rebuild 用 26.3 目录
    // 重解会得到错误物品名（1353→vex_spawn_egg 这类），签名必须绕开这个坑。
    f.db.addBalanceItems(owner, [shulkerItem(oldKey, boxMetaJson('legacy', 'note'), 1)])
    // 实物（对账扫描输入）：只有 26.3 数字 id 的新指纹盒子。
    const actualTotals = [shulkerItem(newKey, boxMetaJson('current', 'note'), 1)]
    f.db.reconcileTotalsToMomo(actualTotals)

    // 新指纹记回原主，未划入 momo；旧指纹的账面因配对消化，未走 missing 扣账。
    assert.equal(f.db.getBalance(owner, newKey), 1)
    assert.equal(f.db.getBalance(f.momo, newKey), 0)
    assert.equal(f.db.getBalance(owner, oldKey), 0)
    const open = f.db.db.prepare("SELECT COUNT(*) AS n FROM inventory_mismatches WHERE status='open'").get().n
    assert.equal(open, 0)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='sync_pair_transfer'").get().n, 1)
  } finally { f.close() }
})

test('盒内内容不同：不配对，维持原对账流程', async () => {
  const f = fixture()
  try {
    const oldKey = 'minecraft:shulker_box|' + 'a1'.repeat(20)
    const newKey = 'minecraft:shulker_box|' + 'b2'.repeat(20)
    const owner = 'vault:owner'
    for (const key of [oldKey, newKey]) {
      f.db.upsertItem({ itemKey: key, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}' })
    }
    f.db.addBalanceItems(owner, [shulkerItem(oldKey, boxMetaJson('legacy', 'note'), 1)])
    const actualTotals = [shulkerItem(newKey, boxMetaJson('current', 'cobble'), 1)]
    f.db.reconcileTotalsToMomo(actualTotals)

    // 内容不同：走原流程——旧指纹 missing 扣账，新指纹 extra 划 momo。
    assert.equal(f.db.getBalance(owner, oldKey), 0)
    assert.equal(f.db.getBalance(f.momo, newKey), 1)
    const openMissing = f.db.db.prepare("SELECT COUNT(*) AS n FROM inventory_mismatches WHERE status='open' AND kind='missing' AND item_key=?").get(oldKey).n
    const openExtra = f.db.db.prepare("SELECT COUNT(*) AS n FROM inventory_mismatches WHERE status='open' AND kind='extra' AND item_key=?").get(newKey).n
    assert.equal(openMissing, 1)
    assert.equal(openExtra, 1)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='sync_pair_transfer'").get().n, 0)
  } finally { f.close() }
})

test('旧指纹多归属持有：不唯一不自动配对，留给人工', async () => {
  const f = fixture()
  try {
    const oldKey = 'minecraft:shulker_box|' + 'c3'.repeat(20)
    const newKey = 'minecraft:shulker_box|' + 'd4'.repeat(20)
    for (const key of [oldKey, newKey]) {
      f.db.upsertItem({ itemKey: key, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}' })
    }
    f.db.addBalanceItems('vault:a', [shulkerItem(oldKey, boxMetaJson('legacy', 'note'), 1)])
    f.db.addBalanceItems('vault:b', [shulkerItem(oldKey, boxMetaJson('legacy', 'note'), 1)])
    const actualTotals = [shulkerItem(newKey, boxMetaJson('current', 'note'), 1)]
    f.db.reconcileTotalsToMomo(actualTotals)

    // 两个持有者：归属不唯一，不自动转移；新指纹仍划 momo 留人工处理。
    assert.equal(f.db.getBalance(f.momo, newKey), 1)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='sync_pair_transfer'").get().n, 0)
  } finally { f.close() }
})

test('配对量按持有者余额钳制：momo 兜底持有部分不把配对扣成负数（2026-11-18 椰汁橙 -1 案例）', async () => {
  const f = fixture()
  try {
    const oldKey = 'minecraft:shulker_box|' + 'e5'.repeat(20)
    const newKey = 'minecraft:shulker_box|' + 'f6'.repeat(20)
    const owner = 'vault:yezhicheng'
    for (const key of [oldKey, newKey]) {
      f.db.upsertItem({ itemKey: key, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}' })
    }
    // 账：持有者 1 + momo 兜底 1（此前某次对账把同指纹盒子划入过 momo），
    // 全账量 2；实物有两只同内容新指纹盒子。
    f.db.addBalanceItems(owner, [shulkerItem(oldKey, boxMetaJson('legacy', 'note'), 1)])
    f.db.addBalanceItems(f.momo, [shulkerItem(oldKey, boxMetaJson('legacy', 'note'), 1)])
    const actualTotals = [shulkerItem(newKey, boxMetaJson('current', 'note'), 2)]
    // 修复前：pairAmount=min(2,2)=2，从持有者（余额 1）扣 2 → 抛 balance would become negative: -1，
    // 整个对账事务回滚，同步被这批漂移盒子永久卡死。
    f.db.reconcileTotalsToMomo(actualTotals)

    // 持有者按余额配对转移 1 只；momo 的旧账残量走主循环标准钳制路径扣掉，
    // 多出的新指纹盒子划入 momo。
    assert.equal(f.db.getBalance(owner, oldKey), 0)
    assert.equal(f.db.getBalance(owner, newKey), 1)
    assert.equal(f.db.getBalance(f.momo, oldKey), 0)
    assert.equal(f.db.getBalance(f.momo, newKey), 1)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='sync_pair_transfer'").get().n, 1)
    // momo 兜底的旧账残量走标准路径扣掉（不产生 missing 异常）；
    // 多出的新指纹盒子按设计划入 momo，留一条 open extra 异常。
    const openMissing = f.db.db.prepare("SELECT COUNT(*) AS n FROM inventory_mismatches WHERE status='open' AND kind='missing'").get().n
    assert.equal(openMissing, 0)
    const openExtra = f.db.db.prepare("SELECT COUNT(*) AS n FROM inventory_mismatches WHERE status='open' AND kind='extra' AND item_key=?").get(newKey).n
    assert.equal(openExtra, 1)
  } finally { f.close() }
})

test('兜底回填：上次同步漏配扣走/划入 momo 的盒子，下次同步按异常留痕划回原主', async () => {
  const f = fixture()
  try {
    const oldKey = 'minecraft:shulker_box|' + '07'.repeat(20)
    const newKey = 'minecraft:shulker_box|' + '18'.repeat(20)
    const owner = 'vault:yezhicheng'
    for (const key of [oldKey, newKey]) {
      f.db.upsertItem({ itemKey: key, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}' })
    }
    // 模拟上次同步漏配后的状态：owner 旧指纹已被 sync_deduct 扣走（余额 0），
    // momo 持有新指纹 ×1；异常留痕 extra(momo,新指纹) + missing(owner,旧指纹,实扣1)。
    f.db.addBalanceItems(f.momo, [shulkerItem(newKey, boxMetaJson('current', 'note'), 1)])
    f.db.addInventoryMismatch('extra', f.momo, 'momo', shulkerItem(newKey, boxMetaJson('current', 'note'), 1), 1, '同步发现仓库实物多于账本，已自动划入 momo。')
    f.db.addInventoryMismatch('missing', owner, '椰汁橙', shulkerItem(oldKey, boxMetaJson('legacy', 'note'), 1), 1, '同步发现仓库实物少于账本，已自动扣除账面 x1。', 1)

    // 下一次同步：实物仍只有新指纹 ×1（与 momo 账面一致，主循环不动账），
    // 但回填通道应把 momo 多持的新指纹划回原主。
    const actualTotals = [shulkerItem(newKey, boxMetaJson('current', 'note'), 1)]
    const result = f.db.reconcileTotalsToMomo(actualTotals)

    assert.equal(result.driftRepair.repaired, 1)
    assert.equal(f.db.getBalance(owner, newKey), 1)
    assert.equal(f.db.getBalance(f.momo, newKey), 0)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='sync_drift_repair'").get().n, 1)
    const open = f.db.db.prepare("SELECT COUNT(*) AS n FROM inventory_mismatches WHERE status='open'").get().n
    assert.equal(open, 0)
  } finally { f.close() }
})

test('兜底回填：内容不同不回配，异常留给人工', async () => {
  const f = fixture()
  try {
    const oldKey = 'minecraft:shulker_box|' + '29'.repeat(20)
    const newKey = 'minecraft:shulker_box|' + '3a'.repeat(20)
    const owner = 'vault:other'
    for (const key of [oldKey, newKey]) {
      f.db.upsertItem({ itemKey: key, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}' })
    }
    f.db.addInventoryMismatch('extra', f.momo, 'momo', shulkerItem(newKey, boxMetaJson('current', 'note'), 1), 1, '同步发现仓库实物多于账本，已自动划入 momo。')
    f.db.addInventoryMismatch('missing', owner, '其他', shulkerItem(oldKey, boxMetaJson('legacy', 'cobble'), 1), 1, '同步发现仓库实物少于账本，已自动扣除账面 x1。', 1)

    const actualTotals = [shulkerItem(newKey, boxMetaJson('current', 'note'), 1)]
    const result = f.db.reconcileTotalsToMomo(actualTotals)

    assert.equal(result.driftRepair.repaired, 0)
    assert.equal(f.db.getBalance(f.momo, newKey), 1)
    assert.equal(f.db.getBalance(owner, newKey), 0)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='sync_drift_repair'").get().n, 0)
  } finally { f.close() }
})

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const StoreDb = require('../src/db')
const { DEFAULT_CONFIG } = require('../src/config')

function fixture () {
  const config = structuredClone(DEFAULT_CONFIG)
  const db = new StoreDb(':memory:', config)
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

test('同内容潜影盒指纹漂移：配对转移归属，不再扣账划兜底', async () => {
  const f = fixture()
  try {
    const oldKey = 'minecraft:shulker_box|' + 'dfcbeb19bbd77cf61ead74d4e84e22ecb69d3974'.slice(0, 40)
    const newKey = 'minecraft:shulker_box|' + 'fff0c02969ea703837e955668eefd9ce3439cb28'.slice(0, 40)
    const owner = 'vault:yezhicheng'
    for (const key of [oldKey, newKey]) {
      f.db.upsertItem({ itemKey: key, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}' })
    }
    const note = itemRow('note_block')
    f.db.upsertItem(note)
    // 账：椰汁橙持有旧指纹盒子 x1；盒内内容登记 1645 音符盒。
    f.db.addBalanceItems(owner, [{ itemKey: oldKey, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}', amount: 1 }])
    f.db.db.prepare('INSERT INTO shulker_contents (shulker_item_key, contained_item_key, contained_item_id, amount, slot_count) VALUES (?, ?, ?, ?, ?)')
      .run(oldKey, note.itemKey, note.itemId, 1645, 26)
    f.db.db.prepare('INSERT INTO shulker_contents (shulker_item_key, contained_item_key, contained_item_id, amount, slot_count) VALUES (?, ?, ?, ?, ?)')
      .run(newKey, note.itemKey, note.itemId, 1645, 26)

    // 实物（对账扫描输入）：只有新指纹盒子 x1，旧指纹无实物。
    const actualTotals = [{ itemKey: newKey, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}', amount: 1 }]
    f.db.reconcileTotalsToMomo(actualTotals)

    // 新指纹记回原主，未划入 momo。
    assert.equal(f.db.getBalance(owner, newKey), 1)
    assert.equal(f.db.getBalance(f.momo, newKey), 0)
    // 旧指纹的账面因配对消化（amount 减到 0），未走 missing 扣账。
    assert.equal(f.db.getBalance(owner, oldKey), 0)
    // 不产生 open 异常；转移流水与闭环留痕各留一条。
    const open = f.db.db.prepare("SELECT COUNT(*) AS n FROM inventory_mismatches WHERE status='open'").get().n
    assert.equal(open, 0)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='sync_pair_transfer'").get().n, 1)
    const resolved = f.db.db.prepare("SELECT COUNT(*) AS n FROM inventory_mismatches WHERE status='resolved' AND item_key=?").get(oldKey).n
    assert.equal(resolved, 1)
  } finally { f.close() }
})

test('盒内内容不同：不配对，维持原对账流程', async () => {
  const f = fixture()
  try {
    const oldKey = 'minecraft:shulker_box|' + 'a1'.repeat(20)
    const newKey = 'minecraft:shulker_box|' + 'b2'.repeat(20)
    const owner = 'vault:owner'
    const note = itemRow('note_block')
    const cobble = itemRow('cobblestone')
    f.db.upsertItem(note)
    f.db.upsertItem(cobble)
    for (const key of [oldKey, newKey]) {
      f.db.upsertItem({ itemKey: key, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}' })
    }
    f.db.addBalanceItems(owner, [{ itemKey: oldKey, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}', amount: 1 }])
    f.db.db.prepare('INSERT INTO shulker_contents (shulker_item_key, contained_item_key, contained_item_id, amount, slot_count) VALUES (?, ?, ?, ?, ?)').run(oldKey, note.itemKey, note.itemId, 1645, 26)
    f.db.db.prepare('INSERT INTO shulker_contents (shulker_item_key, contained_item_key, contained_item_id, amount, slot_count) VALUES (?, ?, ?, ?, ?)').run(newKey, cobble.itemKey, cobble.itemId, 1645, 26)

    const actualTotals = [{ itemKey: newKey, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}', amount: 1 }]
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
    const note = itemRow('note_block')
    f.db.upsertItem(note)
    for (const key of [oldKey, newKey]) {
      f.db.upsertItem({ itemKey: key, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}' })
    }
    f.db.addBalanceItems('vault:a', [{ itemKey: oldKey, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}', amount: 1 }])
    f.db.addBalanceItems('vault:b', [{ itemKey: oldKey, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}', amount: 1 }])
    f.db.db.prepare('INSERT INTO shulker_contents (shulker_item_key, contained_item_key, contained_item_id, amount, slot_count) VALUES (?, ?, ?, ?, ?)').run(oldKey, note.itemKey, note.itemId, 1645, 26)
    f.db.db.prepare('INSERT INTO shulker_contents (shulker_item_key, contained_item_key, contained_item_id, amount, slot_count) VALUES (?, ?, ?, ?, ?)').run(newKey, note.itemKey, note.itemId, 1645, 26)

    const actualTotals = [{ itemKey: newKey, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}', amount: 1 }]
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
    const note = itemRow('note_block')
    f.db.upsertItem(note)
    for (const key of [oldKey, newKey]) {
      f.db.upsertItem({ itemKey: key, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}' })
    }
    // 账：持有者 1 + momo 兜底 1（此前某次对账把同指纹盒子划入过 momo），
    // 全账量 2；实物有两只同内容新指纹盒子。
    f.db.addBalanceItems(owner, [{ itemKey: oldKey, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}', amount: 1 }])
    f.db.addBalanceItems(f.momo, [{ itemKey: oldKey, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}', amount: 1 }])
    f.db.db.prepare('INSERT INTO shulker_contents (shulker_item_key, contained_item_key, contained_item_id, amount, slot_count) VALUES (?, ?, ?, ?, ?)').run(oldKey, note.itemKey, note.itemId, 1645, 26)
    f.db.db.prepare('INSERT INTO shulker_contents (shulker_item_key, contained_item_key, contained_item_id, amount, slot_count) VALUES (?, ?, ?, ?, ?)').run(newKey, note.itemKey, note.itemId, 1645, 26)

    const actualTotals = [{ itemKey: newKey, itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: 'null', metaJson: '{}', amount: 2 }]
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

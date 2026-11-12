'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const StoreDb = require('../../src/db')
const ItemCatalog = require('../../src/itemCatalog')
const { DEFAULT_CONFIG } = require('../../src/config')
const { CraftController } = require('../../src/craft/controller')

test('craft physical totals aggregate exact variants without fetching every warehouse slot or item', () => {
  const db = new StoreDb(':memory:', DEFAULT_CONFIG)
  try {
    const catalog = new ItemCatalog(DEFAULT_CONFIG.server.version, {}, {})
    const Item = require('prismarine-item')(catalog.mcData)
    const plain = new Item(catalog.mcData.itemsByName.stone.id, 1)
    const named = new Item(plain.type, 2)
    named.components = [{ type: 'custom_name', data: 'distinct identity' }]
    const a = catalog.fromPrismarineItem(plain)
    const b = catalog.fromPrismarineItem(named)
    for (let n = 0; n < 8; n++) {
      db.upsertChest({ chestId: String(n), x: n, y: 64, z: 0, blockName: 'barrel' })
      db.replaceChestSlots(String(n), [{ ...a, slot: 0, amount: 64 }, { ...a, slot: 1, amount: 3 }, { ...b, slot: 2, amount: 2 }])
    }
    db.upsertChest({ chestId: 'empty', x: 9, y: 64, z: 0, blockName: 'barrel' })
    let reads = 0
    const list = db.listChestSlots.bind(db)
    const item = db.getItemByKey.bind(db)
    db.listChestSlots = (...args) => { reads++; return list(...args) }
    db.getItemByKey = (...args) => { reads++; return item(...args) }
    const controller = new CraftController({ db, catalog, bot: { inventory: { items: () => [plain] } } })
    const totals = controller.physicalTotals()
    assert.equal(totals.find(value => value.itemKey === a.itemKey).amount, 537)
    assert.equal(totals.find(value => value.itemKey === b.itemKey).amount, 16)
    assert.equal(totals.length, 2)
    for (const value of totals) assert.deepEqual(db.getItemByKey(value.itemKey), {
      itemKey: value.itemKey, itemId: value.itemId, displayName: value.displayName, nbtJson: value.nbtJson, metaJson: value.metaJson
    })
    reads -= totals.length
    assert.equal(reads, 0, 'craft snapshots must not perform per-slot item lookups')
    db.replaceChestSlots('0', [])
    assert.equal(controller.physicalTotals().find(value => value.itemKey === a.itemKey).amount, 470)
    assert.equal(controller.physicalTotals().find(value => value.itemKey === b.itemKey).amount, 14)
  } finally { db.close() }
})

test('craft physical totals reject fractional storage counts even when their sum is an integer', () => {
  const db = new StoreDb(':memory:', DEFAULT_CONFIG)
  try {
    db.upsertChest({ chestId: 'a', x: 0, y: 64, z: 0, blockName: 'barrel' })
    db.replaceChestSlots('a', [0, 1].map(slot => ({ slot, itemKey: 'stone', itemId: 'minecraft:stone', displayName: 'Stone', nbtJson: 'null', metaJson: '{}', amount: 0.5 })))
    const controller = new CraftController({ db, catalog: { aggregatePrismarineItems: () => [] }, bot: { inventory: { items: () => [] } } })
    assert.throws(() => controller.physicalTotals(), /invalid craft inventory snapshot/)
  } finally { db.close() }
})

test('craft physical totals reject unsafe combined storage and backpack counts', () => {
  const controller = new CraftController({
    db: { listChestSlots: () => [{ itemKey: 'stone', amount: Number.MAX_SAFE_INTEGER }], getItemByKey: () => ({ itemKey: 'stone' }) },
    catalog: { aggregatePrismarineItems: () => [{ itemKey: 'stone', amount: 1 }] }, bot: { inventory: { items: () => [] } }, ledger: {}
  })
  assert.throws(() => controller.physicalTotals(), /invalid craft inventory snapshot total/)
})

test('craft physical totals retain lightweight database adapter support', () => {
  const controller = new CraftController({
    db: { listChestSlots: () => [{ itemKey: 'stone', amount: 4 }, { itemKey: 'stone', amount: 0 }], getItemByKey: () => ({ itemKey: 'stone', itemId: 'minecraft:stone' }) },
    catalog: { aggregatePrismarineItems: () => [] }, bot: { inventory: { items: () => [] } }, ledger: {}
  })
  assert.deepEqual(controller.physicalTotals(), [{ itemKey: 'stone', itemId: 'minecraft:stone', amount: 4 }])
})

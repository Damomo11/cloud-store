'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Service = require('../src/service')
const { fixture, item, row } = require('./helpers/packing-server')

function captureBarrels (f) {
  const snapshots = f.db.listChests().map(chest => ({
    chest,
    preReadSeq: f.warehouse.warehouseState.chestRevisions.get(chest.chestId) || 0,
    slots: f.barrels.get(chest.chestId).flatMap((value, slot) => value ? [{ ...row(value), slot }] : [])
  }))
  return { blocks: snapshots.map(value => value.chest), snapshots }
}

async function syncBarrels (f) {
  return f.warehouse.withWarehouseLock(() => f.warehouse.applyWarehouseScan(captureBarrels(f), 10))
}

test('a sync snapshot captured during packing return rereads the changed barrel after settlement', async t => {
  let staleScan
  const f = fixture({ afterShift: () => { staleScan = captureBarrels(f) } })
  t.after(() => f.close())
  const result = await f.controller().run(f.request)
  assert.equal(result.status, 'completed')
  assert.equal(f.db.hasPendingPacking(), false)
  const balances = f.db.getOwnerBalances('alice')
  const applied = await f.warehouse.withWarehouseLock(() => f.warehouse.applyWarehouseScan(staleScan, 10))
  assert.equal(applied.rescanCount, 1)
  assert.deepEqual(f.db.getOwnerBalances('alice'), balances)
  assert.deepEqual(applied.unresolved, [])
  assert.deepEqual(applied.addedToMomo, [])
})

for (const returned of [false, true]) {
  test(`sync preserves uncommitted packing ownership with product ${returned ? 'stored before receipt' : 'still held'}`, async t => {
    const f = fixture({ refuseReturn: true }); t.after(() => f.close())
    const controller = f.controller()
    await assert.rejects(controller.run(f.request))
    const before = f.db.getOwnerBalances('alice')
    if (returned) {
      f.barrels.get('destination')[0] = f.player.items()[0]
      f.player.slots.fill(null)
      f.sync()
    }
    f.addChest('unrelated', [item('dirt', 3)])
    await syncBarrels(f)
    assert.deepEqual(f.db.getOwnerBalances('alice'), before)
    assert.equal(f.db.getBalance(f.config.momoOwner, row(item('dirt')).itemKey), 3)
    const product = controller.ledger.pending('bot-a')[0].data.product
    assert.equal(f.db.getBalance(f.config.momoOwner, product.itemKey), 0)
    f.options.refuseReturn = false
    await controller.recover()
    assert.equal(f.db.hasPendingPacking(), false)
    assert.equal(f.db.getBalance('alice', product.itemKey), 1)
    assert.equal(f.db.getBalance('alice', f.request.items[0].itemKey), 0)
    await syncBarrels(f)
    assert.equal(f.db.getBalance('alice', product.itemKey), 1)
    assert.equal(f.db.getBalance(f.config.momoOwner, product.itemKey), 0)
  })
}

test('sync defers a partially withdrawn packing batch and resumes after raw return', async t => {
  const f = fixture({ withdrawLimit: 3, withdrawError: true, refuseReturn: true }); t.after(() => f.close())
  const controller = f.controller()
  await assert.rejects(controller.run(f.request))
  const before = f.db.getOwnerBalances('alice')
  const stone = f.db.getItemByKey(f.request.items[0].itemKey)
  f.db.addInventoryMismatch('missing', 'alice', 'Alice', stone, 1, 'existing evidence')
  const sync = await syncBarrels(f)
  assert.deepEqual(f.db.getOwnerBalances('alice'), before)
  assert.equal(sync.deferredForPacking.includes(stone.itemKey), true)
  assert.equal(f.db.hasOpenInventoryMismatch('alice', stone.itemKey), true)
  f.options.refuseReturn = false
  await controller.recover()
  assert.equal(f.db.hasPendingPacking(), false)
  assert.deepEqual(f.db.getOwnerBalances('alice'), before)
  await syncBarrels(f)
  assert.deepEqual(f.db.getOwnerBalances('alice'), before)
  assert.equal(f.db.hasOpenInventoryMismatch('alice', stone.itemKey), false)
})

test('emergency rescue preserves a pending packing product instead of delivering it to the admin', async t => {
  const f = fixture({ refuseReturn: true }); t.after(() => f.close())
  const controller = f.controller()
  await assert.rejects(controller.run(f.request))
  const service = new Service(f.bot, f.db, f.catalog, f.warehouse, f.config)
  service.botId = 'bot-a'
  service.packingController = controller
  service.msg = () => {}
  service.teleportToPlayer = async () => true
  let dropped = false
  service.dropWithdrawItemsToPlayer = async () => { dropped = true; return [] }
  service.formatDepositSummary = () => ''
  const held = f.catalog.aggregatePrismarineItems(f.player.items())
  assert.equal(await service.handleEmergencyRescue('OtherAdmin'), false)
  assert.equal(dropped, false)
  assert.deepEqual(f.catalog.aggregatePrismarineItems(f.player.items()), held)
  assert.equal(f.db.hasPendingPacking('bot-a'), true)
})

test('ordinary emergency rescue still delivers ordinary held items without packing', async t => {
  const f = fixture(); t.after(() => f.close())
  f.player.updateSlot(9, item('dirt', 2)); f.sync()
  const service = new Service(f.bot, f.db, f.catalog, f.warehouse, f.config)
  service.msg = () => {}
  service.teleportToPlayer = async () => true
  let delivered
  service.dropWithdrawItemsToPlayer = async (username, held) => { delivered = { username, held }; return held }
  service.formatDepositSummary = () => ''
  assert.equal(await service.handleEmergencyRescue('Admin'), true)
  assert.equal(delivered.username, 'Admin')
  assert.deepEqual(delivered.held.map(value => [value.itemId, value.amount]), [['minecraft:dirt', 2]])
})

test('emergency rescue cancels packing preflight before its journal exists and waits for it to drain', async t => {
  let entered
  const authorizing = new Promise(resolve => { entered = resolve })
  let release
  const f = fixture()
  t.after(() => f.close())
  const controller = f.controller({ validateOwner: async () => { entered(); await new Promise(resolve => { release = resolve }) } })
  const service = new Service(f.bot, f.db, f.catalog, f.warehouse, f.config)
  service.botId = 'bot-a'
  service.packingController = controller
  service.msg = () => {}
  let teleported = false
  service.teleportToPlayer = async () => { teleported = true; return true }
  const running = controller.run(f.request)
  const rejected = assert.rejects(running)
  await authorizing
  assert.equal(controller.isBusy(), true)
  assert.equal(f.db.hasPendingPacking(), false)
  assert.equal(await service.handleEmergencyRescue('OtherAdmin'), false)
  assert.equal(controller.isBusy(), true)
  assert.equal(teleported, false)
  release()
  await rejected
  assert.equal(controller.isBusy(), false)
})

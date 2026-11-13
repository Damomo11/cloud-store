'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture, item } = require('./helpers/packing-server')
const Warehouse = require('../src/warehouse')

test('packing source whitelist rejects malformed or non-strict use before opening any barrel', async t => {
  const f = fixture(); t.after(() => f.close())
  for (const options of [{ packingSourceChestIds: ['source'] }, { requireServerEvidence: true, packingSourceChestIds: [] },
    { requireServerEvidence: true, packingSourceChestIds: ['unknown'] }, { requireServerEvidence: true, packingSourceChestIds: ['source', 'source'] }]) {
    await assert.rejects(Warehouse.prototype.withdrawAllocationsLocked.call(f.warehouse, [], options), /packing/i)
  }
  assert.equal(f.calls.length, 0)
})
test('real warehouse restricts packing source attempts, ordinary callers retain all known groups', async t => {
  const f = fixture(); t.after(() => f.close())
  f.addChest('extra', [item('stone', 10)])
  f.warehouse.tryWithdrawExactFrom = async () => 0
  f.warehouse.verifyCraftContainer = async () => {}
  f.warehouse.inventoryFreeCapacityForItem = () => 64
  const allocation = [f.db.getItemByKey(f.request.items[0].itemKey)].map(row => ({ ...row, amount: 30 }))
  await Warehouse.prototype.withdrawAllocationsLocked.call(f.warehouse, allocation, { requireServerEvidence: true, packingSourceChestIds: ['source'] })
  assert.deepEqual(f.calls, ['source'])
  f.calls.length = 0
  await Warehouse.prototype.withdrawAllocationsLocked.call(f.warehouse, allocation)
  assert.deepEqual(f.calls, ['source', 'extra'])
})

test('storage strict player close rejects hidden zero-count cursor metadata before reservation', async t => {
  const f = fixture({ packet: (packet, id) => { if (id === 0) packet.carriedItem = { itemCount: 0, itemId: 1 } } }); t.after(() => f.close())
  await assert.rejects(f.controller().run(f.request), /confirmed/)
  assert.equal(f.withdrawals, 0)
  assert.equal(f.db.hasPendingPacking(), false)
})

test('initial storage read correlates the current barrel packet despite unrelated player-menu traffic', async t => {
  const f = fixture(); t.after(() => f.close())
  const open = f.warehouse.openContainerAt
  f.warehouse.openContainerAt = async chest => {
    const window = await open(chest)
    f.bot._client.emit('window_items', { windowId: 0, items: [], carriedItem: { itemCount: 0 } })
    return window
  }
  assert.equal((await f.controller().run(f.request)).status, 'completed')
})

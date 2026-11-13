'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture, item, row } = require('./helpers/packing-server')
test('real ledger mixed packing returns owned products usable by normal whole-box and contents queries', async t => {
  const f = fixture(); t.after(() => f.close())
  const result = await f.controller().run(f.request)
  assert.equal(result.status, 'completed')
  assert.equal(result.batches.length, 1)
  const product = result.batches[0].product
  assert.equal(f.db.getBalance('alice', product.itemKey), 1)
  assert.equal(f.db.getBalance('someone-else', product.itemKey), 0)
  assert.equal(f.db.getOwnerItemsByItemKey('alice', product.itemKey)[0].amount, 1)
  assert.equal(f.db.getOwnerShulkersContainingItemId('alice', 'minecraft:diamond_sword').length, 1)
  assert.equal(f.db.getOwnerShulkersContainingItemKey('alice', row(item('diamond_sword')).itemKey).length, 1)
  assert.equal(f.db.hasPendingPacking('bot-a'), false)
  assert.equal(f.bot.inventory.items().length, 0)
})
test('partial withdrawal is immediately returned without conversion and unused reservations released', async t => {
  const f = fixture({ withdrawLimit: 3, withdrawError: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request), error => error.recovery?.status === 'failed')
  assert.equal(f.db.getBalance('alice', f.request.items[0].itemKey), 20)
  assert.equal(f.db.hasPendingPacking('bot-a'), false)
  assert.equal(f.bot.inventory.items().length, 0)
})
test('partial packing settles only actual packed subset and fails the order', async t => {
  const f = fixture({ packLimit: 2, executeError: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request), error => error.recovery?.status === 'failed')
  assert.equal(f.db.getBalance('alice', f.request.items[0].itemKey), 18)
  assert.equal(f.db.hasPendingPacking('bot-a'), false)
})
test('source drift rejects before take without refreshing recorded source baseline', async t => {
  const f = fixture(); t.after(() => f.close())
  const before = f.db.listChestSlots()
  f.barrels.get('source')[0].count = 19
  await assert.rejects(f.controller().run(f.request), /source|record|snapshot/i)
  assert.equal(f.withdrawals, 0)
  assert.deepEqual(f.db.listChestSlots(), before)
})

test('multi-box order yields warehouse lock only after a clean settled batch', async t => {
  const f = fixture({ stocks: Array.from({ length: 25 }, () => item('stone', 64)) }); t.after(() => f.close())
  const extra = [item('stone', 64), item('stone', 64), item('stone', 1)]
  f.addChest('second-source', extra)
  f.db.addBalanceItems('alice', f.catalog.aggregatePrismarineItems(extra))
  f.request.items = [{ itemKey: row(item('stone')).itemKey, amount: 1729 }]
  const c = f.controller()
  let interleave
  f.options.beforeExecute = () => {
    if (interleave) return
    interleave = f.warehouse.withWarehouseLock(async () => {
      const op = c.ledger.pending('bot-a')[0]
      assert.equal(op.data.batchIndex, 1)
      assert.equal(op.phase, 'ready')
      assert.equal(f.player.items().length, 0)
      assert.equal(c.isBusy(), true)
    })
  }
  const result = await c.run(f.request)
  await interleave
  assert.equal(result.boxCount, 2)
  assert.equal(result.itemCount, 1729)
  assert.equal(f.db.getBalance('alice', f.request.items[0].itemKey), 0)
  assert.equal(f.withdrawals, 2)
})

for (const mode of ['missing-validator', 'wrong-actor', 'foreign-local', 'foreign-server', 'server-equipment', 'reserved-stock', 'no-owned-box', 'no-location']) {
  test('refuses unsafe preflight: ' + mode, async t => {
    const f = fixture(); t.after(() => f.close())
    const c = f.controller(mode === 'missing-validator' ? { validateOwner: undefined } : {})
    if (mode === 'wrong-actor') f.request.actor = 'Other'
    if (mode === 'foreign-local') f.bot.inventory.updateSlot(9, item('dirt'))
    if (mode === 'foreign-server') f.player.updateSlot(9, item('dirt'))
    if (mode === 'server-equipment') f.player.updateSlot(5, item('diamond_helmet'))
    if (mode === 'reserved-stock') f.db.reserveInventory('ordinary-reservation', f.request.items.map(row => ({ ...row, ownerUuid: 'alice' })))
    if (mode === 'no-owned-box') {
      const boxes = f.db.getOwnerBalances('alice').filter(row => f.catalog.isShulkerBox(row.itemId))
      for (const box of boxes) { f.db.adjustBalance('alice', box.itemKey, -box.amount); f.db.addBalanceItems('other', [box]) }
    }
    if (mode === 'no-location') f.db.replaceChestSlots('source', [])
    await assert.rejects(c.run(f.request))
    assert.equal(f.withdrawals, 0)
    assert.equal(c.ledger.pending().length, 0)
  })
}

test('cancel holds own lease and warehouse mutex until an awaited physical call drains', async t => {
  const f = fixture(); t.after(() => f.close())
  let release
  let started
  const entered = new Promise(resolve => { started = resolve })
  f.options.beforeWithdraw = async () => { started(); await new Promise(resolve => { release = resolve }) }
  const c = f.controller()
  const run = c.run(f.request)
  await entered
  c.cancel('disconnect')
  assert.equal(c.isBusy(), true)
  await assert.rejects(c.recover(), /busy/)
  await assert.rejects(c.run(f.request), /busy/)
  let lockReleased = false
  const waiter = f.warehouse.withWarehouseLock(() => { lockReleased = true })
  await Promise.resolve(); assert.equal(lockReleased, false)
  release()
  await assert.rejects(run, /disconnect/)
  await waiter
  assert.equal(c.isBusy(), false)
  assert.equal(c.ledger.pending('bot-a')[0].phase, 'withdrawing')
  assert.equal((await c.recover()).status, 'failed')
  assert.equal(f.withdrawals, 1)
})

test('death-lost withdrawal is retained with concrete evidence and cannot release reservation', async t => {
  const f = fixture({ withdrawError: true }); t.after(() => f.close())
  f.options.beforeWithdraw = async () => {}
  const take = f.warehouse.withdrawAllocationsLocked
  f.warehouse.withdrawAllocationsLocked = async (...args) => {
    try { return await take(...args) } finally { f.player.slots.fill(null); f.sync() }
  }
  const c = f.controller()
  await assert.rejects(c.run(f.request), error => error.recoveryRequired && /conservation/.test(error.recoveryError.message))
  const op = c.ledger.pending('bot-a')[0]
  assert.equal(op.phase, 'withdrawing')
  assert.ok(op.data.withdrawalIntent.chests.length)
  assert.ok(op.data.observation.message)
  assert.equal(f.db.getCraftAvailableItems('alice').some(row => row.itemKey === f.request.items[0].itemKey), false)
})

test('return failure retries exactly one verified product and retained original baselines', async t => {
  const f = fixture({ refuseReturn: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request), error => error.recoveryRequired)
  const old = c.ledger.pending('bot-a')[0]
  assert.equal(old.phase, 'returning')
  const product = old.data.product
  assert.equal(f.db.getBalance('alice', product.itemKey), 0)
  f.options.refuseReturn = false
  const restarted = f.controller()
  const result = await restarted.recover()
  assert.equal(result.status, 'failed')
  assert.equal(f.db.getBalance('alice', product.itemKey), 1)
  assert.equal(f.withdrawals, 1)
  assert.equal((await restarted.recover()).status, 'empty')
  const proof = JSON.parse(f.db.db.prepare('SELECT proof_json AS proof FROM packing_batches').get().proof)
  assert.deepEqual(proof.returnIntent, old.data.returnIntent)
})

test('empty inventory without named barrel gain never becomes a credited return', async t => {
  const f = fixture({ refuseReturn: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request))
  const op = c.ledger.pending('bot-a')[0]
  f.player.slots.fill(null); f.sync(); f.options.refuseReturn = false
  await assert.rejects(c.recover(), /conserve/)
  assert.equal(f.db.getBalance('alice', op.data.product.itemKey), 0)
  assert.equal(c.ledger.pending('bot-a').length, 1)
})

test('saved stored proof settles once despite ordinary later destination changes', async t => {
  const f = fixture(); t.after(() => f.close())
  const c = f.controller()
  const settle = c.ledger.settleBatch.bind(c.ledger)
  c.ledger.settleBatch = () => { throw new Error('db unavailable') }
  await assert.rejects(c.run(f.request))
  const saved = c.ledger.pending('bot-a')[0]
  assert.equal(saved.phase, 'stored')
  for (const receipt of saved.data.storedProof.chests) f.barrels.set(receipt.chestId, Array(27).fill(null))
  c.ledger.settleBatch = settle
  assert.equal((await c.recover()).status, 'completed')
  assert.equal(f.db.getBalance('alice', saved.data.product.itemKey), 1)
  assert.equal((await c.recover()).status, 'empty')
})

test('commit-before-response restart does not repeat a batch conversion', async t => {
  const f = fixture(); t.after(() => f.close())
  const c = f.controller()
  const settle = c.ledger.settleBatch.bind(c.ledger)
  c.ledger.settleBatch = (...args) => { settle(...args); c.cancel('process stopped after commit'); throw new Error('response lost') }
  await assert.rejects(c.run(f.request), /response lost/)
  assert.equal((await f.controller().recover()).status, 'completed')
  assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM packing_batches').get().n, 1)
  assert.equal(f.withdrawals, 1)
})

test('a recovered full product remains failed if crash occurs after recovery settlement', async t => {
  const f = fixture({ refuseReturn: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request))
  f.options.refuseReturn = false
  const settle = c.ledger.settleBatch.bind(c.ledger)
  c.ledger.settleBatch = (...args) => { settle(...args); throw new Error('response lost') }
  await assert.rejects(c.recover(), /response lost/)
  assert.equal((await f.controller().recover()).status, 'failed')
})


test('actual transfer before a lost response is recovered from named barrel gains without a second product', async t => {
  const f = fixture({ noReturnResponse: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request), error => error.recovery?.status === 'failed' && !error.recoveryRequired)
  assert.equal(f.shifts, 1)
  assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM packing_batches').get().n, 1)
  assert.equal(f.player.items().length, 0)
})

test('returning cannot recover when a named barrel is missing even with an empty player', async t => {
  const f = fixture({ refuseReturn: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request))
  const op = c.ledger.pending('bot-a')[0]
  f.player.slots.fill(null); f.sync()
  f.barrels.delete(op.data.returnIntent.chests[0].chestId)
  await assert.rejects(c.recover(), /missing barrel/)
  assert.equal(f.db.getBalance('alice', op.data.product.itemKey), 0)
})

test('raw cleanup spans destinations without shrinking durable held or replacing baselines', async t => {
  const f = fixture({ withdrawLimit: 21, withdrawError: true }); t.after(() => f.close())
  const fill = Array.from({ length: 26 }, () => item('dirt', 64))
  f.barrels.delete('destination')
  f.addChest('destination', fill)
  f.addChest('destination-two')
  f.warehouse.nextDepositChest = skipped => f.db.listChests().find(chest => chest.chestId.startsWith('destination') && !skipped.has(chest.chestId))
  const c = f.controller()
  await assert.rejects(c.run(f.request), error => error.recovery?.status === 'failed')
  const record = f.db.db.prepare('SELECT data_json AS data FROM packing_operations').get()
  const data = JSON.parse(record.data)
  assert.equal(data.returnIntent.chests.length, 2)
  assert.deepEqual(data.returnIntent.returned, data.withdrawalProof.withdrawn)
  assert.equal(data.storedProof.chests.length, 2)
  assert.equal(f.db.getBalance('alice', f.request.items[0].itemKey), 20)
})

test('unrelated destination mutation is not accepted as a return receipt', async t => {
  const f = fixture({ afterShift: menu => menu.updateSlot(26, item('dirt')) }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request), error => error.recoveryRequired)
  const op = c.ledger.pending('bot-a')[0]
  assert.equal(f.db.getBalance('alice', op.data.product.itemKey), 0)
  assert.ok(op.data.observation.message.includes('conserve'))
})

test('unchanged empty shell recovery returns raw batch and makes no conversion', async t => {
  const f = fixture({ packLimit: 0, executeError: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request), error => error.recovery?.status === 'failed')
  assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM packing_batches').get().n, 0)
  assert.equal(f.db.getBalance('alice', f.request.items[0].itemKey), 20)
})

test('an authenticated replacement request cleans up only the immutable old owner', async t => {
  const f = fixture({ refuseReturn: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request))
  const old = c.ledger.pending('bot-a')[0]
  f.options.refuseReturn = false
  const next = f.controller({ validateOwner: (owner, actor) => { assert.equal(owner.uuid, 'bob'); assert.equal(actor, 'Bob') } })
  await assert.rejects(next.run({ ...f.request, owner: { uuid: 'bob', username: 'Bob', scope: 'personal' }, actor: 'Bob' }), /Insufficient/)
  assert.equal(f.db.getBalance('alice', old.data.product.itemKey), 1)
  assert.equal(f.db.getBalance('bob', old.data.product.itemKey), 0)
  assert.equal(next.ledger.get(old.id).state, 'failed')
})

test('real executor, ledger, catalog and serialized return integrate a durable sword product', async t => {
  const f = fixture(); t.after(() => f.close())
  const result = await f.controller({ executor: undefined }).run(f.request)
  assert.equal(result.status, 'completed')
  assert.equal(f.db.getOwnerShulkersContainingItemKey('alice', row(item('diamond_sword')).itemKey).length, 1)
  assert.equal(f.shifts, 3)
})

test('normal and recovery calls return home before their registered barrel work', async t => {
  const f = fixture({ refuseReturn: true }); t.after(() => f.close())
  let atHome = false
  let homes = 0
  f.warehouse.goHomeIfAway = async () => { atHome = true; homes++ }
  f.options.beforeOpen = async () => { assert.equal(atHome, true) }
  const c = f.controller()
  await assert.rejects(c.run(f.request), error => error.recoveryRequired)
  atHome = false; f.options.refuseReturn = false
  assert.equal((await c.recover()).status, 'failed')
  assert.ok(homes >= 2)
})

test('malformed diagnostic inventory cannot replace the original failure or erase its journal', async t => {
  const f = fixture({ refuseReturn: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request))
  const op = c.ledger.pending('bot-a')[0]
  c.catalog = { aggregatePrismarineItems: () => { throw new Error('unknown physical item') } }
  const original = new Error('original failure')
  assert.doesNotThrow(() => c.mark(op.id, original))
  const after = c.ledger.get(op.id)
  assert.equal(after.message, 'original failure')
  assert.equal(after.data.observation.inventoryError, 'unknown physical item')
  assert.equal(after.phase, op.phase)
})

'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { BotTaskPool } = require('../src/taskPool')
const Service = require('../src/service')
const { fixture } = require('./helpers/packing-server')

test('same-bot replacement is unavailable to every task until old packing calls drain, other bots eligible', async () => {
  const pool = new BotTaskPool()
  const old = { botId: 'a' }
  const replacement = { botId: 'a', ready: true }
  const other = { botId: 'b', ready: true }
  pool.inFlight.set(old, { type: 'packing' })
  pool.workers.add(replacement); pool.workers.add(other)
  assert.equal(pool.eligibleWorkerForTask({ type: 'deposit' }), other)
  assert.equal(pool.eligibleWorkerForTask({ type: 'packing_recovery', stickyWorker: old }), null)
  assert.equal(pool.hasInFlightPacking('a'), true)
  let drained = false
  const wait = pool.waitForPackingDrain('a').then(() => { drained = true })
  await Promise.resolve(); assert.equal(drained, false)
  pool.inFlight.delete(old); pool.resolvePackingDrainWaiters(); await wait
  assert.equal(pool.eligibleWorkerForTask({ type: 'packing_recovery', stickyWorker: old }), replacement)
})

test('service internal packing is lazy, nonexclusive, owner validated and no public handler', async t => {
  const f = fixture(); t.after(() => f.close())
  const service = new Service(f.bot, f.db, f.catalog, f.warehouse, f.config)
  service.getPlayer = username => ({ uuid: username === 'Alice' ? 'alice' : 'other', username })
  assert.equal(service.packingController, undefined)
  const c = service.getPackingController()
  assert.equal(service.getPackingController(), c)
  assert.throws(() => c.validateOwner(f.owner, 'Other'))
  let queued
  service.taskPool = { enqueue: task => { queued = task; return 'queued' } }
  assert.equal(service.enqueuePacking(f.request), 'queued')
  assert.equal(queued.type, 'packing')
  assert.notEqual(queued.exclusive, true)
  assert.equal(service.handlePacking, undefined)
})

test('packing lifecycle is inert without own pending record', async t => {
  const f = fixture(); t.after(() => f.close())
  const service = new Service(f.bot, f.db, f.catalog, f.warehouse, f.config)
  service.getPackingController = () => { throw new Error('must remain lazy') }
  assert.equal(await service.recoverOwnPacking(), null)
})

test('pending-owner admin remap/deletion rejected atomically, cosmetic and other owner changes allowed', t => {
  const f = fixture(); t.after(() => f.close())
  f.db.createCustomWarehouse('Team', 'alice', 'Alice')
  f.db.createCustomWarehouse('Other', 'other', 'Other')
  const owned = f.db.getOwnerBalances('alice').map(row => ({ ...row, ownerUuid: 'vault:team' }))
  f.db.addBalanceItems('vault:team', owned)
  const { planPacking } = require('../src/packing/planner')
  const Ledger = require('../src/packing/ledger')
  const ledger = new Ledger(f.db)
  const plan = planPacking({ ownerUuid: 'vault:team', items: f.request.items, availableItems: owned, emptyBoxes: owned.filter(row => f.catalog.isShulkerBox(row.itemId)), catalog: f.catalog })
  ledger.begin({ id: 'packing:admin', botId: 'bot-a', owner: { uuid: 'vault:team', username: 'Team', scope: 'custom' }, actor: 'Alice', plan })
  assert.throws(() => f.db.renameCustomWarehouse('Team', 'New Team'), /packing/i)
  assert.equal(f.db.getCustomWarehouse('New Team'), null)
  const before = f.db.getOwnerBalances('vault:team')
  assert.throws(() => f.db.deleteCustomWarehouseToMomo('Team', 'admin'), /packing/i)
  assert.deepEqual(f.db.getOwnerBalances('vault:team'), before)
  assert.equal(f.db.renameCustomWarehouse('Team', 'TEAM').name, 'TEAM')
  assert.equal(f.db.renameCustomWarehouse('Other', 'Else').name, 'Else')
})



test('ordinary same-bot work cannot repurpose packing residue; clean other bots remain usable', async t => {
  const f = fixture({ refuseReturn: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request))
  const service = new Service(f.bot, f.db, f.catalog, f.warehouse, f.config)
  service.botId = 'bot-a'; service.getPackingController = () => c
  let ran = false
  await assert.rejects(service.runExclusive('Bob', 'withdraw', async () => { ran = true }))
  assert.equal(ran, false)
  service.botId = 'bot-other'
  assert.equal(await service.runExclusive('Bob', 'deposit', async () => 'ordinary'), 'ordinary')
})

test('unresolved missing inventory does not blanket-block ordinary work after authoritative clean proof', async t => {
  const f = fixture({ refuseReturn: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request))
  f.player.slots.fill(null); f.sync()
  const service = new Service(f.bot, f.db, f.catalog, f.warehouse, f.config)
  service.botId = 'bot-a'; service.getPackingController = () => c
  assert.equal(await service.runExclusive('Bob', 'withdraw', async () => 'allowed'), 'allowed')
  assert.equal(f.db.hasPendingPacking('bot-a'), true)
})

test('spawn waits for old owning-bot packing drain and rechecks connection before touching inventory', async t => {
  const f = fixture({ refuseReturn: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request))
  let release
  const pool = { hasInFlightPacking: () => true, waitForPackingDrain: () => new Promise(resolve => { release = resolve }) }
  const service = new Service(f.bot, f.db, f.catalog, f.warehouse, f.config, pool)
  service.botId = 'bot-a'
  service.getPackingController = () => { throw new Error('must not touch old inventory') }
  const spawn = service.recoverPersistedTaskOnSpawn()
  await Promise.resolve()
  service.connectionInvalidated = true
  release()
  await assert.rejects(spawn, /连接已失效/)
})

test('respawn routes pending packing before generic death cleanup and cancels packing on invalidation', async t => {
  const f = fixture({ refuseReturn: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request))
  const service = new Service(f.bot, f.db, f.catalog, f.warehouse, f.config)
  service.botId = 'bot-a'; service.getPackingController = () => c
  service.deathContext = { type: 'withdraw', username: 'Bob' }
  service.warehouse.depositInventoryWithoutBalance = () => { throw new Error('generic cleanup must not run') }
  await assert.rejects(service.handleRespawn())
  assert.equal(service.recoveringFromDeath, false)
  let cancelled = false
  service.packingController = { cancel: () => { cancelled = true } }
  service.invalidateConnection('disconnect')
  assert.equal(cancelled, true)
})

test('packing authorization cannot substitute a different vault UUID behind an allowed member name', t => {
  const f = fixture(); t.after(() => f.close())
  f.db.createCustomWarehouse('Team', 'alice', 'Alice')
  f.db.createCustomWarehouse('Other', 'bob', 'Bob')
  const service = new Service(f.bot, f.db, f.catalog, f.warehouse, f.config)
  service.getPlayer = () => ({ uuid: 'alice', username: 'Alice' })
  assert.throws(() => service.getPackingController().validateOwner({ uuid: 'vault:other', scope: 'custom', vaultName: 'Team' }, 'Alice'), /owner|归属/i)
})

test('a clean pending journal does not hijack newly acquired ordinary inventory during that task', async t => {
  const f = fixture({ refuseReturn: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request))
  f.player.slots.fill(null); f.sync()
  const service = new Service(f.bot, f.db, f.catalog, f.warehouse, f.config)
  service.botId = 'bot-a'; service.getPackingController = () => c
  let calls = 0
  const recover = service.recoverOwnPacking.bind(service)
  service.recoverOwnPacking = async () => { calls++; return recover() }
  let depositedOwner
  f.warehouse.depositInventoryForOwner = async uuid => {
    depositedOwner = uuid
    const deposited = f.catalog.aggregatePrismarineItems(f.player.items())
    f.player.slots.fill(null); f.sync()
    return { deposited, leftover: [] }
  }
  const result = await service.runExclusive('Bob', 'withdraw', async () => {
    f.player.updateSlot(9, require('./helpers/packing-server').item('dirt')); f.sync()
    service.saveRecoveryTask('deposit', 'Bob', { uuid: 'bob', username: 'Bob', scope: 'personal' }, 'Bob')
    await service.flushResidual()
    return 'ordinary flush'
  })
  assert.equal(result, 'ordinary flush')
  assert.equal(depositedOwner, 'bob')
  assert.equal(calls, 1)
})

test('direct lifecycle recovery retains a same-bot promise lease across unregister and replacement', async () => {
  const pool = new BotTaskPool()
  const old = { botId: 'a' }
  const replacement = { botId: 'a', ready: true }
  const other = { botId: 'b', ready: true }
  let release
  const recovery = pool.withPackingRecoveryLease(old, () => new Promise(resolve => { release = resolve }))
  pool.workers.add(replacement); pool.workers.add(other)
  assert.equal(pool.hasInFlightPacking('a'), true)
  assert.equal(pool.eligibleWorkerForTask({ type: 'withdraw' }), other)
  let drained = false
  const wait = pool.waitForPackingDrain('a').then(() => { drained = true })
  await Promise.resolve(); assert.equal(drained, false)
  release(); await recovery; await wait
  assert.equal(pool.eligibleWorkerForTask({ type: 'withdraw' }), replacement)
})

test('service replacement waits for disconnected direct recovery network calls before its own recovery', async t => {
  const f = fixture({ refuseReturn: true }); t.after(() => f.close())
  const c = f.controller()
  await assert.rejects(c.run(f.request))
  const pool = new BotTaskPool()
  const old = new Service(f.bot, f.db, f.catalog, f.warehouse, f.config, pool)
  old.botId = 'bot-a'; old.packingController = c
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let release
  f.options.beforeOpen = async () => { entered(); await new Promise(resolve => { release = resolve }) }
  const draining = old.recoverOwnPacking()
  await started
  old.invalidateConnection('old disconnected')
  const replacementWarehouse = Object.create(f.warehouse)
  replacementWarehouse.connectionAbortController = new AbortController()
  const replacement = new Service(f.bot, f.db, f.catalog, replacementWarehouse, f.config, pool)
  replacement.botId = 'bot-a'
  replacement.packingController = f.controller({ warehouse: replacementWarehouse })
  let done = false
  const recovery = replacement.recoverOwnPacking().then(result => { done = true; return result })
  await Promise.resolve(); assert.equal(done, false)
  assert.equal(pool.hasInFlightPacking('bot-a'), true)
  f.options.beforeOpen = null; f.options.refuseReturn = false
  release()
  await assert.rejects(draining, /old disconnected/)
  assert.equal((await recovery).status, 'failed')
  assert.equal(pool.hasInFlightPacking('bot-a'), false)
})

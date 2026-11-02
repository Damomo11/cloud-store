const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const StoreDb = require('../../src/db')
const CraftLedger = require('../../src/craft/ledger')
const { DEFAULT_CONFIG } = require('../../src/config')

const owner = { uuid: 'alice', username: 'Alice', scope: 'personal', vaultName: '' }
const plank = { itemKey: 'oak|plain', itemId: 'minecraft:oak_planks', displayName: '橡木木板', nbtJson: '', metaJson: '' }
const named = { ...plank, itemKey: 'oak|named', nbtJson: '{"name":"souvenir"}' }
const stick = { itemKey: 'stick|plain', itemId: 'minecraft:stick', displayName: '木棍', nbtJson: '', metaJson: '' }
const qty = (item, amount) => ({ ...item, amount })

function fixture () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-craft-ledger-'))
  const dbPath = path.join(directory, 'store.sqlite')
  const db = new StoreDb(dbPath, structuredClone(DEFAULT_CONFIG))
  const ledger = new CraftLedger(db)
  db.addBalanceItems(owner.uuid, [qty(plank, 8), qty(named, 3)])
  return { db, dbPath, ledger, close () { if (db.db.open) db.close(); fs.rmSync(directory, { recursive: true, force: true }) } }
}

function input (overrides = {}) {
  return { id: 'craft:1', botId: 'bot-a', owner, actor: 'Alice', target: { itemId: stick.itemId, amount: 8 },
    allocations: [qty(plank, 4)], data: { held: [], pending: null, stepIndex: 0, plan: { steps: 2 } }, ...overrides }
}

function prepare (f, stepId = 'step-1', before = [qty(plank, 4)], consumed = [qty(plank, 2)], produced = [qty(stick, 4)]) {
  return f.ledger.checkpoint('craft:1', 'crafting', { ...f.ledger.get('craft:1').data, held: before,
    pending: { stepId, before, expectedConsumed: consumed, expectedProduced: produced.map(({ itemId, amount }) => ({ itemId, amount })) } })
}

const stepData = () => ({ held: [qty(plank, 2), qty(stick, 4)], pending: null, stepIndex: 1 })
const confirm = f => f.ledger.confirm('craft:1', 'step-1', [qty(plank, 2)], [qty(stick, 4)], stepData())

test('begin reserves the exact owner and itemKey without changing balances', () => {
  const f = fixture()
  try {
    f.db.addBalanceItems('vault:team', [qty(plank, 6)])
    const op = f.ledger.begin(input())
    assert.equal(op.state, 'running')
    assert.equal(op.phase, 'ready')
    assert.deepEqual(op.owner, owner)
    assert.deepEqual(op.data, input().data)
    assert.equal(f.db.getBalance(owner.uuid, plank.itemKey), 8)
    assert.equal(f.db.getOwnerItemsByItemKey(owner.uuid, plank.itemKey)[0].amount, 4)
    assert.equal(f.db.getOwnerItemsByItemKey(owner.uuid, named.itemKey)[0].amount, 3)
    assert.equal(f.db.getOwnerItemsByItemKey('vault:team', plank.itemKey)[0].amount, 6)
    assert.equal(f.ledger.pending('bot-a').length, 1)
    assert.equal(f.ledger.pending('bot-b').length, 0)
  } finally { f.close() }
})

test('begin checks existing reservations atomically and rejects foreign owner allocations', () => {
  const f = fixture()
  try {
    f.db.reserveInventory('other-task', [{ ...qty(plank, 6), ownerUuid: owner.uuid }])
    assert.throws(() => f.ledger.begin(input()), /占用|available|reservation/i)
    assert.equal(f.ledger.get('craft:1'), null)
    assert.throws(() => f.ledger.begin(input({ allocations: [{ ...qty(named, 1), ownerUuid: 'other' }] })), /owner/i)
  } finally { f.close() }
})

test('begin rolls back earlier reservations when a later allocation cannot be reserved', () => {
  const f = fixture()
  try {
    assert.throws(() => f.ledger.begin(input({ allocations: [qty(plank, 2), qty(named, 4)] })), /占用|available|reservation/i)
    assert.equal(f.ledger.get('craft:1'), null)
    assert.equal(f.db.getOwnerItemsByItemKey(owner.uuid, plank.itemKey)[0].amount, 8)
  } finally { f.close() }
})

test('confirm is idempotent and reserves exact output keys until physical return', () => {
  const f = fixture()
  try {
    f.ledger.begin(input())
    prepare(f)
    const op = confirm(f)
    assert.equal(op.phase, 'storing')
    assert.deepEqual(op.data, stepData())
    assert.equal(f.db.getBalance(owner.uuid, plank.itemKey), 6)
    assert.equal(f.db.getBalance(owner.uuid, stick.itemKey), 4)
    assert.equal(f.db.getOwnerItemsByItemKey(owner.uuid, stick.itemKey).length, 0)
    assert.deepEqual(confirm(f), op)
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM craft_batches').get().n, 1)
    assert.deepEqual(f.db.db.prepare('SELECT type, deduction_key AS key FROM transactions ORDER BY id').all(), [
      { type: 'craft_consume', key: 'craft:1:step-1:consume' }, { type: 'craft_produce', key: 'craft:1:step-1:produce' }
    ])
    assert.throws(() => f.ledger.confirm('craft:1', 'step-1', [qty(plank, 1)], [qty(stick, 4)], stepData()), /idempot|mismatch/i)
  } finally { f.close() }
})

test('partial batches settle independently and finishing records one summary', () => {
  const f = fixture()
  try {
    f.ledger.begin(input())
    prepare(f)
    confirm(f)
    prepare(f, 'step-2', stepData().held)
    f.ledger.confirm('craft:1', 'step-2', [qty(plank, 2)], [qty(stick, 4)], { held: [qty(stick, 8)], pending: null, stepIndex: 2 })
    assert.throws(() => f.ledger.finish('craft:1', 'complete'), /held|pending|return/i)
    f.ledger.checkpoint('craft:1', 'stored', { held: [], pending: null, stepIndex: 2 })
    assert.equal(f.ledger.finish('craft:1', 'complete', 'returned').state, 'completed')
    assert.equal(f.ledger.pending().length, 0)
    assert.equal(f.db.getOwnerItemsByItemKey(owner.uuid, stick.itemKey)[0].amount, 8)
    assert.throws(() => f.ledger.confirm('craft:1', 'late-step', [], [], { held: [], pending: null }), /already completed/i)
    f.ledger.finish('craft:1', 'complete', 'retry')
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'craft'").get().n, 1)
  } finally { f.close() }
})

test('confirm rejects unprepared steps and mismatched snapshots or recipe deltas', () => {
  const f = fixture()
  try {
    f.ledger.begin(input())
    assert.throws(() => confirm(f), /prepared|pending|phase/i)
    prepare(f)
    assert.throws(() => f.ledger.confirm('craft:1', 'wrong', [qty(plank, 2)], [qty(stick, 4)], stepData()), /pending/i)
    assert.throws(() => f.ledger.confirm('craft:1', 'step-1', [qty(named, 2)], [qty(stick, 4)], stepData()), /consumed/i)
    assert.throws(() => f.ledger.confirm('craft:1', 'step-1', [qty(plank, 2)], [qty(stick, 5)], stepData()), /produced/i)
    assert.throws(() => f.ledger.confirm('craft:1', 'step-1', [qty(plank, 2)], [qty(stick, 4)], { held: [qty(stick, 4)] }), /after|held/i)
    assert.throws(() => f.ledger.confirm('craft:1', 'step-1', [qty(plank, 2)], [qty(stick, 4)], {
      after: [qty(stick, 8)], held: [qty(stick, 4)]
    }), /after.*held|held.*after/i)
    const op = f.ledger.get('craft:1')
    op.data.pending.before = [qty(plank, 3)]
    f.ledger.checkpoint('craft:1', 'crafting', op.data)
    assert.throws(() => confirm(f), /before/i)
    assert.equal(f.db.getBalance(owner.uuid, plank.itemKey), 8)
    assert.equal(f.db.getBalance(owner.uuid, stick.itemKey), 0)
  } finally { f.close() }
})

test('prepared produced itemKeys prevent same itemId variants from being substituted', () => {
  const f = fixture()
  const variantStick = { ...stick, itemKey: 'stick|named', nbtJson: '{"name":"souvenir"}' }
  try {
    f.ledger.begin(input())
    f.ledger.checkpoint('craft:1', 'crafting', { ...f.ledger.get('craft:1').data, held: [qty(plank, 4)],
      pending: { stepId: 'step-1', before: [qty(plank, 4)], expectedConsumed: [qty(plank, 2)], expectedProduced: [qty(stick, 4)] } })
    assert.throws(() => f.ledger.confirm('craft:1', 'step-1', [qty(plank, 2)], [qty(variantStick, 4)], {
      held: [qty(variantStick, 4)], pending: null, stepIndex: 1
    }), /produced/i)
    assert.equal(f.db.getBalance(owner.uuid, plank.itemKey), 8)
    assert.equal(f.db.getBalance(owner.uuid, variantStick.itemKey), 0)

    const operation = f.ledger.get('craft:1')
    f.ledger.checkpoint('craft:1', 'crafting', { ...operation.data,
      pending: { ...operation.data.pending, expectedProduced: [qty(stick, 2), { itemId: stick.itemId, amount: 2 }] } })
    assert.throws(() => f.ledger.confirm('craft:1', 'step-1', [qty(plank, 2)], [qty(stick, 4)], stepData()), /all include itemKey/i)
  } finally { f.close() }
})

test('confirm carries the craft operation through the balance transaction context', () => {
  const f = fixture()
  try {
    f.ledger.begin(input())
    prepare(f)
    const contexts = []
    const adjustBalance = f.db.adjustBalance.bind(f.db)
    f.db.adjustBalance = (...args) => {
      contexts.push(f.db.transactionContext.getStore())
      return adjustBalance(...args)
    }
    f.db.transactionContext.run({ botId: 'bot-a', botName: 'Bot A' }, () => confirm(f))
    assert.equal(contexts.length, 2)
    assert.ok(contexts.every(context => context?.craftOperationId === 'craft:1'))
    assert.ok(contexts.every(context => context?.botId === 'bot-a' && context?.botName === 'Bot A'))
  } finally { f.close() }
})

test('confirm cannot consume spare owner balance outside this operation reservation', () => {
  const f = fixture()
  try {
    f.ledger.begin(input({ allocations: [qty(plank, 1)] }))
    prepare(f, 'step-1', [qty(plank, 2)])
    assert.throws(() => f.ledger.confirm('craft:1', 'step-1', [qty(plank, 2)], [qty(stick, 4)], { held: [qty(stick, 4)] }), /reservation/i)
    assert.equal(f.db.getBalance(owner.uuid, plank.itemKey), 8)
  } finally { f.close() }
})

test('SQL failure rolls back balance, reservations, batch and transaction changes', () => {
  const f = fixture()
  try {
    f.ledger.begin(input())
    prepare(f)
    f.db.db.exec("CREATE TRIGGER fail_craft_output BEFORE INSERT ON transactions WHEN NEW.type = 'craft_produce' BEGIN SELECT RAISE(ABORT, 'test craft failure'); END")
    assert.throws(() => confirm(f), /test craft failure/)
    assert.equal(f.db.getBalance(owner.uuid, plank.itemKey), 8)
    assert.equal(f.db.getBalance(owner.uuid, stick.itemKey), 0)
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM craft_batches').get().n, 0)
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 0)
    assert.equal(f.ledger.get('craft:1').data.pending.stepId, 'step-1')
    assert.equal(f.db.db.prepare('SELECT amount FROM inventory_reservations WHERE reservation_id = ?').get('craft:1').amount, 4)
  } finally { f.close() }
})

test('quantities must remain positive safe integers after grouping duplicate keys', () => {
  const f = fixture()
  try {
    for (const amount of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.ledger.begin(input({ allocations: [qty(plank, amount)] })), /integer/i)
    assert.throws(() => f.ledger.begin(input({ allocations: [qty(plank, Number.MAX_SAFE_INTEGER), qty(plank, 1)] })), /integer/i)
    assert.equal(f.ledger.pending().length, 0)
  } finally { f.close() }
})

test('recovery preserves held/pending data and reservation until physical return', () => {
  const f = fixture()
  try {
    f.ledger.begin(input())
    const prepared = prepare(f)
    const op = f.ledger.markRecovery('craft:1', 'connection lost')
    assert.equal(op.phase, 'recovery_required')
    assert.deepEqual(op.data, prepared.data)
    assert.equal(f.ledger.pending().length, 1)
    assert.equal(f.db.getOwnerItemsByItemKey(owner.uuid, plank.itemKey)[0].amount, 4)
    assert.throws(() => f.ledger.finish('craft:1', 'failed'), /held|pending|return/i)
    f.ledger.checkpoint('craft:1', 'stored', { held: [], pending: null })
    f.ledger.finish('craft:1', 'failed', 'materials returned')
    assert.equal(f.db.getOwnerItemsByItemKey(owner.uuid, plank.itemKey)[0].amount, 8)
  } finally { f.close() }
})

test('reopen retains pending craft output reservations while releasing ordinary stale reservations', () => {
  const f = fixture()
  let reopened
  try {
    f.ledger.begin(input())
    prepare(f)
    confirm(f)
    f.ledger.markRecovery('craft:1', 'restart')
    f.db.reserveInventory('ordinary-stale', [{ ...qty(named, 1), ownerUuid: owner.uuid }])
    f.db.close()
    reopened = new StoreDb(f.dbPath, structuredClone(DEFAULT_CONFIG))
    const ledger = new CraftLedger(reopened)
    assert.equal(ledger.pending('bot-a').length, 1)
    assert.deepEqual(ledger.get('craft:1').data, stepData())
    assert.equal(reopened.getOwnerItemsByItemKey(owner.uuid, stick.itemKey).length, 0)
    assert.equal(reopened.getOwnerItemsByItemKey(owner.uuid, named.itemKey)[0].amount, 3)
    ledger.confirm('craft:1', 'step-1', [qty(plank, 2)], [qty(stick, 4)], stepData())
    assert.equal(reopened.getBalance(owner.uuid, stick.itemKey), 4)
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM craft_batches').get().n, 1)
  } finally { if (reopened?.db.open) reopened.close(); f.close() }
})

test('corrupt persisted operation data fails closed instead of releasing reservations', () => {
  const f = fixture()
  try {
    f.ledger.begin(input())
    f.db.db.prepare('UPDATE craft_operations SET data_json = ? WHERE id = ?').run('{', 'craft:1')
    assert.throws(() => f.ledger.get('craft:1'), /invalid persisted operation data/i)
    assert.throws(() => f.ledger.finish('craft:1', 'complete'), /invalid persisted operation data/i)
    assert.equal(f.db.db.prepare('SELECT amount FROM inventory_reservations WHERE reservation_id = ?').get('craft:1').amount, 4)
    f.db.db.prepare('UPDATE craft_operations SET data_json = ? WHERE id = ?')
      .run('{"held":"unknown","pending":null,"stepIndex":0}', 'craft:1')
    assert.throws(() => f.ledger.get('craft:1'), /held.*array/i)
  } finally { f.close() }
})

test('pending craft blocks direct identity, warehouse, and inventory clearing mutations', () => {
  const f = fixture()
  try {
    f.db.upsertPlayer('uuid-primary', 'TwinGuy')
    f.db.upsertPlayer('uuid-secondary', 'TwinGuy')
    f.db.createPersonalWarehouse(owner.uuid, owner.username)
    f.db.createCustomWarehouse('TeamVault', owner.uuid, owner.username)
    f.ledger.begin(input())

    const blocked = /合成仍在进行|pending craft/i
    assert.throws(() => f.db.mergePlayerIdentities('uuid-primary', 'uuid-secondary'), blocked)
    assert.throws(() => f.db.renameCustomWarehouse('TeamVault', 'RenamedVault'), blocked)
    assert.throws(() => f.db.deletePersonalWarehouseToMomo(owner.uuid), blocked)
    assert.throws(() => f.db.deleteCustomWarehouseToMomo('TeamVault'), blocked)
    assert.throws(() => f.db.deleteOwnerWarehouseToMomo(owner.uuid, owner.username, 'personal', 'Admin', () => {}), blocked)
    assert.throws(() => f.db.clearInventoryData(), blocked)

    assert.ok(f.db.hasPersonalWarehouse(owner.uuid))
    assert.ok(f.db.getCustomWarehouse('TeamVault'))
    assert.equal(f.db.getBalance(owner.uuid, plank.itemKey), 8)
    assert.equal(f.ledger.pending().length, 1)
  } finally { f.close() }
})

test('pending craft blocks direct catalog item-key canonicalization', () => {
  const f = fixture()
  try {
    f.db.catalog = { canonicalizeStoredItem: value => ({ ...value, itemKey: 'oak|canonical' }) }
    f.ledger.begin(input())
    assert.throws(() => f.db.canonicalizeItemKeys(), /合成仍在进行|pending craft/i)
    assert.equal(f.db.getBalance(owner.uuid, plank.itemKey), 8)
    assert.equal(f.db.getBalance(owner.uuid, 'oak|canonical'), 0)
    assert.equal(f.db.getItemByKey(plank.itemKey).itemKey, plank.itemKey)
  } finally { f.close() }
})

test('startup and explicit offline identity merges wait for pending craft operations', () => {
  const f = fixture()
  let reopened
  const mojangUuid = 'eea2e783-d003-468b-a831-33d5185cde5e'
  const offlineUuid = 'b419bf89-1f25-3fd5-bc6a-ede63b0da311'
  try {
    f.db.upsertPlayer(mojangUuid, 'TwinGuy')
    f.db.db.prepare("INSERT INTO players (uuid, username, last_seen_at) VALUES (?, 'TwinGuy', CURRENT_TIMESTAMP)").run(offlineUuid)
    f.db.addBalanceItems(offlineUuid, [qty(plank, 7)])
    f.ledger.begin(input())
    assert.equal(f.db.listOfflineUuidPairsToMerge().length, 1)
    assert.deepEqual(f.db.autoMergeOfflineIdentities(), [])
    assert.equal(f.db.getBalance(offlineUuid, plank.itemKey), 7)

    f.db.close()
    reopened = new StoreDb(f.dbPath, structuredClone(DEFAULT_CONFIG))
    const reopenedLedger = new CraftLedger(reopened)
    assert.equal(reopenedLedger.pending().length, 1)
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM players WHERE uuid = ?').get(offlineUuid).n, 1)
    assert.equal(reopened.getBalance(offlineUuid, plank.itemKey), 7)
    assert.equal(reopened.getBalance(mojangUuid, plank.itemKey), 0)
  } finally { if (reopened?.db.open) reopened.close(); f.close() }
})

test('legacy complete operations are terminal for pending guards and confirmations', () => {
  const f = fixture()
  try {
    f.ledger.begin(input({ allocations: [] }))
    f.db.db.prepare("UPDATE craft_operations SET state = 'complete', phase = 'complete' WHERE id = ?").run('craft:1')
    assert.equal(f.db.hasPendingCraft(), false)
    assert.deepEqual(f.ledger.pending(), [])
    assert.throws(() => f.ledger.confirm('craft:1', 'late-step', [], [], { held: [], pending: null }), /already complete/i)
    assert.equal(f.db.adjustBalance(owner.uuid, plank.itemKey, 1), 9)
  } finally { f.close() }
})

test('terminal craft transition runs deferred catalog migration after all pending work clears', () => {
  const f = fixture()
  const legacy = { ...plank, itemKey: 'oak|legacy' }
  const canonical = { ...legacy, itemKey: 'oak|canonical' }
  let failMigration = false
  let canonicalizeCalls = 0
  let rebuildCalls = 0
  const catalog = {
    canonicalizeStoredItem: row => {
      canonicalizeCalls++
      if (failMigration) throw new Error('catalog unavailable')
      return row.itemKey === legacy.itemKey ? { ...canonical, amount: row.amount } : row
    }
  }
  try {
    f.db.addBalanceItems(owner.uuid, [qty(legacy, 5)])
    f.ledger.begin(input({ allocations: [qty(legacy, 1)] }))
    f.ledger.begin(input({ id: 'craft:waiting', botId: 'bot-b', allocations: [] }))
    const rebuild = f.db.rebuildShulkerContentIndex.bind(f.db)
    f.db.rebuildShulkerContentIndex = () => { rebuildCalls++; return rebuild() }
    assert.deepEqual(f.db.setCatalog(catalog), { deferred: true })
    assert.equal(f.db.catalogMigrationDeferred, true)
    assert.equal(f.db.getBalance(owner.uuid, legacy.itemKey), 5)
    assert.equal(f.db.getBalance(owner.uuid, canonical.itemKey), 0)
    f.ledger.finish('craft:1', 'complete', 'returned')
    assert.equal(canonicalizeCalls, 0)
    assert.equal(rebuildCalls, 0)

    failMigration = true
    f.ledger.finish('craft:waiting', 'complete', 'returned')
    assert.equal(f.db.catalogMigrationDeferred, true)
    assert.equal(f.db.getBalance(owner.uuid, legacy.itemKey), 5)
    assert.equal(f.db.getBalance(owner.uuid, canonical.itemKey), 0)

    failMigration = false
    f.ledger.finish('craft:waiting', 'complete', 'retry deferred catalog')
    assert.equal(f.db.catalogMigrationDeferred, false)
    assert.equal(rebuildCalls, 1)
    assert.equal(f.db.getBalance(owner.uuid, legacy.itemKey), 0)
    assert.equal(f.db.getBalance(owner.uuid, canonical.itemKey), 5)
    assert.equal(f.db.getItemByKey(legacy.itemKey), null)
    assert.equal(f.ledger.get('craft:1').reservations[0].itemKey, legacy.itemKey)
    const scansAfterMigration = canonicalizeCalls
    f.ledger.finish('craft:waiting', 'complete', 'ordinary retry')
    assert.equal(canonicalizeCalls, scansAfterMigration)
    assert.equal(rebuildCalls, 1)
  } finally { f.close() }
})

test('deferred offline identity merge runs after the last pending craft ends', () => {
  const f = fixture()
  const mojangUuid = 'eea2e783-d003-468b-a831-33d5185cde5e'
  const offlineUuid = 'b419bf89-1f25-3fd5-bc6a-ede63b0da311'
  try {
    f.db.upsertPlayer(mojangUuid, 'TwinGuy')
    f.db.db.prepare("INSERT INTO players (uuid, username, last_seen_at) VALUES (?, 'TwinGuy', CURRENT_TIMESTAMP)").run(offlineUuid)
    f.db.addBalanceItems(offlineUuid, [qty(plank, 7)])
    f.ledger.begin(input({ id: 'craft:pending-1', allocations: [] }))
    f.ledger.begin(input({ id: 'craft:pending-2', botId: 'bot-b', allocations: [] }))

    assert.deepEqual(f.db.autoMergeOfflineIdentities(), [])
    assert.equal(f.db.offlineIdentityMergeDeferred, true)
    f.ledger.finish('craft:pending-1', 'complete')
    assert.equal(f.db.getBalance(offlineUuid, plank.itemKey), 7)
    assert.equal(f.db.offlineIdentityMergeDeferred, true)

    const mergePlayerIdentities = f.db.mergePlayerIdentities.bind(f.db)
    let failMerge = true
    f.db.mergePlayerIdentities = (...args) => {
      if (failMerge) {
        failMerge = false
        throw new Error('identity migration unavailable')
      }
      return mergePlayerIdentities(...args)
    }
    f.ledger.finish('craft:pending-2', 'complete')
    assert.equal(f.db.offlineIdentityMergeDeferred, true)
    assert.equal(f.db.getBalance(offlineUuid, plank.itemKey), 7)
    f.ledger.finish('craft:pending-2', 'complete')
    assert.equal(f.db.offlineIdentityMergeDeferred, false)
    assert.equal(f.db.getBalance(offlineUuid, plank.itemKey), 0)
    assert.equal(f.db.getBalance(mojangUuid, plank.itemKey), 7)
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM players WHERE uuid = ?').get(offlineUuid).n, 0)
  } finally { f.close() }
})

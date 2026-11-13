'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const StoreDb = require('../src/db')
const ItemCatalog = require('../src/itemCatalog')
const { DEFAULT_CONFIG } = require('../src/config')
const { planPacking } = require('../src/packing/planner')
const catalog = new ItemCatalog('1.21.11')
const Item = require('prismarine-item')(catalog.mcData)
const owner = { uuid: 'alice', username: 'Alice', scope: 'personal', vaultName: '' }
const qty = (item, amount) => ({ ...item, amount })

function row (name, amount, components = []) {
  const item = new Item(catalog.mcData.itemsByName[name].id, amount)
  item.components = components
  return catalog.fromPrismarineItem(item)
}

function fixture (amount = 20) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'packing-ledger-'))
  const dbPath = path.join(directory, 'db.sqlite')
  const db = new StoreDb(dbPath, structuredClone(DEFAULT_CONFIG))
  db.setCatalog(catalog)
  const stone = row('stone', amount)
  const box = row('blue_shulker_box', 3, [{ type: 'custom_name', data: 'Alice box' }])
  db.addBalanceItems(owner.uuid, [stone, box])
  db.upsertChest({ chestId: 'return', x: 0, y: 64, z: 0, blockName: 'barrel' })
  const plan = planPacking({ ownerUuid: owner.uuid, items: [qty(stone, amount)], availableItems: [stone, box], emptyBoxes: [box], catalog })
  const PackingLedger = require('../src/packing/ledger')
  const ledger = new PackingLedger(db)
  return { db, dbPath, directory, ledger, stone, box, plan,
    input (overrides = {}) { return { id: 'packing:1', botId: 'bot-a', owner, actor: 'Alice', plan, ...overrides } },
    close () { if (db.db.open) db.close(); fs.rmSync(directory, { recursive: true, force: true }) } }
}

function product (f, amount = f.plan.boxes[0].inputs[0].amount, components = []) {
  return row('blue_shulker_box', 1, [
    { type: 'custom_name', data: 'Alice box' }, ...components,
    { type: 'container', data: { contents: Array.from({ length: Math.ceil(amount / 64) }, (_, slot) => ({ itemId: catalog.mcData.itemsByName.stone.id, itemCount: Math.min(64, amount - slot * 64), components: [], removeComponents: [] })) } }
  ])
}

function stored (f, result = product(f), inputs = [qty(f.stone, result ? catalog.extractShulkerContents(result)[0].amount : 1)]) {
  const current = f.ledger.get('packing:1')
  const returned = [qty(result, 1), ...current.plan.boxes[current.data.batchIndex].inputs.map(row => qty(row, row.amount - (inputs.find(input => input.itemKey === row.itemKey)?.amount || 0))).filter(row => row.amount > 0)]
  const data = { ...current.data, product: result, packedInputs: inputs, held: [result],
    returnIntent: { chests: [{ chestId: 'return', before: [] }], returned } }
  f.ledger.checkpoint('packing:1', 'returning', data)
  return f.ledger.checkpoint('packing:1', 'stored', { ...data, held: [],
    storedProof: { chests: [{ chestId: 'return', after: returned }], inventoryAfter: [] } })
}

test('begin atomically reserves exact owned planner allocations without balances changing', () => {
  const f = fixture()
  try {
    const op = f.ledger.begin(f.input())
    assert.equal(op.phase, 'ready')
    assert.equal(op.state, 'running')
    assert.deepEqual(op.data, { batchIndex: 0, held: [], product: null, packedInputs: [] })
    assert.deepEqual(op.plan, f.plan)
    assert.equal(f.db.getBalance(owner.uuid, f.stone.itemKey), 20)
    assert.equal(f.db.getOwnerItemsByItemKey(owner.uuid, f.stone.itemKey).length, 0)
    op.plan.boxes.length = 0
    assert.equal(f.ledger.get(op.id).plan.boxes.length, 1)
  } finally { f.close() }
})

test('begin rejects shortages, foreign owners, forged allocations and conflicting reused ids atomically', () => {
  const f = fixture()
  try {
    const forged = structuredClone(f.plan)
    forged.allocations[0].ownerUuid = 'other'
    assert.throws(() => f.ledger.begin(f.input({ plan: forged })), /owner/)
    forged.allocations[0].ownerUuid = owner.uuid
    forged.allocations[0].amount--
    assert.throws(() => f.ledger.begin(f.input({ plan: forged })), /plan|allocation/)
    f.db.reserveInventory('transient', [{ ...f.stone, ownerUuid: owner.uuid }])
    assert.throws(() => f.ledger.begin(f.input()), /占用|reservation|stock/)
    assert.equal(f.ledger.get('packing:1'), null)
    f.db.releaseInventoryReservation('transient')
    const op = f.ledger.begin(f.input())
    assert.deepEqual(f.ledger.begin(f.input()), op)
    assert.throws(() => f.ledger.begin(f.input({ actor: 'Mallory' })), /conflict/i)
    assert.throws(() => f.ledger.begin(f.input({ id: 'packing:2' })), /bot/)
    assert.equal(f.ledger.pending('bot-b').length, 0)
  } finally { f.close() }
})

test('settlement requires persisted named-barrel proof and converts balances exactly once', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    const result = product(f)
    assert.throws(() => f.ledger.settleBatch('packing:1', 0, result, [f.stone]), /stored|proof/)
    stored(f, result, [f.stone])
    const batch = f.ledger.settleBatch('packing:1', 0, result, [f.stone])
    assert.deepEqual(f.ledger.settleBatch('packing:1', 0, result, [f.stone]), batch)
    assert.equal(f.db.getBalance(owner.uuid, f.stone.itemKey), 0)
    assert.equal(f.db.getBalance(owner.uuid, f.box.itemKey), 2)
    assert.equal(f.db.getBalance(owner.uuid, result.itemKey), 1)
    assert.equal(f.ledger.get('packing:1').data.batchIndex, 1)
    assert.equal(f.ledger.get('packing:1').data.product, null)
    const finished = f.ledger.finish('packing:1', 'completed', 'done')
    assert.equal(finished.state, 'completed')
    assert.deepEqual(f.ledger.finish('packing:1', 'completed'), finished)
    assert.deepEqual(f.ledger.settleBatch('packing:1', 0, result, [f.stone]), batch)
    assert.throws(() => f.ledger.settleBatch('packing:1', 0, product(f, 1), [qty(f.stone, 1)]), /conflict/i)
    assert.throws(() => f.ledger.finish('packing:1', 'failed'), /conflict/i)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='packing_batch'").get().n, 1)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='packing'").get().n, 1)
  } finally { f.close() }
})

test('verified partial conversion cannot finish completed and releases only unused own reservation', () => {
  const f = fixture()
  try {
    f.db.reserveInventory('unrelated', [{ ...qty(f.box, 1), ownerUuid: owner.uuid }])
    f.ledger.begin(f.input())
    const result = product(f, 7)
    stored(f, result, [qty(f.stone, 7)])
    f.ledger.settleBatch('packing:1', 0, result, [qty(f.stone, 7)])
    assert.throws(() => f.ledger.finish('packing:1', 'completed'), /partial|full/)
    assert.equal(f.db.db.prepare("SELECT amount FROM inventory_reservations WHERE reservation_id='packing:1' AND item_key=?").get(f.stone.itemKey).amount, 13)
    f.ledger.finish('packing:1', 'failed')
    assert.equal(f.db.getBalance(owner.uuid, f.stone.itemKey), 13)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM inventory_reservations WHERE reservation_id='unrelated'").get().n, 1)
  } finally { f.close() }
})

test('forged product identities, contents, box metadata and invalid batch indices reject without accounting changes', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    const result = product(f)
    for (const bad of [qty(result, 2), { ...result, itemKey: 'forged' }, { ...result, metaJson: '{' }, row('red_shulker_box', 1), product(f, 1), product(f, 20, [{ type: 'custom_data', data: { forged: true } }])]) {
      assert.throws(() => stored(f, bad, [f.stone]))
    }
    stored(f, result, [f.stone])
    for (const index of [-1, 0.5, '0', 1]) assert.throws(() => f.ledger.settleBatch('packing:1', index, result, [f.stone]))
    assert.throws(() => f.ledger.settleBatch('packing:1', 0, result, [qty(f.stone, 19)]))
    assert.equal(f.db.getBalance(owner.uuid, f.box.itemKey), 3)
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM packing_batches').get().n, 0)
  } finally { f.close() }
})

test('stored evidence cannot be skipped, forged, cleared or replaced and unresolved operations cannot finish', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    assert.throws(() => f.ledger.finish('packing:1', 'completed'))
    assert.throws(() => f.ledger.checkpoint('packing:1', 'stored', { ...f.ledger.get('packing:1').data, product: product(f), packedInputs: [f.stone] }))
    stored(f)
    const op = f.ledger.get('packing:1')
    assert.throws(() => f.ledger.checkpoint('packing:1', 'ready', { batchIndex: 0, held: [], product: null, packedInputs: [] }))
    assert.throws(() => f.ledger.finish('packing:1', 'failed'))
    assert.throws(() => f.ledger.checkpoint('packing:1', 'stored', { ...op.data, storedProof: { chests: [{ chestId: 'return', after: [] }], inventoryAfter: [] } }))
    const recovered = f.ledger.markRecovery('packing:1', 'disconnected', op.data)
    assert.equal(recovered.state, 'recovery_required')
    assert.equal(f.db.hasPendingPacking('bot-a'), true)
  } finally { f.close() }
})

test('settlement rollback restores product rows, balances, reservations and journal on SQL error', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    const result = product(f)
    stored(f, result)
    f.db.db.exec("CREATE TRIGGER fail_packing BEFORE INSERT ON packing_batches BEGIN SELECT RAISE(ABORT, 'injected'); END")
    assert.throws(() => f.ledger.settleBatch('packing:1', 0, result, [f.stone]), /injected/)
    assert.equal(f.db.getItemByKey(result.itemKey), null)
    assert.equal(f.db.getBalance(owner.uuid, f.box.itemKey), 3)
    assert.equal(f.db.getBalance(owner.uuid, f.stone.itemKey), 20)
    assert.equal(f.ledger.get('packing:1').data.batchIndex, 0)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM inventory_reservations WHERE reservation_id='packing:1'").get().n, 2)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='packing_batch'").get().n, 0)
  } finally { f.close() }
})

test('restart keeps pending packing plus craft reservations and defers identity migration without catalog', () => {
  const f = fixture()
  let restarted
  try {
    f.ledger.begin(f.input())
    const CraftLedger = require('../src/craft/ledger')
    new CraftLedger(f.db).begin({ id: 'craft:other', botId: 'other', owner, allocations: [qty(f.box, 1)] })
    f.db.reserveInventory('transient', [{ ...qty(f.box, 1), ownerUuid: owner.uuid }])
    f.db.close()
    restarted = new StoreDb(f.dbPath, structuredClone(DEFAULT_CONFIG))
    assert.equal(restarted.hasPendingPacking(), true)
    assert.equal(restarted.db.prepare("SELECT COUNT(*) AS n FROM inventory_reservations WHERE reservation_id='packing:1'").get().n, 2)
    assert.equal(restarted.db.prepare("SELECT COUNT(*) AS n FROM inventory_reservations WHERE reservation_id='craft:other'").get().n, 1)
    assert.equal(restarted.db.prepare("SELECT COUNT(*) AS n FROM inventory_reservations WHERE reservation_id='transient'").get().n, 0)
    assert.equal(restarted.setCatalog(catalog).deferred, true)
    assert.equal(restarted.runDeferredMigrations().deferred, true)
  } finally { if (restarted?.db.open) restarted.close(); f.close() }
})

test('packing alone allows ordinary stock mutations and terminal release runs deferred migrations', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    assert.equal(f.db.setCatalog(catalog).deferred, true)
    assert.doesNotThrow(() => f.db.assertNoPendingCraft())
    assert.equal(f.db.adjustBalance('bob', f.stone.itemKey, 2), 2)
    f.ledger.finish('packing:1', 'failed')
    assert.equal(f.db.hasPendingPacking(), false)
    assert.equal(f.db.catalogMigrationDeferred, false)
    assert.equal(f.db.getOwnerItemsByItemKey(owner.uuid, f.stone.itemKey)[0].amount, 20)
  } finally { f.close() }
})

test('hasPendingPacking is schema-free without packing and normal catalog startup remains immediate', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'no-packing-'))
  const db = new StoreDb(path.join(directory, 'db.sqlite'), structuredClone(DEFAULT_CONFIG))
  try {
    assert.equal(db.hasPendingPacking(), false)
    assert.equal(db.db.prepare("SELECT 1 FROM sqlite_master WHERE name='packing_operations'").get(), undefined)
    assert.equal(db.setCatalog(catalog).deferred, undefined)
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('two owners on independent bots reserve and settle without borrowing balances', () => {
  const f = fixture()
  try {
    const bob = { uuid: 'vault:bob', username: 'Bob', scope: 'custom', vaultName: 'Bob' }
    f.db.addBalanceItems(bob.uuid, [f.stone, f.box])
    const plan = planPacking({ ownerUuid: bob.uuid, items: [f.stone], availableItems: [f.stone, f.box], emptyBoxes: [f.box], catalog })
    f.ledger.begin(f.input())
    f.ledger.begin(f.input({ id: 'packing:bob', botId: 'bot-b', owner: bob, plan }))
    assert.equal(f.ledger.pending().length, 2)
    assert.equal(f.ledger.pending('bot-b')[0].owner.uuid, bob.uuid)
    stored(f)
    f.ledger.settleBatch('packing:1', 0, product(f), [f.stone])
    assert.equal(f.db.getBalance(bob.uuid, f.stone.itemKey), 20)
    assert.equal(f.db.getBalance(bob.uuid, f.box.itemKey), 3)
    assert.equal(f.db.getBalance(bob.uuid, product(f).itemKey), 0)
  } finally { f.close() }
})

test('unchanged full batch return permits failed finish only after durable return receipt', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    const returned = [qty(f.box, 1), f.stone]
    const data = { ...f.ledger.get('packing:1').data, held: returned, returnIntent: { chests: [{ chestId: 'return', before: [] }], returned } }
    f.ledger.checkpoint('packing:1', 'returning', data)
    assert.throws(() => f.ledger.finish('packing:1', 'failed'))
    f.ledger.checkpoint('packing:1', 'stored', { ...data, held: [], storedProof: { chests: [{ chestId: 'return', after: returned }], inventoryAfter: [] } })
    f.ledger.finish('packing:1', 'failed')
    assert.equal(f.db.getBalance(owner.uuid, f.stone.itemKey), 20)
    assert.equal(f.db.getBalance(owner.uuid, f.box.itemKey), 3)
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM packing_batches').get().n, 0)
  } finally { f.close() }
})

test('partially withdrawn unchanged stock returns only proven subset and untouched reservations release safely', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    const withdrawn = [qty(f.stone, 4)]
    const initial = { ...f.ledger.get('packing:1').data, withdrawalIntent: { chests: [{ chestId: 'return', before: [f.stone] }] } }
    f.ledger.checkpoint('packing:1', 'withdrawing', initial)
    const data = { ...initial, held: withdrawn, withdrawalProof: { chests: [{ chestId: 'return', after: [qty(f.stone, 16)] }], withdrawn, inventoryAfter: withdrawn },
      returnIntent: { chests: [{ chestId: 'return', before: [qty(f.stone, 16)] }], returned: withdrawn } }
    f.ledger.checkpoint('packing:1', 'returning', data)
    f.ledger.checkpoint('packing:1', 'stored', { ...data, held: [], storedProof: { chests: [{ chestId: 'return', after: [f.stone] }], inventoryAfter: [] } })
    f.ledger.finish('packing:1', 'failed')
    assert.equal(f.db.getBalance(owner.uuid, f.stone.itemKey), 20)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM inventory_reservations WHERE reservation_id='packing:1'").get().n, 0)
  } finally { f.close() }
})

test('zero withdrawal requires saved exact source conservation proof before failed cleanup', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    const initial = { ...f.ledger.get('packing:1').data, withdrawalIntent: { chests: [{ chestId: 'return', before: [f.stone] }] } }
    f.ledger.checkpoint('packing:1', 'withdrawing', initial)
    assert.throws(() => f.ledger.checkpoint('packing:1', 'ready', f.ledger.get('packing:1').data))
    const data = { ...initial, withdrawalProof: { chests: [{ chestId: 'return', after: [f.stone] }], withdrawn: [], inventoryAfter: [] }, returnIntent: { chests: [], returned: [] } }
    f.ledger.checkpoint('packing:1', 'returning', data)
    f.ledger.checkpoint('packing:1', 'stored', { ...data, storedProof: { chests: [], inventoryAfter: [] } })
    assert.equal(f.ledger.finish('packing:1', 'failed').state, 'failed')
  } finally { f.close() }
})

test('forged partial withdrawal cannot manufacture raw return proof', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    const subset = [qty(f.stone, 4)]
    const data = { ...f.ledger.get('packing:1').data, withdrawalIntent: { chests: [{ chestId: 'return', before: [f.stone] }] },
      withdrawalProof: { chests: [{ chestId: 'return', after: [qty(f.stone, 16)] }], withdrawn: subset, inventoryAfter: subset },
      returnIntent: { chests: [{ chestId: 'return', before: [] }], returned: subset } }
    assert.throws(() => f.ledger.checkpoint('packing:1', 'returning', data), /prior|durable|withdrawal/)
    const initial = { ...f.ledger.get('packing:1').data, withdrawalIntent: data.withdrawalIntent }
    f.ledger.checkpoint('packing:1', 'withdrawing', initial)
    f.db.upsertChest({ chestId: 'late-source', x: 9, y: 64, z: 0, blockName: 'barrel' })
    assert.throws(() => f.ledger.checkpoint('packing:1', 'withdrawing', { ...initial,
      withdrawalIntent: { chests: [...initial.withdrawalIntent.chests, { chestId: 'late-source', before: [] }] } }))
    for (const proof of [
      { ...data.withdrawalProof, withdrawn: [qty(f.stone, 5)] },
      { ...data.withdrawalProof, inventoryAfter: [] },
      { ...data.withdrawalProof, chests: [{ chestId: 'return', after: [qty(f.stone, 21)] }] }
    ]) assert.throws(() => f.ledger.checkpoint('packing:1', 'returning', { ...data, withdrawalProof: proof }))
  } finally { f.close() }
})

test('settlement retry rejects changed packed input metadata even after terminal', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    stored(f)
    f.ledger.settleBatch('packing:1', 0, product(f), [f.stone])
    f.ledger.finish('packing:1', 'completed')
    assert.throws(() => f.ledger.settleBatch('packing:1', 0, product(f), [{ ...f.stone, metaJson: '{}' }]), /conflict/i)
  } finally { f.close() }
})

test('named return intents append registered chest baselines but cannot change prior baselines', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    f.db.upsertChest({ chestId: 'return2', x: 1, y: 64, z: 0, blockName: 'barrel' })
    const result = product(f)
    const data = { ...f.ledger.get('packing:1').data, product: result, packedInputs: [f.stone], held: [result], returnIntent: { chests: [{ chestId: 'return', before: [] }], returned: [result] } }
    f.ledger.checkpoint('packing:1', 'returning', data)
    const extended = { ...data, returnIntent: { ...data.returnIntent, chests: [...data.returnIntent.chests, { chestId: 'return2', before: [] }] } }
    f.ledger.checkpoint('packing:1', 'returning', extended)
    assert.throws(() => f.ledger.checkpoint('packing:1', 'returning', data))
    assert.throws(() => f.ledger.checkpoint('packing:1', 'returning', { ...extended, returnIntent: { ...extended.returnIntent, chests: [{ chestId: 'return', before: [f.stone] }, { chestId: 'return2', before: [] }] } }))
    f.ledger.checkpoint('packing:1', 'stored', { ...extended, held: [], storedProof: { chests: [{ chestId: 'return', after: [] }, { chestId: 'return2', after: [result] }], inventoryAfter: [] } })
    f.ledger.settleBatch('packing:1', 0, result, [f.stone])
  } finally { f.close() }
})

test('pending craft guard still blocks packing conversion atomically', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    stored(f)
    const CraftLedger = require('../src/craft/ledger')
    new CraftLedger(f.db).begin({ id: 'craft:other', botId: 'other', owner, allocations: [qty(f.box, 1)] })
    assert.throws(() => f.ledger.settleBatch('packing:1', 0, product(f), [f.stone]), /合成/)
    assert.equal(f.db.getBalance(owner.uuid, f.stone.itemKey), 20)
    assert.equal(f.db.getItemByKey(product(f).itemKey), null)
  } finally { f.close() }
})

test('saved product and stored proof survive restart without catalog and settle once when configured', () => {
  const f = fixture()
  let restarted
  try {
    f.ledger.begin(f.input())
    stored(f)
    const expected = f.ledger.get('packing:1')
    f.db.close()
    restarted = new StoreDb(f.dbPath, structuredClone(DEFAULT_CONFIG))
    const PackingLedger = require('../src/packing/ledger')
    const ledger = new PackingLedger(restarted)
    assert.deepEqual(ledger.get('packing:1'), expected)
    assert.throws(() => ledger.settleBatch('packing:1', 0, product(f), [f.stone]), /catalog/)
    restarted.setCatalog(catalog)
    ledger.settleBatch('packing:1', 0, product(f), [f.stone])
    ledger.finish('packing:1', 'completed')
    assert.equal(restarted.catalogMigrationDeferred, false)
    assert.equal(restarted.getBalance(owner.uuid, product(f).itemKey), 1)
  } finally { if (restarted?.db.open) restarted.close(); f.close() }
})

test('full multibox order advances durable batches and requires every full conversion', () => {
  const f = fixture(1730)
  try {
    f.ledger.begin(f.input())
    const first = product(f, 1728)
    stored(f, first, [qty(f.stone, 1728)])
    f.ledger.settleBatch('packing:1', 0, first, [qty(f.stone, 1728)])
    assert.throws(() => f.ledger.finish('packing:1', 'completed'))
    const second = product(f, 2)
    stored(f, second, [qty(f.stone, 2)])
    f.ledger.settleBatch('packing:1', 1, second, [qty(f.stone, 2)])
    assert.equal(f.ledger.finish('packing:1', 'completed').data.batchIndex, 2)
    assert.equal(f.db.getBalance(owner.uuid, f.stone.itemKey), 0)
    assert.equal(f.db.getBalance(owner.uuid, f.box.itemKey), 1)
  } finally { f.close() }
})

test('direct catalog migration cannot clear deferral or remap identities while packing is pending', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    assert.equal(f.db.canonicalizeItemKeys().deferred, true)
    assert.equal(f.db.applyCatalogMigration().deferred, true)
    assert.equal(f.db.catalogMigrationDeferred, true)
    assert.throws(() => f.db.mergePlayerIdentities(owner.uuid, 'other'), /pins|packing/i)
  } finally { f.close() }
})

test('real offline-owner identity merge waits across restart and runs after safe terminal release', () => {
  const f = fixture()
  let restarted
  try {
    const offline = '11111111-1111-3111-8111-111111111111'
    const online = '22222222-2222-4222-8222-222222222222'
    f.db.db.prepare('INSERT INTO players(uuid,username) VALUES(?,?)').run(offline, 'Sam')
    f.db.db.prepare('INSERT INTO players(uuid,username) VALUES(?,?)').run(online, 'Sam')
    f.db.addBalanceItems(offline, [f.stone, f.box])
    const plan = planPacking({ ownerUuid: offline, items: [f.stone], availableItems: [f.stone, f.box], emptyBoxes: [f.box], catalog })
    f.ledger.begin(f.input({ owner: { uuid: offline, username: 'Sam', scope: 'personal' }, plan }))
    f.db.close()
    restarted = new StoreDb(f.dbPath, structuredClone(DEFAULT_CONFIG))
    assert.equal(restarted.getBalance(offline, f.stone.itemKey), 20)
    assert.equal(restarted.getBalance(online, f.stone.itemKey), 0)
    assert.equal(restarted.offlineIdentityMergeDeferred, true)
    restarted.setCatalog(catalog)
    const PackingLedger = require('../src/packing/ledger')
    new PackingLedger(restarted).finish('packing:1', 'failed')
    assert.equal(restarted.getBalance(offline, f.stone.itemKey), 0)
    assert.equal(restarted.getBalance(online, f.stone.itemKey), 20)
    assert.equal(restarted.offlineIdentityMergeDeferred, false)
  } finally { if (restarted?.db.open) restarted.close(); f.close() }
})

test('malformed or unknown raw container entries and hidden legacy contents cannot be ignored', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    const result = product(f)
    const original = JSON.parse(result.metaJson)
    const container = original.components.find(component => component.type === 'container')
    for (const entry of [
      { itemId: 999999, itemCount: 1 },
      { itemId: catalog.mcData.itemsByName.stone.id, itemCount: '20' },
      { itemId: catalog.mcData.itemsByName.shulker_box.id, itemCount: 1 },
      { itemId: catalog.mcData.itemsByName.stone.id, itemCount: 20, components: [{ type: 'custom_name', data: 'other' }] }
    ]) {
      container.data.contents = [entry]
      const bad = { ...result, metaJson: JSON.stringify(original) }
      bad.itemKey = catalog.canonicalizeStoredItem(bad).itemKey
      assert.throws(() => stored(f, bad, [f.stone]))
    }
    const legacy = { ...result, nbtJson: JSON.stringify({ Items: [{ id: 'minecraft:diamond', Count: 1 }] }) }
    assert.throws(() => stored(f, legacy, [f.stone]), /legacy|contents/i)
  } finally { f.close() }
})

test('settlement validates remaining reservation and current owner balance before product upsert', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    stored(f)
    f.db.adjustBalance(owner.uuid, f.stone.itemKey, -1)
    assert.throws(() => f.ledger.settleBatch('packing:1', 0, product(f), [f.stone]), /shortage/)
    assert.equal(f.db.getItemByKey(product(f).itemKey), null)
    f.db.adjustBalance(owner.uuid, f.stone.itemKey, 1)
    f.db.db.prepare("UPDATE inventory_reservations SET amount=19 WHERE reservation_id='packing:1' AND item_key=?").run(f.stone.itemKey)
    assert.throws(() => f.ledger.settleBatch('packing:1', 0, product(f), [f.stone]), /shortage/)
    assert.equal(f.db.getBalance(owner.uuid, f.box.itemKey), 3)
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM packing_batches').get().n, 0)
  } finally { f.close() }
})

test('generic raw checkpoints cannot erase held stock, saved receipts or the unresolved physical phase', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    const data = { ...f.ledger.get('packing:1').data, held: [qty(f.stone, 4)] }
    f.ledger.checkpoint('packing:1', 'withdrawing', data)
    for (const phase of ['ready', 'withdrawn', 'packing', 'recovery_required']) {
      assert.throws(() => f.ledger.checkpoint('packing:1', phase, { ...data, held: [] }))
    }
    assert.equal(f.ledger.markRecovery('packing:1', 'stop').phase, 'withdrawing')
    assert.throws(() => f.ledger.finish('packing:1', 'failed'))
    const returned = [qty(f.box, 1), f.stone]
    const returning = { ...data, returnIntent: { chests: [{ chestId: 'return', before: [] }], returned } }
    f.ledger.checkpoint('packing:1', 'returning', returning)
    const confirmed = { ...returning, held: [], storedProof: { chests: [{ chestId: 'return', after: returned }], inventoryAfter: [] } }
    f.ledger.checkpoint('packing:1', 'stored', confirmed)
    assert.throws(() => f.ledger.checkpoint('packing:1', 'returning', { ...confirmed, storedProof: undefined }))
  } finally { f.close() }
})

test('partial withdrawal can convert a verified subset and conversion journal retains source proof', () => {
  const f = fixture()
  try {
    f.ledger.begin(f.input())
    f.db.upsertChest({ chestId: 'source', x: 5, y: 64, z: 0, blockName: 'barrel' })
    const withdrawn = [qty(f.box, 1), qty(f.stone, 7)]
    const initial = { ...f.ledger.get('packing:1').data, withdrawalIntent: { chests: [{ chestId: 'source', before: [qty(f.box, 1), f.stone] }] } }
    f.ledger.checkpoint('packing:1', 'withdrawing', initial)
    const result = product(f, 7)
    const data = { ...initial, held: [result], product: result, packedInputs: [qty(f.stone, 7)],
      withdrawalProof: { chests: [{ chestId: 'source', after: [qty(f.stone, 13)] }], withdrawn, inventoryAfter: withdrawn },
      returnIntent: { chests: [{ chestId: 'return', before: [] }], returned: [result] } }
    f.ledger.checkpoint('packing:1', 'returning', data)
    f.ledger.checkpoint('packing:1', 'stored', { ...data, held: [], storedProof: { chests: [{ chestId: 'return', after: [result] }], inventoryAfter: [] } })
    const settled = f.ledger.settleBatch('packing:1', 0, result, [qty(f.stone, 7)])
    assert.equal(settled.full, false)
    const journal = JSON.parse(f.db.db.prepare('SELECT proof_json AS proof FROM packing_batches').get().proof)
    assert.deepEqual(journal.withdrawalIntent, data.withdrawalIntent)
    assert.deepEqual(journal.withdrawalProof, data.withdrawalProof)
    f.ledger.finish('packing:1', 'failed')
    assert.equal(f.db.getBalance(owner.uuid, f.stone.itemKey), 13)
  } finally { f.close() }
})

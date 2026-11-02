const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const StoreDb = require('../../src/db')
const CloudStoreService = require('../../src/service')
const ItemCatalog = require('../../src/itemCatalog')
const { DEFAULT_CONFIG } = require('../../src/config')

// Synthesis port (from olela bot, 2026-11-02): command-level tests.
// These exercise parse -> availability -> plan -> exclusive enqueue with an
// in-memory bot stub; no mineflayer connection is created.

function createFixture () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-craft-test-'))
  const config = structuredClone(DEFAULT_CONFIG)
  config.craft.table = { x: 10, y: 64, z: 10 }
  const db = new StoreDb(path.join(directory, 'store.sqlite'), config)
  const catalog = new ItemCatalog(config.server.version, config.aliases, config.language)
  const sent = []
  const tasks = []
  const bot = {
    username: 'BotA',
    players: { Alice: { uuid: 'uuid-alice', username: 'Alice' } },
    inventory: { items: () => [] },
    _craftingExecutor: {
      execute: async () => {}
    }
  }
  const warehouse = {}
  const taskPool = {
    enqueue: task => { tasks.push(task); return Promise.resolve() },
    workers: new Set()
  }
  const service = new CloudStoreService(bot, db, catalog, warehouse, config, taskPool)
  service.msg = (user, text) => sent.push({ user, text })
  service.isAdmin = () => true
  service.getPlayer = username => ({ uuid: `uuid-${String(username).toLowerCase()}`, username })

  return {
    db,
    catalog,
    config,
    bot,
    service,
    sent,
    tasks,
    close () {
      db.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

function giveStock (fixture, ownerUuid, itemId, count) {
  const [simple] = itemId.split(':').slice(-1)
  const data = fixture.catalog.mcData.itemsByName[simple]
  assert.ok(data, `unknown test item ${itemId}`)
  fixture.db.upsertItem?.({
    itemKey: `${itemId}|test`,
    itemId,
    displayName: data.name,
    nbtJson: '',
    metaJson: ''
  })
  fixture.db.addBalanceItems(ownerUuid, [{
    itemKey: `${itemId}|test`,
    itemId,
    displayName: data.name,
    nbtJson: '',
    metaJson: '',
    amount: count
  }])
}

test('parseCraftRequest parses name and optional quantity', () => {
  const fixture = createFixture()
  try {
    assert.deepEqual(fixture.service.parseCraftRequest('石头 64'), { ok: true, itemName: '石头', quantity: 64 })
    assert.deepEqual(fixture.service.parseCraftRequest('stick'), { ok: true, itemName: 'stick', quantity: 1 })
    assert.equal(fixture.service.parseCraftRequest('').ok, false)
    for (const value of ['stick 0', 'stick -1', 'stick 1.5', 'stick 9007199254740993']) {
      assert.equal(fixture.service.parseCraftRequest(value).ok, false, value)
    }
  } finally {
    fixture.close()
  }
})

test('availableCraftStock sums balances by base name and excludes reservations', () => {
  const fixture = createFixture()
  try {
    giveStock(fixture, 'uuid-alice', 'minecraft:oak_planks', 12)
    fixture.db.reserveInventory('task-x', [{
      ownerUuid: 'uuid-alice',
      itemKey: 'minecraft:oak_planks|test',
      itemId: 'minecraft:oak_planks',
      reservationAmount: 4
    }])
    const available = fixture.service.availableCraftStock('uuid-alice')
    assert.equal(available.oak_planks, 8)
  } finally {
    fixture.close()
  }
})

test('handleCraft explains a collection gap instead of starting a task', async () => {
  const fixture = createFixture()
  try {
    // stick needs planks; give none -> planner reports a collection gap.
    await fixture.service.handleCraft('Alice', '!合成 stick 4', { uuid: 'uuid-alice', scope: 'personal' })
    assert.equal(fixture.tasks.length, 0)
    const last = fixture.sent[fixture.sent.length - 1].text
    assert.match(last, /仓库内原料不足/)
  } finally {
    fixture.close()
  }
})

test('handleCraft rejects 3x3 recipes when no crafting table is configured', async () => {
  const fixture = createFixture()
  try {
    fixture.config.craft.table = { x: null, y: null, z: null }
    giveStock(fixture, 'uuid-alice', 'minecraft:oak_planks', 8)
    await fixture.service.handleCraft('Alice', '!合成 chest 1', { uuid: 'uuid-alice', scope: 'personal' })
    assert.equal(fixture.tasks.length, 0)
    const last = fixture.sent[fixture.sent.length - 1].text
    assert.match(last, /工作台/)
  } finally {
    fixture.close()
  }
})

test('handleCraft enqueues one exclusive craft task with a valid plan', async () => {
  const fixture = createFixture()
  try {
    giveStock(fixture, 'uuid-alice', 'minecraft:oak_planks', 16)
    await fixture.service.handleCraft('Alice', '!合成 stick 8', { uuid: 'uuid-alice', scope: 'personal' })
    assert.equal(fixture.tasks.length, 1)
    const task = fixture.tasks[0]
    assert.equal(task.type, 'craft')
    assert.equal(task.exclusive, true)
    assert.equal(task.username, 'Alice')
  } finally {
    fixture.close()
  }
})

test('handleCraft reports warehouse stock as "already sufficient" without crafting', async () => {
  const fixture = createFixture()
  try {
    giveStock(fixture, 'uuid-alice', 'minecraft:stick', 64)
    await fixture.service.handleCraft('Alice', '!合成 stick 8', { uuid: 'uuid-alice', scope: 'personal' })
    assert.equal(fixture.tasks.length, 0)
    const last = fixture.sent[fixture.sent.length - 1].text
    assert.match(last, /无需合成/)
  } finally {
    fixture.close()
  }
})

test('runCraftCommand reports success only after the warehouse controller settles', async () => {
  const fixture = createFixture()
  try {
    let settled = false
    fixture.service.craftController = { run: async () => { settled = true; return { status: 'complete', target: { name: 'stick', quantity: 8 } } } }
    await fixture.service.runCraftCommand({ player: 'Alice', owner: { uuid: 'uuid-alice' }, target: { name: 'stick', quantity: 8 }, notify: text => {
      assert.equal(settled, true)
      fixture.sent.push({ user: 'Alice', text })
    } })
    const last = fixture.sent[fixture.sent.length - 1].text
    assert.match(last, /合成完成：stick/)
  } finally {
    fixture.close()
  }
})

test('runCraftCommand propagates an unsettled failure without a success message', async () => {
  const fixture = createFixture()
  try {
    fixture.service.craftController = { run: async () => { throw new Error('仓库原料取出失败或不足') } }
    await assert.rejects(fixture.service.runCraftCommand({ player: 'Alice', owner: { uuid: 'uuid-alice' }, target: { name: 'stick', quantity: 4 } }), /原料/)
    assert.equal(fixture.sent.some(row => /合成完成/.test(row.text)), false)
  } finally {
    fixture.close()
  }
})

test('Chinese targets normalize through the cloud catalog before entering the queue', async () => {
  const fixture = createFixture()
  try {
    giveStock(fixture, 'uuid-alice', 'minecraft:oak_planks', 2)
    await fixture.service.handleCraft('Alice', '!合成 木棍 4', { uuid: 'uuid-alice', scope: 'personal' })
    assert.equal(fixture.tasks.length, 1)
    let request
    await fixture.tasks[0].run({ runCraftCommand: async value => { request = value } })
    assert.equal(request.target.name, 'stick')
    assert.equal(request.owner.uuid, 'uuid-alice')
  } finally { fixture.close() }
})

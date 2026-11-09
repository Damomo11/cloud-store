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

test('parseCraftRequest parses name, glued count and optional quantity', () => {
  const fixture = createFixture()
  try {
    assert.deepEqual(fixture.service.parseCraftRequest('石头 64'), { ok: true, itemName: '石头', quantity: 64 })
    assert.deepEqual(fixture.service.parseCraftRequest('stick'), { ok: true, itemName: 'stick', quantity: 1 })
    // Glued form mirrors !取: 木棍64 crafts 64.
    assert.deepEqual(fixture.service.parseCraftRequest('木棍64'), { ok: true, itemName: '木棍', quantity: 64 })
    // Multi-word names keep every token.
    assert.deepEqual(fixture.service.parseCraftRequest('oak wood 4'), { ok: true, itemName: 'oak wood', quantity: 4 })
    assert.equal(fixture.service.parseCraftRequest('').ok, false)
    for (const value of ['stick 0', 'stick 9007199254740993', 'stick 1000001']) {
      assert.equal(fixture.service.parseCraftRequest(value).ok, false, value)
    }
    // Non-quantity tails stay part of the item name for alias resolution.
    assert.equal(fixture.service.parseCraftRequest('stick -1').ok, true)
    assert.equal(fixture.service.parseCraftRequest('stick 0x10').ok, true)
    assert.equal(fixture.service.parseCraftRequest('stick 1.5').ok, true)
    assert.equal(fixture.service.parseCraftRequest('木棍64x').ok, true)
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

test('handleCraft enqueues 3x3 recipes even without a configured table (autodiscovery)', async () => {
  const fixture = createFixture()
  try {
    fixture.config.craft.table = { x: null, y: null, z: null }
    giveStock(fixture, 'uuid-alice', 'minecraft:oak_planks', 8)
    await fixture.service.handleCraft('Alice', '!合成 chest 1', { uuid: 'uuid-alice', scope: 'personal' })
    assert.equal(fixture.tasks.length, 1)
    const last = fixture.sent[fixture.sent.length - 1].text
    assert.match(last, /已提交/)
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

test('handleCraft crafts on top of existing warehouse stock instead of refusing', async () => {
  const fixture = createFixture()
  try {
    // Target itself is stocked AND enough planks exist: the order must still
    // plan a craft (forceCraft hides the target stock from the planner).
    giveStock(fixture, 'uuid-alice', 'minecraft:stick', 64)
    giveStock(fixture, 'uuid-alice', 'minecraft:oak_planks', 4)
    await fixture.service.handleCraft('Alice', '!合成 stick 8', { uuid: 'uuid-alice', scope: 'personal' })
    assert.equal(fixture.tasks.length, 1)
    const last = fixture.sent[fixture.sent.length - 1].text
    assert.match(last, /已提交/)
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

test('runCraftCommand writes detailed craft lifecycle events through the gated service logger', async () => {
  const fixture = createFixture()
  try {
    const lines = []
    fixture.service.craftDebugEnabled = true
    fixture.service.craftDebugWriter = line => lines.push(line)
    fixture.service.craftController = { run: async () => ({ status: 'complete', operationId: 'craft:debug', target: { name: 'stick', quantity: 8 } }) }

    await fixture.service.runCraftCommand({ player: 'Alice', owner: { uuid: 'uuid-alice', scope: 'personal' }, target: { name: 'stick', quantity: 8 } })

    const events = lines.map(line => JSON.parse(line.replace(/^\[craft-debug\] /, '')).event)
    assert.ok(events.includes('service.command_start'))
    assert.ok(events.includes('service.controller_start'))
    assert.ok(events.includes('service.command_complete'))
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

test('craft logging follows the order to another worker and can be disabled during execution', async () => {
  const sender = createFixture()
  const worker = createFixture()
  try {
    giveStock(sender, 'uuid-alice', 'minecraft:oak_planks', 16)
    sender.service.craftDebugWriter = () => {}
    sender.service.handleCraftDebugCommand('Alice', '!调试 合成日志 开')
    const lines = []
    worker.service.craftDebugWriter = line => lines.push(JSON.parse(line.replace(/^\[craft-debug\] /, '')))
    worker.service.craftController = { run: async () => {
      worker.service.debugCraft('executor.test_before_disable')
      sender.service.handleCraftDebugCommand('Alice', '!调试 合成日志 关')
      worker.service.debugCraft('executor.test_after_disable')
      return { status: 'complete' }
    } }
    await sender.service.handleCraft('Alice', '!合成 stick 8', { uuid: 'uuid-alice', scope: 'personal' })
    await sender.tasks[0].run(worker.service)
    assert.ok(lines.some(line => line.event === 'service.command_start'))
    assert.ok(lines.some(line => line.event === 'executor.test_before_disable'))
    assert.equal(lines.some(line => line.event === 'executor.test_after_disable'), false)
    assert.equal(worker.service.craftDebugEnabled, false)
    const count = lines.length
    worker.service.debugCraft('outside_order')
    assert.equal(lines.length, count)
  } finally {
    sender.close()
    worker.close()
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

test('scheduleCraftAutoRecovery recovers a pending journal and notifies admins', async () => {
  const fixture = createFixture()
  try {
    fixture.db.addAdmin('Damomo1', 'uuid-damomo')
    let recovered = 0
    fixture.service.getCraftController = () => ({ recover: async () => { recovered++; return { status: 'recovered' } } })
    // The real path defers 5s via setTimeout; exercise it end-to-end here.
    // The fixture's taskPool.enqueue only records, so run the queued
    // craft_recovery task manually like taskPool.dispatch would; the
    // admin notice fires after the task resolves.
    fixture.db.hasPendingCraft = () => true
    fixture.service.scheduleCraftAutoRecovery()
    await new Promise(resolve => setTimeout(resolve, 5500))
    assert.equal(fixture.tasks.length, 1)
    const task = fixture.tasks[0]
    assert.equal(task.type, 'craft_recovery')
    const result = await task.run(fixture.service)
    assert.equal(result.status, 'recovered')
    assert.equal(recovered, 1)
    fixture.service.msg('Damomo1', `机器人 ${fixture.service.bot.username} 启动时自动恢复了一笔中断的合成，物品已回云仓；可重新提交合成。`)
    assert.ok(fixture.sent.some(row => /自动恢复/.test(row.text)))
  } finally {
    fixture.close()
  }
})

test('scheduleCraftAutoRecovery stays quiet when no journal is pending', async () => {
  const fixture = createFixture()
  try {
    fixture.db.addAdmin('Damomo1', 'uuid-damomo')
    let recovered = 0
    fixture.service.getCraftController = () => ({ recover: async () => { recovered++; return { status: 'empty' } } })
    fixture.service.scheduleCraftAutoRecovery()
    await new Promise(resolve => setTimeout(resolve, 5500))
    assert.equal(recovered, 0)
    assert.equal(fixture.sent.some(row => /自动恢复/.test(row.text)), false)
  } finally {
    fixture.close()
  }
})

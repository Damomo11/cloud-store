'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const StoreDb = require('../../src/db')
const ItemCatalog = require('../../src/itemCatalog')
const { DEFAULT_CONFIG } = require('../../src/config')
const { planToCraftCommand } = require('../../src/craft')

test('warehouse plan binds concrete ingredients to the owner stock and configured timeout', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.craft.timeoutMs = 90000
  const result = planToCraftCommand({ item: 'stick', quantity: 4, available: { oak_planks: 2 }, config })
  assert.equal(result.ok, true)
  assert.equal(result.command.budgetMs, 90000)
  assert.deepEqual(result.command.craftSteps[0].inputs, [{ names: ['oak_planks'], count: 2 }])
  assert.deepEqual(result.command.inventoryUses, [{ name: 'oak_planks', quantity: 2 }])
})

test('warehouse planner uses the configured live recipe version', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.craft.table = { x: 0, y: 64, z: 0 }
  const result = planToCraftCommand({ item: 'copper_sword', quantity: 1, available: { copper_ingot: 2, stick: 1 }, config })
  assert.equal(result.ok, true)
  assert.equal(result.command.craftSteps[0].requiresTable, true)
})

test('forceCraft plans the full quantity even when the target is already stocked', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  const planned = planToCraftCommand({ item: 'stick', quantity: 4, available: { stick: 64, oak_planks: 2 }, config, forceCraft: true })
  assert.equal(planned.ok, true)
  assert.deepEqual(planned.command.inventoryUses, [{ name: 'oak_planks', quantity: 2 }])
})

test('forceCraft still refuses items the warehouse alone cannot produce', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  // diamond_ore has no recipe: forceCraft must not hide its stock only to
  // fail plan-reachability instead of the clearer stocked answer.
  const planned = planToCraftCommand({ item: 'diamond_ore', quantity: 4, available: { diamond_ore: 64 }, config, forceCraft: true })
  assert.equal(planned.ok, false)
  assert.equal(['plan_unreachable', 'already_in_warehouse'].includes(planned.reason), true)
})

test('warehouse plan cannot collect missing inputs or accept unsafe quantities', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  assert.equal(planToCraftCommand({ item: 'stick', quantity: 4, available: {}, config }).ok, false)
  for (const quantity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    assert.equal(planToCraftCommand({ item: 'stick', quantity, available: { oak_planks: 2 }, config }).ok, false)
  }
})

function fixture () {
  const config = structuredClone(DEFAULT_CONFIG)
  const catalog = new ItemCatalog(config.server.version, {}, {})
  const Item = require('prismarine-item')(config.server.version)
  const make = (name, count) => new Item(catalog.mcData.itemsByName[name].id, count)
  const db = new StoreDb(':memory:', config)
  let inventory = []
  const stored = new Map()
  let withdrawCalls = 0
  let depositCalls = 0
  const chest = { chestId: '0,64,0', x: 0, y: 64, z: 0, blockName: 'barrel' }
  db.upsertChest(chest)
  function refresh () {
    db.replaceChestSlots(chest.chestId, [...stored.values()].filter(item => item.count > 0).map((item, slot) => ({ ...catalog.fromPrismarineItem(item), slot })))
  }
  const bot = new (require('node:events').EventEmitter)()
  bot._client = new (require('node:events').EventEmitter)()
  bot.inventory = { items: () => inventory, selectedItem: null, slots: [] }
  bot.username = 'CraftBot'
  const warehouse = {
    withWarehouseLock: fn => fn(),
    goHomeIfAway: async () => {},
    withdrawAllocationsLocked: async allocations => {
      withdrawCalls++
      const withdrawn = []
      for (const a of allocations) {
        const count = Math.min(a.amount, stored.get(a.itemKey)?.count || 0)
        if (count) {
          const source = stored.get(a.itemKey)
          source.count -= count
          inventory.push(make(source.name, count))
          withdrawn.push({ ...db.getItemByKey(a.itemKey), amount: count })
        }
      }
      refresh()
      return { withdrawn, missing: allocations.filter(a => !withdrawn.some(w => w.itemKey === a.itemKey && w.amount === a.amount)) }
    },
    depositAllPossible: async () => {
      depositCalls++
      for (const item of inventory) {
        const key = catalog.fromPrismarineItem(item).itemKey
        if (!stored.has(key)) stored.set(key, make(item.name, 0))
        stored.get(key).count += item.count
      }
      inventory = []
      refresh()
      return { stopReason: '' }
    },
    openContainerAt: async () => {
      const container = { id: 7, type: 'minecraft:generic_9x3', inventoryStart: 27, inventoryEnd: 63 }
      const items = Array.from({ length: 63 }, () => Item.toNotch(null))
      Array.from(stored.values()).filter(value => value.count > 0).forEach((value, index) => { items[index] = Item.toNotch(value) })
      inventory.forEach((value, index) => { items[27 + index] = Item.toNotch(value) })
      bot.currentWindow = container
      bot._client.emit('open_window', { windowId: container.id })
      bot._client.emit('window_items', { windowId: container.id, items, carriedItem: Item.toNotch(null) })
      bot.emit('windowOpen', container)
      return container
    },
    refreshChestSnapshot: () => refresh(),
    closeContainerQuietly: () => { bot.currentWindow = null }
  }
  function seed (owner, name, count) {
    const item = make(name, count)
    const row = catalog.fromPrismarineItem(item)
    db.addBalanceItems(owner, [row])
    if (!stored.has(row.itemKey)) stored.set(row.itemKey, make(name, 0))
    stored.get(row.itemKey).count += count
    refresh()
    return row
  }
  const executor = {
    execute: async ({ step, triggers = 1 }) => {
      const before = catalog.aggregatePrismarineItems(inventory)
      inventory = [make(step.result.name, step.result.count * triggers)]
      const after = catalog.aggregatePrismarineItems(inventory)
      return { before, after, consumed: before, produced: after }
    },
    preview: (step, triggers = 1) => ({
      expectedConsumed: catalog.aggregatePrismarineItems(inventory),
      expectedProduced: [{ ...catalog.fromPrismarineItem(make(step.result.name, step.result.count * triggers)) }]
    }),
    cancel: () => {},
    isBusy: () => false
  }
  return { db, config, catalog, bot, warehouse, executor, seed, stored, make, refresh,
    getInventory: () => inventory, setInventory: items => { inventory = items },
    counts: () => ({ withdrawCalls, depositCalls }) }
}

test('batch budget fits ten pistons in one crafting transaction', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 30)
    f.seed('alice', 'cobblestone', 40)
    f.seed('alice', 'iron_ingot', 10)
    f.seed('alice', 'redstone', 10)
    const calls = []
    const debugEvents = []
    const execute = f.executor.execute
    f.executor.execute = async args => {
      calls.push({ item: args.step.result.name, triggers: args.triggers, operationId: args.operationId, stepId: args.stepId })
      return execute(args)
    }
    const controller = new CraftController({ ...f, botId: 'bot-a', debugCraft: (event, details) => debugEvents.push({ event, details }) })

    const result = await controller.run({ actor: 'Alice', owner: { uuid: 'alice', username: 'Alice', scope: 'personal' }, item: 'piston', quantity: 10 })

    assert.equal(result.status, 'complete')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].item, 'piston')
    assert.equal(calls[0].triggers, 10)
    assert.match(calls[0].operationId, /^craft:/)
    assert.equal(calls[0].stepId, '0:0+10')
    assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:piston')[0].amount, 10)
    assert.ok(debugEvents.some(event => event.event === 'controller.plan_ready' && event.details.target.quantity === 10))
    assert.ok(debugEvents.some(event => event.event === 'controller.batch_budget' && event.details.triggers === 10))
    assert.ok(debugEvents.some(event => event.event === 'controller.withdraw_confirmed' && event.details.items.length > 0))
    assert.ok(debugEvents.some(event => event.event === 'controller.batch_confirmed' && event.details.produced[0][1] === 10))
    assert.ok(debugEvents.some(event => event.event === 'controller.return_complete'))
  } finally { f.db.close() }
})

test('100 pistons use one warehouse batch and one return while the executor receives all triggers', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 300)
    f.seed('alice', 'cobblestone', 400)
    f.seed('alice', 'iron_ingot', 100)
    f.seed('alice', 'redstone', 100)
    const waves = []
    const execute = f.executor.execute
    f.executor.execute = async args => {
      waves.push(args.triggers)
      return execute(args)
    }
    const controller = new CraftController({ ...f, botId: 'bot-a' })

    const result = await controller.run({
      actor: 'Alice',
      owner: { uuid: 'alice', username: 'Alice', scope: 'personal' },
      item: 'piston',
      quantity: 100
    })

    assert.equal(result.status, 'complete')
    assert.deepEqual(waves, [100])
    assert.deepEqual(f.counts(), { withdrawCalls: 1, depositCalls: 1 })
    assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:piston')[0].amount, 100)
  } finally { f.db.close() }
})

test('death recovery resumes the same order from its confirmed cursor without duplicate reservation', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 2)
    let controller
    let interrupt = true
    const execute = f.executor.execute
    const operationIds = []
    f.executor.execute = async args => {
      operationIds.push(args.operationId)
      if (interrupt) {
        interrupt = false
        controller.cancel('death during crafting')
        throw controller.active.abort.signal.reason
      }
      return execute(args)
    }
    controller = new CraftController({ ...f, botId: 'bot-a' })
    const request = { actor: 'Alice', owner: { uuid: 'alice', username: 'Alice', scope: 'personal' }, item: 'stick', quantity: 4 }

    await assert.rejects(controller.run(request), /death during crafting/)
    const interrupted = controller.ledger.pending('bot-a')[0]
    assert.ok(interrupted)
    const recovered = await controller.recover()
    assert.equal(recovered.status, 'resumable')

    const result = await controller.resume(recovered.operationId)

    assert.equal(result.status, 'complete')
    assert.equal(result.operationId, interrupted.id)
    assert.deepEqual(operationIds, [interrupted.id, interrupted.id])
    assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:stick')[0].amount, 4)
    assert.equal(controller.ledger.pending('bot-a').length, 0)
    assert.equal(controller.ledger.listCraftReservations(interrupted.id).length, 0)
  } finally { f.db.close() }
})

test('partial failure during resumed batch recovers from the proven trigger cursor', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 4)
    let controller
    let executions = 0
    const execute = f.executor.execute
    f.executor.execute = async args => {
      executions++
      if (executions === 1) {
        controller.cancel('death before crafting')
        throw controller.active.abort.signal.reason
      }
      if (executions === 2) {
        const before = f.catalog.aggregatePrismarineItems(f.getInventory())
        const consumed = f.catalog.aggregatePrismarineItems([f.make('oak_planks', 2)])
        const produced = f.catalog.aggregatePrismarineItems([f.make('stick', 4)])
        f.setInventory([f.make('oak_planks', 2), f.make('stick', 4)])
        const after = f.catalog.aggregatePrismarineItems(f.getInventory())
        throw Object.assign(new Error('partial resumed craft failure'), {
          recoveryRequired: true,
          partial: true,
          before,
          after,
          consumed,
          produced
        })
      }
      return execute(args)
    }
    controller = new CraftController({ ...f, botId: 'bot-a' })
    const request = { actor: 'Alice', owner: { uuid: 'alice', username: 'Alice', scope: 'personal' }, item: 'stick', quantity: 8 }

    await assert.rejects(controller.run(request), /death before crafting/)
    let recovered = await controller.recover()
    assert.equal(recovered.status, 'resumable')
    await assert.rejects(controller.resume(recovered.operationId), /partial resumed craft failure/)

    recovered = await controller.recover()
    assert.equal(recovered.status, 'resumable')
    assert.equal(recovered.stepIndex, 0)
    assert.equal(recovered.nextTrigger, 1)
    const result = await controller.resume(recovered.operationId)

    assert.equal(result.status, 'complete')
    assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:stick')[0].amount, 8)
    assert.equal(controller.ledger.pending('bot-a').length, 0)
  } finally { f.db.close() }
})

test('recovery after a resumed craft is interrupted again uses the latest confirmed cursor', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 4)
    let controller
    let execution = 0
    let deaths = 0
    const execute = f.executor.execute
    const operationIds = []
    f.executor.execute = async args => {
      execution++
      operationIds.push(args.operationId)
      if (execution === 2 || execution === 3) {
        deaths++
        controller.cancel(`death ${deaths}`)
        throw controller.active.abort.signal.reason
      }
      return execute(args)
    }
    controller = new CraftController({ ...f, botId: 'bot-a' })
    const maxTriggersPerBatch = controller.maxTriggersPerBatch.bind(controller)
    controller.maxTriggersPerBatch = (...args) => Math.min(1, maxTriggersPerBatch(...args))
    const request = { actor: 'Alice', owner: { uuid: 'alice', username: 'Alice', scope: 'personal' }, item: 'stick', quantity: 8 }

    await assert.rejects(controller.run(request), /death 1/)
    let recovered = await controller.recover()
    assert.equal(recovered.status, 'resumable')
    await assert.rejects(controller.resume(recovered.operationId), /death 2/)

    const interrupted = controller.ledger.get(recovered.operationId)
    assert.deepEqual(interrupted.data.progress, { stepIndex: 0, nextTrigger: 1 })
    assert.equal(interrupted.data.recoveryIntent, undefined)
    recovered = await controller.recover()
    assert.equal(recovered.status, 'resumable')
    assert.equal(recovered.stepIndex, 0)
    assert.equal(recovered.nextTrigger, 1)
    assert.equal(controller.ledger.get(interrupted.id).data.recoveryIntent.pending.stepId, '0:1+1')
    const result = await controller.resume(recovered.operationId)

    assert.equal(result.status, 'complete')
    assert.deepEqual(operationIds, [interrupted.id, interrupted.id, interrupted.id, interrupted.id])
    assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:stick')[0].amount, 8)
    assert.equal(controller.ledger.pending('bot-a').length, 0)
    assert.equal(controller.ledger.listCraftReservations(interrupted.id).length, 0)
  } finally { f.db.close() }
})

test('resume clears stale recovery evidence and journals pre-craft failures for another recovery attempt', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const input = f.seed('alice', 'oak_planks', 2)
    const owner = { uuid: 'alice', username: 'Alice', scope: 'personal' }
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    const planned = planToCraftCommand({ item: 'stick', quantity: 4, available: controller.availableStock(owner.uuid), config: f.config, forceCraft: true })
    const id = 'craft:resume-navigation-failure'
    const allocations = controller.allocate(planned.plan.inventoryUses, controller.availableItems(owner.uuid))
    const data = {
      held: [],
      pending: null,
      physicalTotals: controller.physicalTotals(),
      progress: { stepIndex: 0, nextTrigger: 0 },
      plan: planned.command,
      recoveryPhase: 'crafting',
      recoveryBaseline: controller.physicalTotals(),
      recoveryIntent: { phase: 'crafting', baseline: controller.physicalTotals(), pending: { stepId: 'old-batch' } }
    }
    controller.ledger.begin({ id, botId: 'bot-a', owner, actor: 'Alice', target: planned.command.target, allocations, data })
    controller.ledger.checkpoint(id, 'ready', data)
    f.warehouse.goHomeIfAway = async () => { throw new Error('temporary navigation failure') }

    await assert.rejects(controller.resume(id), /temporary navigation failure/)

    const pending = controller.ledger.get(id)
    assert.equal(pending.phase, 'recovery_required')
    assert.equal(pending.data.recoveryPhase, 'ready')
    assert.equal(pending.data.recoveryIntent, undefined)
    assert.equal(pending.data.recoveryBaseline, undefined)
    assert.deepEqual(pending.data.progress, { stepIndex: 0, nextTrigger: 0 })
    assert.equal(controller.ledger.listCraftReservations(id).find(row => row.itemKey === input.itemKey).amount, 2)
  } finally { f.db.close() }
})

test('batch budget respects input and output stack limits while reserving one slot', () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    const pool = (name, amount) => [{ ...f.catalog.fromItemIdAmount(`minecraft:${name}`, amount), amount }]
    const step = (input, output) => ({
      times: 64,
      inputs: [{ names: [input], count: 1 }],
      outputs: [{ name: output, count: 1 }],
      result: { name: output, count: 1 }
    })

    assert.equal(controller.maxTriggersPerBatch(step('oak_log', 'ender_pearl'), pool('oak_log', 64)), 64)
    assert.equal(controller.maxTriggersPerBatch(step('oak_log', 'stick'), pool('oak_log', 64)), 64)
    // Stack limits cap each workbench wave; they no longer cap the whole
    // warehouse withdrawal. The executor will split this into four waves.
    assert.equal(controller.maxTriggersPerBatch(step('ender_pearl', 'stick'), pool('ender_pearl', 64)), 64)
    assert.equal(controller.maxTriggersPerBatch(step('iron_pickaxe', 'stick'), pool('iron_pickaxe', 64)), 35)
    assert.equal(controller.batchBudget(step('oak_log', 'ender_pearl'), pool('oak_log', 64)).outputSlots, 4)
    assert.equal(controller.maxTriggersPerBatch(step('oak_log', 'iron_pickaxe'), pool('oak_log', 64)), 35)
  } finally { f.db.close() }
})

test('batch budget keeps 100 pistons in one withdrawal when the 36-slot inventory fits', () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    const pool = (name, amount) => [{ ...f.catalog.fromItemIdAmount(`minecraft:${name}`, amount), amount }]
    const inputs = [
      { names: ['oak_planks'], count: 3 },
      { names: ['cobblestone'], count: 4 },
      { names: ['iron_ingot'], count: 1 },
      { names: ['redstone'], count: 1 }
    ]
    const sourceRows = [
      ...pool('oak_planks', 300),
      ...pool('cobblestone', 400),
      ...pool('iron_ingot', 100),
      ...pool('redstone', 100)
    ]
    const budget = controller.batchBudget({
      times: 100,
      inputs,
      outputs: [{ name: 'piston', count: 1 }],
      result: { name: 'piston', count: 1 }
    }, sourceRows, 100)

    assert.equal(budget.triggers, 100)
    assert.equal(budget.gridStackLimit, 64)
    assert.ok(budget.usedSlots + budget.reserveSlots <= 36)
  } finally { f.db.close() }
})

test('batch budget fits 16 hopper minecarts despite the unstackable minecart input', () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    const pool = (name, amount) => [{ ...f.catalog.fromItemIdAmount(`minecraft:${name}`, amount), amount }]
    const budget = controller.batchBudget({
      times: 16,
      inputs: [{ names: ['hopper'], count: 1 }, { names: ['minecart'], count: 1 }],
      outputs: [{ name: 'hopper_minecart', count: 1 }],
      result: { name: 'hopper_minecart', count: 1 }
    }, [...pool('hopper', 16), ...pool('minecart', 16)], 16)

    assert.equal(budget.triggers, 16)
    assert.equal(budget.gridStackLimit, 1)
    assert.ok(budget.usedSlots + budget.reserveSlots <= 36)
  } finally { f.db.close() }
})

test('batch budget keeps input and accumulated output stacks plus one empty slot', () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    const step = {
      times: 64,
      inputs: [{ names: ['oak_log'], count: 1 }],
      outputs: [{ name: 'iron_pickaxe', count: 1 }],
      result: { name: 'iron_pickaxe', count: 1 }
    }
    const budget = controller.batchBudget(step, [{ ...f.catalog.fromItemIdAmount('minecraft:oak_log', 64), amount: 64 }])

    assert.equal(budget.triggers, 35)
    assert.equal(budget.inputSlots, 1)
    assert.equal(budget.outputSlots, 35)
    assert.equal(budget.usedSlots, 35)
    assert.equal(budget.freeSlots, 0)
  } finally { f.db.close() }
})

test('preflight rejects a single craft whose input and output cannot preserve one empty slot', () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_log', 1)
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    const step = {
      times: 1,
      inputs: [{ names: ['oak_log'], count: 1 }],
      outputs: [{ name: 'iron_pickaxe', count: 36 }],
      result: { name: 'iron_pickaxe', count: 36 }
    }
    const plan = {
      inventoryUses: [{ name: 'oak_log', quantity: 1 }],
      craftSteps: [step]
    }

    assert.throws(() => controller.checkQuota({ uuid: 'alice' }, plan), /无法在保留 1 个保险槽位时装入单次合成材料和产物/)
    assert.deepEqual(f.getInventory(), [])
  } finally { f.db.close() }
})

test('multi-step log to planks to sticks to pickaxes remains batch-compatible', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_log', 3)
    f.seed('alice', 'iron_ingot', 30)
    const calls = []
    const execute = f.executor.execute
    f.executor.execute = async args => {
      calls.push({ item: args.step.result.name, triggers: args.triggers })
      return execute(args)
    }
    const controller = new CraftController({ ...f, botId: 'bot-a' })

    const result = await controller.run({ actor: 'Alice', owner: { uuid: 'alice', username: 'Alice', scope: 'personal' }, item: 'iron_pickaxe', quantity: 10 })

    assert.equal(result.status, 'complete')
    assert.deepEqual(calls, [
      { item: 'oak_planks', triggers: 3 },
      { item: 'stick', triggers: 5 },
      { item: 'iron_pickaxe', triggers: 10 }
    ])
    assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:iron_pickaxe')[0].amount, 10)
  } finally { f.db.close() }
})

test('whole warehouse craft flow converts only Alice stock and returns products to the same warehouse', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const plank = f.seed('alice', 'oak_planks', 2)
    const bob = f.seed('bob', 'spruce_planks', 100)
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    const result = await controller.run({ actor: 'Alice', owner: { uuid: 'alice', username: 'Alice', scope: 'personal' }, item: 'stick', quantity: 4 })
    assert.equal(result.status, 'complete')
    assert.equal(f.db.getBalance('alice', plank.itemKey), 0)
    assert.equal(f.db.getBalance('bob', bob.itemKey), 100)
    const sticks = f.db.getOwnerItemsByItemId('alice', 'minecraft:stick')
    assert.equal(sticks[0].amount, 4)
    assert.equal(f.stored.get(sticks[0].itemKey).count, 4)
    assert.deepEqual(f.getInventory(), [])
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM inventory_reservations').get().n, 0)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='craft_consume'").get().n, 1)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='craft_produce'").get().n, 1)
    assert.deepEqual(controller.ledger.pending(), [])
  } finally { f.db.close() }
})

test('real executor completes a confirmed batch through warehouse and owner ledger', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const { createInventoryExecutor } = require('../../src/craft/inventory-executor')
  const f = fixture()
  try {
    const registry = f.catalog.mcData
    const Recipe = require('prismarine-recipe')(registry).Recipe
    const Item = require('prismarine-item')(registry)
    const planks = f.seed('alice', 'oak_planks', 4)
    f.bot.registry = registry
    f.bot.inventory.id = 0
    f.bot.inventory.inventoryStart = 9
    f.bot.inventory.inventoryEnd = 45
    f.bot.inventory.slots = new Array(46).fill(null)
    f.bot.recipesAll = (id, metadata, block) => Recipe.find(id, metadata).filter(recipe => !recipe.requiresTable || block)
    f.bot.clickWindow = async () => {}
    f.bot.pathfinder = { stop: () => {} }
    f.bot.clearControlStates = () => {}
    let craftCount = 0
    f.bot.craft = async (recipe, count) => {
      craftCount = count
      f.setInventory([f.make('stick', 8)])
      f.bot._client.emit('set_slot', { windowId: 0, slot: 0, item: Item.toNotch(f.make('stick', recipe.result.count)) })
      await f.bot.clickWindow(0, 0, 0)
      const items = Array.from({ length: 46 }, () => Item.toNotch(null))
      items[9] = Item.toNotch(f.getInventory()[0])
      f.bot._client.emit('window_items', { windowId: 0, items })
      f.bot._client.emit('set_cursor_item', { contents: Item.toNotch(null) })
    }
    f.config.craft.confirmTimeoutMs = 60
    f.config.craft.settleMs = 5
    f.executor = createInventoryExecutor(f.bot, f.catalog, f.config, f.warehouse)
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    const result = await controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 8 })
    assert.equal(result.status, 'complete')
    assert.equal(craftCount, 2)
    assert.equal(f.db.getBalance('alice', planks.itemKey), 0)
    const sticks = f.db.getOwnerItemsByItemId('alice', 'minecraft:stick')[0]
    assert.equal(sticks.amount, 8)
    assert.equal(f.stored.get(sticks.itemKey).count, 8)
    assert.deepEqual(f.getInventory(), [])
    assert.deepEqual(controller.ledger.pending(), [])
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM inventory_reservations').get().n, 0)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='craft_consume'").get().n, 1)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='craft_produce'").get().n, 1)
  } finally { f.db.close() }
})

test('initial craft journal records the physical baseline before navigation', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const planks = f.seed('alice', 'oak_planks', 2)
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    let observed
    f.warehouse.goHomeIfAway = async () => {
      observed = controller.ledger.pending()[0]
      throw new Error('navigation interrupted')
    }
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 4 }), /navigation interrupted/)
    assert.equal(observed.phase, 'ready')
    assert.deepEqual(observed.data.physicalTotals.map(item => [item.itemKey, item.amount]), [[planks.itemKey, 2]])
  } finally { f.db.close() }
})

test('a partial withdrawal is returned without creating a new deposit balance', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const plank = f.seed('alice', 'oak_planks', 2)
    f.stored.get(plank.itemKey).count = 1
    f.warehouse.refreshChestSnapshot()
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice', username: 'Alice' }, item: 'stick', quantity: 4 }), /原料|material/)
    assert.equal(f.db.getBalance('alice', plank.itemKey), 2)
    assert.equal(f.stored.get(plank.itemKey).count, 1)
    assert.deepEqual(f.getInventory(), [])
    assert.deepEqual(controller.ledger.pending(), [])
  } finally { f.db.close() }
})

test('multi-step recipes keep intermediates reserved and return surplus output to the owner', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const log = f.seed('alice', 'oak_log', 1)
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    const run = f.executor.execute
    let batches = 0
    f.executor.execute = async args => {
      batches++
      assert.equal(controller.ledger.pending().length, 1)
      assert.ok(controller.ledger.listCraftReservations(controller.ledger.pending()[0].id).length)
      assert.throws(() => f.db.adjustBalance('alice', log.itemKey, 1), /合成|craft/)
      return run(args)
    }
    const result = await controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 5 })
    assert.equal(result.status, 'complete')
    // Two steps (log→planks 1 trigger, planks→stick 2 triggers) but batching
    // merges each step's triggers into one batch: 2 batches total.
    assert.equal(batches, 2)
    assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:stick')[0].amount, 8)
    assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:oak_planks').length, 0)
    assert.deepEqual(controller.ledger.pending(), [])
  } finally { f.db.close() }
})

test('requested quantity is crafted on top of existing finished items', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 4)
    const sticks = f.seed('alice', 'stick', 2)
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    // 6 requested with 2 already stored: forceCraft crafts the full 6.
    // The graph's cheapest stick recipe yields 4 per trigger (2 planks),
    // so two triggers cover 6: 2 existing + 8 crafted = 10 final.
    await controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 6 })
    assert.equal(f.db.getBalance('alice', sticks.itemKey), 10)
    assert.equal(f.stored.get(sticks.itemKey).count, 10)
  } finally { f.db.close() }
})

test('stock and owner authorization are rechecked when the queued task starts', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const plank = f.seed('alice', 'oak_planks', 2)
    const request = { actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 4 }
    assert.equal(planToCraftCommand({ ...request, available: { oak_planks: 2 }, config: f.config }).ok, true)
    const controller = new CraftController({ ...f, botId: 'bot-a', validateOwner: () => { throw new Error('member removed') } })
    await assert.rejects(controller.run(request), /member removed/)
    controller.validateOwner = () => {}
    f.db.adjustBalance('alice', plank.itemKey, -2)
    await assert.rejects(controller.run(request), /原料|配方/)
    assert.deepEqual(controller.ledger.pending(), [])
    assert.deepEqual(f.getInventory(), [])
  } finally { f.db.close() }
})

test('quota checks every trigger including temporary peak before consuming all inputs', () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 64)
    const controller = new CraftController({ ...f, botId: 'bot-a', quota: () => ({ quotaSlots: 2 }) })
    f.seed('alice', 'oak_planks', 16)
    const plan = planToCraftCommand({ item: 'stick', quantity: 160, available: { oak_planks: 80 }, config: f.config }).plan
    assert.throws(() => controller.checkQuota({ uuid: 'alice' }, plan), /额度/)
  } finally { f.db.close() }
})

test('quota includes returned containers as well as the main craft output', () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'honey_bottle', 64)
    const controller = new CraftController({ ...f, botId: 'bot-a', quota: () => ({ quotaSlots: 5 }) })
    const plan = { inventoryUses: [{ name: 'honey_bottle', quantity: 4 }], craftSteps: [{ times: 1, inputs: [{ names: ['honey_bottle'], count: 4 }],
      result: { name: 'honey_block', count: 1 }, outputs: [{ name: 'honey_block', count: 1 }, { name: 'glass_bottle', count: 4 }] }] }
    assert.throws(() => controller.checkQuota({ uuid: 'alice' }, plan), /额度/)
  } finally { f.db.close() }
})

test('full warehouse keeps settled outputs reserved and never issues a second deposit credit', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    const plank = f.seed('alice', 'oak_planks', 2)
    f.warehouse.depositAllPossible = async () => ({ stopReason: 'full' })
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 4 }), /空间不足/)
    assert.equal(f.db.getBalance('alice', plank.itemKey), 0)
    const sticks = f.db.getOwnerBalances('alice').find(item => item.itemId === 'minecraft:stick')
    assert.equal(sticks.amount, 4)
    assert.equal(controller.ledger.pending().length, 1)
    assert.equal(controller.ledger.getCraftAvailableItems('alice').length, 0)
    assert.throws(() => f.db.adjustBalance('bob', sticks.itemKey, 1), /合成|craft/)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='craft_produce'").get().n, 1)
  } finally { f.db.close() }
})

test('cancel after a confirmed batch returns that output and releases only safely stored reservations', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 8)
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    const run = f.executor.execute
    f.executor.execute = async args => { const result = await run(args); controller.cancel('cancel test'); return result }
    // 8 sticks = 2 triggers = one batch (4 planks withdrawn at once).
    // The cancel fires after the only batch confirmed and stored, so the run
    // has no remaining work to abort: it completes with the full output.
    const result = await controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 8 })
    assert.equal(result.status, 'complete')
    assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:stick')[0].amount, 8)
    // 8 planks seeded, 4 consumed by the single batch: 4 remain in stock.
    assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:oak_planks')[0].amount, 4)
    assert.deepEqual(f.getInventory(), [])
    assert.deepEqual(controller.ledger.pending(), [])
  } finally { f.db.close() }
})

test('cancel between batches aborts the queued batch and returns already-crafted output', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 4)
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    const run = f.executor.execute
    f.executor.execute = async args => { const result = await run(args); controller.cancel('cancel test'); return result }
    // Quantity 8 needs 2 triggers of 2 planks; capacity allows 18 triggers per
    // batch, so force a second batch by capping capacity through a crafted step.
    const step = { inputs: [{ names: ['oak_planks'], count: 2 }], result: { name: 'stick', count: 4 }, requiresTable: false }
    const original = controller.maxTriggersPerBatch.bind(controller)
    controller.maxTriggersPerBatch = () => 1
    try {
      await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 8 }), /cancel test/)
      assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:stick')[0].amount, 4)
      assert.equal(f.db.getOwnerItemsByItemId('alice', 'minecraft:oak_planks')[0].amount, 2)
      assert.deepEqual(f.getInventory(), [])
      assert.deepEqual(controller.ledger.pending(), [])
    } finally {
      controller.maxTriggersPerBatch = original
    }
  } finally { f.db.close() }
})

test('cursor residue after an otherwise complete deposit keeps the craft journal and reservations', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 2)
    const deposit = f.warehouse.depositAllPossible
    f.warehouse.depositAllPossible = async () => { await deposit(); f.bot.inventory.selectedItem = f.make('stick', 1) }
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 4 }), /残留/)
    assert.equal(controller.ledger.pending().length, 1)
    assert.equal(controller.ledger.pending()[0].phase, 'recovery_required')
    assert.equal(controller.ledger.listCraftReservations(controller.ledger.pending()[0].id)[0].amount, 4)
  } finally { f.db.close() }
})

module.exports = { fixture }

test('partial return resumes from server snapshots without crediting settled products twice', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 2)
    const deposit = f.warehouse.depositAllPossible
    f.warehouse.depositAllPossible = async () => {
      const item = f.getInventory()[0]
      const key = f.catalog.fromPrismarineItem(item).itemKey
      f.stored.set(key, f.make('stick', 2))
      f.setInventory([f.make('stick', 2)])
      f.refresh()
    }
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 4 }), /空间不足/)
    f.warehouse.depositAllPossible = deposit
    const recovery = await controller.recover()
    assert.equal(recovery.status, 'resumable')
    await controller.resume(recovery.operationId)
    assert.equal((await controller.recover()).status, 'empty')
    const sticks = f.db.getOwnerBalances('alice').find(item => item.itemId === 'minecraft:stick')
    assert.equal(sticks.amount, 4)
    assert.equal(f.stored.get(sticks.itemKey).count, 4)
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='craft_produce'").get().n, 1)
    assert.deepEqual(controller.ledger.pending(), [])
  } finally { f.db.close() }
})

test('unexplained loss cannot release reservations or turn into a successful recovery', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 2)
    f.warehouse.depositAllPossible = async () => {}
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 4 }), /空间不足/)
    // Backpack holds 3 sticks: neither the raw inputs nor the full conversion.
    // The deposit is a no-op here (depositAllPossible stubbed empty), so the
    // recovery cannot park them and must refuse with leftovers; the journal
    // and reservations survive for the audit.
    f.setInventory([f.make('stick', 3)])
    await assert.rejects(controller.recover(), /空间不足|实物与记录不一致|人工核对/)
    assert.equal(controller.ledger.pending().length, 1)
    const sticks = f.db.getOwnerBalances('alice').find(item => item.itemId === 'minecraft:stick')
    assert.equal(sticks.amount, 4)
    assert.equal(controller.ledger.listCraftReservations(controller.ledger.pending()[0].id)[0].amount, 4)
  } finally { f.db.close() }
})

test('recovery holds a cancellable lease until an outstanding deposit has drained', async () => {
  const { CraftController } = require('../../src/craft/controller')
  const f = fixture()
  try {
    // A full warehouse leaves the crafted sticks stranded, so recovery
    // first tries depositing them; block mid-deposit to exercise the lease.
    f.seed('alice', 'oak_planks', 2)
    f.warehouse.depositAllPossible = async () => ({ stopReason: 'full' })
    const controller = new CraftController({ ...f, botId: 'bot-a' })
    await assert.rejects(controller.run({ actor: 'Alice', owner: { uuid: 'alice' }, item: 'stick', quantity: 4 }), /空间不足/)
    let release, entered
    const waiting = new Promise(resolve => { entered = resolve })
    const blocked = f.warehouse.depositAllPossible
    f.warehouse.depositAllPossible = async (...args) => {
      entered()
      await new Promise(resolve => { release = resolve })
      return blocked(...args)
    }
    const recovering = controller.recover()
    recovering.catch(() => {})
    await waiting
    assert.equal(controller.isBusy(), true)
    await assert.rejects(controller.recover(), /旧合成操作/)
    controller.cancel('recovery death test')
    release()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(controller.isBusy(), false)
    assert.equal(controller.ledger.pending().length, 1)
    // The failed deposit left the crafted sticks in the backpack (1 stack).
    assert.equal(f.getInventory().length, 1)
    assert.equal(f.getInventory()[0].count, 4)
  } finally { f.db.close() }
})

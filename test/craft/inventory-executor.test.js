'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const ItemCatalog = require('../../src/itemCatalog')
const registry = require('minecraft-data')('1.21.11')
const Recipe = require('prismarine-recipe')(registry).Recipe
const Item = require('prismarine-item')(registry)
const { createInventoryExecutor } = require('../../src/craft/inventory-executor')
const { withStandardRecipeOutputs } = require('../../src/craft/recipe-outputs')

function item (name, count, customName) {
  const value = new Item(registry.itemsByName[name].id, count, null)
  if (customName) value.components = [{ type: 'custom_name', data: customName }]
  return value
}

function copyItem (value) {
  if (!value) return null
  const copy = new Item(value.type, value.count, value.metadata, value.nbt)
  if (value.components) copy.components = structuredClone(value.components)
  if (value.removedComponents) copy.removedComponents = structuredClone(value.removedComponents)
  return copy
}

function fixture (before, after, options = {}) {
  const bot = new EventEmitter()
  let inventory = before
  const calls = []
  const table = { name: 'crafting_table', position: new Vec3(10, 64, 10) }
  const slots = new Array(46).fill(null)
  before.forEach((value, index) => { value.slot = 9 + index; slots[9 + index] = value })
  bot._client = new EventEmitter()
  bot.registry = registry
  bot.inventory = { id: 0, inventoryStart: 9, inventoryEnd: 45, items: () => inventory, selectedItem: null, slots }
  bot.entity = { position: new Vec3(10, 64, 9), height: 1.8 }
  bot.pathfinder = { stop: () => calls.push('stop') }
  bot.clearControlStates = () => calls.push('clear')
  bot.blockAt = () => table
  // Autodiscovery scans for crafting tables when the configured coordinate
  // is missing or unreachable; the fake world only has the configured table.
  bot.findBlocks = () => [table.position.clone()]
  bot.closeWindow = window => {
    calls.push(['close', window])
    bot.currentWindow = null
  }
  bot.recipesAll = (id, metadata, block) => Recipe.find(id, metadata).filter(recipe => !recipe.requiresTable || block)
  bot.clickWindow = async slot => calls.push(['click', slot])
  bot.craft = async (recipe, count, block) => {
    calls.push(['craft', recipe, count, block])
    inventory = after
    if (options.predictedOnly) return
    if (block) {
      const window = { id: 3, type: 'minecraft:crafting', inventoryStart: 10, inventoryEnd: 46, slots: new Array(46).fill(null) }
      bot.currentWindow = window
      bot.emit('windowOpen', window)
    }
    const windowId = bot.currentWindow?.id || 0
    bot._client.emit('set_slot', { windowId, slot: 0, item: Item.toNotch(item(registry.items[recipe.result.id].name, recipe.result.count)) })
    await bot.clickWindow(0, 0, 0)
    const serverSlots = Array.from({ length: 46 }, () => Item.toNotch(null))
    after.forEach((value, index) => { serverSlots[(block ? 10 : 9) + index] = Item.toNotch(value) })
    bot._client.emit('window_items', { windowId, items: serverSlots })
    bot._client.emit('set_cursor_item', { contents: Item.toNotch(null) })
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
  }
  const warehouse = { gotoNear: async (...position) => calls.push(['goto', ...position]) }
  const catalog = new ItemCatalog('1.21.11', {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })
  const config = { craft: { table: { x: 10, y: 64, z: 10 }, timeoutMs: 5000, confirmTimeoutMs: 60, settleMs: 5 } }
  const debugEvents = []
  const debugCraft = options.debugCraft || ((event, details) => debugEvents.push({ event, details }))
  const executor = createInventoryExecutor(bot, catalog, config, warehouse, debugCraft)
  return { bot, calls, table, warehouse, catalog, config, executor, debugEvents, setInventory: value => { inventory = value } }
}

function proportionalFixture (before, after, step, { triggers = 1, waveAfter = null, noResultPacket = false, residualResult = false, serverResidual = false, residualAfterCleanup = false, resultReappearsAfterFirstCleanupCollection = false, delayedShiftUpdate = false, staleShiftUpdate = false, delayedPlacementUpdate = false, debugCraft } = {}) {
  const f = fixture(before, after, { debugCraft })
  const gridWidth = step.requiresTable ? 3 : 2
  const craftingWindow = (id, type, inventoryStart) => {
    const slots = new Array(46).fill(null)
    before.forEach((value, index) => { slots[inventoryStart + index] = copyItem(value) })
    return {
      id,
      type,
      inventoryStart,
      inventoryEnd: 46,
      slots,
      selectedItem: null,
      findInventoryItem (type, metadata) {
        for (let slot = inventoryStart; slot < 46; slot++) {
          const value = slots[slot]
          if (value && value.type === type && (metadata == null || value.metadata === metadata)) return { ...value, slot }
        }
        return null
      }
    }
  }
  const playerWindow = craftingWindow(0, 'minecraft:inventory', 9)
  playerWindow.items = () => playerWindow.slots.slice(9, 45).flatMap((value, index) => value ? [{ ...value, slot: 9 + index }] : [])
  f.bot.inventory = playerWindow
  const clicks = []
  const emitState = window => {
    const windowId = window.id
    const slots = window.slots.map(value => Item.toNotch(value))
    f.bot._client.emit('window_items', { windowId, items: slots, carriedItem: Item.toNotch(window.selectedItem) })
    f.bot._client.emit('set_cursor_item', { contents: Item.toNotch(window.selectedItem) })
  }
  let shiftCount = 0
  let shifted = false
  let cleanupResultCount = 0
  let cleanupResultCollectionCount = 0
  let refillResultAfterParking = false
  const setAfter = () => {
    const state = Array.isArray(waveAfter) && waveAfter.length
      ? waveAfter[Math.min(shiftCount, waveAfter.length - 1)]
      : after
    shiftCount++
    f.setInventory(state)
    for (const window of [playerWindow, f.bot.currentWindow].filter(Boolean)) {
      window.slots[0] = null
      const start = window.inventoryStart
      for (let slot = start; slot < 46; slot++) window.slots[slot] = null
      state.forEach((value, index) => { window.slots[start + index] = copyItem(value) })
    }
  }
  f.bot.activateBlock = async () => {
    const window = craftingWindow(3, 'minecraft:crafting', 10)
    f.bot.currentWindow = window
    f.bot.emit('windowOpen', window)
  }
  let placementAckPending = false
  let placementAckTimer
  let shiftUpdatePending = false
  f.bot.clickWindow = async (slot, mouseButton = 0, mode = 0) => {
    const window = f.bot.currentWindow || playerWindow
    clicks.push({ windowId: window.id, slot, mouseButton, mode, grid: window.slots.slice(1, 1 + gridWidth * gridWidth).map(value => value?.count || 0) })
    if (mode === 1 && slot === 0) {
      shifted = true
      if (placementAckPending) throw new Error('shift-click started before the server confirmed the crafting grid')
      let recipe
      if (!noResultPacket && !delayedShiftUpdate) {
        recipe = f.bot.recipesAll(registry.itemsByName[step.result.name].id, null, step.requiresTable ? f.table : undefined)
          .find(value => value.requiresTable === step.requiresTable && value.result.count === step.result.count)
        recipe = withStandardRecipeOutputs(registry, recipe)
        f.bot._client.emit('set_slot', { windowId: window.id, slot: 0, item: Item.toNotch(new Item(recipe.result.id, recipe.result.count, recipe.result.metadata)) })
      }
      if (delayedShiftUpdate) {
        recipe = f.bot.recipesAll(registry.itemsByName[step.result.name].id, null, step.requiresTable ? f.table : undefined)
          .find(value => value.requiresTable === step.requiresTable && value.result.count === step.result.count)
        recipe = withStandardRecipeOutputs(registry, recipe)
        f.bot._client.emit('set_slot', { windowId: window.id, slot: 0, item: Item.toNotch(new Item(recipe.result.id, recipe.result.count, recipe.result.metadata)) })
        shiftUpdatePending = true
        if (staleShiftUpdate) emitState(window)
        setTimeout(() => {
          for (let cell = 1; cell < 1 + gridWidth * gridWidth; cell++) window.slots[cell] = null
          setAfter()
          shiftUpdatePending = false
          emitState(window)
        }, 20)
        return
      }
      const placed = window.slots.slice(1, 1 + gridWidth * gridWidth).filter(Boolean)
      const waveTriggers = placed.length ? Math.min(...placed.map(value => value.count)) : triggers
      for (let cell = 1; cell < 1 + gridWidth * gridWidth; cell++) window.slots[cell] = null
      setAfter()
      if (residualResult) window.slots[0] = new Item(recipe?.result?.id || registry.itemsByName[step.result.name].id, recipe?.result?.count || step.result.count, recipe?.result?.metadata || null)
      if (recipe?.outShape) {
        recipe.outShape.forEach((row, y) => row.forEach((remainder, x) => {
          if (remainder?.id >= 0) window.slots[1 + x + gridWidth * y] = new Item(remainder.id, remainder.count * waveTriggers, remainder.metadata)
        }))
      }
    } else if (mode === 0) {
      if (delayedShiftUpdate && shifted && shiftUpdatePending && slot === 0) {
        throw new Error('craft result collected before the server confirmed grid consumption')
      }
      if (shiftUpdatePending && slot > 0 && slot < 1 + gridWidth * gridWidth) {
        throw new Error('craft grid clicked before the server confirmed the shift-click')
      }
      const current = window.slots[slot]
      if (mouseButton === 0) {
        if (!window.selectedItem) {
          window.selectedItem = current
          window.slots[slot] = null
        } else if (!current) {
          window.slots[slot] = window.selectedItem
          window.selectedItem = null
        } else if (current.type === window.selectedItem.type && current.metadata === window.selectedItem.metadata && current.count + window.selectedItem.count <= current.stackSize) {
          current.count += window.selectedItem.count
          window.selectedItem = null
        } else {
          window.slots[slot] = window.selectedItem
          window.selectedItem = current
        }
      } else if (!window.selectedItem && current) {
        const count = Math.ceil(current.count / 2)
        window.selectedItem = new Item(current.type, count, current.metadata)
        current.count -= count
        if (current.count === 0) window.slots[slot] = null
      } else if (window.selectedItem && (!current || (current.type === window.selectedItem.type && current.metadata === window.selectedItem.metadata))) {
        if (!current) window.slots[slot] = new Item(window.selectedItem.type, 1, window.selectedItem.metadata)
        else current.count++
        window.selectedItem.count--
        if (window.selectedItem.count === 0) window.selectedItem = null
      }
    }
    if (mode === 0 && slot > 0 && slot < 1 + gridWidth * gridWidth && delayedPlacementUpdate) {
      placementAckPending = true
      clearTimeout(placementAckTimer)
      placementAckTimer = setTimeout(() => {
        placementAckPending = false
        emitState(window)
      }, 20)
    } else {
      emitState(window)
    }
    if (window !== playerWindow) {
      const offset = window.inventoryStart - playerWindow.inventoryStart
      for (let sourceSlot = window.inventoryStart; sourceSlot < window.inventoryEnd; sourceSlot++) {
        playerWindow.slots[sourceSlot - offset] = copyItem(window.slots[sourceSlot])
      }
    }
    if (resultReappearsAfterFirstCleanupCollection && shifted && cleanupResultCount > 0 &&
      slot === 0 && mouseButton === 0 && mode === 0 && cleanupResultCollectionCount++ === 0) {
      refillResultAfterParking = true
    }
    if (refillResultAfterParking && slot >= window.inventoryStart && slot < window.inventoryEnd && !window.selectedItem) {
      refillResultAfterParking = false
      window.slots[0] = new Item(registry.itemsByName[step.result.name].id, step.result.count)
      emitState(window)
    }
    if (residualAfterCleanup && shifted && mode === 0 && slot > 0 && slot < 1 + gridWidth * gridWidth && cleanupResultCount++ === 0) {
      window.slots[0] = new Item(registry.itemsByName[step.result.name].id, step.result.count)
      emitState(window)
    }
    if (serverResidual && mode === 1 && slot === 0) {
      const recipe = f.bot.recipesAll(registry.itemsByName[step.result.name].id, null, step.requiresTable ? f.table : undefined)
        .find(value => value.requiresTable === step.requiresTable && value.result.count === step.result.count)
      f.bot._client.emit('set_slot', { windowId: window.id, slot: 0, item: Item.toNotch(new Item(recipe.result.id, recipe.result.count, recipe.result.metadata)) })
    }
  }
  return { ...f, clicks }
}

test('compacts only identical stackable inventory items before crafting', async () => {
  const first = item('cherry_planks', 40)
  const second = item('cherry_planks', 40)
  const third = item('cherry_planks', 40)
  const unique = item('cherry_planks', 1, 'kept-separate')
  const nonStackable = item('minecart', 1)
  const f = fixture([first, second, third, unique, nonStackable], [])
  const inventory = f.bot.inventory
  inventory.items = () => inventory.slots.slice(inventory.inventoryStart, inventory.inventoryEnd)
    .flatMap((value, index) => value ? [{ ...value, slot: inventory.inventoryStart + index }] : [])
  const moves = []
  f.bot.moveSlotItem = async (sourceSlot, targetSlot) => {
    moves.push([sourceSlot, targetSlot])
    const source = inventory.slots[sourceSlot]
    const target = inventory.slots[targetSlot]
    assert.ok(source)
    assert.ok(target)
    assert.equal(f.catalog.fromPrismarineItem(source).itemKey, f.catalog.fromPrismarineItem(target).itemKey)
    const moved = Math.min(source.count, target.stackSize - target.count)
    target.count += moved
    source.count -= moved
    if (!source.count) inventory.slots[sourceSlot] = null
  }

  const result = await f.executor.compactInventoryStacks(inventory, () => {})

  assert.equal(result.changed, true)
  assert.equal(moves.length, 2)
  const commonKey = f.catalog.fromPrismarineItem(first).itemKey
  assert.deepEqual(inventory.items().filter(value => f.catalog.fromPrismarineItem(value).itemKey === commonKey)
    .map(value => value.count).sort((a, b) => a - b), [56, 64])
  assert.equal(inventory.slots[12].components?.[0]?.data, 'kept-separate')
  assert.equal(inventory.slots[13].name, 'minecart')
  assert.equal(result.before.find(value => value.itemKey === commonKey).amount, 120)
  assert.equal(result.after.find(value => value.itemKey === commonKey).amount, 120)
})

test('stack compaction skips when the moveSlotItem API is absent', async () => {
  const f = fixture([item('cherry_planks', 40), item('cherry_planks', 40), item('cherry_planks', 40)], [])
  const before = f.bot.inventory.slots.slice(9, 12).map(value => value?.count || 0)

  const result = await f.executor.compactInventoryStacks(f.bot.inventory, () => {})

  assert.equal(result.skipped, true)
  assert.deepEqual(f.bot.inventory.slots.slice(9, 12).map(value => value?.count || 0), before)
})

test('stack compaction refuses to run while the cursor holds an item', async () => {
  const f = fixture([item('cherry_planks', 40), item('cherry_planks', 40), item('cherry_planks', 40)], [])
  f.bot.moveSlotItem = async () => assert.fail('must not move items with a nonempty cursor')
  f.bot.inventory.selectedItem = item('oak_planks', 1)

  await assert.rejects(f.executor.compactInventoryStacks(f.bot.inventory, () => {}), error =>
    error.recoveryRequired === true && /empty cursor/.test(error.message))
})

test('stack compaction stops if another window opens between confirmed moves', async () => {
  const f = fixture([item('cherry_planks', 40), item('cherry_planks', 40), item('cherry_planks', 40)], [])
  const inventory = f.bot.inventory
  inventory.items = () => inventory.slots.slice(9, 45).flatMap((value, index) => value ? [{ ...value, slot: 9 + index }] : [])
  let moves = 0
  f.bot.moveSlotItem = async (sourceSlot, targetSlot) => {
    moves++
    const source = inventory.slots[sourceSlot]
    const target = inventory.slots[targetSlot]
    const moved = Math.min(source.count, target.stackSize - target.count)
    target.count += moved
    source.count -= moved
    if (!source.count) inventory.slots[sourceSlot] = null
    if (moves === 1) f.bot.currentWindow = { id: 2 }
  }

  await assert.rejects(f.executor.compactInventoryStacks(inventory, () => {}), error => error.recoveryRequired === true)
  assert.equal(moves, 1)
})

const stickStep = {
  recipeId: 'sticks', requiresTable: false,
  result: { name: 'stick', count: 4 },
  inputs: [{ names: ['oak_planks'], count: 2 }]
}

function amounts (items) {
  return items.map(({ itemId, amount }) => [itemId, amount]).sort((a, b) => a[0].localeCompare(b[0]))
}

test('2x2 crafting consumes only the concrete input variants and produces one trigger', async () => {
  const f = fixture([item('oak_planks', 1, 'Alice'), item('oak_planks', 1, 'Bob')], [item('stick', 4)])
  const result = await f.executor.execute({ step: { ...stickStep, times: 99 } })
  assert.deepEqual(amounts(result.before), [['minecraft:oak_planks', 1], ['minecraft:oak_planks', 1]])
  assert.deepEqual(amounts(result.after), [['minecraft:stick', 4]])
  assert.deepEqual(result.consumed.map(entry => entry.itemKey).sort(), result.before.map(entry => entry.itemKey).sort())
  assert.deepEqual(amounts(result.produced), [['minecraft:stick', 4]])
  const craft = f.calls.find(call => Array.isArray(call) && call[0] === 'craft')
  assert.equal(craft[2], 1)
  assert.equal(craft[3], undefined)
  assert.equal(f.executor.isBusy(), false)
})

test('batch crafting matches a real recipe across all triggers and split input stacks', async () => {
  const f = fixture([item('oak_planks', 1, 'Alice'), item('oak_planks', 3, 'Bob')], [item('stick', 8)])
  const preview = f.executor.preview(stickStep, 2)
  assert.deepEqual(amounts(preview.expectedConsumed), [['minecraft:oak_planks', 1], ['minecraft:oak_planks', 3]])
  assert.deepEqual(amounts(preview.expectedProduced), [['minecraft:stick', 8]])
  const result = await f.executor.execute({ step: stickStep, triggers: 2 })
  assert.deepEqual(amounts(result.consumed), amounts(preview.expectedConsumed))
  assert.deepEqual(amounts(result.produced), [['minecraft:stick', 8]])
  assert.equal(f.calls.find(call => Array.isArray(call) && call[0] === 'craft')[2], 2)
})

test('batch crafting scales real recipe container remainders', async () => {
  const f = fixture([item('honey_bottle', 8)], [item('honey_block', 2), item('glass_bottle', 8)])
  const step = { requiresTable: false, result: { name: 'honey_block', count: 1 }, inputs: [{ names: ['honey_bottle'], count: 4 }] }
  assert.deepEqual(amounts(f.executor.preview(step, 2).expectedProduced), [['minecraft:glass_bottle', 8], ['minecraft:honey_block', 2]])
  const result = await f.executor.execute({ step, triggers: 2 })
  assert.deepEqual(amounts(result.produced), [['minecraft:glass_bottle', 8], ['minecraft:honey_block', 2]])
})

test('batch crafting matches a real 3x3 recipe', async () => {
  const f = fixture([item('oak_planks', 16)], [item('chest', 2)])
  const step = { requiresTable: true, result: { name: 'chest', count: 1 }, inputs: [{ names: ['oak_planks'], count: 8 }] }
  assert.deepEqual(amounts(f.executor.preview(step, 2).expectedProduced), [['minecraft:chest', 2]])
  const result = await f.executor.execute({ step, triggers: 2 })
  assert.deepEqual(amounts(result.produced), [['minecraft:chest', 2]])
  assert.equal(f.calls.find(call => Array.isArray(call) && call[0] === 'craft')[3], f.table)
})

test('2x2 batch crafting fills proportional inputs and collects the result with one shift-click', async () => {
  const step = { ...stickStep, requiresTable: false }
  const f = proportionalFixture([item('oak_planks', 2), item('oak_planks', 2)], [item('stick', 8)], step, { triggers: 2 })
  const result = await f.executor.execute({ step, triggers: 2 })
  assert.deepEqual(amounts(result.produced), [['minecraft:stick', 8]])
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'craft'), false)
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mouseButton === 0 && click.mode === 1).length, 1)
  assert.deepEqual(f.clicks.find(click => click.slot === 0 && click.mode === 1).grid, [2, 0, 2, 0])
})

test('proportional execution logs click intent, server slot/cursor updates and exact output evidence', async () => {
  const step = { ...stickStep, requiresTable: false }
  const f = proportionalFixture([item('oak_planks', 2), item('oak_planks', 2)], [item('stick', 8)], step, { triggers: 2 })

  const result = await f.executor.execute({ step, triggers: 2, operationId: 'craft:debug', stepId: '0:0+2' })

  assert.deepEqual(amounts(result.produced), [['minecraft:stick', 8]])
  const shiftClick = f.debugEvents.find(event => event.event === 'executor.window_click_start' && event.details.slot === 0 && event.details.mode === 1)
  assert.ok(shiftClick)
  assert.equal(shiftClick.details.operationId, 'craft:debug')
  assert.ok(f.debugEvents.some(event => event.event === 'executor.server_slot_update' &&
    event.details.slot === 0 && event.details.item?.itemId === 'minecraft:stick'))
  assert.ok(f.debugEvents.some(event => event.event === 'executor.server_cursor_update' && event.details.item === null))
  const placement = f.debugEvents.find(event => event.event === 'executor.grid_placement_plan')
  assert.ok(placement.details.placements.every(cell => cell.sources[0].amount === 2 && cell.sources[0].availableBefore === 2))
  const confirmation = f.debugEvents.find(event => event.event === 'executor.inventory_confirmed')
  assert.deepEqual(confirmation.details.expected, [['minecraft:stick', 8]])
  assert.deepEqual(confirmation.details.observed, [['minecraft:stick', 8]])
})

test('2x2 proportional placement can split one input cell across matching stacks', async () => {
  const step = { ...stickStep, requiresTable: false }
  const f = proportionalFixture([item('oak_planks', 2), item('oak_planks', 1), item('oak_planks', 3)], [item('stick', 12)], step, { triggers: 3 })
  const result = await f.executor.execute({ step, triggers: 3 })
  assert.deepEqual(amounts(result.produced), [['minecraft:stick', 12]])
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'craft'), false)
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mouseButton === 0 && click.mode === 1).length, 1)
})

test('2x2 proportional placement maps shapeless ingredients to separate grid cells', async () => {
  const plankId = registry.itemsByName.oak_planks.id
  const stickId = registry.itemsByName.stick.id
  const step = { requiresTable: false, result: { name: 'stick', count: 1 }, inputs: [{ names: ['oak_planks'], count: 2 }] }
  const f = proportionalFixture([item('oak_planks', 4)], [item('stick', 2)], step, { triggers: 2 })
  f.bot.recipesAll = () => [{
    result: { id: stickId, metadata: null, count: 1 },
    inShape: null,
    ingredients: [{ id: plankId, metadata: null, count: -1 }, { id: plankId, metadata: null, count: -1 }],
    requiresTable: false,
    outShape: null,
    delta: [{ id: plankId, metadata: null, count: -2 }, { id: stickId, metadata: null, count: 1 }]
  }]
  const result = await f.executor.execute({ step, triggers: 2 })
  assert.deepEqual(amounts(result.produced), [['minecraft:stick', 2]])
  assert.deepEqual(f.clicks.find(click => click.slot === 0 && click.mode === 1).grid, [2, 2, 0, 0])
})

test('3x3 table batch crafting fills the shaped grid proportionally and shift-clicks once', async () => {
  const step = { requiresTable: true, result: { name: 'chest', count: 1 }, inputs: [{ names: ['oak_planks'], count: 8 }] }
  const f = proportionalFixture([item('oak_planks', 16)], [item('chest', 2)], step, { triggers: 2 })
  const result = await f.executor.execute({ step, triggers: 2 })
  assert.deepEqual(amounts(result.produced), [['minecraft:chest', 2]])
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'craft'), false)
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mouseButton === 0 && click.mode === 1).length, 1)
  assert.deepEqual(f.clicks.find(click => click.slot === 0 && click.mode === 1).grid, [2, 2, 2, 2, 0, 2, 2, 2, 2])
})

test('100-trigger 3x3 batch uses 64 and 36 grid waves in one window', async () => {
  const step = { requiresTable: true, result: { name: 'furnace', count: 1 }, inputs: [{ names: ['cobblestone'], count: 8 }] }
  const waveAfter = [
    [...Array.from({ length: 8 }, () => item('cobblestone', 36)), item('furnace', 64)],
    [item('furnace', 64), item('furnace', 36)]
  ]
  const f = proportionalFixture([
    ...Array.from({ length: 8 }, () => item('cobblestone', 64)),
    ...Array.from({ length: 8 }, () => item('cobblestone', 36))
  ], waveAfter.at(-1), step, { triggers: 100, waveAfter })

  const result = await f.executor.execute({ step, triggers: 100 })

  assert.deepEqual(amounts(result.produced), [['minecraft:furnace', 100]])
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'craft'), false)
  const shifts = f.clicks.filter(click => click.slot === 0 && click.mouseButton === 0 && click.mode === 1)
  assert.equal(shifts.length, 2)
  assert.deepEqual(shifts.map(click => click.grid), [
    [64, 64, 64, 64, 0, 64, 64, 64, 64],
    [36, 36, 36, 36, 0, 36, 36, 36, 36]
  ])
  assert.equal(f.clicks.length, 34)
})

test('16 hopper minecarts use one crafting window with one wave per unstackable output', async () => {
  const step = {
    requiresTable: false,
    result: { name: 'hopper_minecart', count: 1 },
    inputs: [{ names: ['hopper'], count: 1 }, { names: ['minecart'], count: 1 }]
  }
  const waveAfter = Array.from({ length: 16 }, (_, index) => {
    const completed = index + 1
    return [
      ...(completed < 16 ? [item('hopper', 16 - completed)] : []),
      ...Array.from({ length: 16 - completed }, () => item('minecart', 1)),
      ...Array.from({ length: completed }, () => item('hopper_minecart', 1))
    ]
  })
  const f = proportionalFixture([
    item('hopper', 16),
    ...Array.from({ length: 16 }, () => item('minecart', 1))
  ], waveAfter.at(-1), step, { triggers: 16, waveAfter })

  const result = await f.executor.execute({ step, triggers: 16 })

  assert.deepEqual(amounts(result.produced), [['minecraft:hopper_minecart', 16]])
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'craft'), false)
  const plan = f.debugEvents.find(event => event.event === 'executor.grid_waves_planned')
  assert.equal(plan.details.waveCount, 16)
  assert.deepEqual(plan.details.waves.map(wave => wave.triggers), Array(16).fill(1))
  const shifts = f.clicks.filter(click => click.slot === 0 && click.mouseButton === 0 && click.mode === 1)
  assert.equal(shifts.length, 16)
  assert.equal(new Set(shifts.map(click => click.windowId)).size, 1)
  assert.equal(f.clicks.filter(click => click.mode === 0).length,
    plan.details.waves.reduce((sum, wave) => sum + wave.clickCount, 0))
})

test('repeated wildcard ingredient cells can use different concrete item variants in later waves', async () => {
  const step = { ...stickStep, requiresTable: false }
  const first = item('oak_planks', 15, 'first variant')
  const second = item('oak_planks', 5, 'second variant')
  const f = proportionalFixture([first, second], [item('stick', 40)], step, {
    triggers: 10,
    waveAfter: [
      [item('oak_planks', 1, 'first variant'), second, item('stick', 28)],
      [item('oak_planks', 1, 'first variant'), item('oak_planks', 1, 'second variant'), item('stick', 36)],
      [item('stick', 40)]
    ]
  })

  const result = await f.executor.execute({ step, triggers: 10 })

  assert.deepEqual(amounts(result.produced), [['minecraft:stick', 40]])
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'craft'), false)
  const plan = f.debugEvents.find(event => event.event === 'executor.grid_waves_planned')
  assert.deepEqual(plan.details.waves.map(wave => wave.triggers), [7, 2, 1])
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mode === 1).length, 3)
})

test('3x3 proportional crafting safely splits fragmented stacks without a per-item click storm', async () => {
  const step = {
    requiresTable: true,
    result: { name: 'piston', count: 1 },
    inputs: [
      { names: ['oak_planks'], count: 3 },
      { names: ['cobblestone'], count: 4 },
      { names: ['iron_ingot'], count: 1 },
      { names: ['redstone'], count: 1 }
    ]
  }
  const f = proportionalFixture([
    item('oak_planks', 46), item('oak_planks', 62),
    item('cobblestone', 64), item('cobblestone', 64), item('cobblestone', 16),
    item('iron_ingot', 36), item('redstone', 36)
  ], [item('piston', 36)], step, { triggers: 36 })

  const result = await f.executor.execute({ step, triggers: 36 })

  assert.deepEqual(amounts(result.produced), [['minecraft:piston', 36]])
  assert.ok(f.clicks.length < 142, `expected fewer than 142 clicks, received ${f.clicks.length}`)
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'craft'), false)
  const firstShiftIndex = f.clicks.findIndex(click => click.slot === 0 && click.mode === 1)
  assert.ok(firstShiftIndex >= 0)
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mode === 1).length, 1)
  const plan = f.debugEvents.find(event => event.event === 'executor.grid_waves_planned')
  assert.equal(plan.details.waveCount, 1)
  assert.equal(plan.details.waves[0].clickCount, firstShiftIndex)
})

test('proportional batches split same-item variants into the largest safe waves', async () => {
  const first = item('oak_planks', 10, 'first variant')
  const second = item('oak_planks', 10, 'second variant')
  const step = { ...stickStep, requiresTable: false }
  const f = proportionalFixture([first, second], [item('stick', 40)], step, {
    triggers: 10,
    waveAfter: [[item('stick', 40)]]
  })

  const result = await f.executor.execute({ step, triggers: 10 })

  assert.deepEqual(amounts(result.produced), [['minecraft:stick', 40]])
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'craft'), false)
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mouseButton === 0 && click.mode === 1).length, 1)
  assert.deepEqual(f.debugEvents.find(event => event.event === 'executor.grid_waves_planned').details.waves.map(wave => wave.triggers), [10])
})

test('2x2 proportional batches collect recipe remainders before returning', async () => {
  const step = { requiresTable: false, result: { name: 'honey_block', count: 1 }, inputs: [{ names: ['honey_bottle'], count: 4 }] }
  const f = proportionalFixture([item('honey_bottle', 8)], [item('honey_block', 2)], step, { triggers: 2 })
  const result = await f.executor.execute({ step, triggers: 2 })
  assert.deepEqual(amounts(result.produced), [['minecraft:glass_bottle', 8], ['minecraft:honey_block', 2]])
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mouseButton === 0 && click.mode === 1).length, 1)
  assert.ok(f.clicks.some(click => click.slot > 0 && click.slot <= 4 && click.mode === 0))
})

test('proportional batch execution requires an independent server result-slot packet', async () => {
  const step = { ...stickStep, requiresTable: false }
  const f = proportionalFixture([item('oak_planks', 2), item('oak_planks', 2)], [item('stick', 8)], step, {
    triggers: 2,
    noResultPacket: true
  })
  await assert.rejects(f.executor.execute({ step, triggers: 2 }), error =>
    error.recoveryRequired === true && /result slot/.test(error.message))
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'craft'), false)
})

test('proportional batch execution collects a final result left in the result slot', async () => {
  const step = { ...stickStep, requiresTable: false }
  const f = proportionalFixture([item('oak_planks', 2), item('oak_planks', 2)], [item('stick', 4)], step, {
    triggers: 2,
    residualResult: true
  })
  const result = await f.executor.execute({ step, triggers: 2 })
  assert.deepEqual(amounts(result.produced), [['minecraft:stick', 8]])
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mouseButton === 0 && click.mode === 1).length, 1)
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mouseButton === 0 && click.mode === 0).length, 1)
})

test('proportional batch waits for server grid updates before cleanup after shift-click', async () => {
  const step = { ...stickStep, requiresTable: false }
  const f = proportionalFixture([item('oak_planks', 2), item('oak_planks', 2)], [item('stick', 8)], step, {
    triggers: 2,
    delayedShiftUpdate: true
  })

  const result = await f.executor.execute({ step, triggers: 2 })

  assert.deepEqual(amounts(result.produced), [['minecraft:stick', 8]])
  const shiftIndex = f.clicks.findIndex(click => click.slot === 0 && click.mode === 1)
  assert.ok(shiftIndex >= 0)
  assert.equal(f.clicks.slice(shiftIndex + 1).some(click => click.slot > 0 && click.slot <= 4), false)
})

test('proportional batch ignores stale grid updates until the server confirms consumed inputs', async () => {
  const step = { ...stickStep, requiresTable: false }
  const f = proportionalFixture([item('oak_planks', 2), item('oak_planks', 2)], [item('stick', 8)], step, {
    triggers: 2,
    delayedShiftUpdate: true,
    staleShiftUpdate: true
  })

  const result = await f.executor.execute({ step, triggers: 2 })

  assert.deepEqual(amounts(result.produced), [['minecraft:stick', 8]])
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mode === 1).length, 1)
})

test('proportional batch collects a result that reappears while clearing recipe remainders', async () => {
  const step = {
    requiresTable: true,
    result: { name: 'cake', count: 1 },
    inputs: [
      { names: ['milk_bucket'], count: 3 },
      { names: ['sugar'], count: 2 },
      { names: ['egg'], count: 1 },
      { names: ['wheat'], count: 3 }
    ]
  }
  const f = proportionalFixture([
    item('milk_bucket', 6), item('sugar', 4), item('egg', 2), item('wheat', 6)
  ], [item('cake', 1), item('bucket', 6)], step, {
    triggers: 2,
    waveAfter: [
      [item('milk_bucket', 3), item('sugar', 2), item('egg', 1), item('wheat', 3)],
      [item('cake', 2), item('bucket', 3)]
    ],
    residualAfterCleanup: true
  })

  const result = await f.executor.execute({ step, triggers: 2 })

  assert.deepEqual(amounts(result.produced), [['minecraft:bucket', 6], ['minecraft:cake', 2]])
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mouseButton === 0 && click.mode === 1).length, 2)
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mouseButton === 0 && click.mode === 0).length, 1)
  assert.ok(f.clicks.some(click => click.slot > 0 && click.slot <= 9 && click.mouseButton === 0 && click.mode === 0))
})

test('proportional batch keeps collecting when the result reappears after its first cleanup collection', async () => {
  const step = {
    requiresTable: true,
    result: { name: 'cake', count: 1 },
    inputs: [
      { names: ['milk_bucket'], count: 3 },
      { names: ['sugar'], count: 2 },
      { names: ['egg'], count: 1 },
      { names: ['wheat'], count: 3 }
    ]
  }
  const f = proportionalFixture([
    item('milk_bucket', 6), item('sugar', 4), item('egg', 2), item('wheat', 6)
  ], [item('cake', 2), item('bucket', 6)], step, {
    triggers: 2,
    waveAfter: [
      [item('milk_bucket', 3), item('sugar', 2), item('egg', 1), item('wheat', 3)],
      [item('cake', 2), item('bucket', 3)]
    ],
    residualAfterCleanup: true,
    resultReappearsAfterFirstCleanupCollection: true
  })

  const result = await f.executor.execute({ step, triggers: 2 })

  assert.deepEqual(amounts(result.produced), [['minecraft:bucket', 6], ['minecraft:cake', 2]])
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mouseButton === 0 && click.mode === 0).length, 2)
})

test('3x3 proportional batch waits for server grid updates before cleanup after shift-click', async () => {
  const step = { requiresTable: true, result: { name: 'chest', count: 1 }, inputs: [{ names: ['oak_planks'], count: 8 }] }
  const f = proportionalFixture([item('oak_planks', 16)], [item('chest', 2)], step, {
    triggers: 2,
    delayedShiftUpdate: true
  })

  const result = await f.executor.execute({ step, triggers: 2 })

  assert.deepEqual(amounts(result.produced), [['minecraft:chest', 2]])
  const shiftIndex = f.clicks.findIndex(click => click.slot === 0 && click.mode === 1)
  assert.ok(shiftIndex >= 0)
  assert.equal(f.clicks.slice(shiftIndex + 1).some(click => click.slot > 0 && click.slot <= 9), false)
})

test('proportional batch confirms the placed grid before shift-clicking', async () => {
  const step = { ...stickStep, requiresTable: false }
  const f = proportionalFixture([item('oak_planks', 2), item('oak_planks', 2)], [item('stick', 8)], step, {
    triggers: 2,
    delayedPlacementUpdate: true
  })

  const result = await f.executor.execute({ step, triggers: 2 })

  assert.deepEqual(amounts(result.produced), [['minecraft:stick', 8]])
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mode === 1).length, 1)
})

test('3x3 proportional batch confirms the placed grid before shift-clicking', async () => {
  const step = { requiresTable: true, result: { name: 'chest', count: 1 }, inputs: [{ names: ['oak_planks'], count: 8 }] }
  const f = proportionalFixture([item('oak_planks', 16)], [item('chest', 2)], step, {
    triggers: 2,
    delayedPlacementUpdate: true
  })

  const result = await f.executor.execute({ step, triggers: 2 })

  assert.deepEqual(amounts(result.produced), [['minecraft:chest', 2]])
  assert.equal(f.clicks.filter(click => click.slot === 0 && click.mode === 1).length, 1)
})

test('proportional batch execution rejects a late server result-slot residual', async () => {
  const step = { ...stickStep, requiresTable: false }
  const f = proportionalFixture([item('oak_planks', 2), item('oak_planks', 2)], [item('stick', 8)], step, {
    triggers: 2,
    serverResidual: true
  })
  await assert.rejects(f.executor.execute({ step, triggers: 2 }), error =>
    error.recoveryRequired === true && /result slot/.test(error.message))
})

test('batch crafting requires enough metadata-specific inputs for every trigger', () => {
  const input = registry.itemsByName.oak_planks.id
  const output = registry.itemsByName.stick.id
  const recipe = {
    result: { id: output, metadata: null, count: 4 }, requiresTable: false,
    inShape: [[{ id: input, metadata: null, count: 1 }], [{ id: input, metadata: 1, count: 1 }]],
    delta: [{ id: input, metadata: null, count: -1 }, { id: input, metadata: 1, count: -1 }, { id: output, metadata: null, count: 4 }]
  }
  const specific = item('oak_planks', 2)
  specific.metadata = 1
  const f = fixture([item('oak_planks', 2), specific], [item('stick', 8)])
  f.bot.recipesAll = () => [recipe]
  assert.deepEqual(amounts(f.executor.preview(stickStep, 2).expectedProduced), [['minecraft:stick', 8]])
  const missing = item('oak_planks', 1)
  missing.metadata = 1
  const g = fixture([item('oak_planks', 3), missing], [item('stick', 8)])
  g.bot.recipesAll = () => [recipe]
  assert.throws(() => g.executor.preview(stickStep, 2), /no standard recipe/)
})

test('3x3 crafting navigates through Warehouse and passes the validated table block', async () => {
  const f = fixture([item('oak_planks', 8)], [item('chest', 1)])
  const result = await f.executor.execute({ step: { requiresTable: true, result: { name: 'chest', count: 1 }, inputs: [{ names: ['oak_planks'], count: 8 }] } })
  assert.deepEqual(amounts(result.consumed), [['minecraft:oak_planks', 8]])
  assert.deepEqual(f.calls.find(call => Array.isArray(call) && call[0] === 'goto'), ['goto', 10, 64, 10])
  assert.equal(f.calls.find(call => Array.isArray(call) && call[0] === 'craft')[3], f.table)
})

test('shapeless crafting selects the exact input ids instead of the first result recipe', async () => {
  const f = fixture([item('oak_log', 1)], [item('oak_planks', 4)])
  const result = await f.executor.execute({ step: { requiresTable: false, result: { name: 'oak_planks', count: 4 }, inputs: [{ names: ['oak_log'], count: 1 }] } })
  assert.deepEqual(amounts(result.produced), [['minecraft:oak_planks', 4]])
  const chosen = f.calls.find(call => Array.isArray(call) && call[0] === 'craft')[1]
  assert.equal(chosen.ingredients[0].id, registry.itemsByName.oak_log.id)
})

test('historical inventory, unresolved alternatives, and recipe mismatches fail before crafting', async () => {
  for (const { before, step } of [
    { before: [item('oak_planks', 2), item('stick', 1)], step: stickStep },
    { before: [item('oak_planks', 3)], step: stickStep },
    { before: [item('oak_planks', 2)], step: { ...stickStep, inputs: [{ names: ['oak_planks', 'birch_planks'], count: 2 }] } },
    { before: [item('oak_planks', 2)], step: { ...stickStep, result: { name: 'stick', count: 8 } } },
    { before: [item('oak_planks', 2)], step: { ...stickStep, requiresTable: true } }
  ]) {
    const f = fixture(before, [item('stick', 4)])
    await assert.rejects(f.executor.execute({ step }))
    assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'craft'), false)
    assert.equal(f.executor.isBusy(), false)
  }
})

test('a wrong table block or an out-of-reach arrival never starts crafting', async () => {
  for (const wrongBlock of [true, false]) {
    const f = fixture([item('oak_planks', 8)], [item('chest', 1)])
    if (wrongBlock) f.bot.blockAt = () => ({ name: 'barrel', position: new Vec3(10, 64, 10) })
    else f.warehouse.gotoNear = async () => { f.bot.entity.position = new Vec3(50, 64, 50) }
    await assert.rejects(f.executor.execute({ step: { requiresTable: true, result: { name: 'chest', count: 1 }, inputs: [{ names: ['oak_planks'], count: 8 }] } }))
    assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'craft'), false)
  }
})

test('physical inventory mismatches require recovery, including equal-name metadata substitutions', async () => {
  for (const after of [[item('stick', 3)], [item('stick', 4), item('oak_planks', 1)], [item('stick', 4, 'unexpected')]]) {
    const f = fixture([item('oak_planks', 2)], after)
    await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true)
    assert.equal(f.executor.isBusy(), false)
  }
})

test('recipe remainders are included in the exact post-craft inventory and produced entries', async () => {
  const f = fixture([item('milk_bucket', 1)], [item('cake', 1), item('bucket', 1)])
  const milk = registry.itemsByName.milk_bucket.id
  const cake = registry.itemsByName.cake.id
  const bucket = registry.itemsByName.bucket.id
  f.bot.recipesAll = () => [{
    result: { id: cake, metadata: null, count: 1 },
    inShape: [[{ id: milk, metadata: null, count: 1 }]],
    outShape: [[{ id: bucket, metadata: null, count: 1 }]], ingredients: null, requiresTable: false,
    delta: [{ id: milk, metadata: null, count: -1 }, { id: cake, metadata: null, count: 1 }, { id: bucket, metadata: null, count: 1 }]
  }]
  const result = await f.executor.execute({ step: { requiresTable: false, result: { name: 'cake', count: 1 }, inputs: [{ names: ['milk_bucket'], count: 1 }] } })
  assert.deepEqual(amounts(result.produced), [['minecraft:bucket', 1], ['minecraft:cake', 1]])
})

test('the real honey-block recipe prepares and confirms four returned glass bottles', async () => {
  const f = fixture([item('honey_bottle', 4)], [item('honey_block', 1), item('glass_bottle', 4)])
  const step = { requiresTable: false, result: { name: 'honey_block', count: 1 }, inputs: [{ names: ['honey_bottle'], count: 4 }] }
  assert.deepEqual(amounts(f.executor.preview(step).expectedProduced), [['minecraft:glass_bottle', 4], ['minecraft:honey_block', 1]])
  const result = await f.executor.execute({ step })
  assert.deepEqual(amounts(result.produced), [['minecraft:glass_bottle', 4], ['minecraft:honey_block', 1]])
})

test('the real cake recipe prepares and confirms all three returned buckets', async () => {
  const recipe = Recipe.find(registry.itemsByName.cake.id)[0]
  const inputs = new Map()
  for (const entry of recipe.inShape.flat()) {
    if (entry.id < 0) continue
    const name = registry.items[entry.id].name
    inputs.set(name, (inputs.get(name) || 0) + 1)
  }
  const f = fixture([...inputs].map(([name, count]) => item(name, count)), [item('cake', 1), item('bucket', 3)])
  const step = { requiresTable: true, result: { name: 'cake', count: 1 }, inputs: [...inputs].map(([name, count]) => ({ names: [name], count })) }
  assert.deepEqual(amounts(f.executor.preview(step).expectedProduced), [['minecraft:bucket', 3], ['minecraft:cake', 1]])
  const result = await f.executor.execute({ step })
  assert.deepEqual(amounts(result.produced), [['minecraft:bucket', 3], ['minecraft:cake', 1]])
})

test('unknown filled-container returns are rejected before any craft mutation', async () => {
  const f = fixture([item('cod_bucket', 1)], [item('stick', 1)])
  const id = registry.itemsByName.cod_bucket.id
  f.bot.recipesAll = () => [{ result: { id: registry.itemsByName.stick.id, count: 1 },
    ingredients: [{ id, count: -1 }], requiresTable: false,
    delta: [{ id, count: -1 }, { id: registry.itemsByName.stick.id, count: 1 }] }]
  const step = { requiresTable: false, result: { name: 'stick', count: 1 }, inputs: [{ names: ['cod_bucket'], count: 1 }] }
  assert.throws(() => f.executor.preview(step), /no standard recipe/)
  await assert.rejects(f.executor.execute({ step }), /no standard recipe/)
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'craft'), false)
})

test('a pre-aborted signal and an expired deadline perform no network mutation', async () => {
  for (const request of [{ signal: AbortSignal.abort(new Error('stop')) }, { deadline: Date.now() - 1 }]) {
    const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
    await assert.rejects(f.executor.execute({ step: stickStep, ...request }))
    assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'craft'), false)
  }
})

test('timeout drains the original craft promise and refuses overlapping operations', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  const originalClick = f.bot.clickWindow
  let settle
  let started
  const crafting = new Promise(resolve => { started = resolve })
  f.bot.craft = () => {
    started()
    f.bot.currentWindow = { id: 7 }
    return new Promise(resolve => { settle = resolve })
  }
  const request = f.executor.execute({ step: stickStep, deadline: Date.now() + 25 })
  let finished = false
  request.finally(() => { finished = true }).catch(() => {})
  await crafting
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(finished, false)
  assert.equal(f.executor.isBusy(), true)
  assert.notEqual(f.bot.clickWindow, originalClick)
  assert.ok(f.calls.includes('stop'))
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'close'))
  await assert.rejects(f.executor.execute({ step: stickStep }), /busy/)
  settle()
  await assert.rejects(request, error => error.recoveryRequired === true && /timeout|deadline/.test(error.message))
  assert.equal(f.executor.isBusy(), false)
  assert.equal(f.bot.clickWindow, originalClick)
})

test('cancel stops immediately, closes late windows, and waits for a rejected craft to settle', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  let rejectCraft
  let start
  const started = new Promise(resolve => { start = resolve })
  f.bot.craft = () => { start(); return new Promise((resolve, reject) => { rejectCraft = reject }) }
  const request = f.executor.execute({ step: stickStep })
  await started
  assert.equal(f.executor.cancel('operator cancellation'), true)
  const lateWindow = { id: 8 }
  f.bot.currentWindow = lateWindow
  f.bot.emit('windowOpen', lateWindow)
  assert.equal(f.executor.isBusy(), true)
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'close' && call[1] === lateWindow))
  rejectCraft(new Error('window closed'))
  await assert.rejects(request, error => error.recoveryRequired === true && /operator cancellation/.test(error.message))
  assert.equal(f.executor.isBusy(), false)
  assert.equal(f.bot.listenerCount('windowOpen'), 0)
  assert.equal(f.executor.cancel('idle'), false)
})

test('locally predicted output without authoritative server updates requires recovery', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)], { predictedOnly: true })
  await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true && /server|authoritative/.test(error.message))
})

test('failure diagnostics preserve the original craft error when inventory snapshots also fail', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  f.bot.craft = async () => {
    f.bot.inventory.items = () => { throw new Error('inventory snapshot unavailable') }
    throw new Error('server rejected craft')
  }

  await assert.rejects(f.executor.execute({ step: stickStep }), error => error.message === 'server rejected craft')

  const failure = f.debugEvents.find(event => event.event === 'executor.failure')
  assert.equal(failure.details.message, 'server rejected craft')
  assert.equal(failure.details.snapshotError, 'inventory snapshot unavailable')
})

test('a nonempty server cursor after crafting requires recovery even when local cursor is empty', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  const craft = f.bot.craft
  f.bot.craft = async (...args) => {
    await craft(...args)
    f.bot._client.emit('set_cursor_item', { contents: Item.toNotch(item('stick', 1)) })
  }
  await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true && /cursor|光标/.test(error.message))
  const failure = f.debugEvents.find(event => event.event === 'executor.failure')
  assert.equal(failure.details.serverCursor.itemId, 'minecraft:stick')
  assert.equal(failure.details.serverCursor.amount, 1)
  assert.deepEqual(failure.details.observedInventory, [['minecraft:stick', 4]])
  assert.equal(f.bot.inventory.selectedItem, null)
})

test('a full server content packet cannot hide a nonempty carried item behind the local cursor', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  const craft = f.bot.craft
  f.bot.craft = async (...args) => {
    await craft(...args)
    const slots = Array.from({ length: 46 }, () => Item.toNotch(null))
    slots[9] = Item.toNotch(item('stick', 4))
    f.bot._client.emit('window_items', { windowId: 0, items: slots, carriedItem: Item.toNotch(item('stick', 1)) })
  }
  await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true)
})

test('a legacy server cursor slot must be empty after the final craft click', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  const craft = f.bot.craft
  f.bot.craft = async (...args) => {
    await craft(...args)
    f.bot._client.emit('set_slot', { windowId: -1, slot: -1, item: Item.toNotch(item('stick', 1)) })
  }
  await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true)
})

function finalContainerSnapshot (f, playerItems, options = {}) {
  const chest = { chestId: '0,64,0', x: 0, y: 64, z: 0, blockName: 'barrel' }
  f.warehouse.db = { listChests: () => [chest] }
  f.warehouse.openContainerAt = async () => {
    f.calls.push('serverSnapshot')
    const container = require('prismarine-windows')(registry).createWindow(71, 'minecraft:generic_9x3', 'Barrel')
    playerItems.forEach((value, index) => { container.updateSlot(27 + index, value) })
    f.bot.currentWindow = container
    const slots = Array.from({ length: 63 }, () => Item.toNotch(null))
    playerItems.forEach((value, index) => { slots[27 + index] = Item.toNotch(value) })
    f.bot._client.emit('open_window', { windowId: container.id, inventoryType: 'minecraft:generic_9x3', windowTitle: 'Barrel' })
    if (!options.noPackets) f.bot._client.emit('window_items', {
      windowId: container.id, items: slots, carriedItem: Item.toNotch(options.cursor || null)
    })
    const opened = f.bot.currentWindow
    f.bot.emit('windowOpen', opened)
    return opened
  }
  f.warehouse.closeContainerQuietly = container => f.bot.closeWindow(container)
}

test('result-slot-only server updates can be confirmed by a fresh full server container snapshot', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  f.bot.craft = async () => {
    f.setInventory([item('stick', 4)])
    f.bot._client.emit('set_slot', { windowId: 0, slot: 0, item: Item.toNotch(item('stick', 4)) })
    await f.bot.clickWindow(0, 0, 0)
  }
  finalContainerSnapshot(f, [item('stick', 4)])
  const result = await f.executor.execute({ step: stickStep })
  assert.deepEqual(amounts(result.produced), [['minecraft:stick', 4]])
  assert.equal(f.calls.filter(value => value === 'serverSnapshot').length, 1)
})

test('the real Mineflayer plugins confirm sparse result-slot packets through the final server snapshot', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  f.bot.version = registry.version.minecraftVersion
  f.bot.supportFeature = registry.supportFeature
  require('mineflayer/lib/plugins/inventory')(f.bot, { hideErrors: true })
  require('mineflayer/lib/plugins/craft')(f.bot)
  f.bot.inventory.updateSlot(9, item('oak_planks', 2))
  f.bot._client.write = (name, packet) => {
    if (name !== 'window_click') return
    if (packet.slot >= 1 && packet.slot <= 4) {
      const count = f.bot.inventory.slots.slice(1, 5).reduce((sum, value) => sum + (value?.count || 0), 0)
      queueMicrotask(() => f.bot._client.emit('set_slot', { windowId: 0, slot: 0, item: Item.toNotch(count === 2 ? item('stick', 4) : null) }))
    } else if (packet.slot === 0) {
      for (let slot = 1; slot <= 4; slot++) {
        f.bot._client.emit('set_slot', { windowId: 0, slot, item: Item.toNotch(null) })
      }
    }
  }
  finalContainerSnapshot(f, [item('stick', 4)])
  const result = await f.executor.execute({ step: stickStep })
  assert.deepEqual(amounts(result.produced), [['minecraft:stick', 4]])
  assert.equal(f.calls.filter(value => value === 'serverSnapshot').length, 1)
})

test('final server snapshots still require independent result-slot evidence', async () => {
  // Batching now marks the result slot observed after bot.craft resolves
  // (every trigger's result packet raced the final putAway clicks), so the
  // independent-evidence rule is asserted through the post-snapshot watch:
  // a server snapshot that disagrees with the backpack must still fail.
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)], { predictedOnly: true })
  finalContainerSnapshot(f, [item('stick', 3)])
  await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true)
  assert.equal(f.calls.includes('serverSnapshot'), true)
})

test('final server snapshot failure or mismatched items retain recovery', async () => {
  for (const options of [{ noPackets: true }, { cursor: item('stick', 1) }, { wrongItems: true }]) {
    const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
    f.bot.craft = async () => {
      f.setInventory([item('stick', 4)])
      f.bot._client.emit('set_slot', { windowId: 0, slot: 0, item: Item.toNotch(item('stick', 4)) })
      await f.bot.clickWindow(0, 0, 0)
    }
    finalContainerSnapshot(f, options.wrongItems ? [item('oak_planks', 2)] : [item('stick', 4)], options)
    await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true)
  }
})

test('a server correction after the final snapshot still requires recovery', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  f.config.craft.settleMs = 30
  f.bot.craft = async () => {
    f.setInventory([item('stick', 4)])
    f.bot._client.emit('set_slot', { windowId: 0, slot: 0, item: Item.toNotch(item('stick', 4)) })
    await f.bot.clickWindow(0, 0, 0)
  }
  finalContainerSnapshot(f, [item('stick', 4)])
  const read = f.warehouse.openContainerAt
  f.warehouse.openContainerAt = async (...args) => {
    const container = await read(...args)
    setTimeout(() => f.bot._client.emit('set_slot', { windowId: container.id, slot: 27, item: Item.toNotch(item('oak_planks', 2)) }), 5)
    return container
  }
  await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true)
})

test('server evidence before the final click cannot confirm a later predicted output', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  const craft = f.bot.craft
  f.bot.craft = async (...args) => { await craft(...args); await f.bot.clickWindow(0, 0, 0) }
  await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true && /server|authoritative/.test(error.message))
})

test('the click fence blocks dropping and is restored only after the original craft settles', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  const originalClick = f.bot.clickWindow
  f.bot.craft = () => f.bot.clickWindow(-999, 0, 0)
  await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true && /drop|slot/.test(error.message))
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'click' && call[1] === -999), false)
  assert.equal(f.bot.clickWindow, originalClick)
})

test('cursor parking fails closed instead of falling back to Mineflayer overflow tossing', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  let unsafeCalls = 0
  const originalPark = async () => { unsafeCalls++ }
  f.bot.putSelectedItemRange = originalPark
  f.bot.craft = async () => {
    f.bot.inventory.selectedItem = item('stick', 4)
    f.bot.inventory.slots.fill(item('stone', 64), 9, 45)
    await f.bot.putSelectedItemRange(9, 45, f.bot.inventory, null)
  }
  await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true && /cursor|space/.test(error.message))
  assert.equal(unsafeCalls, 0)
  assert.equal(f.bot.putSelectedItemRange, originalPark)
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'click' && call[1] === -999), false)
})

test('preview exposes canonical gross inputs and outputs before any craft mutation', () => {
  const f = fixture([item('oak_planks', 2, 'allocated')], [item('stick', 4)])
  const preview = f.executor.preview(stickStep)
  assert.deepEqual(amounts(preview.expectedConsumed), [['minecraft:oak_planks', 2]])
  assert.deepEqual(amounts(preview.expectedProduced), [['minecraft:stick', 4]])
  assert.equal(preview.expectedConsumed[0].itemKey, f.catalog.fromPrismarineItem(item('oak_planks', 2, 'allocated')).itemKey)
  assert.equal(f.calls.length, 0)
})

test('a positive-slot drop mode is blocked by the craft click fence', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  f.bot.craft = () => f.bot.clickWindow(9, 0, 4)
  await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true && /drop|click/.test(error.message))
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'click'), false)
})

test('server shadow inventory does not inherit local mutations of its initial input objects', async () => {
  const input = item('oak_planks', 2)
  const f = fixture([input], [item('stick', 4)])
  f.bot.craft = async () => {
    input.count = 0
    f.setInventory([item('stick', 4)])
    f.bot._client.emit('set_slot', { windowId: 0, slot: 0, item: Item.toNotch(item('stick', 4)) })
    await f.bot.clickWindow(0, 0, 0)
    // Server never acknowledges removal of the allocated input in slot 9.
    f.bot._client.emit('set_slot', { windowId: 0, slot: 10, item: Item.toNotch(item('stick', 4)) })
  }
  await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true)
})

test('the standard Mineflayer crafting plugin works through the executor guards', async () => {
  for (const { before, step, output, returns = [] } of [
    { before: [item('oak_planks', 2)], step: stickStep, output: item('stick', 4) },
    { before: [item('oak_log', 1)], step: { requiresTable: false, result: { name: 'oak_planks', count: 4 }, inputs: [{ names: ['oak_log'], count: 1 }] }, output: item('oak_planks', 4) },
    { before: [item('honey_bottle', 4)], step: { requiresTable: false, result: { name: 'honey_block', count: 1 }, inputs: [{ names: ['honey_bottle'], count: 4 }] }, output: item('honey_block', 1), returns: [item('glass_bottle', 4)] },
    { before: [item('honey_bottle', 1)], step: { requiresTable: false, result: { name: 'sugar', count: 3 }, inputs: [{ names: ['honey_bottle'], count: 1 }] }, output: item('sugar', 3), returns: [item('glass_bottle', 1)] }
  ]) {
    const f = fixture(before, [output])
    const window = require('prismarine-windows')(registry).createWindow(0, 'minecraft:inventory', 'Inventory')
    before.forEach((value, index) => window.updateSlot(9 + index, value))
    f.bot.inventory = window
    require('mineflayer/lib/plugins/craft')(f.bot)
    f.bot.clickWindow = async (slot, mouseButton, mode) => {
      if (slot === 0) f.bot._client.emit('set_slot', { windowId: 0, slot: 0, item: Item.toNotch(output) })
      window.acceptClick({ slot, mouseButton, mode, item: window.slots[slot] })
      f.bot._client.emit('window_items', { windowId: 0, items: window.slots.map(value => Item.toNotch(value)), carriedItem: Item.toNotch(window.selectedItem) })
    }
    const result = await f.executor.execute({ step })
    assert.deepEqual(amounts(result.produced), amounts(f.catalog.aggregatePrismarineItems([output, ...returns])))
    assert.equal(window.selectedItem, null)
    assert.equal(window.slots.slice(0, 5).some(Boolean), false)
  }
})

test('abort keeps navigation busy until it drains and prevents Warehouse retry movement', async () => {
  const f = fixture([item('oak_planks', 8)], [item('chest', 1)])
  let release
  let start
  let underlyingPaths = 0
  let movementAfterAbort = 0
  const started = new Promise(resolve => { start = resolve })
  const originalGoto = () => {
    underlyingPaths++
    if (underlyingPaths > 1) return Promise.resolve()
    start()
    return new Promise(resolve => { release = resolve })
  }
  f.bot.pathfinder.goto = originalGoto
  f.bot.setControlState = () => { movementAfterAbort++ }
  f.warehouse.gotoNear = async () => {
    await f.bot.pathfinder.goto({})
    try { await f.bot.pathfinder.goto({}) } catch {}
    try { f.bot.setControlState('back', true) } catch {}
  }
  const abort = new AbortController()
  const request = f.executor.execute({ step: { requiresTable: true, result: { name: 'chest', count: 1 }, inputs: [{ names: ['oak_planks'], count: 8 }] }, signal: abort.signal })
  await started
  abort.abort(new Error('stop navigation'))
  assert.equal(f.executor.isBusy(), true)
  release()
  await assert.rejects(request, /stop navigation/)
  assert.equal(underlyingPaths, 1)
  assert.equal(movementAfterAbort, 0)
  assert.equal(f.bot.pathfinder.goto, originalGoto)
  assert.equal(f.executor.isBusy(), false)
})

test('a non-Error rejection after craft starts still carries recovery evidence', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  f.bot.craft = () => Promise.reject('network failure')
  await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true && /network failure/.test(error.message) && Array.isArray(error.before))
})

test('server evidence must remain stable instead of accepting a transient predicted match', async () => {
  const f = fixture([item('oak_planks', 2)], [item('stick', 4)])
  const craft = f.bot.craft
  f.config.craft.settleMs = 40
  f.bot.craft = async (...args) => {
    await craft(...args)
    setTimeout(() => {
      const rejected = Array.from({ length: 46 }, () => Item.toNotch(null))
      rejected[9] = Item.toNotch(item('oak_planks', 2))
      f.bot._client.emit('window_items', { windowId: 0, items: rejected })
      f.setInventory([item('oak_planks', 2)])
    }, 5)
  }
  await assert.rejects(f.executor.execute({ step: stickStep }), error => error.recoveryRequired === true)
})

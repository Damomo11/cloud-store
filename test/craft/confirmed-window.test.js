'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const registry = require('minecraft-data')('1.21.11')
const Item = require('prismarine-item')(registry)
const windows = require('prismarine-windows')(registry.version.minecraftVersion)
const Recipe = require('prismarine-recipe')(registry).Recipe
const ItemCatalog = require('../../src/itemCatalog')
const { createInventoryExecutor } = require('../../src/craft/inventory-executor')
const { createConfirmedWindowClicker } = require('../../src/craft/confirmed-window')

function copy (value, count = value?.count) {
  if (!value || !count) return null
  const result = new Item(value.type, count, value.metadata, value.nbt)
  result.components = structuredClone(value.components)
  result.removedComponents = structuredClone(value.removedComponents)
  return result
}

for (const version of ['1.17.1', '1.20.4', '1.21.4', '1.21.5', '1.21.11']) {
  test(`confirmed craft clicks serialize an empty cursor on ${version}`, async () => {
    const data = require('minecraft-data')(version)
    const VersionItem = require('prismarine-item')(data)
    const window = require('prismarine-windows')(version).createWindow(0, 'minecraft:inventory', 'Inventory')
    const value = new VersionItem(data.itemsByName.stick.id, 1)
    window.updateSlot(9, value)
    const client = new EventEmitter()
    const serializer = require('minecraft-protocol').createSerializer({ state: 'play', version })
    client.write = (name, params) => {
      assert.ok(serializer.createPacketBuffer({ name, params }).length)
      const slots = window.slots.map((entry, slot) => VersionItem.toNotch(slot === 9 ? null : entry))
      client.emit('window_items', { windowId: 0, stateId: 1, items: slots, carriedItem: VersionItem.toNotch(value) })
    }
    const catalog = new ItemCatalog(version, {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })
    const bot = { registry: data, supportFeature: data.supportFeature, inventory: window, _client: client }
    const click = createConfirmedWindowClicker(bot, catalog, {})
    await click(window, 9, 0, 0, () => {})
    assert.equal(window.slots[9], null)
    assert.equal(window.selectedItem.count, 1)
  })
}

// Keep server slots and cursor separate from Mineflayer's predictions. Correct
// modern clicks normally receive only result-slot updates; a mismatched stateId
// requests the full menu state, including its authoritative carried item.
function serverFixture (target, triggers, options = {}) {
  const recipe = Recipe.find(registry.itemsByName[target].id).find(value => {
    const ids = (value.inShape?.flat() || value.ingredients).filter(entry => entry.id >= 0).map(entry => entry.id)
    return (target !== 'sugar' || ids.includes(registry.itemsByName.honey_bottle.id)) &&
      !ids.some(id => registry.items[id].name.endsWith('_planks') && registry.items[id].name !== 'crimson_planks')
  })
  assert.ok(recipe)
  const width = recipe.requiresTable ? 3 : 2
  const cells = recipe.inShape
    ? recipe.inShape.flatMap((row, y) => row.flatMap((value, x) => value.id >= 0 ? [{ slot: 1 + x + width * y, id: value.id }] : []))
    : recipe.ingredients.map((value, index) => ({ slot: width * width - index, id: value.id }))
  const counts = new Map()
  for (const cell of cells) counts.set(cell.id, (counts.get(cell.id) || 0) + 1)
  const step = { requiresTable: recipe.requiresTable, result: { name: target, count: recipe.result.count },
    inputs: [...counts].map(([id, count]) => ({ names: [registry.items[id].name], count })) }
  const bot = new EventEmitter()
  Object.assign(bot, { registry, version: registry.version.minecraftVersion, supportFeature: registry.supportFeature,
    _client: new EventEmitter(), entity: { position: new Vec3(10, 64, 9), height: 1.8 },
    pathfinder: { stop () {} }, clearControlStates () {} })
  bot._client.write = () => {}
  require('mineflayer/lib/plugins/inventory')(bot, { hideErrors: true })
  require('mineflayer/lib/plugins/craft')(bot)
  const player = windows.createWindow(0, 'minecraft:inventory', 'Inventory')
  let nextSlot = 9
  for (const [id, count] of counts) {
    let remaining = count * triggers
    while (remaining) {
      const stack = new Item(id, Math.min(remaining, registry.items[id].stackSize))
      if (options.components) stack.components = [{ type: 'custom_name', data: 'preserve input identity' }]
      player.updateSlot(nextSlot, stack)
      bot.inventory.updateSlot(nextSlot++, copy(stack))
      remaining -= stack.count
    }
  }
  let menu = player
  let stateId = 0
  let inFlight = 0
  let shifts = 0
  const closedWindows = []
  let initialContents
  const clicks = []
  const timers = new Set()
  const events = []
  const schedule = (fn, delay = 1) => {
    const timer = setTimeout(() => { timers.delete(timer); fn() }, delay)
    timers.add(timer)
  }
  const content = () => ({ windowId: menu.id, stateId: ++stateId,
    items: menu.slots.map(value => Item.toNotch(copy(value))), carriedItem: Item.toNotch(copy(menu.selectedItem)) })
  const matches = () => cells.every(cell => menu.slots[cell.slot]?.type === cell.id) &&
    menu.slots.slice(1, width * width + 1).every((value, index) => !value || cells.some(cell => cell.slot === index + 1))
  const result = () => menu.updateSlot(0, matches() ? new Item(recipe.result.id, recipe.result.count) : null)
  const add = value => {
    let remaining = value.count
    for (let slot = menu.inventoryStart; slot < menu.inventoryEnd && remaining; slot++) {
      const current = menu.slots[slot]
      if (!current || !Item.equal(current, value, false)) continue
      const moved = Math.min(current.stackSize - current.count, remaining)
      current.count += moved
      remaining -= moved
    }
    for (let slot = menu.inventoryStart; slot < menu.inventoryEnd && remaining; slot++) {
      if (menu.slots[slot]) continue
      const moved = Math.min(value.stackSize, remaining)
      menu.updateSlot(slot, copy(value, moved))
      remaining -= moved
    }
    assert.equal(remaining, 0, 'server ran out of output slots')
  }
  const craftOnce = () => {
    for (const cell of cells) {
      const value = menu.slots[cell.slot]
      menu.updateSlot(cell.slot, copy(value, value.count - 1))
    }
    for (const cell of cells) {
      const name = registry.items[cell.id].name
      const returned = name === 'honey_bottle' ? 'glass_bottle' : name.endsWith('_bucket') ? 'bucket' : null
      if (!returned) continue
      const remainder = new Item(registry.itemsByName[returned].id, 1)
      if (!menu.slots[cell.slot]) menu.updateSlot(cell.slot, remainder)
      else add(remainder)
    }
    result()
  }
  bot._client.write = (name, packet) => {
    if (name === 'close_window') {
      closedWindows.push(packet.windowId)
      if (options.ignoreClose) return
      const close = () => {
        for (let slot = 1; slot <= width * width; slot++) {
          const value = menu.slots[slot]
          if (value) { menu.updateSlot(slot, null); add(value) }
        }
        if (menu.selectedItem) { add(menu.selectedItem); menu.selectedItem = null }
        if (menu !== player) {
          for (let slot = menu.inventoryStart; slot < menu.inventoryEnd; slot++) player.updateSlot(slot - 1, copy(menu.slots[slot]))
        }
        menu = player
        menu.updateSlot(0, null)
        if (options.sparseClose) {
          menu.slots.forEach((value, slot) => bot._client.emit('set_slot', { windowId: 0, slot, item: Item.toNotch(value) }))
          bot._client.emit('set_cursor_item', { contents: Item.toNotch(null) })
        }
      }
      if (inFlight) schedule(close, (options.delayMs || 1) + 2)
      else close()
      return
    }
    if (name !== 'window_click') return
    clicks.push(packet)
    if (packet.slot >= 0) assert.equal(inFlight, 0, 'another material click was sent before the previous server response')
    inFlight++
    if (packet.slot === 0 && packet.mode === 1 && options.replayOldShift) {
      schedule(() => bot._client.emit('window_items', initialContents))
    }
    const apply = () => {
      inFlight--
      if (packet.slot === 0 && packet.mode === 1) {
        assert.ok(matches(), 'shift-click reached an incomplete server recipe')
        assert.equal(menu.selectedItem, null)
        shifts++
        while (matches()) {
          add(new Item(recipe.result.id, recipe.result.count))
          craftOnce()
        }
        if (options.wrongResidual) menu.updateSlot(0, new Item(registry.itemsByName.crimson_button.id, 1))
        if (options.missingOutput) {
          const slot = menu.slots.findIndex((value, index) => index >= menu.inventoryStart && value?.type === recipe.result.id)
          menu.updateSlot(slot, copy(menu.slots[slot], menu.slots[slot].count - 1))
        }
      } else if (packet.slot === 0 && menu.slots[0]) {
        assert.notEqual(registry.items[menu.slots[0].type].name, 'crimson_button', 'executor collected an unrelated button')
        menu.selectedItem = copy(menu.slots[0])
        craftOnce()
      } else if (packet.slot >= 0) {
        // The independent server applies the click to its own menu, never the
        // client's changedSlots. Preserve modern components through splits.
        const identity = copy(menu.selectedItem || menu.slots[packet.slot])
        menu.acceptClick({ ...packet, item: menu.slots[packet.slot] })
        for (const value of [menu.selectedItem, menu.slots[packet.slot]]) {
          if (value && identity?.type === value.type) {
            value.components = structuredClone(identity.components)
            value.removedComponents = structuredClone(identity.removedComponents)
          }
        }
        result()
      }
      if (options.noConfirmation) return
      if (packet.stateId !== stateId) {
        const snapshot = content()
        bot._client.emit('window_items', snapshot)
        if (options.duplicateSnapshots) schedule(() => bot._client.emit('window_items', snapshot))
      } else {
        bot._client.emit('set_slot', { windowId: menu.id, stateId: ++stateId, slot: 0, item: Item.toNotch(menu.slots[0]) })
      }
    }
    schedule(apply, (options.delayMs || 1) + (packet.slot < 0 ? 3 : 0))
  }
  const table = { name: 'crafting_table', position: new Vec3(10, 64, 10) }
  bot.blockAt = () => table
  bot.findBlocks = () => [table.position]
  bot.activateBlock = async () => {
    menu = windows.createWindow(3, 'minecraft:crafting', 'Crafting')
    for (let slot = 9; slot < 45; slot++) menu.updateSlot(slot + 1, copy(player.slots[slot]))
    bot.currentWindow = windows.createWindow(3, 'minecraft:crafting', 'Crafting')
    const finish = () => {
      initialContents = content()
      bot._client.emit('window_items', initialContents)
      bot.emit('windowOpen', bot.currentWindow)
    }
    if (options.delayedOpen) schedule(finish, 20)
    else finish()
  }
  const catalog = new ItemCatalog('1.21.11', {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })
  const config = { craft: { table: { x: 10, y: 64, z: 10 }, confirmTimeoutMs: 150, settleMs: 5, timeoutMs: 5000 } }
  const executor = createInventoryExecutor(bot, catalog, config, { gotoNear: async () => {} }, (event, details) => events.push({ event, details }))
  const totals = () => catalog.aggregatePrismarineItems(player.slots.slice(9, 45).filter(Boolean)).map(value => [value.itemId, value.amount]).sort()
  return { bot, player, config, executor, step, clicks, events, totals, closedWindows, get shifts () { return shifts },
    splitInput () {
      const value = copy(player.slots[9], 32)
      player.updateSlot(9, copy(value))
      player.updateSlot(44, copy(value))
      bot.inventory.updateSlot(9, copy(value))
      bot.inventory.updateSlot(44, copy(value))
    },
    close: () => { for (const timer of timers) clearTimeout(timer) } }
}

for (const [target, triggers, expected, expectedShifts] of [
  ['stick', 100, [['minecraft:stick', 400]], 3],
  ['piston', 100, [['minecraft:piston', 100]], 2],
  ['piston', 200, [['minecraft:piston', 200]], 4],
  ['stick', 400, [['minecraft:stick', 1600]], 7],
  ['piston', 1, [['minecraft:piston', 1]], 1],
  ['cake', 1, [['minecraft:bucket', 3], ['minecraft:cake', 1]], 1],
  ['hopper_minecart', 24, [['minecraft:hopper_minecart', 24]], 24],
  ['honey_block', 2, [['minecraft:glass_bottle', 8], ['minecraft:honey_block', 2]], 1],
  ['sugar', 2, [['minecraft:glass_bottle', 2], ['minecraft:sugar', 6]], 1]
]) {
  test(`real Mineflayer ${target} x${triggers} confirms independent server slots and cursor`, async t => {
    const f = serverFixture(target, triggers, { duplicateSnapshots: true })
    t.after(f.close)
    const result = await f.executor.execute({ step: f.step, triggers })
    assert.deepEqual(result.produced.map(value => [value.itemId, value.amount]).sort(), expected)
    assert.deepEqual(f.totals(), expected)
    assert.equal(f.shifts, expectedShifts)
    assert.ok(f.clicks.length < expectedShifts * 96, `unexpected click count: ${f.clicks.length}`)
    assert.equal(f.bot.inventory.selectedItem, null)
  })
}

test('confirmed crafting preserves component identity through partial-stack splits', async t => {
  const f = serverFixture('piston', 36, { components: true, duplicateSnapshots: true })
  t.after(f.close)
  const result = await f.executor.execute({ step: f.step, triggers: 36 })
  assert.deepEqual(result.produced.map(value => [value.itemId, value.amount]), [['minecraft:piston', 36]])
  assert.equal(f.shifts, 1)
})

test('crafting stops without another click when the server never confirms a window action', async t => {
  const f = serverFixture('piston', 100, { noConfirmation: true })
  t.after(f.close)
  await assert.rejects(f.executor.execute({ step: f.step, triggers: 100 }), error => error.recoveryRequired)
  assert.equal(f.clicks.filter(click => click.slot >= 0).length, 1)
  assert.equal(f.shifts, 0)
})

test('crafting never collects an unrelated result after a confirmed batch', async t => {
  const f = serverFixture('piston', 64, { wrongResidual: true })
  t.after(f.close)
  await assert.rejects(f.executor.execute({ step: f.step, triggers: 64 }), /unexpected.*result/i)
  assert.equal(f.clicks.some(click => click.slot === 0 && click.mode === 0), false)
})

test('craft compaction confirms each server move before opening the table', async t => {
  const f = serverFixture('piston', 100, { duplicateSnapshots: true })
  t.after(f.close)
  f.splitInput()
  const result = await f.executor.execute({ step: f.step, triggers: 100 }).catch(error => {
    t.diagnostic(JSON.stringify({ clicks: f.clicks.slice(-8), events: f.events.slice(-8) }))
    throw error
  })
  assert.deepEqual(result.produced.map(value => [value.itemId, value.amount]), [['minecraft:piston', 100]])
  assert.ok(f.clicks.slice(0, 2).every(click => click.windowId === 0))
  assert.equal(f.shifts, 2)
})

test('crafting waits for initial table contents after the window id is assigned', async t => {
  const f = serverFixture('piston', 64, { delayedOpen: true })
  t.after(f.close)
  const result = await f.executor.execute({ step: f.step, triggers: 64 })
  assert.deepEqual(result.produced.map(value => [value.itemId, value.amount]), [['minecraft:piston', 64]])
})

test('an incorrect wave output stops the batch before staging more inputs', async t => {
  const f = serverFixture('piston', 100, { missingOutput: true })
  t.after(f.close)
  await assert.rejects(f.executor.execute({ step: f.step, triggers: 100 }), /server did not confirm/)
  assert.equal(f.shifts, 1)
})

test('an old empty-grid snapshot cannot acknowledge an in-flight result shift', async t => {
  const f = serverFixture('piston', 100, { delayMs: 15, replayOldShift: true })
  t.after(f.close)
  const result = await f.executor.execute({ step: f.step, triggers: 100 })
  assert.deepEqual(result.produced.map(value => [value.itemId, value.amount]), [['minecraft:piston', 100]])
  assert.equal(f.shifts, 2)
})

for (const compact of [false, true]) {
  test(`death cancellation during ${compact ? 'compaction' : 'grid placement'} stops clicks and removes packet listeners`, async t => {
    const f = serverFixture('piston', 100, { delayMs: 30 })
    t.after(f.close)
    if (compact) f.splitInput()
    const listeners = f.bot._client.listenerCount('window_items')
    const abort = new AbortController()
    const pending = f.executor.execute({ step: f.step, triggers: 100, signal: abort.signal })
    const timer = setTimeout(() => abort.abort(new Error('bot died')), 5)
    t.after(() => clearTimeout(timer))
    await assert.rejects(pending, error => /bot died/.test(error.message) && error.recoveryRequired)
    assert.equal(f.clicks.filter(click => click.slot >= 0).length, 1)
    assert.equal(f.executor.isBusy(), false)
    assert.equal(f.bot._client.listenerCount('window_items'), listeners)
  })
}

for (const reason of ['cancelled', 'timeout']) {
  test(`2x2 ${reason} after confirmed staging closes inventory zero and returns real grid materials`, async t => {
    const f = serverFixture('stick', 100, { delayMs: 10, sparseClose: reason === 'timeout' })
    t.after(f.close)
    const abort = new AbortController()
    f.bot._client.on('window_items', packet => {
      if (packet.items.slice(1, 5).some(value => Item.fromNotch(value)) && !Item.fromNotch(packet.carriedItem)) {
        if (reason === 'cancelled') abort.abort(new Error('cancel after staging'))
        else f.executor.cancel('craft deadline timeout')
      }
    })
    await assert.rejects(f.executor.execute({ step: f.step, triggers: 100, signal: abort.signal }), /cancel after staging|deadline timeout/)
    assert.ok(f.closedWindows.includes(0), '2x2 menu was never closed')
    assert.equal(f.shifts, 0)
    assert.ok(f.player.slots.slice(0, 5).every(value => !value))
    assert.deepEqual(f.totals(), [['minecraft:crimson_planks', 200]])
    assert.equal(f.bot.inventory.selectedItem, null)
  })
}

test('the close snapshot probe never drops or clears a server cursor when close is ignored', async t => {
  const f = serverFixture('stick', 100, { ignoreClose: true })
  t.after(f.close)
  const abort = new AbortController()
  f.bot._client.on('window_items', packet => {
    if (Item.fromNotch(packet.carriedItem)) abort.abort(new Error('cancel with carried materials'))
  })
  await assert.rejects(f.executor.execute({ step: f.step, triggers: 100, signal: abort.signal }),
    error => error.recoveryRequired && /cancel with carried/.test(error.message))
  assert.equal(f.shifts, 0)
  assert.ok(f.player.selectedItem.count > 0)
  assert.equal(f.bot.inventory.selectedItem.count, f.player.selectedItem.count)
  assert.ok(f.clicks.some(click => click.slot === -1 && click.mode === 0))
  assert.equal(f.clicks.some(click => click.slot === -999), false)
  assert.ok(f.events.some(entry => entry.event === 'executor.window_close_confirmed' && !entry.details.confirmed))
})

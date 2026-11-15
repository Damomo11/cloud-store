'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const ItemCatalog = require('../../src/itemCatalog')
const { createConfirmedWindowClicker } = require('../../src/craft/confirmed-window')
const catalog = new ItemCatalog('1.21.11')
const registry = catalog.mcData
const Item = require('prismarine-item')(registry)
const windows = require('prismarine-windows')('1.21.11')
const notch = value => value ? Item.toNotch(value) : { itemCount: 0 }

function fixture (container = false) {
  const inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory')
  const window = container ? windows.createWindow(5, 'minecraft:generic_9x3', 'Barrel') : inventory
  const source = container ? window.inventoryStart : 9
  const stone = new Item(registry.itemsByName.stone.id, 1)
  window.updateSlot(source, stone)
  const bot = { registry, supportFeature: registry.supportFeature, inventory, currentWindow: container ? window : null,
    _client: new EventEmitter(), closeWindow: () => { bot.currentWindow = null } }
  bot._client.write = () => {}
  // Model Mineflayer's slot updates without manufacturing carriedItem updates.
  bot._client.on('window_items', packet => {
    if (packet.windowId === window.id && packet.items?.length === window.slots.length) {
      packet.items.forEach((value, slot) => { if (value) window.updateSlot(slot, Item.fromNotch(value)) })
    }
  })
  const click = createConfirmedWindowClicker(bot, catalog, { craft: { confirmTimeoutMs: 20 } }, undefined,
    { allowContainer: container })
  const slots = window.slots.map(notch)
  const accepted = { windowId: window.id, stateId: 2, items: structuredClone(slots), carriedItem: notch(container ? null : stone) }
  accepted.items[source] = notch(null)
  if (container) accepted.items[0] = Item.toNotch(stone)
  const emit = packet => bot._client.emit('window_items', packet)
  return { bot, window, source, click, accepted, emit }
}

for (const container of [false, true]) {
  for (const [label, supersede] of [
    ['different full content', f => {
      const items = f.accepted.items.map(value => structuredClone(value))
      items[f.source] = Item.toNotch(new Item(registry.itemsByName.diamond.id, 1))
      f.emit({ ...f.accepted, stateId: 3, items, carriedItem: notch(null) })
    }],
    ['incomplete full content', f => f.emit({ windowId: f.window.id, stateId: 3, items: [] })],
    ['undecodable full content', f => {
      const items = structuredClone(f.accepted.items); items[1] = undefined
      f.emit({ ...f.accepted, stateId: 3, items })
    }],
    ['slot update', f => f.bot._client.emit('set_slot', { windowId: f.window.id, slot: f.source, item: notch(null) })],
    ['slot update alias', f => f.bot._client.emit('container_set_slot', { containerId: f.window.id, slot: f.source, item: notch(null) })],
    ['cursor update', f => f.bot._client.emit('set_cursor_item', { contents: notch(null) })],
    ['cursor update alias', f => f.bot._client.emit('container_set_cursor_item', { contents: notch(null) })]
  ]) {
    test(`${container ? 'deposit' : 'craft'} click cannot reuse a confirmation superseded by ${label}`, async () => {
      const f = fixture(container)
      f.bot._client.write = () => { f.emit(f.accepted); supersede(f) }
      await assert.rejects(f.click(f.window, f.source, 0, container ? 1 : 0, () => {},
        container ? (slots, cursor) => !cursor && !slots[f.source] && slots[0]?.type === registry.itemsByName.stone.id : undefined),
      { recoveryRequired: true })
      if (label === 'different full content') assert.equal(f.window.slots[f.source].name, 'diamond')
      assert.equal(f.bot._client.listenerCount('container_set_slot'), 0)
      assert.equal(f.bot._client.listenerCount('set_cursor_item'), 0)
    })
  }
}

test('a fresh full content response can confirm a click after an intervening slot update', async () => {
  const f = fixture()
  f.bot._client.write = () => {
    f.emit(f.accepted)
    f.bot._client.emit('set_cursor_item', { contents: notch(null) })
    setImmediate(() => f.emit({ ...f.accepted, stateId: 4 }))
  }
  await f.click(f.window, f.source, 0, 0, () => {})
  assert.equal(f.window.slots[f.source], null)
  assert.equal(f.window.selectedItem.name, 'stone')
})

test('an asynchronous response burst also invalidates an earlier matching full content', async () => {
  const f = fixture()
  f.bot._client.write = () => setImmediate(() => {
    f.emit(f.accepted)
    f.emit({ ...f.accepted, stateId: 3, carriedItem: notch(null) })
  })
  await assert.rejects(f.click(f.window, f.source, 0, 0, () => {}), { recoveryRequired: true })
})

for (const [label, supersede] of [
  ['nonempty cursor', (f, packet) => f.emit({ ...packet, stateId: 3, carriedItem: Item.toNotch(new Item(registry.itemsByName.stone.id, 1)) })],
  ['incomplete content', f => f.emit({ windowId: 0, items: [] })],
  ['cursor delta', f => f.bot._client.emit('set_cursor_item', { contents: notch(null) })]
]) {
  test(`close confirmation waits for fresh evidence after ${label}`, async () => {
    const f = fixture()
    const packet = { windowId: 0, stateId: 2, items: f.window.slots.map(notch), carriedItem: notch(null) }
    f.bot._client.write = () => { f.emit(packet); supersede(f, packet) }
    assert.equal(await f.click.close(f.window), false)
  })
}

test('close can accept a fresh full response after a superseding cursor delta', async () => {
  const f = fixture()
  const packet = { windowId: 0, stateId: 2, items: f.window.slots.map(notch), carriedItem: notch(null) }
  f.bot._client.write = () => {
    f.emit(packet)
    f.bot._client.emit('set_cursor_item', { contents: notch(null) })
    setImmediate(() => f.emit({ ...packet, stateId: 4 }))
  }
  assert.equal(await f.click.close(f.window), true)
  assert.equal(f.bot._client.listenerCount('set_cursor_item'), 0)
})

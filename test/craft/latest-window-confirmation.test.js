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

function fixture (container = false, { table = false, allowPacking = false } = {}) {
  const inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory')
  const window = container ? windows.createWindow(5, table ? 'minecraft:crafting' : 'minecraft:generic_9x3', 'Container') : inventory
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
    { allowContainer: container && !table, allowPacking })
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
    ['slot update', f => f.bot._client.emit('set_slot', { windowId: f.window.id, slot: f.source, item: Item.toNotch(new Item(registry.itemsByName.diamond.id, 1)) })],
    ['slot update alias', f => f.bot._client.emit('container_set_slot', { containerId: f.window.id, slot: f.source, item: Item.toNotch(new Item(registry.itemsByName.diamond.id, 1)) })],
    ['cursor update', f => f.bot._client.emit('set_cursor_item', { contents: container ? Item.toNotch(new Item(registry.itemsByName.stone.id, 1)) : notch(null) })],
    ['cursor update alias', f => f.bot._client.emit('container_set_cursor_item', { contents: container ? Item.toNotch(new Item(registry.itemsByName.stone.id, 1)) : notch(null) })]
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
  ['cursor delta', f => f.bot._client.emit('set_cursor_item', { contents: Item.toNotch(new Item(registry.itemsByName.stone.id, 1)) })]
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
    f.bot._client.emit('set_cursor_item', { contents: Item.toNotch(new Item(registry.itemsByName.stone.id, 1)) })
    setImmediate(() => f.emit({ ...packet, stateId: 4 }))
  }
  assert.equal(await f.click.close(f.window), true)
  assert.equal(f.bot._client.listenerCount('set_cursor_item'), 0)
})

for (const container of [false, true]) {
  test(`${container ? 'deposit' : 'craft'} accepts identical deltas following a full confirmation`, async () => {
    const f = fixture(container)
    f.bot._client.write = () => setImmediate(() => {
      f.emit(f.accepted)
      f.bot._client.emit('set_slot', { windowId: f.window.id, slot: f.source, item: notch(null) })
      f.bot._client.emit('container_set_slot', { containerId: f.window.id, slot: f.source, item: notch(null) })
      f.bot._client.emit('set_player_inventory', { slotId: 9, contents: notch(null) })
      f.bot._client.emit('set_slot', { windowId: -2, slot: 9, item: notch(null) })
      f.bot._client.emit('set_slot', { windowId: -1, slot: -1, item: f.accepted.carriedItem })
      f.bot._client.emit('set_cursor_item', { contents: f.accepted.carriedItem })
      f.bot._client.emit('container_set_cursor_item', { contents: f.accepted.carriedItem })
    })
    await f.click(f.window, f.source, 0, container ? 1 : 0, () => {},
      container ? (slots, cursor) => !cursor && !slots[f.source] && slots[0]?.name === 'stone' : undefined)
    assert.equal(f.window.slots[f.source], null)
    assert.equal(f.window.selectedItem?.name || null, container ? null : 'stone')
  })
}

test('an identical delta cannot restore a confirmation invalidated by a changed player slot', async () => {
  const f = fixture(true)
  f.bot._client.write = () => {
    f.emit(f.accepted)
    f.bot._client.emit('set_player_inventory', { slotId: 9, contents: Item.toNotch(new Item(registry.itemsByName.diamond.id, 1)) })
    f.bot._client.emit('set_player_inventory', { slotId: 9, contents: notch(null) })
  }
  await assert.rejects(f.click(f.window, f.source, 0, 1, () => {}, slots => !slots[f.source]), { recoveryRequired: true })
})

function playerRefresh (f) {
  return { windowId: 0, stateId: 3, carriedItem: structuredClone(f.accepted.carriedItem),
    items: [...Array.from({ length: 9 }, () => notch(null)), ...structuredClone(f.accepted.items.slice(-36)), notch(null)] }
}

for (const table of [false, true]) {
  test(`${table ? 'workbench' : 'craft return'} keeps a full click confirmation across an identical player refresh`, async () => {
    const f = fixture(true, { table })
    f.bot._client.write = () => setImmediate(() => { f.emit(f.accepted); f.emit(playerRefresh(f)) })
    await f.click(f.window, f.source, 0, 1, () => {}, (slots, cursor) => !cursor && !slots[f.source] && slots[0]?.name === 'stone')
    assert.equal(f.window.slots[0].name, 'stone')
    assert.equal(f.bot.inventory.slots[9], null)
  })
}

for (const [label, supersede] of [
  ['changed item, even if followed by a duplicate', f => {
    const update = playerRefresh(f)
    update.items[9] = Item.toNotch(new Item(registry.itemsByName.stone.id, 1))
    f.emit(update)
    f.emit(playerRefresh(f))
  }],
  ['missing cursor', f => {
    const update = playerRefresh(f)
    delete update.carriedItem
    f.emit(update)
  }],
  ['occupied offhand', f => {
    const update = playerRefresh(f)
    update.items[45] = Item.toNotch(new Item(registry.itemsByName.stone.id, 1))
    f.emit(update)
  }],
  ['changed cursor', f => f.emit({ ...playerRefresh(f), carriedItem: Item.toNotch(new Item(registry.itemsByName.stone.id, 1)) })]
]) {
  test(`a full player refresh cannot preserve click confirmation with ${label}`, async () => {
    const f = fixture(true)
    f.bot._client.write = () => { f.emit(f.accepted); supersede(f) }
    await assert.rejects(f.click(f.window, f.source, 0, 1, () => {}, slots => !slots[f.source]), { recoveryRequired: true })
  })
}

test('packing container clicks still invalidate confirmation on a player refresh', async () => {
  const f = fixture(true, { allowPacking: true })
  f.bot._client.write = () => { f.emit(f.accepted); f.emit(playerRefresh(f)) }
  await assert.rejects(f.click(f.window, f.source, 0, 1, () => {}, slots => !slots[f.source]), { recoveryRequired: true })
})

test('a component-only change supersedes a confirmation', async () => {
  const f = fixture()
  const renamed = new Item(registry.itemsByName.stone.id, 1)
  renamed.components = [{ type: 'custom_name', data: { type: 'string', value: 'changed' } }]
  f.bot._client.write = () => {
    f.emit(f.accepted)
    f.bot._client.emit('set_cursor_item', { contents: Item.toNotch(renamed) })
  }
  await assert.rejects(f.click(f.window, f.source, 0, 0, () => {}), { recoveryRequired: true })
})

for (const event of ['set_player_inventory', 'set_slot']) {
  for (const changed of [false, true]) {
    test(`${event} compares vanilla hotbar indices with the matching menu slot (changed=${changed})`, async () => {
      const f = fixture(true)
      const stone = new Item(registry.itemsByName.stone.id, 1)
      f.window.updateSlot(f.window.inventoryStart + 27, stone)
      f.accepted.items[f.window.inventoryStart + 27] = Item.toNotch(stone)
      f.bot._client.write = () => {
        f.emit(f.accepted)
        const item = changed ? notch(null) : Item.toNotch(stone)
        f.bot._client.emit(event, event === 'set_slot' ? { windowId: -2, slot: 0, item } : { slotId: 0, contents: item })
      }
      const result = f.click(f.window, f.source, 0, 1, () => {}, slots => !slots[f.source])
      if (changed) await assert.rejects(result, { recoveryRequired: true })
      else await result
    })
  }
}

test('delta comparison does not discard components normalized out of warehouse item keys', async () => {
  const f = fixture()
  const hive = new Item(registry.itemsByName.beehive.id, 1)
  f.window.updateSlot(f.source, hive)
  f.accepted.carriedItem = Item.toNotch(hive)
  const changed = new Item(hive.type, 1)
  changed.components = [{ type: 'custom_name', data: { type: 'string', value: 'changed' } }]
  assert.equal(catalog.fromPrismarineItem(hive).itemKey, catalog.fromPrismarineItem(changed).itemKey)
  f.bot._client.write = () => {
    f.emit(f.accepted)
    f.bot._client.emit('set_cursor_item', { contents: Item.toNotch(changed) })
  }
  await assert.rejects(f.click(f.window, f.source, 0, 0, () => {}), { recoveryRequired: true })
})

test('malformed component counts cannot reuse a full confirmation', async () => {
  const f = fixture()
  f.bot._client.write = () => {
    f.emit(f.accepted)
    f.bot._client.emit('set_cursor_item', { contents: { ...f.accepted.carriedItem, addedComponentCount: 1 } })
  }
  await assert.rejects(f.click(f.window, f.source, 0, 0, () => {}), { recoveryRequired: true })
})

test('close accepts identical slot and empty-cursor notifications after its full snapshot', async () => {
  const f = fixture()
  const packet = { windowId: 0, stateId: 2, items: f.window.slots.map(notch), carriedItem: notch(null) }
  f.bot._client.write = () => setImmediate(() => {
    f.emit(packet)
    f.bot._client.emit('set_slot', { windowId: 0, slot: 9, item: packet.items[9] })
    f.bot._client.emit('set_cursor_item', { contents: notch(null) })
  })
  assert.equal(await f.click.close(f.window), true)
})

for (const delta of [
  { windowId: 0, slot: 9, item: { itemCount: 0, unexpected: true } },
  { windowId: 0, slot: 99, item: { itemCount: 0 } },
  { windowId: -1, slot: -1 },
  { windowId: 0, slot: 9, item: Item.toNotch(new Item(registry.itemsByName.stone.id, 2)) }
]) {
  test(`a full confirmation cannot survive a malformed or changed delta ${JSON.stringify(delta)}`, async () => {
    const f = fixture()
    f.bot._client.write = () => { f.emit(f.accepted); f.bot._client.emit('set_slot', delta) }
    await assert.rejects(f.click(f.window, f.source, 0, 0, () => {}), { recoveryRequired: true })
  })
}

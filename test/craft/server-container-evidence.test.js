'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const windows = require('prismarine-windows')('1.21.11')
const ItemCatalog = require('../../src/itemCatalog')
const { canReuseCraftWindow, openServerContainer } = require('../../src/craft/server-container-evidence')

function evidenceFixture () {
  const container = { id: 5, selectedItem: null }
  const bot = { currentWindow: container, inventory: { selectedItem: null } }
  const snapshot = {
    chestSlots: [{ slot: 0, itemKey: 'minecraft:stone|plain', amount: 12 }],
    playerItems: [{ itemKey: 'minecraft:oak_planks|plain', amount: 4 }],
    cursorEmpty: true
  }
  return { container, bot, snapshot, serverSnapshot: snapshot, local: structuredClone(snapshot) }
}

test('craft window evidence can be reused only while revision, owner, cursor and contents stay unchanged', () => {
  const f = evidenceFixture()
  assert.equal(canReuseCraftWindow({
    expectedRevision: 7,
    currentRevision: 7,
    bot: f.bot,
    container: f.container,
    serverSnapshot: f.snapshot,
    localSnapshot: f.local
  }), true)

  for (const mutate of [
    value => { value.currentRevision = 8 },
    value => { value.bot.currentWindow = { id: 5 } },
    value => { value.container.selectedItem = { name: 'stone', count: 1 } },
    value => { value.bot.inventory.selectedItem = { name: 'stone', count: 1 } },
    value => { value.bot.inventory.slots = [null, { name: 'stone', count: 1 }] },
    value => { value.serverSnapshot.chestSlots[0].amount = 11 },
    value => { value.local.playerItems[0].amount = 3 },
    value => { value.serverSnapshot.cursorEmpty = false }
  ]) {
    const value = evidenceFixture()
    mutate(value)
    assert.equal(canReuseCraftWindow({
      expectedRevision: value.expectedRevision ?? 7,
      currentRevision: value.currentRevision ?? 7,
      bot: value.bot,
      container: value.container,
      serverSnapshot: value.serverSnapshot,
      localSnapshot: value.local
    }), false)
  }
})

async function retainedFixture (afterContent, options, { fillHotbar = false, fillOffhand = false, omitInventorySlots = false } = {}) {
  const openOptions = options === undefined
    ? { keepEvidence: true, validateOffhand: true }
    : { validateOffhand: true, ...options }
  const catalog = new ItemCatalog('1.21.11')
  const Item = require('prismarine-item')(catalog.mcData)
  const container = windows.createWindow(5, 'minecraft:generic_9x3', 'Barrel')
  const bot = {
    registry: catalog.mcData,
    _client: new EventEmitter(),
    currentWindow: container,
    inventory: windows.createWindow(0, 'minecraft:inventory', 'Inventory')
  }
  if (fillHotbar) {
    const item = new Item(catalog.mcData.itemsByName.stone.id, 1)
    container.updateSlot(container.inventoryStart + 27, item)
    bot.inventory.updateSlot(36, item)
  }
  if (omitInventorySlots) delete bot.inventory.slots
  if (fillOffhand) bot.inventory.updateSlot(45, new Item(catalog.mcData.itemsByName.dirt.id, 1))
  const content = { windowId: 5, stateId: 1, items: container.slots.map(value => value ? Item.toNotch(value) : { itemCount: 0 }), carriedItem: { itemCount: 0 } }
  const warehouse = {
    openContainerAt: async () => {
      bot._client.emit('open_window', { windowId: 5 })
      bot._client.emit('window_items', content)
      afterContent?.(bot._client, content, Item.toNotch(new Item(catalog.mcData.itemsByName.stone.id, 1)))
      return container
    },
    closeContainerQuietly: () => {}
  }
  const { evidence } = await openServerContainer(warehouse, { chestId: 'source' }, catalog, bot, openOptions)
  return {
    bot,
    evidence,
    content,
    held: Item.toNotch(new Item(catalog.mcData.itemsByName.stone.id, 1)),
    offhand: Item.toNotch(bot.inventory.slots[45]),
    emptyOffhand: { itemCount: 0 }
  }
}

for (const [label, name, packet] of [
  ['current slot update', 'set_slot', (content, held) => ({ windowId: 5, slot: 0, item: held })],
  ['slot update alias', 'container_set_slot', (content, held) => ({ containerId: 5, slot: 0, item: held })],
  ['cursor update', 'set_cursor_item', () => ({})],
  ['incomplete full content', 'window_items', () => ({ windowId: 5, items: [] })],
  ['missing cursor', 'window_items', content => ({ windowId: 5, items: content.items })]
]) {
  test(`default opening evidence rejects a snapshot superseded by ${label}`, async () => {
    await assert.rejects(retainedFixture((client, content, held) => client.emit(name, packet(content, held)), {}))
  })
}

for (const [event, packet] of [
  ['set_slot', { windowId: 5, slot: 0, item: { itemCount: 0 } }],
  ['container_set_slot', { containerId: 5, slot: 0, item: { itemCount: 0 } }],
  ['set_slot', { windowId: -1, slot: -1, item: { itemCount: 0 } }],
  ['set_slot', { windowId: 0, slot: 36, item: { itemCount: 0 } }],
  ['set_slot', { windowId: 0, slot: 45, item: { itemCount: 0 } }],
  ['set_slot', { windowId: -2, slot: 0, item: { itemCount: 0 } }],
  ['set_player_inventory', { slotId: 0, contents: { itemCount: 0 } }],
  ['set_cursor_item', { contents: { itemCount: 0 } }],
  ['container_set_cursor_item', { contents: { itemCount: 0 } }]
]) {
  test(`opening and retained evidence survive identical ${event} ${JSON.stringify(packet)}`, async () => {
    const opened = await retainedFixture(client => client.emit(event, packet), {})
    assert.equal(opened.evidence, null)
    const f = await retainedFixture(client => client.emit(event, packet))
    try {
      assert.equal(f.evidence.isReusable(), true)
      f.bot._client.emit(event, packet)
      assert.equal(f.evidence.isReusable(), true)
    } finally { f.evidence.dispose() }
  })
}

test('identical deltas cannot restore invalidated retained evidence', async () => {
  const f = await retainedFixture()
  try {
    f.bot._client.emit('set_cursor_item', { contents: f.held })
    f.bot._client.emit('set_cursor_item', { contents: { itemCount: 0 } })
    assert.equal(f.evidence.isReusable(), false)
  } finally { f.evidence.dispose() }
})

test('retained player inventory deltas use vanilla hotbar numbering', async () => {
  const f = await retainedFixture(null, { keepEvidence: true }, { fillHotbar: true })
  try {
    assert.equal(f.evidence.isReusable(), true)
    f.bot._client.emit('set_player_inventory', { slotId: 0, contents: f.held })
    assert.equal(f.evidence.isReusable(), true)
    f.bot._client.emit('set_player_inventory', { slotId: 0, contents: { itemCount: 0 } })
    assert.equal(f.evidence.isReusable(), false)
  } finally { f.evidence.dispose() }
})

for (const [label, event, packet] of [
  ['window slot', 'set_slot', f => ({ windowId: 0, slot: 45, item: f.offhand })],
  ['player inventory', 'set_player_inventory', f => ({ slotId: 40, contents: f.offhand })],
  ['legacy inventory slot', 'set_slot', f => ({ windowId: -2, slot: 40, item: f.offhand })]
]) {
  test(`retained offhand deltas preserve identical opening state through ${label}`, async () => {
    const f = await retainedFixture(null, { keepEvidence: true }, { fillOffhand: true })
    try {
      assert.equal(f.evidence.isReusable(), true)
      f.bot._client.emit(event, packet(f))
      assert.equal(f.evidence.isReusable(), true)
    } finally { f.evidence.dispose() }
  })
}

test('retained empty offhand refresh is accepted only when it was already empty', async () => {
  const f = await retainedFixture(null, { keepEvidence: true })
  try {
    f.bot._client.emit('set_slot', { windowId: 0, slot: 45, item: f.emptyOffhand })
    assert.equal(f.evidence.isReusable(), true)
  } finally { f.evidence.dispose() }
})

test('retained offhand replacement invalidates evidence even when the slot stays occupied', async () => {
  const f = await retainedFixture(null, { keepEvidence: true }, { fillOffhand: true })
  try {
    f.bot._client.emit('set_slot', { windowId: 0, slot: 45, item: f.held })
    assert.equal(f.evidence.isReusable(), false)
  } finally { f.evidence.dispose() }
})

for (const [label, event, packet] of [
  ['cleared window slot', 'set_slot', f => ({ windowId: 0, slot: 45, item: f.emptyOffhand })],
  ['cleared player inventory', 'set_player_inventory', f => ({ slotId: 40, contents: f.emptyOffhand })],
  ['changed legacy inventory slot', 'set_slot', f => ({ windowId: -2, slot: 40, item: f.emptyOffhand })]
]) {
  test(`retained offhand changes invalidate evidence through ${label}`, async () => {
    const f = await retainedFixture(null, { keepEvidence: true }, { fillOffhand: true })
    try {
      f.bot._client.emit(event, packet(f))
      assert.equal(f.evidence.isReusable(), false)
    } finally { f.evidence.dispose() }
  })
}

test('retained offhand updates reject malformed empty-slot payloads', async () => {
  const f = await retainedFixture(null, { keepEvidence: true })
  try {
    f.bot._client.emit('set_slot', { windowId: 0, slot: 45, item: { itemCount: 0, unexpected: true } })
    assert.equal(f.evidence.isReusable(), false)
  } finally { f.evidence.dispose() }
})

test('a changed offhand cannot be hidden by a later full barrel refresh', async () => {
  const f = await retainedFixture()
  try {
    f.bot._client.emit('set_slot', { windowId: 0, slot: 45, item: f.held })
    f.bot._client.emit('window_items', { ...f.content, stateId: 2 })
    assert.equal(f.evidence.isReusable(), false)
  } finally { f.evidence.dispose() }
})

test('a changed offhand in a full player refresh cannot be hidden by a barrel refresh', async () => {
  const f = await retainedFixture()
  try {
    const player = playerMenuContent(f.content)
    player.items[45] = f.held
    f.bot._client.emit('window_items', player)
    f.bot._client.emit('window_items', { ...f.content, stateId: 2 })
    assert.equal(f.evidence.isReusable(), false)
  } finally { f.evidence.dispose() }
})

test('opening rejects an offhand change even when a fresh barrel snapshot follows', async () => {
  await assert.rejects(retainedFixture((client, content, held) => {
    client.emit('set_slot', { windowId: 0, slot: 45, item: held })
    client.emit('window_items', { ...content, stateId: 2 })
  }), /副手状态发生变化/)
})

test('opening fails closed when the offhand baseline is unavailable', async () => {
  await assert.rejects(
    retainedFixture(null, { keepEvidence: true }, { omitInventorySlots: true }),
    /开窗时无法确认副手状态/
  )
})

test('shared non-craft reads preserve empty offhand handling when validation is disabled', async () => {
  const f = await retainedFixture(null, { keepEvidence: true, validateOffhand: false })
  try {
    f.bot._client.emit('set_slot', { windowId: 0, slot: 45, item: f.emptyOffhand })
    assert.equal(f.evidence.isReusable(), true)
  } finally { f.evidence.dispose() }
})

test('retained duplicate comparison preserves component-count differences', async () => {
  const f = await retainedFixture(null, { keepEvidence: true }, { fillHotbar: true })
  try {
    f.bot._client.emit('set_player_inventory', { slotId: 0, contents: { ...f.held, addedComponentCount: 1 } })
    assert.equal(f.evidence.isReusable(), false)
  } finally { f.evidence.dispose() }
})

for (const packet of [
  { windowId: 5, slot: 99, item: { itemCount: 0 } },
  { windowId: 5, slot: 0, item: { itemCount: 0, unexpected: true } },
  { windowId: -2, slot: 41, item: { itemCount: 0 } }
]) {
  test(`malformed or unrepresented opening delta invalidates evidence ${JSON.stringify(packet)}`, async () => {
    await assert.rejects(retainedFixture(client => client.emit('set_slot', packet)))
  })
}

test('default opening ignores unrelated player-menu full content', async () => {
  const f = await retainedFixture((client, content) => client.emit('window_items', { ...content, windowId: 0 }), {})
  assert.equal(f.evidence, null)
  assert.equal(f.bot._client.eventNames().length, 0)
})

function playerMenuContent (content) {
  const empty = { itemCount: 0 }
  return {
    windowId: 0, stateId: 2, carriedItem: empty,
    items: [...Array(9).fill(empty), ...content.items.slice(-36), empty]
  }
}

test('craft opening keeps its barrel snapshot when a complete player refresh repeats the same state', async () => {
  const f = await retainedFixture((client, content) => client.emit('window_items', playerMenuContent(content)), { keepEvidence: true }, { fillHotbar: true })
  try {
    assert.equal(f.evidence.current().stateId, 1)
    assert.equal(f.evidence.isReusable(), true)
    f.bot._client.emit('window_items', playerMenuContent(f.content))
    assert.equal(f.evidence.isReusable(), false)
  } finally { f.evidence.dispose() }
})

for (const [label, change] of [
  ['changed backpack', (packet, item) => { packet.items[9] = item }],
  ['occupied crafting grid', (packet, item) => { packet.items[1] = item }],
  ['occupied offhand', (packet, item) => { packet.items[45] = item }],
  ['held cursor', (packet, item) => { packet.carriedItem = item }],
  ['missing cursor', packet => { delete packet.carriedItem }],
  ['short player window', packet => { packet.items.pop() }]
]) {
  test(`craft opening still rejects a player refresh with ${label}`, async () => {
    await assert.rejects(retainedFixture((client, content, item) => {
      const packet = playerMenuContent(content)
      change(packet, item)
      client.emit('window_items', packet)
    }), /没有收到当前容器完整的服务端快照/)
  })
}

for (const [label, name, packet] of [
  ['legacy cursor update', 'set_slot', f => ({ windowId: -1, slot: -1, item: f.held })],
  ['unsigned cursor update', 'set_slot', f => ({ windowId: 255, slot: -1, item: f.held })],
  ['container slot update', 'container_set_slot', f => ({ containerId: 5, slot: 0, item: f.held })],
  ['cursor update', 'set_cursor_item', f => ({ contents: f.held })],
  ['cursor update alias', 'container_set_cursor_item', f => ({ contents: f.held })],
  ['player inventory update', 'set_player_inventory', f => ({ slotId: 9, contents: f.held })],
  ['player slot update', 'set_slot', f => ({ windowId: 0, slot: 9, item: f.held })],
  ['occupied offhand update', 'set_slot', f => ({ windowId: 0, slot: 45, item: f.held })],
  ['player window content', 'window_items', f => ({ ...f.content, windowId: 0 })],
  ['undefined cursor', 'window_items', f => ({ ...f.content, carriedItem: undefined })],
  ['missing cursor', 'window_items', f => ({ windowId: 5, items: f.content.items })],
  ['incomplete content', 'window_items', f => ({ ...f.content, items: [] })]
]) {
  test(`retained evidence requires new full content after ${label}`, async () => {
    const f = await retainedFixture()
    try {
      assert.equal(f.evidence.isReusable(), true)
      f.bot._client.emit(name, packet(f))
      assert.equal(f.evidence.isReusable(), false)
    } finally {
      f.evidence.dispose()
      assert.equal(f.bot._client.eventNames().length, 0)
    }
  })
}

test('a fresh full owned-window snapshot restores evidence invalidated by a cursor packet', async () => {
  const f = await retainedFixture()
  try {
    f.bot._client.emit('set_cursor_item', { contents: f.held })
    assert.equal(f.evidence.isReusable(), false)
    f.bot._client.emit('window_items', { ...f.content, stateId: 3 })
    assert.equal(f.evidence.isReusable(), true)
  } finally { f.evidence.dispose() }
})

for (const [label, name, packet] of [
  ['cursor update', 'set_cursor_item', () => ({})],
  ['incomplete content', 'window_items', () => ({ windowId: 5, items: [] })],
  ['missing cursor', 'window_items', content => ({ windowId: 5, items: content.items })]
]) {
  test(`opening evidence cannot use a full snapshot superseded by ${label}`, async () => {
    await assert.rejects(retainedFixture((client, content) => client.emit(name, packet(content))))
  })
}

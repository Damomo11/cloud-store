'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const registry = require('minecraft-data')('1.21.11')
const Item = require('prismarine-item')(registry)
const ItemCatalog = require('../../src/itemCatalog')
const { createConfirmedWindowClicker } = require('../../src/craft/confirmed-window')

function fixture (writer) {
  const window = require('prismarine-windows')(registry.version.minecraftVersion).createWindow(0, 'minecraft:inventory', 'Inventory')
  const value = new Item(registry.itemsByName.stick.id, 1)
  value.components = [{ type: 'custom_name', data: 'private component payload' }]
  window.updateSlot(9, value)
  const client = new EventEmitter()
  client.write = () => {}
  const events = []
  const catalog = new ItemCatalog('1.21.11', {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })
  const bot = { registry, supportFeature: () => true, inventory: window, _client: client, closeWindow () {} }
  const click = createConfirmedWindowClicker(bot, catalog, { craft: { confirmTimeoutMs: 25 } },
    writer || ((event, details) => events.push({ event, details })))
  const reply = (matches = true) => client.emit('window_items', { windowId: 0, stateId: 7,
    items: window.slots.map((item, slot) => Item.toNotch(matches && slot === 9 ? null : item)),
    carriedItem: Item.toNotch(matches ? value : null) })
  return { window, value, client, events, click, reply }
}

test('click diagnostics distinguish incomplete and mismatched replies without logging components', async () => {
  const f = fixture()
  let writes = 0
  f.client.write = () => {
    writes++
    f.client.emit('window_items', { windowId: 99 })
    f.client.emit('window_items', { windowId: 0, items: [] })
    f.reply(false)
    f.reply(true)
  }
  await f.click(f.window, 9, 0, 0, () => {})
  assert.equal(writes, 1)
  assert.equal(f.window.selectedItem.count, 1)
  const details = f.events.find(entry => entry.event === 'executor.window_click_confirmed').details
  assert.equal(details.responseCount, 3)
  assert.equal(details.incompleteResponseCount, 1)
  assert.equal(details.rejectedResponseCount, 1)
  assert.equal(details.lastMismatch.reason, 'cursor')
  assert.equal(details.lastMismatch.expected.itemId, 'minecraft:stick')
  assert.equal(details.lastMismatch.observed, null)
  assert.ok(details.firstResponseMs >= 0)
  assert.ok(details.confirmationMs >= details.firstResponseMs)
  assert.ok(details.elapsedMs >= details.confirmationMs)
  assert.doesNotMatch(JSON.stringify(f.events), /private component payload|components|nbt/)
  assert.equal(f.client.listenerCount('window_items'), 0)
})

test('unconfirmed clicks report elapsed wait and the last conflicting slot before recovery', async () => {
  const f = fixture()
  let writes = 0
  f.client.write = () => {
    writes++
    // The carried item is correct, but the source slot was never cleared.
    f.client.emit('window_items', { windowId: 0, stateId: 8,
      items: f.window.slots.map(item => Item.toNotch(item)), carriedItem: Item.toNotch(f.value) })
  }
  await assert.rejects(f.click(f.window, 9, 0, 0, () => {}), error => error.recoveryRequired)
  assert.equal(writes, 1)
  const details = f.events.find(entry => entry.event === 'executor.window_confirmation_timeout').details
  assert.equal(details.responseCount, 1)
  assert.equal(details.confirmationMs, null)
  assert.equal(details.lastMismatch.reason, 'slot')
  assert.equal(details.lastMismatch.slot, 9)
  assert.equal(details.lastMismatch.expected, null)
  assert.equal(details.lastMismatch.observed.itemId, 'minecraft:stick')
  assert.ok(details.elapsedMs >= 0)
  assert.equal(f.client.listenerCount('window_items'), 0)
})

test('diagnostic writer failures cannot reject a server-confirmed click or close', async () => {
  const f = fixture(() => { throw new Error('log sink unavailable') })
  f.client.write = () => f.reply(true)
  await f.click(f.window, 9, 0, 0, () => {})
  f.client.write = () => f.client.emit('window_items', { windowId: 0, stateId: 9,
    items: f.window.slots.map(() => Item.toNotch(null)), carriedItem: Item.toNotch(null) })
  assert.equal(await f.click.close(f.window), true)
  assert.equal(f.client.listenerCount('window_items'), 0)
})

test('writing a slow start diagnostic does not consume the server confirmation budget', async () => {
  const f = fixture(event => {
    if (event !== 'executor.window_confirmation_start') return
    const until = performance.now() + 40
    while (performance.now() < until) { /* Simulate a synchronous blocked log writer. */ }
  })
  f.client.write = () => setImmediate(() => f.reply(true))
  await f.click(f.window, 9, 0, 0, () => {})
  assert.equal(f.window.selectedItem.count, 1)
  assert.equal(f.client.listenerCount('window_items'), 0)
})

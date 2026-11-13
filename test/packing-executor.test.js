'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const registry = require('minecraft-data')('1.21.11')
const Item = require('prismarine-item')(registry)
const windows = require('prismarine-windows')('1.21.11')
const protocol = require('minecraft-protocol')
const serializer = protocol.createSerializer({ state: 'play', version: '1.21.11', isServer: true })
const deserializer = protocol.createDeserializer({ state: 'play', version: '1.21.11', isServer: false })
const roundtrip = (name, params) => deserializer.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data.params
const ItemCatalog = require('../src/itemCatalog')
const { createConfirmedWindowClicker } = require('../src/craft/confirmed-window')
const { planPacking } = require('../src/packing/planner')
const catalog = new ItemCatalog('1.21.11', {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })
const item = (name, count = 1, components = []) => {
  const value = new Item(registry.itemsByName[name].id, count)
  value.components = structuredClone(components)
  return value
}
const copy = value => value ? Item.fromNotch(structuredClone(Item.toNotch(value))) : null
const row = value => catalog.fromPrismarineItem(value)
const named = name => [{ type: 'custom_name', data: { type: 'string', value: name } }]

function fixture (options = {}) {
  const bot = new EventEmitter()
  Object.assign(bot, { registry, supportFeature: registry.supportFeature, _client: new EventEmitter(), currentWindow: null,
    inventory: windows.createWindow(0, 'minecraft:inventory', 'Inventory') })
  const player = windows.createWindow(0, 'minecraft:inventory', 'Server inventory')
  const originalBox = item('blue_shulker_box', 1, named('Owned box'))
  const stocks = options.stocks || [item('stone', 32), item('stone', 33), item('ender_pearl', 16), item('diamond_sword')]
  const inputs = catalog.aggregatePrismarineItems(stocks)
  player.updateSlot(9, copy(originalBox))
  stocks.forEach((value, i) => player.updateSlot(10 + i, copy(value)))
  player.slots.forEach((value, i) => bot.inventory.updateSlot(i, copy(value)))
  let menu = null
  let shifts = 0
  let opens = 0
  let closes = 0
  let pendingShift = null
  const clicks = []
  const timers = new Set()
  const schedule = (fn, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); fn() }, delay || 1)
    timers.add(timer)
  }
  const snapshot = window => ({ windowId: window.id, stateId: 4,
    items: window.slots.map(value => Item.toNotch(copy(value))), carriedItem: Item.toNotch(window.selectedItem) })
  const emit = (window, kind) => {
    const packet = roundtrip('window_items', snapshot(window))
    options.packet?.(packet, kind, shifts)
    bot._client.emit(options.contentEvent || 'window_items', packet)
  }
  const product = () => {
    const box = copy(originalBox)
    box.components.push({ type: 'container', data: { contents: menu.slots.slice(0, 27).filter(Boolean).map(value => Item.toNotch(value)) } })
    if (options.emptyPlaceholders) box.components.at(-1).data.contents.push({ itemCount: 0 })
    return box
  }
  const warehouse = {
    isQuickShulkerWindow: window => window.type === 'minecraft:shulker_box' && window.inventoryStart === 27,
    async openQuickShulkerWindow (key) {
      opens++
      assert.equal(key, row(player.slots[9]).itemKey, 'opening must select the exact held box')
      if (options.openDelay) await new Promise(resolve => schedule(resolve, options.openDelay))
      menu = windows.createWindow(8, options.wrongWindow ? 'minecraft:generic_9x3' : 'minecraft:shulker_box', 'Server box')
      const contents = player.slots[9].components.find(value => value.type === 'container')?.data.contents || []
      contents.forEach((value, slot) => menu.updateSlot(slot, Item.fromNotch(value)))
      for (let i = 0; i < 36; i++) menu.updateSlot(27 + i, copy(player.slots[9 + i]))
      options.initial?.(menu)
      bot.currentWindow = windows.createWindow(8, menu.type, 'Client box')
      if (!options.noOpenPacket) bot._client.emit('open_window', roundtrip('open_window', { windowId: 8,
        inventoryType: windows.windows[menu.type].type, windowTitle: { type: 'string', value: 'Server box' } }))
      if (!options.noInitial) {
        if (options.initialDelay) schedule(() => emit(menu, 'initial'), options.initialDelay)
        else emit(menu, 'initial')
      }
      return bot.currentWindow
    }
  }
  bot.closeWindow = window => {
    closes++
    if (menu) {
      for (let i = 0; i < 36; i++) player.updateSlot(9 + i, copy(menu.slots[27 + i]))
      if (!options.staleClose) player.updateSlot(9, product())
    }
    bot.currentWindow = null
  }
  bot._client.write = (name, packet) => {
    assert.equal(name, 'window_click')
    clicks.push(packet)
    assert.deepEqual(packet.changedSlots, [])
    assert.equal(packet.stateId, -1)
    if (packet.slot < 0) {
      assert.equal(packet.slot, -1)
      if (!options.noClose) schedule(() => emit(player, 'close'), options.closeDelay)
      return
    }
    assert.equal(packet.mode, 1, 'packing must use stack shifts')
    shifts++
    const apply = () => {
      const source = menu.slots[packet.slot]
      if (options.refuseAt !== shifts) {
        const limit = source.components.find(value => value.type === 'max_stack_size')?.data || source.stackSize
        let remaining = source.count
        for (let i = 0; i < 27 && remaining; i++) {
          const target = menu.slots[i]
          if (target && row(target).itemKey !== row(source).itemKey) continue
          const moved = Math.min(limit - (target?.count || 0), remaining)
          if (!moved) continue
          const next = copy(source)
          next.count = (target?.count || 0) + moved
          menu.updateSlot(i, next)
          remaining -= moved
        }
        const rest = copy(source)
        rest.count = remaining
        menu.updateSlot(packet.slot, remaining ? rest : null)
      }
      options.afterShift?.(menu, shifts)
      emit(menu, 'shift')
    }
    if (options.holdShift) pendingShift = apply
    else schedule(apply, options.shiftDelay)
  }
  const { PackingExecutor } = require('../src/packing/executor')
  const config = { craft: { confirmTimeoutMs: 70 } }
  const executor = new PackingExecutor({ bot, catalog, warehouse, config, debug: options.debug })
  return { bot, player, executor, config, inputs, box: row(originalBox), clicks,
    releaseShift () { assert.ok(pendingShift); const apply = pendingShift; pendingShift = null; apply() },
    get menu () { return menu }, get shifts () { return shifts }, get opens () { return opens }, get closes () { return closes },
    cleanup () { for (const timer of timers) clearTimeout(timer) },
    assertListeners () { for (const name of ['open_window', 'open_screen', 'window_items', 'container_set_content']) assert.equal(bot._client.listenerCount(name), 0, name) } }
}

test('packing-only adapter permits a 27-slot shulker shift, ordinary callers reject it', async () => {
  const window = windows.createWindow(7, 'minecraft:shulker_box', 'Box')
  const client = new EventEmitter()
  const bot = { registry, supportFeature: registry.supportFeature, _client: client, currentWindow: window,
    inventory: windows.createWindow(0, 'minecraft:inventory', 'Inventory') }
  client.write = () => client.emit('window_items', roundtrip('window_items', { windowId: 7, stateId: 1, items: window.slots.map(Item.toNotch), carriedItem: Item.toNotch(null) }))
  for (const options of [{}, { allowContainer: true }]) {
    await assert.rejects(createConfirmedWindowClicker(bot, catalog, {}, undefined, options)(window, 27, 0, 1, () => {}, () => true))
  }
  await createConfirmedWindowClicker(bot, catalog, {}, undefined, { allowPacking: true })(window, 27, 0, 1, () => {}, () => true)
})

test('packs mixed 64/16/1 stacks and preserves a named colored physical box', async t => {
  const f = fixture({ debug () { throw new Error('logging failed') } })
  t.after(f.cleanup)
  const result = await f.executor.execute(f)
  assert.equal(result.product.itemId, 'minecraft:blue_shulker_box')
  assert.equal(result.product.amount, 1)
  assert.equal(JSON.parse(result.product.metaJson).components.find(value => value.type === 'custom_name').data.value, 'Owned box')
  assert.deepEqual(result.packedInputs, f.inputs)
  assert.deepEqual(f.menu.slots.slice(0, 5).map(value => value?.count), [64, 1, 16, 1, undefined])
  assert.equal(f.shifts, 4)
  assert.equal(f.executor.isBusy(), false)
  f.assertListeners()
})

test('keeps exact variants and partial component-limited stacks separate with delayed responses', async t => {
  const limited = [...named('limited'), { type: 'max_stack_size', data: 4 }]
  const f = fixture({ stocks: [item('stone', 3, limited), item('stone', 3, limited), item('stone', 2, named('other'))], initialDelay: 10, shiftDelay: 10, contentEvent: 'container_set_content' })
  t.after(f.cleanup)
  await f.executor.execute(f)
  assert.deepEqual(f.menu.slots.slice(0, 3).map(value => value.count), [4, 2, 2])
  f.assertListeners()
})

test('valid serialized empty container slots do not masquerade as missing contents', async t => {
  const f = fixture({ emptyPlaceholders: true })
  t.after(f.cleanup)
  const result = await f.executor.execute(f)
  assert.deepEqual(result.packedInputs.map(value => value.amount), [65, 16, 1])
  f.assertListeners()
})

test('executes a real owned planner batch and preserves its owner in the proof', async t => {
  const f = fixture()
  t.after(f.cleanup)
  const plan = planPacking({ ownerUuid: 'actual-owner', items: f.inputs, availableItems: [f.box, ...f.inputs], emptyBoxes: [f.box], catalog })
  const result = await f.executor.execute(plan.boxes[0])
  assert.deepEqual(result.packedInputs, plan.boxes[0].inputs)
  assert.ok(result.packedInputs.every(value => value.ownerUuid === 'actual-owner'))
})

for (const [name, options] of [
  ['wrong window', { wrongWindow: true }], ['missing open identity', { noOpenPacket: true }], ['missing initial packet', { noInitial: true }],
  ['nonempty target', { initial: menu => menu.updateSlot(0, item('dirt')) }],
  ['wrong held box', { initial: menu => menu.updateSlot(27, item('red_shulker_box')) }],
  ['foreign inventory', { initial: menu => menu.updateSlot(62, item('dirt')) }],
  ['server cursor', { initial: menu => { menu.selectedItem = item('stone') } }],
  ['refused shift', { refuseAt: 1 }], ['partial then refused', { refuseAt: 2 }],
  ['slot zero mutation', { afterShift: menu => menu.updateSlot(0, item('dirt')) }],
  ['shell changed', { afterShift: menu => menu.updateSlot(27, item('red_shulker_box')) }],
  ['missing carried item', { packet: (packet, kind) => { if (kind === 'shift') delete packet.carriedItem } }],
  ['malformed carried item', { packet: (packet, kind) => { if (kind === 'shift') packet.carriedItem = {} } }],
  ['hidden carried item at initial', { packet: (packet, kind) => { if (kind === 'initial') packet.carriedItem = { itemCount: 0, itemId: registry.itemsByName.stone.id } } }],
  ['hidden carried item at shift', { packet: (packet, kind) => { if (kind === 'shift') packet.carriedItem = { itemCount: 0, itemId: registry.itemsByName.stone.id } } }],
  ['close hidden carried item', { packet: (packet, kind) => { if (kind === 'close') packet.carriedItem = { itemCount: 0, itemId: registry.itemsByName.stone.id } } }],
  ['close missing carried item', { packet: (packet, kind) => { if (kind === 'close') delete packet.carriedItem } }],
  ['close wrong named box', { packet: (packet, kind) => { if (kind === 'close') packet.items[9].components[0].data = { type: 'string', value: 'Other owner' } } }],
  ['close hidden zero contents', { packet: (packet, kind) => { if (kind === 'close') packet.items[9].components.at(-1).data.contents.push({ itemCount: 0, components: [] }) } }],
  ['close unknown contents', { packet: (packet, kind) => { if (kind === 'close') packet.items[9].components.at(-1).data.contents[0].itemId = 999999 } }],
  ['close nested box contents', { packet: (packet, kind) => { if (kind === 'close') packet.items[9].components.at(-1).data.contents[0].itemId = registry.itemsByName.shulker_box.id } }],
  ['close oversized contents', { packet: (packet, kind) => { if (kind === 'close') packet.items[9].components.at(-1).data.contents[0].itemCount = 65 } }],
  ['close missing', { noClose: true }], ['close unchanged NBT', { staleClose: true }]
]) {
  test(`fails closed on ${name}`, async t => {
    const f = fixture(options)
    t.after(f.cleanup)
    await assert.rejects(f.executor.execute(f), error => error.recoveryRequired === true)
    assert.equal(f.executor.isBusy(), false)
    assert.ok(f.shifts <= (options.refuseAt || (name.startsWith('close') ? 4 : 1)))
    f.assertListeners()
  })
}

test('rejects local cursor and extra items before quick opening', async t => {
  const f = fixture()
  t.after(f.cleanup)
  f.bot.inventory.selectedItem = item('dirt')
  await assert.rejects(f.executor.execute(f), /cursor/i)
  assert.equal(f.opens, 0)
  f.assertListeners()
})

for (const packed of [false, true]) {
  test(`recovery proves ${packed ? 'partial contents' : 'an unchanged empty box'} without filling`, async t => {
    const f = fixture(packed ? { refuseAt: 2 } : { refuseAt: 1 })
    t.after(f.cleanup)
    await assert.rejects(f.executor.execute(f))
    const shifts = f.shifts
    const result = await f.executor.recover(f)
    assert.equal(f.shifts, shifts)
    assert.deepEqual(result.packedInputs.map(value => [value.itemId, value.amount]), packed ? [['minecraft:stone', 32]] : [])
    assert.deepEqual(result.remainingInputs.map(value => [value.itemId, value.amount]), packed
      ? [['minecraft:stone', 33], ['minecraft:ender_pearl', 16], ['minecraft:diamond_sword', 1]]
      : [['minecraft:stone', 65], ['minecraft:ender_pearl', 16], ['minecraft:diamond_sword', 1]])
    f.assertListeners()
  })
}

test('cancel retains the busy lease while open and close promises drain', async t => {
  const f = fixture({ openDelay: 25, closeDelay: 25 })
  t.after(f.cleanup)
  const pending = f.executor.execute(f)
  const rejected = assert.rejects(pending, error => error.recoveryRequired && /stop/.test(error.message))
  f.executor.cancel('stop')
  assert.equal(f.executor.isBusy(), true)
  await assert.rejects(f.executor.recover(f), /busy/i)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.executor.isBusy(), true)
  await rejected
  assert.equal(f.shifts, 0)
  assert.equal(f.executor.isBusy(), false)
  f.assertListeners()
})

test('abort during a delayed shift drains its confirmation before close and releases no early busy lease', async t => {
  const f = fixture({ holdShift: true, closeDelay: 20 })
  t.after(f.cleanup)
  const abort = new AbortController()
  const pending = f.executor.execute({ ...f, signal: abort.signal })
  const rejected = assert.rejects(pending, error => error.recoveryRequired && /died/.test(error.message))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.shifts, 1)
  abort.abort(new Error('bot died'))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.executor.isBusy(), true)
  assert.equal(f.closes, 0, 'close must wait for the outstanding shift confirmation')
  f.releaseShift()
  await rejected
  assert.equal(f.shifts, 1)
  const recovered = await f.executor.recover(f)
  assert.deepEqual(recovered.packedInputs.map(value => [value.itemId, value.amount]), [['minecraft:stone', 32]])
  f.assertListeners()
})

test('duplicate requested identities cannot inflate the returned packed proof', async t => {
  const f = fixture()
  t.after(f.cleanup)
  await assert.rejects(f.executor.execute({ ...f, inputs: [{ ...f.inputs[0], amount: 32 }, { ...f.inputs[0], amount: 33 }, ...f.inputs.slice(1)] }), error => error.recoveryRequired)
  assert.equal(f.shifts, 0)
})

test('a disconnected write preserves the original failure and cleans packet listeners', async t => {
  const f = fixture()
  t.after(f.cleanup)
  const failure = new Error('connection ended')
  f.bot._client.write = () => { throw failure }
  await assert.rejects(f.executor.execute(f), error => error === failure && error.recoveryRequired)
  assert.equal(f.executor.isBusy(), false)
  f.assertListeners()
})

test('caller check cancellation after opening sends no fill click and keeps the original error', async t => {
  const f = fixture()
  t.after(f.cleanup)
  const failure = new Error('operation timed out')
  await assert.rejects(f.executor.execute({ ...f, check () { if (f.opens) throw failure } }), error => error === failure && error.recoveryRequired)
  assert.equal(f.shifts, 0)
  f.assertListeners()
})

for (const [name, mutate] of [
  ['missing box', f => { f.bot.inventory.updateSlot(9, null) }],
  ['ambiguous box', f => { f.bot.inventory.updateSlot(44, copy(f.player.slots[9])) }],
  ['foreign item', f => { f.bot.inventory.updateSlot(44, item('dirt')) }],
  ['missing loose quantity', f => { f.player.updateSlot(10, null) }],
  ['excessive loose quantity', f => { f.player.updateSlot(10, item('stone', 64)) }]
]) {
  test(`recovery rejects ${name} and never fills`, async t => {
    const f = fixture()
    t.after(f.cleanup)
    mutate(f)
    await assert.rejects(f.executor.recover(f), error => error.recoveryRequired)
    assert.equal(f.shifts, 0)
    f.assertListeners()
  })
}

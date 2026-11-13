'use strict'
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const StoreDb = require('../../src/db')
const ItemCatalog = require('../../src/itemCatalog')
const Warehouse = require('../../src/warehouse')
const { AsyncMutex } = require('../../src/taskPool')
const { DEFAULT_CONFIG } = require('../../src/config')
const catalog = new ItemCatalog('1.21.11')
const registry = catalog.mcData
const Item = require('prismarine-item')(registry)
const windows = require('prismarine-windows')('1.21.11')
const protocol = require('minecraft-protocol')
const serializer = protocol.createSerializer({ state: 'play', version: '1.21.11', isServer: true })
const deserializer = protocol.createDeserializer({ state: 'play', version: '1.21.11', isServer: false })
const wire = (name, params) => deserializer.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data.params
const item = (name, count = 1, components = []) => Object.assign(new Item(registry.itemsByName[name].id, count), { components: structuredClone(components) })
const copy = value => value ? Item.fromNotch(structuredClone(Item.toNotch(value))) : null
const row = value => catalog.fromPrismarineItem(value)
const owner = { uuid: 'alice', username: 'Alice', scope: 'personal' }
function fixture (options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'packing-controller-'))
  const config = structuredClone(DEFAULT_CONFIG)
  config.craft.confirmTimeoutMs = 50
  const db = new StoreDb(path.join(directory, 'db.sqlite'), config)
  db.setCatalog(catalog)
  const bot = Object.assign(new EventEmitter(), { username: 'bot-a', registry, supportFeature: registry.supportFeature,
    _client: new EventEmitter(), currentWindow: null, inventory: windows.createWindow(0, 'minecraft:inventory', 'Client') })
  const player = windows.createWindow(0, 'minecraft:inventory', 'Server')
  const barrels = new Map()
  let menu = null
  let openedChest = null
  let quickSlot = null
  let shifts = 0
  let withdrawals = 0
  const calls = []
  const warehouse = new Warehouse(bot, db, catalog, config, new AsyncMutex())
  warehouse.goHomeIfAway = async () => {}
  warehouse.closeContainerQuietly = window => bot.closeWindow(window)
  const emit = window => {
    const packet = wire('window_items', { windowId: window.id, stateId: 1, items: window.slots.map(value => Item.toNotch(copy(value))), carriedItem: Item.toNotch(window.selectedItem) })
    options.packet?.(packet, window.id)
    bot._client.emit('window_items', packet)
  }
  const sync = () => player.slots.forEach((value, slot) => bot.inventory.updateSlot(slot, copy(value)))
  const addChest = (id, contents = []) => {
    const chest = { chestId: id, x: barrels.size, y: 64, z: 0, blockName: 'barrel' }
    db.upsertChest(chest)
    const slots = Array(27).fill(null)
    contents.forEach((value, index) => { slots[index] = copy(value) })
    barrels.set(id, slots)
    db.replaceChestSlots(id, slots.flatMap((value, slot) => value ? [{ ...row(value), slot }] : []))
    return chest
  }
  warehouse.openContainerAt = async chest => {
    calls.push(chest.chestId)
    await options.beforeOpen?.(chest)
    if (!barrels.has(chest.chestId)) throw new Error('missing barrel')
    openedChest = chest.chestId
    menu = windows.createWindow(5, 'minecraft:generic_9x3', 'Barrel')
    barrels.get(chest.chestId).forEach((value, slot) => menu.updateSlot(slot, copy(value)))
    for (let i = 0; i < 36; i++) menu.updateSlot(27 + i, copy(player.slots[9 + i]))
    bot.currentWindow = windows.createWindow(5, menu.type, 'Client barrel')
    menu.slots.forEach((value, slot) => bot.currentWindow.updateSlot(slot, copy(value)))
    bot._client.emit('open_window', wire('open_window', { windowId: 5, inventoryType: windows.windows[menu.type].type, windowTitle: { type: 'string', value: 'Barrel' } }))
    emit(menu)
    return bot.currentWindow
  }
  warehouse.isQuickShulkerWindow = window => window.type === 'minecraft:shulker_box'
  warehouse.openQuickShulkerWindow = async key => {
    quickSlot = player.slots.findIndex(value => value && row(value).itemKey === key)
    if (quickSlot < 0) throw new Error('missing exact quick box')
    menu = windows.createWindow(8, 'minecraft:shulker_box', 'Quick box')
    const contents = player.slots[quickSlot].components.find(value => value.type === 'container')?.data.contents || []
    contents.forEach((value, slot) => menu.updateSlot(slot, Item.fromNotch(value)))
    for (let i = 0; i < 36; i++) menu.updateSlot(27 + i, copy(player.slots[9 + i]))
    bot.currentWindow = windows.createWindow(8, menu.type, 'Client quick box')
    bot._client.emit('open_window', wire('open_window', { windowId: 8, inventoryType: windows.windows[menu.type].type, windowTitle: { type: 'string', value: 'Quick box' } }))
    emit(menu)
    return bot.currentWindow
  }
  bot.closeWindow = () => {
    if (menu) {
      if (openedChest) barrels.set(openedChest, menu.slots.slice(0, 27).map(copy))
      for (let i = 0; i < 36; i++) player.updateSlot(9 + i, copy(menu.slots[27 + i]))
      if (quickSlot !== null) {
        const box = copy(player.slots[quickSlot])
        box.components = [...box.components.filter(value => value.type !== 'container'), { type: 'container', data: { contents: menu.slots.slice(0, 27).filter(Boolean).map(Item.toNotch) } }]
        player.updateSlot(quickSlot, box)
      }
    }
    menu = null
    quickSlot = null
    openedChest = null
    bot.currentWindow = null
    sync()
  }
  bot._client.write = (name, packet) => {
    if (name !== 'window_click') throw new Error('unexpected packet')
    if (packet.slot === -1) { if (!options.noClose) emit(player); return }
    shifts++
    const source = menu.slots[packet.slot]
    if (!options.refuseReturn && options.refuseAt !== shifts) {
      let remaining = source.count
      for (let i = 0; i < 27 && remaining; i++) {
        const target = menu.slots[i]
        if (target && row(target).itemKey !== row(source).itemKey) continue
        const moved = Math.min(source.stackSize - (target?.count || 0), remaining)
        if (!moved) continue
        const next = copy(source); next.count = (target?.count || 0) + moved
        menu.updateSlot(i, next); remaining -= moved
      }
      const rest = copy(source); rest.count = remaining
      menu.updateSlot(packet.slot, remaining ? rest : null)
    }
    options.afterShift?.(menu, shifts)
    if (!options.noReturnResponse) emit(menu)
  }
  // Only physical withdrawal is a seam here. All journal/accounting and all
  // return evidence use real implementations and serialized server packets.
  warehouse.withdrawAllocationsLocked = async (allocations, opts) => {
    withdrawals++
    if (!opts.requireServerEvidence) throw new Error('non-strict withdrawal')
    await options.beforeWithdraw?.(allocations)
    let budget = options.withdrawLimit ?? Infinity
    for (const allocation of allocations) {
      let need = allocation.amount
      for (const slots of barrels.values()) {
        for (let i = 0; i < slots.length && need && budget; i++) {
          const source = slots[i]
          if (!source || row(source).itemKey !== allocation.itemKey) continue
          const take = Math.min(source.count, need, budget)
          const target = player.slots.findIndex((value, slot) => slot >= 9 && slot < 45 && !value)
          if (target < 0) throw new Error('fixture full')
          const next = copy(source); next.count = take; player.updateSlot(target, next)
          source.count -= take; if (!source.count) slots[i] = null
          need -= take; budget -= take
        }
      }
    }
    sync()
    if (options.withdrawError) throw new Error('withdraw interrupted')
    return { withdrawn: [], missing: [] }
  }
  const executor = {
    isBusy: () => false, cancel () {},
    async execute ({ box, inputs }) {
      await options.beforeExecute?.()
      const packed = options.packLimit == null ? inputs : inputs.map(value => ({ ...value, amount: Math.min(value.amount, options.packLimit) })).filter(value => value.amount)
      const boxSlot = player.slots.findIndex(value => value && row(value).itemKey === box.itemKey)
      const value = copy(player.slots[boxSlot])
      const contents = []
      for (const input of packed) {
        let need = input.amount
        for (let slot = 9; slot < 45 && need; slot++) {
          const source = player.slots[slot]
          if (!source || row(source).itemKey !== input.itemKey) continue
          const moved = Math.min(source.count, need)
          const entry = copy(source); entry.count = moved; contents.push(Item.toNotch(entry))
          source.count -= moved; if (!source.count) player.updateSlot(slot, null)
          need -= moved
        }
      }
      value.components = [...value.components.filter(c => c.type !== 'container'), { type: 'container', data: { contents } }]
      player.updateSlot(boxSlot, value); sync()
      if (options.executeError) throw new Error('packing interrupted')
      return { product: row(value), packedInputs: packed }
    },
    async recover ({ inputs }) {
      const value = player.slots.find(value => value && catalog.isShulkerBox(row(value).itemId))
      if (!value) throw new Error('missing shell')
      const counts = catalog.extractShulkerContents(row(value))
      const packedInputs = inputs.flatMap(input => { const amount = counts.find(c => c.item.itemKey === input.itemKey)?.amount || 0; return amount ? [{ ...input, amount }] : [] })
      const remainingInputs = catalog.aggregatePrismarineItems(player.slots.filter(value => value && !catalog.isShulkerBox(row(value).itemId)))
      return { product: row(value), packedInputs, remainingInputs }
    }
  }
  const stocks = options.stocks || [item('stone', 20), item('diamond_sword')]
  const boxes = options.boxes || [item('blue_shulker_box'), item('blue_shulker_box')]
  const source = addChest('source', [...stocks, ...boxes])
  addChest('destination')
  db.addBalanceItems(owner.uuid, catalog.aggregatePrismarineItems([...stocks, ...boxes]))
  return { db, catalog, bot, player, config, warehouse, executor, owner, source, options, barrels, calls, addChest, sync,
    get shifts () { return shifts }, get withdrawals () { return withdrawals },
    request: { owner, actor: 'Alice', items: catalog.aggregatePrismarineItems(stocks).map(({ itemKey, amount }) => ({ itemKey, amount })) },
    controller (extra = {}) { const { PackingController } = require('../../src/packing/controller'); return new PackingController({ bot, db, catalog, warehouse, config, botId: 'bot-a', executor, validateOwner: (owner, actor) => { if (owner.uuid !== 'alice' || actor !== 'Alice') throw new Error('unauthorized') }, ...extra }) },
    close () { db.close(); fs.rmSync(directory, { recursive: true, force: true }) }
  }
}
module.exports = { fixture, catalog, item, row, copy, owner }

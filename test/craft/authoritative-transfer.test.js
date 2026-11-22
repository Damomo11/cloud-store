'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const StoreDb = require('../../src/db')
const ItemCatalog = require('../../src/itemCatalog')
const Warehouse = require('../../src/warehouse')
const CraftLedger = require('../../src/craft/ledger')
const { CraftController } = require('../../src/craft/controller')
const { DEFAULT_CONFIG } = require('../../src/config')

function fixture (options = {}) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.timing.containerSettleMs = 0
  config.debug = false
  const catalog = new ItemCatalog(config.server.version, {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })
  const Item = require('prismarine-item')(catalog.mcData)
  const windows = require('prismarine-windows')(config.server.version)
  const make = (count) => new Item(catalog.mcData.itemsByName.stick.id, count)
  const db = new StoreDb(':memory:', config)
  const chest = { chestId: '0,64,0', x: 0, y: 64, z: 0, blockName: 'barrel' }
  db.upsertChest(chest)
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.closeWindow = window => { if (bot.currentWindow === window) bot.currentWindow = null }
  bot.inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory')
  if (!options.withdraw) bot.inventory.updateSlot(9, make(4))
  bot.username = 'CraftBot'
  const server = options.withdraw ? { chest: make(4), player: null } : { chest: null, player: make(4) }
  let packetMode = options.packetMode
  if (options.withdraw) db.replaceChestSlots(chest.chestId, [{ ...catalog.fromPrismarineItem(server.chest), slot: 0, amount: 4 }])
  let opens = 0
  const openedChestIds = []
  let withdrawals = 0
  let current
  bot.clickWindow = async (slot, mouseButton, mode) => {
    current.acceptClick({ slot, mouseButton, mode, item: current.slots[slot] })
    if (options.accepted !== false) {
      server.chest = make(4)
      server.player = null
    }
  }
  if (options.modern) {
    bot.registry = catalog.mcData
    bot.supportFeature = name => name === 'stateIdUsed'
    bot._client.write = (name, packet) => {
      assert.equal(name, 'window_click')
      assert.equal(packet.stateId, -1)
      current.acceptClick({ ...packet, item: current.slots[packet.slot] })
      server.chest = make(4)
      server.player = null
      const response = { windowId: current.id, stateId: 1,
        items: current.slots.map(item => Item.toNotch(item)), carriedItem: Item.toNotch(null) }
      if (options.transferMode === 'old') {
        response.items[0] = Item.toNotch(null)
        response.items[current.inventoryStart] = Item.toNotch(make(4))
      }
      if (options.transferMode === 'cursor') response.carriedItem = Item.toNotch(make(1))
      if (options.transferMode === 'missing') delete response.carriedItem
      bot._client.emit('window_items', response)
      if (options.closeAfterClick && packet.windowId !== 0) bot.closeWindow(current)
    }
    config.craft = { ...config.craft, confirmTimeoutMs: 30 }
  }
  const warehouse = new Warehouse(bot, db, catalog, config)
  if (options.withdraw) warehouse.tryWithdrawExactFrom = async container => {
    withdrawals++
    if (options.uncertain) {
      const error = new Error('uncertain withdraw')
      error.uncertainTransfer = true
      throw error
    }
    container.updateSlot(0, null)
    container.updateSlot(container.inventoryStart, make(4))
    if (options.accepted !== false) {
      server.chest = null
      server.player = make(4)
    }
    return 4
  }
  warehouse.openContainerAt = async chest => {
    opens++
    openedChestIds.push(chest.chestId)
    current = windows.createWindow(7 + opens, options.containerType || 'minecraft:generic_9x3', 'Barrel')
    current.updateSlot(0, server.chest)
    current.updateSlot(current.inventoryStart, server.player)
    bot.currentWindow = current
    current.close = () => {
      for (let slot = current.inventoryStart; slot < current.inventoryEnd; slot++) {
        bot.inventory.updateSlot(slot - current.inventoryStart + 9, current.slots[slot])
      }
      bot.currentWindow = null
    }
    const items = current.slots.map(item => Item.toNotch(item))
    const packet = { windowId: current.id, items, carriedItem: Item.toNotch(options.carried && opens > 1 ? make(1) : null) }
    if (options.omitCursor && opens > 1) delete packet.carriedItem
    if (options.noFirstPacket && opens === 1) {
      bot._client.emit('open_window', { windowId: current.id })
    } else if (opens === 1 || packetMode === 'valid' || !packetMode) {
      bot._client.emit(opens > 1 && options.alias ? 'open_screen' : 'open_window', { windowId: current.id })
      bot._client.emit(opens > 1 && options.alias ? 'container_set_content' : 'window_items', packet)
    } else if (packetMode === 'wrong') {
      bot._client.emit('open_window', { windowId: current.id })
      bot._client.emit('window_items', { ...packet, windowId: current.id + 1 })
    } else if (packetMode === 'stale') {
      bot._client.emit('window_items', packet)
      bot._client.emit('open_window', { windowId: current.id })
    } else if (packetMode === 'reused') {
      bot._client.emit('open_window', { windowId: current.id })
      bot._client.emit('window_items', packet)
      bot._client.emit('open_window', { windowId: current.id })
    } else if (packetMode === 'missing') {
      bot._client.emit('open_window', { windowId: current.id })
    }
    return current
  }
  return { db, bot, warehouse, catalog, config, chest, server, opens: () => opens, openedChestIds,
    withdrawals: () => withdrawals, setPacketMode: value => { packetMode = value }, close: () => db.close() }
}

function storingOperation (f) {
  const held = f.catalog.aggregatePrismarineItems(f.bot.inventory.items())
  const ledger = new CraftLedger(f.db)
  const operation = ledger.begin({ id: 'craft:strict-deposit', botId: 'bot-a', owner: { uuid: 'alice' },
    allocations: [], data: { held, pending: null, physicalTotals: held, stepIndex: 0 } })
  const controller = new CraftController({ ...f, ledger, executor: { isBusy: () => false }, botId: 'bot-a' })
  return { controller, operation, ledger }
}

test('strict deposit confirms a fresh server container and player snapshot', async () => {
  const f = fixture()
  try {
    await f.warehouse.depositAllPossible({ requireServerEvidence: true })
    assert.equal(f.opens(), 2)
    assert.deepEqual(f.bot.inventory.items(), [])
    assert.equal(f.db.listChestSlots().find(row => row.slot === 0)?.amount, 4)
  } finally { f.close() }
})

test('modern strict deposit confirms its shift without a fixed settle delay and still reopens the barrel', async () => {
  const f = fixture({ modern: true })
  const originalClick = f.bot.clickWindow
  const originalTimer = global.setTimeout
  let settles = 0
  f.config.timing.containerSettleMs = 123
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 123) settles++
    return originalTimer(fn, ms, ...args)
  }
  f.bot.clickWindow = () => { throw new Error('must use the confirmed craft deposit') }
  try {
    await f.warehouse.depositAllPossible({ requireServerEvidence: true })
    assert.equal(f.opens(), 2)
    assert.deepEqual(f.bot.inventory.items(), [])
    assert.equal(f.db.listChestSlots().find(row => row.slot === 0)?.amount, 4)
    assert.equal(f.bot._client.listenerCount('window_items'), 0)
    assert.equal(settles, 0)
  } finally { global.setTimeout = originalTimer; f.bot.clickWindow = originalClick; f.close() }
})

test('modern strict deposit keeps a confirmed transfer when the server closes the barrel window', async () => {
  const f = fixture({ modern: true, closeAfterClick: true })
  try {
    await f.warehouse.depositAllPossible({ requireServerEvidence: true })
    assert.deepEqual(f.bot.inventory.items(), [])
    assert.equal(f.db.listChestSlots().find(row => row.slot === 0)?.amount, 4)
  } finally { f.close() }
})

test('modern strict deposit still rejects a missing final independent barrel snapshot', async () => {
  const f = fixture({ modern: true, packetMode: 'missing' })
  try {
    await assert.rejects(f.warehouse.depositAllPossible({ requireServerEvidence: true }), error => error.uncertainTransfer === true)
    assert.equal(f.opens(), 2)
  } finally { f.close() }
})

for (const transferMode of ['old', 'cursor', 'missing']) {
  test(`modern strict deposit cannot advance on ${transferMode} transfer evidence`, async () => {
    const f = fixture({ modern: true, transferMode })
    try {
      await assert.rejects(f.warehouse.depositAllPossible({ requireServerEvidence: true }), error => error.uncertainTransfer === true)
      assert.equal(f.opens(), 1)
      assert.equal(f.bot._client.listenerCount('window_items'), 0)
    } finally { f.close() }
  })
}

test('ordinary deposits retain the original click helper on modern protocols', async () => {
  const f = fixture({ modern: true })
  f.bot._client.write = () => { throw new Error('ordinary deposits must not request craft confirmation') }
  try {
    await f.warehouse.depositAllPossible()
    assert.equal(f.opens(), 1)
    assert.deepEqual(f.bot.inventory.items(), [])
  } finally { f.close() }
})

test('strict deposits keep the original adapter for other supported container types', async () => {
  const f = fixture({ modern: true, containerType: 'minecraft:shulker_box' })
  f.bot._client.write = () => { throw new Error('unsupported confirmation model must use the original deposit helper') }
  try {
    await f.warehouse.depositAllPossible({ requireServerEvidence: true })
    assert.equal(f.opens(), 2)
    assert.deepEqual(f.bot.inventory.items(), [])
  } finally { f.close() }
})

for (const packetMode of ['missing', 'wrong', 'stale', 'reused']) {
  test(`strict deposit retains uncertainty after ${packetMode} server packet`, async () => {
    const f = fixture({ packetMode })
    try {
      await assert.rejects(f.warehouse.depositAllPossible({ requireServerEvidence: true }), /服务端|server|快照/)
      assert.equal(f.opens(), 2)
      assert.equal(f.bot._client.listenerCount('window_items'), 0)
      assert.equal(f.bot._client.listenerCount('open_window'), 0)
    } finally { f.close() }
  })
}

test('strict deposit rejects a server transfer refusal', async () => {
  const f = fixture({ accepted: false })
  try {
    await assert.rejects(f.warehouse.depositAllPossible({ requireServerEvidence: true }), /服务端|server|快照/)
    assert.equal(f.bot.inventory.items()[0].count, 4)
  } finally { f.close() }
})

test('strict deposit rejects a nonempty server cursor', async () => {
  const f = fixture({ carried: true })
  try {
    await assert.rejects(f.warehouse.depositAllPossible({ requireServerEvidence: true }), /光标|cursor/)
  } finally { f.close() }
})

test('strict deposit fails closed when the protocol snapshot omits cursor evidence', async () => {
  const f = fixture({ omitCursor: true })
  try {
    await assert.rejects(f.warehouse.depositAllPossible({ requireServerEvidence: true }), /光标|cursor/)
  } finally { f.close() }
})

test('strict deposit verifies a predicted transfer even when the helper reports zero progress', async () => {
  const f = fixture({ packetMode: 'missing' })
  try {
    const deposit = f.warehouse.tryDepositInto.bind(f.warehouse)
    f.warehouse.tryDepositInto = async (...args) => { await deposit(...args); return 0 }
    await assert.rejects(f.warehouse.depositAllPossible({ requireServerEvidence: true }), /服务端|server|快照/)
    assert.equal(f.opens(), 2)
  } finally { f.close() }
})

test('strict deposit accepts equivalent container packet event names', async () => {
  const f = fixture({ alias: true })
  try {
    await f.warehouse.depositAllPossible({ requireServerEvidence: true })
    assert.equal(f.opens(), 2)
  } finally { f.close() }
})

test('controller store cannot mark ready without a fresh server deposit snapshot', async () => {
  const f = fixture({ packetMode: 'missing' })
  try {
    const { controller, operation, ledger } = storingOperation(f)
    await assert.rejects(controller.store(operation), /服务端|server|快照/)
    assert.equal(ledger.get(operation.id).phase, 'storing')
    assert.equal(ledger.pending().length, 1)
  } finally { f.close() }
})

test('controller store marks ready after a matching server deposit snapshot', async () => {
  const f = fixture()
  try {
    const { controller, operation } = storingOperation(f)
    assert.equal((await controller.store(operation)).phase, 'ready')
    assert.equal(f.opens(), 2)
  } finally { f.close() }
})

test('recovery completes a deposit whose first confirmation packet was missing', async () => {
  const f = fixture({ packetMode: 'missing' })
  try {
    const { controller, operation, ledger } = storingOperation(f)
    await assert.rejects(controller.store(operation), /服务端|server|快照/)
    assert.equal(ledger.pending().length, 1)
    f.setPacketMode('valid')
    f.warehouse.goHomeIfAway = async () => {}
    const result = await controller.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(ledger.pending().length, 0)
    assert.equal(f.db.listChestSlots().find(row => row.slot === 0)?.amount, 4)
  } finally { f.close() }
})

test('sync rewrites chest slots without the old global craft lockout', async () => {
  const f = fixture()
  try {
    storingOperation(f)
    const scan = { blocks: [], snapshots: [] }
    // 新行为（2026-11-22 拆锁）：pending 恢复记录不再阻塞同步——在途键
    // 在对账里剔除（deferredForCraft），其余照常落库。
    await assert.doesNotReject(f.warehouse.applyWarehouseScan(scan, 1, { allowShrink: true }))
    // blocks 为空 → clearChests 清空登记；同步本身照常执行。
    assert.equal(f.db.listChests().length, 0)
  } finally { f.close() }
})

test('strict withdrawal verifies the server chest and player after the local click', async () => {
  const f = fixture({ withdraw: true })
  try {
    const item = f.catalog.fromPrismarineItem(f.server.chest)
    const result = await f.warehouse.withdrawAllocationsLocked([{ ...item, amount: 4 }], { requireServerEvidence: true })
    assert.equal(result.withdrawn[0].amount, 4)
    assert.equal(f.opens(), 2)
  } finally { f.close() }
})

test('only strict craft withdrawal opts into fragmented stack packing', async () => {
  for (const requireServerEvidence of [false, true]) {
    const f = fixture({ withdraw: true })
    try {
      let transferOptions
      const withdraw = f.warehouse.tryWithdrawExactFrom
      f.warehouse.tryWithdrawExactFrom = async (...args) => {
        transferOptions = args[4]
        return withdraw(...args)
      }
      const item = f.catalog.fromPrismarineItem(f.server.chest)
      await f.warehouse.withdrawAllocationsLocked([{ ...item, amount: 4 }], { requireServerEvidence })
      assert.equal(transferOptions?.requireServerEvidence, requireServerEvidence)
    } finally { f.close() }
  }
})

test('strict withdrawal rejects a predicted transfer refused by the server', async () => {
  const f = fixture({ withdraw: true, accepted: false })
  try {
    const item = f.catalog.fromPrismarineItem(f.server.chest)
    await assert.rejects(f.warehouse.withdrawAllocationsLocked([{ ...item, amount: 4 }], { requireServerEvidence: true }), /服务端|server|快照/)
    assert.equal(f.opens(), 2)
  } finally { f.close() }
})

test('strict withdrawal propagates an uncertain click instead of trying another barrel', async () => {
  const f = fixture({ withdraw: true, uncertain: true })
  try {
    const item = f.catalog.fromPrismarineItem(f.server.chest)
    await assert.rejects(f.warehouse.withdrawAllocationsLocked([{ ...item, amount: 4 }], { requireServerEvidence: true }), error => error.uncertainTransfer)
  } finally { f.close() }
})

test('strict withdrawal never clicks without a complete initial server snapshot', async () => {
  const f = fixture({ withdraw: true, noFirstPacket: true })
  try {
    const item = f.catalog.fromPrismarineItem(f.server.chest)
    await assert.rejects(f.warehouse.withdrawAllocationsLocked([{ ...item, amount: 4 }], { requireServerEvidence: true }), error => error.uncertainTransfer)
    assert.equal(f.withdrawals(), 0)
  } finally { f.close() }
})

test('strict withdrawal does not credit unexplained extra stock to momo', async () => {
  const f = fixture({ withdraw: true })
  try {
    const item = f.catalog.fromPrismarineItem(f.server.chest)
    f.server.chest.count = 5
    await assert.rejects(f.warehouse.withdrawAllocationsLocked([{ ...item, amount: 4 }], { requireServerEvidence: true }), /服务端|人工核对/)
    assert.equal(f.withdrawals(), 0)
    assert.equal(f.db.getOwnerBalances(f.config.momoOwner).length, 0)
  } finally { f.close() }
})


test('recovery cannot finish a return while the affected barrel still lacks server evidence', async () => {
  const f = fixture({ packetMode: 'missing' })
  try {
    const { controller, operation, ledger } = storingOperation(f)
    await assert.rejects(controller.store(operation), /服务端|server|快照/)
    f.warehouse.goHomeIfAway = async () => {}
    await assert.rejects(controller.recover(), /服务端|server|快照/)
    assert.equal(ledger.pending().length, 1)
    assert.equal(ledger.get(operation.id).data.pendingReturnChestId, f.chest.chestId)
    f.setPacketMode('valid')
    assert.equal((await controller.recover()).status, 'recovered')
    assert.equal(ledger.pending().length, 0)
  } finally { f.close() }
})

test('recovery rechecks an uncertain return even with an empty backpack instead of deducting stale stock', async () => {
  const f = fixture({ modern: true, transferMode: 'missing' })
  try {
    const held = f.catalog.aggregatePrismarineItems(f.bot.inventory.items())
    f.db.addBalanceItems('alice', held)
    f.db.upsertChest({ chestId: '99,64,0', x: 99, y: 64, z: 0, blockName: 'barrel' })
    const { controller, operation, ledger } = storingOperation(f)
    const write = f.bot._client.write
    f.bot._client.write = (...args) => {
      assert.equal(ledger.get(operation.id).data.pendingReturnChestId, f.chest.chestId)
      write(...args)
    }
    await assert.rejects(controller.store(operation), error => error.uncertainTransfer)
    assert.equal(ledger.get(operation.id).data.pendingReturnChestId, f.chest.chestId)
    assert.equal(f.server.chest.count, 4)
    assert.equal(f.bot.inventory.items().length, 0)
    f.warehouse.goHomeIfAway = async () => {}
    const restarted = new CraftController({ ...f, ledger: new CraftLedger(f.db), executor: { isBusy: () => false }, botId: 'bot-a' })
    const result = await restarted.recover()
    assert.equal(result.status, 'recovered')
    assert.equal(Boolean(result.diffRegistered), false)
    assert.equal(f.db.listChestSlots().find(row => row.slot === 0)?.amount, 4)
    assert.equal(f.db.getBalance('alice', held[0].itemKey), 4)
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM inventory_mismatches').get().n, 0)
    assert.equal(ledger.pending().length, 0)
    assert.deepEqual(f.openedChestIds, [f.chest.chestId, f.chest.chestId])
  } finally { f.close() }
})

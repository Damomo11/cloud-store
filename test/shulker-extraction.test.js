const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const CloudStoreService = require('../src/service')
const StoreDb = require('../src/db')
const Warehouse = require('../src/warehouse')
const ItemCatalog = require('../src/itemCatalog')
const { DEFAULT_CONFIG } = require('../src/config')

function createPlanningService ({ loose = 0, boxes = 1, perBox = 64, singleItem = true } = {}) {
  const target = {
    itemKey: 'target-key',
    itemId: 'minecraft:diamond',
    displayName: '钻石',
    nbtJson: '',
    metaJson: ''
  }
  const shulker = {
    shulkerItemKey: 'box-key',
    shulkerItemId: 'minecraft:purple_shulker_box',
    shulkerDisplayName: '紫色潜影盒',
    shulkerNbtJson: '',
    shulkerMetaJson: '{}',
    shulkerAmount: boxes,
    containedItemId: target.itemId,
    containedItemKey: target.itemKey,
    containedDisplayName: target.displayName,
    containedAmount: perBox,
    slotCount: singleItem ? 27 : 1,
    totalSlotCount: 27,
    boxContainedAmount: singleItem ? perBox : perBox + 1
  }
  const db = {
    getOwnerItemsByItemKey: () => loose > 0 ? [{ ...target, amount: loose }] : [],
    getOwnerItemsByItemId: () => loose > 0 ? [{ ...target, amount: loose }] : [],
    getOwnerShulkersContainingItemKey: () => boxes > 0 ? [shulker] : [],
    getOwnerShulkersContainingItemId: () => boxes > 0 ? [shulker] : []
  }
  const catalog = {
    getDisplayName: () => target.displayName,
    getStackSize: () => 64
  }
  const config = structuredClone(DEFAULT_CONFIG)
  return {
    service: new CloudStoreService({ username: 'bot' }, db, catalog, {}, config),
    target,
    shulker
  }
}

test('disabled quick shulker extraction falls back to whole-box allocations', () => {
  const { service, target } = createPlanningService({ loose: 10, boxes: 2, perBox: 64 })
  service.db.isQuickShulkerExtractionEnabled = () => false
  const plan = service.buildWithdrawPlan('owner', [{ ...target, amount: 70, requestIndex: 0 }])

  assert.equal(plan.allocations.some(item => item.withdrawMode === 'shulker_extract'), false)
  assert.equal(plan.allocations.filter(item => item.itemKey === 'box-key').reduce((sum, item) => sum + item.amount, 0), 1)
  assert.equal(plan.allocations.filter(item => item.itemKey === 'target-key').reduce((sum, item) => sum + item.amount, 0), 6)
})

test('withdraw below 1728 uses loose items first and extracts only the shortfall from a shulker', () => {
  const { service, target } = createPlanningService({ loose: 10, boxes: 2, perBox: 64 })
  const plan = service.buildWithdrawPlan('owner', [{ ...target, amount: 70, requestIndex: 0 }])

  assert.equal(plan.allocations.length, 2)
  assert.equal(plan.allocations[0].withdrawMode, undefined)
  assert.equal(plan.allocations[0].amount, 10)
  assert.equal(plan.allocations[1].withdrawMode, 'shulker_extract')
  assert.equal(plan.allocations[1].amount, 60)
  assert.equal(plan.allocations[1].sourceBoxCount, 1)
  assert.equal(plan.allocations[1].reservationItemKey, 'box-key')
  assert.equal(plan.allocations[1].reservationAmount, 1)
})

test('shulker extraction plans as much as physically available when inventory is short', () => {
  const { service, target } = createPlanningService({ loose: 10, boxes: 2, perBox: 64 })
  const plan = service.buildWithdrawPlan('owner', [{ ...target, amount: 200, requestIndex: 0 }])

  assert.match(plan.notices[0], /只有 138 个钻石，将尽量取出/)
  assert.equal(plan.allocations.reduce((sum, item) => sum + item.amount, 0), 138)
  const extraction = plan.allocations.find(item => item.withdrawMode === 'shulker_extract')
  assert.equal(extraction.amount, 128)
  assert.equal(extraction.sourceBoxCount, 2)
})

test('withdraw at 1728 keeps whole-shulker delivery behavior', () => {
  const { service, target } = createPlanningService({ loose: 0, boxes: 1, perBox: 1728 })
  const plan = service.buildWithdrawPlan('owner', [{ ...target, amount: 1728, requestIndex: 0 }])

  assert.equal(plan.allocations.length, 1)
  assert.equal(plan.allocations[0].withdrawMode, undefined)
  assert.equal(plan.allocations[0].itemKey, 'box-key')
  assert.equal(plan.allocations[0].amount, 1)
  assert.equal(plan.allocations[0].coverageAmount, 1728)
})

test('large withdrawals extract partial or non-full shulkers instead of delivering whole boxes', () => {
  const partial = createPlanningService({ loose: 42, boxes: 2, perBox: 875 })
  const partialPlan = partial.service.buildWithdrawPlan('owner', [{ ...partial.target, amount: 1792, requestIndex: 0 }])

  assert.equal(partialPlan.allocations.length, 2)
  assert.equal(partialPlan.allocations[0].withdrawMode, undefined)
  assert.equal(partialPlan.allocations[0].amount, 42)
  assert.equal(partialPlan.allocations[1].withdrawMode, 'shulker_extract')
  assert.equal(partialPlan.allocations[1].amount, 1750)
  assert.equal(partialPlan.allocations[1].sourceBoxCount, 2)

  const remainder = createPlanningService({ loose: 0, boxes: 2, perBox: 1728 })
  const remainderPlan = remainder.service.buildWithdrawPlan('owner', [{ ...remainder.target, amount: 2000, requestIndex: 0 }])

  assert.equal(remainderPlan.allocations.length, 2)
  assert.equal(remainderPlan.allocations[0].withdrawMode, undefined)
  assert.equal(remainderPlan.allocations[0].amount, 1)
  assert.equal(remainderPlan.allocations[1].withdrawMode, 'shulker_extract')
  assert.equal(remainderPlan.allocations[1].amount, 272)
  assert.equal(remainderPlan.allocations[1].sourceBoxCount, 1)
})

test('shulker extraction batches reserve one inventory workspace slot', () => {
  const { service, target } = createPlanningService()
  const batches = service.splitAllocationsIntoInventoryBatches([{
    withdrawMode: 'shulker_extract',
    itemKey: target.itemKey,
    itemId: target.itemId,
    amount: 36 * 64
  }], 36)

  assert.equal(batches.length, 2)
  assert.equal(batches[0][0].amount, 35 * 64)
  assert.equal(batches[1][0].amount, 64)
})

function createDb () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-shulker-test-'))
  const db = new StoreDb(path.join(directory, 'store.sqlite'), structuredClone(DEFAULT_CONFIG))
  return {
    db,
    close: () => {
      db.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

test('quick shulker extraction defaults to enabled and persists warehouse overrides', () => {
  const fixture = createDb()
  try {
    assert.equal(fixture.db.isQuickShulkerExtractionEnabled('owner'), true)
    fixture.db.setQuickShulkerExtractionEnabled('owner', false)
    assert.equal(fixture.db.isQuickShulkerExtractionEnabled('owner'), false)
    assert.equal(fixture.db.getWarehouseFeatureSettings('owner').quickShulkerExtractionEnabled, 0)
  } finally {
    fixture.close()
  }
})

test('shulker reservation reserves the source box instead of nonexistent loose contents', () => {
  const fixture = createDb()
  const oldBox = { itemKey: 'old-box', itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: '', metaJson: '{}', amount: 1 }
  try {
    fixture.db.addBalanceItems('owner', [oldBox])
    fixture.db.reserveInventory('task', [{
      ownerUuid: 'owner',
      itemKey: 'target-key',
      amount: 20,
      reservationItemKey: oldBox.itemKey,
      reservationAmount: 1
    }])

    const row = fixture.db.db.prepare('SELECT item_key AS itemKey, amount FROM inventory_reservations WHERE reservation_id = ?').get('task')
    assert.deepEqual(row, { itemKey: oldBox.itemKey, amount: 1 })
  } finally {
    fixture.close()
  }
})

test('shulker extraction atomically replaces the box balance and credits extracted loose items', () => {
  const fixture = createDb()
  const oldBox = { itemKey: 'old-box', itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: '', metaJson: '{"contents":64}', amount: 1 }
  const newBox = { itemKey: 'new-box', itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: '', metaJson: '{"contents":59}', amount: 1 }
  const target = { itemKey: 'target-key', itemId: 'minecraft:diamond', displayName: '钻石', nbtJson: '', metaJson: '', amount: 5 }
  try {
    fixture.db.addBalanceItems('owner', [oldBox])
    fixture.db.applyShulkerExtraction('owner', oldBox.itemKey, newBox, [target], 'Player')

    assert.equal(fixture.db.getBalance('owner', oldBox.itemKey), 0)
    assert.equal(fixture.db.getBalance('owner', newBox.itemKey), 1)
    assert.equal(fixture.db.getBalance('owner', target.itemKey), 5)
    const transaction = fixture.db.db.prepare('SELECT type, status FROM transactions ORDER BY id DESC LIMIT 1').get()
    assert.deepEqual(transaction, { type: 'shulker_repack', status: 'ok' })
  } finally {
    fixture.close()
  }
})

test('shulker repack recovery commits balances once and removes its journal atomically', () => {
  const fixture = createDb()
  const oldBox = { itemKey: 'journal-old-box', itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: '', metaJson: '{"contents":64}' }
  const newBox = { itemKey: 'journal-new-box', itemId: 'minecraft:shulker_box', displayName: '潜影盒', nbtJson: '', metaJson: '{"contents":59}' }
  const target = { itemKey: 'journal-target', itemId: 'minecraft:diamond', displayName: '钻石', nbtJson: '', metaJson: '' }
  try {
    fixture.db.addBalanceItems('owner', [{ ...oldBox, amount: 1 }])
    fixture.db.beginShulkerRepackRecovery('bot-a', {
      ownerUuid: 'owner',
      ownerUsername: 'Player',
      oldBoxItemKey: oldBox.itemKey,
      sourceChestId: '1,2,3',
      targetItem: target,
      beforeAmount: 64,
      requestedAmount: 5
    })
    fixture.db.markShulkerRepackPhysicalChange('bot-a', newBox, [{ ...target, amount: 5 }])

    const committed = fixture.db.commitShulkerRepackRecovery('bot-a')

    assert.equal(committed.state, 'physical_changed')
    assert.equal(fixture.db.getBalance('owner', oldBox.itemKey), 0)
    assert.equal(fixture.db.getBalance('owner', newBox.itemKey), 1)
    assert.equal(fixture.db.getBalance('owner', target.itemKey), 5)
    assert.equal(fixture.db.getShulkerRepackRecovery('bot-a'), null)
    assert.equal(fixture.db.commitShulkerRepackRecovery('bot-a'), null)
    assert.equal(fixture.db.db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE type = 'shulker_repack'").get().count, 1)
  } finally {
    fixture.close()
  }
})

test('prepared shulker recovery infers the physical change from the held box', () => {
  const fixture = createDb()
  const target = { itemKey: 'infer-target', itemId: 'minecraft:diamond', displayName: '钻石', nbtJson: '', metaJson: '' }
  const other = { itemKey: 'infer-other', itemId: 'minecraft:stone', displayName: '石头', nbtJson: '', metaJson: '' }
  const oldBox = { itemKey: 'infer-old-box', itemId: 'minecraft:purple_shulker_box', displayName: '紫色潜影盒', nbtJson: '', metaJson: '{}' }
  const newBoxInfo = { itemKey: 'infer-new-box', itemId: oldBox.itemId, displayName: oldBox.displayName, nbtJson: '', metaJson: '{}' }
  const unrelatedBoxInfo = { itemKey: 'infer-unrelated-box', itemId: oldBox.itemId, displayName: oldBox.displayName, nbtJson: '', metaJson: '{}' }
  const newBox = { name: 'purple_shulker_box', count: 1, slot: 36, normalized: newBoxInfo }
  const unrelatedBox = { name: 'purple_shulker_box', count: 1, slot: 37, normalized: unrelatedBoxInfo }
  try {
    fixture.db.addBalanceItems('owner', [{ ...oldBox, amount: 1 }])
    fixture.db.beginShulkerRepackRecovery('bota', {
      ownerUuid: 'owner',
      ownerUsername: 'Player',
      oldBoxItemKey: oldBox.itemKey,
      targetItem: target,
      beforeAmount: 64,
      requestedAmount: 5
    })
    const warehouse = new Warehouse(
      { username: 'BotA', inventory: { items: () => [unrelatedBox, newBox] } },
      fixture.db,
      {
        fromPrismarineItem: item => item.normalized,
        isShulkerBox: itemId => /_shulker_box$/.test(itemId),
        extractShulkerContents: item => {
          if (item.itemKey === oldBox.itemKey) return [{ item: target, amount: 64 }, { item: other, amount: 1 }]
          if (item.itemKey === newBoxInfo.itemKey) return [{ item: target, amount: 59 }, { item: other, amount: 1 }]
          return [{ item: target, amount: 10 }, { item: other, amount: 2 }]
        }
      },
      { ...structuredClone(DEFAULT_CONFIG), server: { ...DEFAULT_CONFIG.server, botName: 'BotA' } }
    )

    const recovery = warehouse.resolvePreparedShulkerRepackFromInventory()

    assert.equal(recovery.state, 'physical_changed')
    assert.equal(recovery.newBoxItem.itemKey, newBoxInfo.itemKey)
    assert.equal(recovery.extractedItems[0].amount, 5)
  } finally {
    fixture.close()
  }
})

test('prepared shulker recovery stays pending when the box is temporarily absent', () => {
  const fixture = createDb()
  const oldBox = { itemKey: 'missing-old-box', itemId: 'minecraft:purple_shulker_box', displayName: '紫色潜影盒', nbtJson: '', metaJson: '{}' }
  const target = { itemKey: 'missing-target', itemId: 'minecraft:diamond', displayName: '钻石', nbtJson: '', metaJson: '' }
  try {
    fixture.db.addBalanceItems('owner', [{ ...oldBox, amount: 1 }])
    fixture.db.beginShulkerRepackRecovery('bot-a', {
      ownerUuid: 'owner',
      ownerUsername: 'Player',
      oldBoxItemKey: oldBox.itemKey,
      targetItem: target,
      beforeAmount: 64,
      requestedAmount: 5
    })

    const warehouse = new Warehouse(
      { username: 'BotA', inventory: { items: () => [] } },
      fixture.db,
      {
        fromPrismarineItem: item => item.normalized,
        isShulkerBox: itemId => /_shulker_box$/.test(itemId)
      },
      { ...structuredClone(DEFAULT_CONFIG), server: { ...DEFAULT_CONFIG.server, botName: 'BotA' } }
    )

    assert.equal(warehouse.resolvePreparedShulkerRepackFromInventory(), null)
    assert.equal(fixture.db.getShulkerRepackRecovery('bot-a').state, 'prepared')
  } finally {
    fixture.close()
  }
})

test('flushResidual continues normal cleanup when a prepared shulker is absent', async () => {
  const events = []
  const loose = { itemKey: 'residual-loose', itemId: 'minecraft:diamond', displayName: '钻石', amount: 1 }
  const recovery = { state: 'prepared', oldBoxItemKey: 'residual-old-box' }
  const db = {
    getShulkerRepackRecovery: () => recovery,
    getRecoveryTask: () => null,
    addBalanceItems: (...args) => events.push(['balance', ...args]),
    addTransaction: (...args) => events.push(['transaction', ...args])
  }
  const bot = { username: 'BotA', inventory: { items: () => [{ normalized: loose }] } }
  const catalog = { aggregatePrismarineItems: () => [loose] }
  const warehouse = {
    resolvePreparedShulkerRepackFromInventory: () => null,
    depositInventoryWithoutBalance: async () => {
      events.push(['deposit'])
      return { deposited: [loose], leftover: [] }
    }
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  const service = new CloudStoreService(bot, db, catalog, warehouse, config)

  await service.flushResidual()

  assert.deepEqual(events.map(event => event[0]), ['balance', 'transaction', 'deposit'])
  assert.equal(db.getShulkerRepackRecovery(), recovery)
})

test('disconnect recovery stores held items before committing the pending shulker repack', async () => {
  const events = []
  const loose = { itemKey: 'recovery-target', itemId: 'minecraft:diamond', displayName: '钻石', amount: 5 }
  let pending = {
    state: 'physical_changed',
    ownerUuid: 'owner',
    ownerUsername: 'Player',
    oldBoxItemKey: 'old-box',
    newBoxItem: { itemKey: 'new-box' },
    extractedItems: [loose]
  }
  let taskCleared = false
  const db = {
    getRecoveryTask: () => ({
      type: 'withdraw',
      actorUsername: 'Player',
      ownerUuid: 'owner',
      ownerUsername: 'Player',
      ownerScope: 'personal',
      targetUsername: 'Player',
      phase: 'withdraw_from_chests',
      items: []
    }),
    getShulkerRepackRecovery: () => pending,
    commitShulkerRepackRecovery: () => {
      events.push('commit')
      const result = pending
      pending = null
      return result
    },
    addCommandReply: () => {},
    clearRecoveryTask: () => { taskCleared = true },
    ownerLabel: () => 'Player'
  }
  const bot = { username: 'BotA', inventory: { items: () => [{ normalized: loose }] }, chat: () => {} }
  const catalog = { aggregatePrismarineItems: items => items.map(item => item.normalized) }
  const warehouse = {
    goHome: async () => { events.push('home') },
    depositInventoryWithoutBalance: async () => {
      events.push('deposit')
      return { deposited: [loose], leftover: [] }
    }
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  const service = new CloudStoreService(bot, db, catalog, warehouse, config)

  await service.recoverPersistedTaskOnSpawn()

  assert.deepEqual(events, ['home', 'deposit', 'commit'])
  assert.equal(taskCleared, true)
  assert.equal(pending, null)
})

test('quick shulker opening aims at air and sends activateItem without block interaction', async () => {
  const bot = new EventEmitter()
  let activateCalls = 0
  let blockOpenCalls = 0
  bot.entity = { yaw: 0, pitch: 0 }
  bot.currentWindow = null
  bot.heldItem = { name: 'purple_shulker_box', slot: 36, count: 1 }
  bot.look = async () => {}
  bot.blockAtCursor = () => null
  bot.activateItem = offHand => {
    assert.equal(offHand, false)
    activateCalls++
    setImmediate(() => bot.emit('windowOpen', {
      type: 'minecraft:shulker_box',
      inventoryStart: 27,
      slots: new Array(63),
      close: () => {}
    }))
  }
  bot.openContainer = () => { blockOpenCalls++ }
  const config = structuredClone(DEFAULT_CONFIG)
  config.debug = false
  config.timing.openContainerTimeoutMs = 200
  const catalog = {
    fromPrismarineItem: () => ({ itemKey: 'box-key', itemId: 'minecraft:purple_shulker_box', displayName: '紫色潜影盒' }),
    isShulkerBox: itemId => /_shulker_box$/.test(itemId)
  }
  const warehouse = new Warehouse(bot, {}, catalog, config)

  const window = await warehouse.openQuickShulkerWindow('box-key')

  assert.equal(window.inventoryStart, 27)
  assert.equal(activateCalls, 1)
  assert.equal(blockOpenCalls, 0)
})

test('taking a shulker waits for the delayed inventory update after the barrel closes', async () => {
  const boxInfo = { itemKey: 'box-key', itemId: 'minecraft:purple_shulker_box', displayName: '紫色潜影盒' }
  const box = { name: 'purple_shulker_box', slot: 36, count: 1, normalized: boxInfo }
  let inventory = []
  const container = {
    close: () => setTimeout(() => { inventory = [box] }, 25)
  }
  const bot = { inventory: { items: () => inventory } }
  const catalog = { fromPrismarineItem: item => ({ ...item.normalized, amount: item.count }) }
  const config = structuredClone(DEFAULT_CONFIG)
  config.debug = false
  config.timing.containerSettleMs = 0
  config.timing.inventoryUpdateTimeoutMs = 200
  const warehouse = new Warehouse(bot, {}, catalog, config)
  warehouse.openContainerAt = async () => container
  warehouse.countContainerItem = () => 1
  warehouse.tryWithdrawExactFrom = async () => 1
  warehouse.refreshChestSnapshot = () => {}

  const taken = await warehouse.takeOneShulkerFromChest(
    { chestId: '1,2,3', x: 1, y: 2, z: 3, blockName: 'barrel' },
    boxInfo.itemKey,
    [4]
  )

  assert.equal(taken, box)
})

test('quick shulker opening refuses to activate an empty main hand', async () => {
  const bot = new EventEmitter()
  bot.currentWindow = null
  bot.heldItem = null
  const config = structuredClone(DEFAULT_CONFIG)
  config.debug = false
  const warehouse = new Warehouse(bot, {}, {}, config)

  await assert.rejects(warehouse.openQuickShulkerWindow(), /主手为空/)
})

test('quick shulker extraction waits for delayed window contents', async () => {
  const target = { slot: 0, count: 3, normalized: { itemKey: 'target-key', itemId: 'minecraft:diamond', displayName: '钻石' } }
  let contents = []
  const window = { items: () => contents }
  const catalog = { fromPrismarineItem: item => ({ ...item.normalized, amount: item.count }) }
  const config = structuredClone(DEFAULT_CONFIG)
  config.debug = false
  config.timing.inventoryUpdateTimeoutMs = 200
  const warehouse = new Warehouse({}, {}, catalog, config)
  setTimeout(() => { contents = [target] }, 25)

  const available = await warehouse.waitForContainerItemCount(window, 'target-key')

  assert.equal(available, 3)
})

test('shulker metadata drops AxShulkers UUID while preserving other custom data', () => {
  const catalog = new ItemCatalog('1.21.11')
  const container = {
    type: 'container',
    data: { contents: [{ itemId: 995, itemCount: 16, components: [], removeComponents: [] }] }
  }
  const customData = value => ({
    type: 'custom_data',
    data: { type: 'compound', value }
  })
  const common = {
    name: 'purple_shulker_box',
    count: 1,
    type: 1193,
    metadata: 0
  }
  const withPluginUuid = catalog.fromPrismarineItem({
    ...common,
    components: [
      customData({
        'AxShulkers-UUID': { type: 'string', value: 'ea78f26f-e5f3-4f55-9866-09f863e6832f' },
        KeepMe: { type: 'string', value: 'custom-value' }
      }),
      container
    ]
  })
  const withoutPluginUuid = catalog.fromPrismarineItem({
    ...common,
    components: [customData({ KeepMe: { type: 'string', value: 'custom-value' } }), container]
  })
  const onlyPluginUuid = catalog.fromPrismarineItem({
    ...common,
    components: [customData({ 'AxShulkers-UUID': { type: 'string', value: 'temporary' } }), container]
  })

  assert.equal(withPluginUuid.itemKey, withoutPluginUuid.itemKey)
  assert.equal(withPluginUuid.metaJson.includes('AxShulkers-UUID'), false)
  assert.equal(withPluginUuid.metaJson.includes('KeepMe'), true)
  assert.equal(onlyPluginUuid.metaJson.includes('custom_data'), false)

  const canonical = catalog.canonicalizeStoredItem({
    itemKey: 'old-key',
    itemId: 'minecraft:purple_shulker_box',
    displayName: '潜影盒',
    nbtJson: 'null',
    metaJson: JSON.stringify({
      metadata: 0,
      components: [customData({ 'AxShulkers-UUID': { type: 'string', value: 'stored-value' } }), container]
    }),
    amount: 1
  })
  assert.equal(canonical.metaJson.includes('AxShulkers-UUID'), false)
})

test('component items use the same fingerprint inside a shulker and in an open window', () => {
  const catalog = new ItemCatalog('1.21.11')
  const itemData = catalog.mcData.itemsByName.amethyst_block
  const components = [
    { type: 'custom_name', data: '{"text":"紫水晶母岩"}' },
    { type: 'custom_data', data: { type: 'compound', value: { CustomId: { type: 'string', value: 'amethyst_bedrock' } } } }
  ]
  const removeComponents = ['minecraft:rarity']
  const nested = catalog.fromContainerEntry({
    itemId: itemData.id,
    itemCount: 2,
    components,
    removeComponents
  })
  const opened = catalog.fromPrismarineItem({
    name: itemData.name,
    type: itemData.id,
    count: 2,
    metadata: 0,
    components,
    removedComponents: removeComponents
  })

  assert.equal(opened.itemKey, nested.itemKey)
  assert.equal(JSON.parse(opened.metaJson).metadata, null)
  assert.deepEqual(JSON.parse(opened.metaJson).removeComponents, removeComponents)

  const nestedWithoutComponents = catalog.fromContainerEntry({
    itemId: itemData.id,
    itemCount: 2,
    components: [],
    removeComponents: []
  })
  const openedWithoutComponents = catalog.fromPrismarineItem({
    name: itemData.name,
    type: itemData.id,
    count: 2,
    metadata: 0,
    components: [],
    removedComponents: []
  })
  assert.equal(openedWithoutComponents.itemKey, nestedWithoutComponents.itemKey)
  assert.equal(JSON.parse(openedWithoutComponents.metaJson).components, null)
})

test('bee containers use a fixed fingerprint inside shulkers and open windows', () => {
  const catalog = new ItemCatalog('1.21.11')
  const beeNest = catalog.mcData.itemsByName.bee_nest
  const nested = catalog.fromContainerEntry({
    itemId: beeNest.id,
    itemCount: 1,
    components: [{
      type: 'bees',
      data: { bees: [{ ticksInHive: 20, entityData: { UUID: [1, 2, 3, 4] } }] }
    }],
    removeComponents: ['minecraft:custom_data']
  })
  const opened = catalog.fromPrismarineItem({
    name: beeNest.name,
    type: beeNest.id,
    count: 1,
    metadata: 0,
    components: [{
      type: 'custom_data',
      data: { type: 'compound', value: { 'VV|original_hashes': { type: 'intArray', value: [1, 2] } } }
    }],
    removedComponents: []
  })

  assert.equal(opened.itemKey, nested.itemKey)
  assert.equal(opened.metaJson, JSON.stringify({ components: null, metadata: null }))
  assert.equal(opened.nbtJson, 'null')
})

test('shulker storage strips nested bee container components', () => {
  const catalog = new ItemCatalog('1.21.11')
  const shulker = catalog.mcData.itemsByName.shulker_box
  const beeNest = catalog.mcData.itemsByName.bee_nest
  const corruptedNumericItem = catalog.mcData.itemsByName.copper_nugget
  const normalized = catalog.fromPrismarineItem({
    name: shulker.name,
    type: shulker.id,
    count: 1,
    metadata: 0,
    components: [{
      type: 'container',
      data: {
        contents: [{
          itemId: corruptedNumericItem.id,
          itemCount: 1,
          addedComponentCount: 1,
          components: [{
            type: 'custom_data',
            data: { type: 'compound', value: { 'VV|original_hashes': { type: 'intArray', value: [1, 2] } } }
          }],
          removeComponents: ['minecraft:bees'],
          removedComponentCount: 1
        }]
      }
    }]
  })

  const storedEntry = JSON.parse(normalized.metaJson).components[0].data.contents[0]
  assert.equal(storedEntry.itemId, beeNest.id)
  assert.deepEqual(storedEntry.components, [])
  assert.deepEqual(storedEntry.removeComponents, [])
  assert.equal(storedEntry.addedComponentCount, 0)
  assert.equal(storedEntry.removedComponentCount, 0)
  assert.equal(normalized.metaJson.includes('VV|original_hashes'), false)
})

test('air aiming finds a horizontal cardinal opening inside a 1x2 barrel tunnel', async () => {
  const looks = []
  const bot = {
    entity: { yaw: 0.37, pitch: 0 },
    look: async (yaw, pitch) => {
      bot.entity.yaw = yaw
      bot.entity.pitch = pitch
      looks.push({ yaw, pitch })
    },
    blockAtCursor: () => {
      const eastOrWest = Math.abs(Math.abs(bot.entity.yaw) - (Math.PI / 2)) < 0.001
      return bot.entity.pitch === 0 && eastOrWest
        ? null
        : { name: bot.entity.pitch === 0 ? 'barrel' : 'quartz_block', position: { x: 0, y: 0, z: 0 } }
    }
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.debug = false
  const warehouse = new Warehouse(bot, {}, {}, config)

  await warehouse.aimAtAir(6)

  assert.equal(looks.at(-1).pitch, 0)
  assert.ok(Math.abs(Math.abs(looks.at(-1).yaw) - (Math.PI / 2)) < 0.001)
  assert.ok(looks.every(look => look.pitch === 0), 'horizontal opening should be found before vertical fallback')
})

test('shulker return accepts a delayed inventory update without clicking twice', async () => {
  const boxInfo = { itemKey: 'box-key', itemId: 'minecraft:purple_shulker_box', displayName: '紫色潜影盒' }
  const box = { name: 'purple_shulker_box', slot: 36, count: 1, normalized: boxInfo }
  let inventory = [box]
  let depositCalls = 0
  let refreshed = false
  const container = { close: () => {} }
  const bot = { inventory: { items: () => inventory } }
  const catalog = {
    fromPrismarineItem: item => ({ ...item.normalized, amount: item.count }),
    isShulkerBox: itemId => /_shulker_box$/.test(itemId)
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.debug = false
  config.timing.containerSettleMs = 0
  config.timing.inventoryUpdateTimeoutMs = 200
  const warehouse = new Warehouse(bot, {}, catalog, config)
  warehouse.openContainerAt = async () => container
  warehouse.tryDepositInto = async () => {
    depositCalls++
    setTimeout(() => { inventory = [] }, 25)
    return 0
  }
  warehouse.refreshChestSnapshot = () => { refreshed = true }

  const returned = await warehouse.returnShulkerToChest({ chestId: '1,2,3', x: 1, y: 2, z: 3, blockName: 'barrel' }, box)

  assert.equal(returned.itemKey, boxInfo.itemKey)
  assert.equal(depositCalls, 1)
  assert.equal(refreshed, true)
})

test('deposit confirms a shulker from the clicked window slot when inventory metadata stays stale', async () => {
  const oldBoxInfo = { itemKey: 'old-box-key', itemId: 'minecraft:purple_shulker_box', displayName: '紫色潜影盒' }
  const mutatedBoxInfo = { ...oldBoxInfo, itemKey: 'plugin-mutated-key' }
  const box = { name: 'purple_shulker_box', slot: 36, count: 1, stackSize: 1, normalized: oldBoxInfo }
  const mutatedBox = { ...box, normalized: mutatedBoxInfo }
  let inventory = [box]
  let clickCalls = 0
  const slots = new Array(63).fill(null)
  slots[54] = box
  const container = { inventoryStart: 27, inventoryEnd: 63, slots }
  const bot = {
    inventory: { inventoryStart: 9, items: () => inventory },
    clickWindow: async slot => {
      assert.equal(slot, 54)
      clickCalls++
      setTimeout(() => { inventory = [mutatedBox] }, 10)
      setTimeout(() => { slots[54] = null }, 90)
    }
  }
  const catalog = {
    fromPrismarineItem: item => ({ ...item.normalized, amount: item.count }),
    getStackSize: () => 1
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.debug = false
  config.timing.containerSettleMs = 0
  config.timing.inventoryUpdateTimeoutMs = 200
  const warehouse = new Warehouse(bot, {}, catalog, config)

  const startedAt = Date.now()
  const moved = await warehouse.tryDepositInto(container, box)

  assert.equal(moved, 1)
  assert.equal(clickCalls, 1)
  assert.ok(Date.now() - startedAt >= 75, 'metadata-only changes must not confirm the deposit')
})

test('deposit skips stale inventory entries after the open window slot is empty', async () => {
  const itemInfo = { itemKey: 'moss-key', itemId: 'minecraft:moss_block', displayName: '苔藓块' }
  const item = { name: 'moss_block', slot: 36, count: 64, stackSize: 64, normalized: itemInfo }
  let inventory = [item]
  let clickCalls = 0
  const slots = new Array(63).fill(null)
  slots[54] = item
  const container = {
    inventoryStart: 27,
    inventoryEnd: 63,
    slots,
    close: () => { inventory = [] }
  }
  const bot = {
    inventory: { inventoryStart: 9, items: () => inventory },
    clickWindow: async slot => {
      assert.equal(slot, 54)
      clickCalls++
      slots[54] = null
    }
  }
  const db = {
    listChests: () => [{ chestId: '1,2,3' }],
    listChestSlots: () => [{ chestId: '1,2,3', x: 1, y: 2, z: 3, blockName: 'barrel', slot: null }]
  }
  const catalog = {
    fromPrismarineItem: entry => ({ ...entry.normalized, amount: entry.count }),
    getStackSize: () => 64
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.debug = false
  config.timing.containerSettleMs = 0
  config.timing.inventoryUpdateTimeoutMs = 200
  const warehouse = new Warehouse(bot, db, catalog, config)
  warehouse.openContainerAt = async () => container
  warehouse.refreshChestSnapshot = () => {}

  await warehouse.depositAllPossible()

  assert.equal(clickCalls, 1)
  assert.deepEqual(inventory, [])
})

test('shulker extraction returns the changed box to its source chest before updating balances', async () => {
  const target = { itemKey: 'target-key', itemId: 'minecraft:diamond', displayName: '钻石', amount: 2 }
  const oldBoxInfo = { itemKey: 'old-box', itemId: 'minecraft:purple_shulker_box', displayName: '潜影盒' }
  const oldBox = { slot: 36, count: 1, normalized: oldBoxInfo }
  const newBoxInfo = { itemKey: 'new-box', itemId: oldBoxInfo.itemId, displayName: '潜影盒' }
  const newBox = { slot: 36, count: 1, normalized: newBoxInfo }
  let inventory = [oldBox]
  let returnedTo = null
  let balanceUpdate = null
  const operations = []
  const db = {
    getItemByKey: key => key === target.itemKey ? target : (key === oldBoxInfo.itemKey ? oldBoxInfo : null),
    listSlotsForItemKey: () => [{ chestId: '1,2,3', x: 1, y: 2, z: 3, blockName: 'barrel', slot: 4, amount: 1 }],
    beginShulkerRepackRecovery: () => { operations.push('prepared') },
    markShulkerRepackPhysicalChange: (...args) => { operations.push('physical_changed'); balanceUpdate = args },
    commitShulkerRepackRecovery: () => { operations.push('committed') },
    clearShulkerRepackRecovery: () => {},
    getShulkerRepackRecovery: () => null
  }
  const catalog = {
    fromPrismarineItem: item => ({ ...item.normalized, amount: item.count }),
    isShulkerBox: itemId => /_shulker_box$/.test(itemId),
    extractShulkerContents: box => box.itemKey === newBoxInfo.itemKey
      ? [{ item: target, amount: 3 }]
      : [{ item: target, amount: 5 }]
  }
  const bot = { inventory: { items: () => inventory } }
  const config = structuredClone(DEFAULT_CONFIG)
  config.debug = false
  config.timing.containerSettleMs = 0
  const warehouse = new Warehouse(bot, db, catalog, config)
  warehouse.takeOneShulkerFromChest = async chest => {
    assert.equal(chest.chestId, '1,2,3')
    return oldBox
  }
  warehouse.equipItemInHand = async item => assert.equal(item, oldBox)
  warehouse.openQuickShulkerWindow = async () => ({ close: () => { inventory = [newBox] } })
  warehouse.countContainerItem = () => 5
  warehouse.tryWithdrawExactFrom = async () => 2
  warehouse.returnShulkerToChest = async (chest, item) => {
    operations.push('returned')
    returnedTo = { chest, item }
    inventory = []
  }

  const result = await warehouse.withdrawFromShulkerBoxes({
    withdrawMode: 'shulker_extract',
    ownerUuid: 'owner',
    ownerUsername: 'Player',
    itemKey: target.itemKey,
    amount: 2,
    sourceShulkerItemKey: oldBoxInfo.itemKey,
    sourceBoxCount: 1
  })

  assert.equal(result.withdrawn[0].amount, 2)
  assert.equal(result.missing.length, 0)
  assert.equal(returnedTo.chest.chestId, '1,2,3')
  assert.equal(returnedTo.item, newBox)
  assert.equal(balanceUpdate[0], 'nankinz1')
  assert.equal(balanceUpdate[1].itemKey, newBoxInfo.itemKey)
  assert.equal(balanceUpdate[2][0].amount, 2)
  assert.deepEqual(operations, ['prepared', 'physical_changed', 'returned', 'committed'])
})

test('shulker extraction keeps the physical-change journal when the balance commit fails', async () => {
  const target = { itemKey: 'target-key', itemId: 'minecraft:diamond', displayName: '钻石', amount: 2 }
  const oldBoxInfo = { itemKey: 'old-box', itemId: 'minecraft:purple_shulker_box', displayName: '潜影盒' }
  const newBoxInfo = { itemKey: 'new-box', itemId: oldBoxInfo.itemId, displayName: '潜影盒' }
  const oldBox = { slot: 36, count: 1, normalized: oldBoxInfo }
  const newBox = { slot: 36, count: 1, normalized: newBoxInfo }
  let inventory = [oldBox]
  let recovery = null
  const db = {
    getItemByKey: key => key === target.itemKey ? target : (key === oldBoxInfo.itemKey ? oldBoxInfo : null),
    listSlotsForItemKey: () => [{ chestId: '1,2,3', x: 1, y: 2, z: 3, blockName: 'barrel', slot: 4, amount: 1 }],
    beginShulkerRepackRecovery: (botId, details) => { recovery = { botId, state: 'prepared', ...details } },
    markShulkerRepackPhysicalChange: (botId, box, items) => { recovery = { ...recovery, state: 'physical_changed', newBoxItem: box, extractedItems: items } },
    commitShulkerRepackRecovery: () => { throw new Error('simulated commit failure') },
    getShulkerRepackRecovery: () => recovery,
    clearShulkerRepackRecovery: () => { recovery = null }
  }
  const catalog = {
    fromPrismarineItem: item => ({ ...item.normalized, amount: item.count }),
    isShulkerBox: itemId => /_shulker_box$/.test(itemId),
    extractShulkerContents: box => box.itemKey === newBoxInfo.itemKey
      ? [{ item: target, amount: 3 }]
      : [{ item: target, amount: 5 }]
  }
  const bot = { username: 'BotA', inventory: { items: () => inventory } }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.debug = false
  config.timing.containerSettleMs = 0
  const warehouse = new Warehouse(bot, db, catalog, config)
  warehouse.takeOneShulkerFromChest = async () => oldBox
  warehouse.equipItemInHand = async () => {}
  warehouse.openQuickShulkerWindow = async () => ({ close: () => { inventory = [newBox] } })
  warehouse.countContainerItem = () => 5
  warehouse.tryWithdrawExactFrom = async () => 2
  warehouse.returnShulkerToChest = async () => { inventory = [] }

  await assert.rejects(() => warehouse.withdrawFromShulkerBoxes({
    ownerUuid: 'owner',
    ownerUsername: 'Player',
    itemKey: target.itemKey,
    amount: 2,
    sourceShulkerItemKey: oldBoxInfo.itemKey,
    sourceBoxCount: 1
  }), /simulated commit failure/)

  assert.equal(recovery.state, 'physical_changed')
  assert.equal(recovery.oldBoxItemKey, oldBoxInfo.itemKey)
  assert.equal(recovery.newBoxItem.itemKey, newBoxInfo.itemKey)
})

test('shulker extraction skips an unresolved recovery conflict without stopping the bot', async () => {
  const target = { itemKey: 'conflict-target', itemId: 'minecraft:diamond', displayName: '钻石', amount: 2 }
  const oldBoxInfo = { itemKey: 'conflict-old-box', itemId: 'minecraft:purple_shulker_box', displayName: '潜影盒' }
  const oldBox = { slot: 36, count: 1, normalized: oldBoxInfo }
  let inventory = [oldBox]
  let returned = false
  const recovery = {
    state: 'physical_changed',
    oldBoxItemKey: oldBoxInfo.itemKey,
    newBoxItem: { itemKey: 'conflict-new-box', itemId: oldBoxInfo.itemId },
    extractedItems: [{ ...target, amount: 1 }]
  }
  const db = {
    getItemByKey: key => key === target.itemKey ? target : (key === oldBoxInfo.itemKey ? oldBoxInfo : null),
    listSlotsForItemKey: () => [{ chestId: '1,2,3', x: 1, y: 2, z: 3, blockName: 'barrel', slot: 4, amount: 1 }],
    getShulkerRepackRecovery: () => recovery,
    clearShulkerRepackRecovery: () => { throw new Error('must not clear unresolved recovery') },
    beginShulkerRepackRecovery: () => { throw new Error('must not begin while recovery is unresolved') }
  }
  const catalog = {
    fromPrismarineItem: item => ({ ...item.normalized, amount: item.count }),
    isShulkerBox: itemId => /_shulker_box$/.test(itemId)
  }
  const bot = { username: 'BotA', inventory: { items: () => inventory } }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.debug = false
  config.timing.containerSettleMs = 0
  const warehouse = new Warehouse(bot, db, catalog, config)
  warehouse.takeOneShulkerFromChest = async () => oldBox
  warehouse.equipItemInHand = async () => {}
  warehouse.openQuickShulkerWindow = async () => ({ close: () => { inventory = [oldBox] } })
  warehouse.countContainerItem = () => 5
  warehouse.tryWithdrawExactFrom = async () => 2
  warehouse.returnShulkerToChest = async (chest, item) => {
    assert.equal(item, oldBox)
    returned = true
    inventory = []
  }

  const result = await warehouse.withdrawFromShulkerBoxes({
    ownerUuid: 'owner',
    ownerUsername: 'Player',
    itemKey: target.itemKey,
    amount: 2,
    sourceShulkerItemKey: oldBoxInfo.itemKey,
    sourceBoxCount: 1
  })

  assert.deepEqual(result.withdrawn, [])
  assert.equal(result.missing[0].amount, 2)
  assert.equal(returned, true)
})

test('shulker extraction clears an unchanged prepared recovery before retrying', async () => {
  const target = { itemKey: 'retry-target', itemId: 'minecraft:diamond', displayName: '钻石', amount: 2 }
  const oldBoxInfo = { itemKey: 'retry-old-box', itemId: 'minecraft:purple_shulker_box', displayName: '潜影盒' }
  const oldBox = { slot: 36, count: 1, normalized: oldBoxInfo }
  let recovery = { state: 'prepared', oldBoxItemKey: oldBoxInfo.itemKey }
  const operations = []
  let inventory = [oldBox]
  const db = {
    getItemByKey: key => key === target.itemKey ? target : (key === oldBoxInfo.itemKey ? oldBoxInfo : null),
    listSlotsForItemKey: () => [{ chestId: '1,2,3', x: 1, y: 2, z: 3, blockName: 'barrel', slot: 4, amount: 1 }],
    getShulkerRepackRecovery: () => recovery,
    clearShulkerRepackRecovery: () => { operations.push('cleared'); recovery = null },
    beginShulkerRepackRecovery: () => { operations.push('prepared') },
    markShulkerRepackPhysicalChange: () => { operations.push('physical_changed') },
    commitShulkerRepackRecovery: () => { operations.push('committed') }
  }
  const catalog = {
    fromPrismarineItem: item => ({ ...item.normalized, amount: item.count }),
    isShulkerBox: itemId => /_shulker_box$/.test(itemId),
    extractShulkerContents: () => [{ item: target, amount: 3 }]
  }
  const bot = { username: 'BotA', inventory: { items: () => inventory } }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.debug = false
  config.timing.containerSettleMs = 0
  const warehouse = new Warehouse(bot, db, catalog, config)
  warehouse.takeOneShulkerFromChest = async () => oldBox
  warehouse.equipItemInHand = async () => {}
  warehouse.openQuickShulkerWindow = async () => ({ close: () => { inventory = [oldBox] } })
  warehouse.countContainerItem = () => 5
  warehouse.tryWithdrawExactFrom = async () => 0
  warehouse.returnShulkerToChest = async () => { inventory = [] }

  const result = await warehouse.withdrawFromShulkerBoxes({
    ownerUuid: 'owner',
    ownerUsername: 'Player',
    itemKey: target.itemKey,
    amount: 2,
    sourceShulkerItemKey: oldBoxInfo.itemKey,
    sourceBoxCount: 1
  })

  assert.equal(result.missing[0].amount, 2)
  assert.deepEqual(operations, ['cleared', 'prepared', 'cleared'])
})

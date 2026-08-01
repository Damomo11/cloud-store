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

test('shulker extraction returns the changed box to its source chest before updating balances', async () => {
  const target = { itemKey: 'target-key', itemId: 'minecraft:diamond', displayName: '钻石', amount: 2 }
  const oldBoxInfo = { itemKey: 'old-box', itemId: 'minecraft:purple_shulker_box', displayName: '潜影盒' }
  const oldBox = { slot: 36, count: 1, normalized: oldBoxInfo }
  const newBoxInfo = { itemKey: 'new-box', itemId: oldBoxInfo.itemId, displayName: '潜影盒' }
  const newBox = { slot: 36, count: 1, normalized: newBoxInfo }
  let inventory = [oldBox]
  let returnedTo = null
  let balanceUpdate = null
  const db = {
    getItemByKey: key => key === target.itemKey ? target : (key === oldBoxInfo.itemKey ? oldBoxInfo : null),
    listSlotsForItemKey: () => [{ chestId: '1,2,3', x: 1, y: 2, z: 3, blockName: 'barrel', slot: 4, amount: 1 }],
    applyShulkerExtraction: (...args) => { balanceUpdate = args }
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
  assert.equal(balanceUpdate[0], 'owner')
  assert.equal(balanceUpdate[1], oldBoxInfo.itemKey)
  assert.equal(balanceUpdate[2].itemKey, newBoxInfo.itemKey)
  assert.equal(balanceUpdate[3][0].amount, 2)
})

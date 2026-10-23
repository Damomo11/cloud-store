const test = require('node:test')
const assert = require('node:assert/strict')
const Warehouse = require('../src/warehouse')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

const TARGET = {
  itemKey: 'k:target',
  itemId: 'minecraft:cherry_fence_gate',
  displayName: '樱花木栅栏门'
}

const BOX = {
  itemKey: 'k:box',
  itemId: 'minecraft:shulker_box',
  displayName: '潜影盒',
  nbtJson: 'null',
  metaJson: '{}'
}

function makeConfig () {
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.debug = false
  config.timing.containerSettleMs = 0
  config.timing.containerClickIntervalMs = 0
  return config
}

const catalogStub = {
  fromPrismarineItem: item => ({ itemKey: item.key || item.itemKeyHint || `k:${item.name}` }),
  getStackSize: () => 64,
  isShulkerBox: itemId => String(itemId).endsWith('shulker_box')
}

function makeWindow ({ container = {}, inventory = {} } = {}) {
  const slots = new Array(63).fill(null)
  for (const [slot, item] of Object.entries(container)) slots[Number(slot)] = item
  for (const [slot, item] of Object.entries(inventory)) slots[Number(slot)] = item
  return {
    inventoryStart: 27,
    inventoryEnd: 63,
    slots,
    items: () => slots.map((item, slot) => item ? { ...item, slot } : null).filter(Boolean),
    selectedItem: null,
    close: () => {}
  }
}

function makeMoveWarehouse () {
  const clicks = []
  const bot = {
    username: 'BotA',
    clickWindow: async (slot, button, mode) => { clicks.push({ slot, button, mode }) },
    inventory: { items: () => [] }
  }
  const warehouse = new Warehouse(bot, {}, catalogStub, makeConfig())
  return { warehouse, clicks }
}

test('partial withdraw merges into an existing same-type stack instead of a new slot', async () => {
  const { warehouse, clicks } = makeMoveWarehouse()
  // 线上事故场景：背包只有同类型 50 个的半堆，没有空格，桶里还有 4 个要取
  const window = makeWindow({
    container: { 5: { name: 'cherry_fence_gate', count: 4, stackSize: 64, key: TARGET.itemKey } },
    inventory: { 40: { name: 'cherry_fence_gate', count: 50, stackSize: 64, key: TARGET.itemKey } }
  })
  // 把其余背包格填满，确认并堆不再依赖空格
  for (let slot = 27; slot < 63; slot++) {
    if (slot !== 40) window.slots[slot] = { name: 'stone', count: 64, stackSize: 64, key: `k:junk-${slot}` }
  }

  await warehouse.movePartialContainerSlotToInventory(window, 5, 4)

  assert.deepEqual(clicks, [
    { slot: 5, button: 0, mode: 0 },
    { slot: 40, button: 1, mode: 0 },
    { slot: 40, button: 1, mode: 0 },
    { slot: 40, button: 1, mode: 0 },
    { slot: 40, button: 1, mode: 0 },
    { slot: 5, button: 0, mode: 0 }
  ], '右键应逐个点进 40 号半堆，而不是找空格')
})

test('whole stack move merges into a same-type partial stack', async () => {
  const { warehouse, clicks } = makeMoveWarehouse()
  const window = makeWindow({
    container: { 6: { name: 'cherry_fence_gate', count: 14, stackSize: 64, key: TARGET.itemKey } },
    inventory: {
      40: { name: 'cherry_fence_gate', count: 50, stackSize: 64, key: TARGET.itemKey },
      41: null
    }
  })

  await warehouse.moveContainerSlotToInventory(window, 6)

  assert.deepEqual(clicks, [
    { slot: 6, button: 0, mode: 0 },
    { slot: 40, button: 0, mode: 0 }
  ])
})

test('whole stack larger than partial free space falls back to an empty slot', async () => {
  const { warehouse, clicks } = makeMoveWarehouse()
  const window = makeWindow({
    container: { 6: { name: 'cherry_fence_gate', count: 30, stackSize: 64, key: TARGET.itemKey } },
    inventory: { 40: { name: 'cherry_fence_gate', count: 55, stackSize: 64, key: TARGET.itemKey } }
  })

  await warehouse.moveContainerSlotToInventory(window, 6)

  assert.deepEqual(clicks, [
    { slot: 6, button: 0, mode: 0 },
    { slot: 27, button: 0, mode: 0 }
  ], '半堆余量 9 装不下 30，应落到空格 27')
})

test('withdraw with a full inventory and no merge target still throws the no-slot error', async () => {
  const { warehouse } = makeMoveWarehouse()
  const window = makeWindow({
    container: { 6: { name: 'cherry_fence_gate', count: 30, stackSize: 64, key: TARGET.itemKey } },
    inventory: { 40: { name: 'cherry_fence_gate', count: 55, stackSize: 64, key: TARGET.itemKey } }
  })
  for (let slot = 27; slot < 63; slot++) {
    if (slot !== 40) window.slots[slot] = { name: 'stone', count: 64, stackSize: 64, key: `k:junk-${slot}` }
  }

  await assert.rejects(() => warehouse.moveContainerSlotToInventory(window, 6), /背包没有空槽/)
})

test('ensureWindowCursorCleared merges cursor items back into a same-type partial stack', async () => {
  const window = makeWindow({
    inventory: {
      40: { name: 'cherry_fence_gate', count: 50, stackSize: 64, key: TARGET.itemKey },
      41: null
    }
  })
  window.selectedItem = { name: 'cherry_fence_gate', count: 5, stackSize: 64, key: TARGET.itemKey }
  const clicks = []
  const bot = {
    username: 'BotA',
    clickWindow: async (slot, button, mode) => {
      clicks.push({ slot, button, mode })
      window.selectedItem = null // 点击后光标物品并入目标堆
    },
    inventory: { items: () => [] }
  }
  const warehouse = new Warehouse(bot, {}, catalogStub, makeConfig())

  const cleared = await warehouse.ensureWindowCursorCleared(window)

  assert.equal(cleared, true)
  assert.deepEqual(clicks, [{ slot: 40, button: 0, mode: 0 }])
})

test('inventoryFreeCapacityForItem counts empty slots plus partial headroom', () => {
  const slots = new Array(46).fill(null)
  const held = [
    { name: 'cherry_fence_gate', count: 50, stackSize: 64, key: TARGET.itemKey, slot: 12 }
  ]
  slots[12] = held[0]
  for (let slot = 13; slot < 45; slot++) {
    const junk = { name: 'stone', count: 64, stackSize: 64, key: `k:junk-${slot}`, slot }
    slots[slot] = junk
    held.push(junk)
  }
  const warehouse = new Warehouse(
    { username: 'BotA', inventory: { items: () => held, slots } },
    {},
    catalogStub,
    makeConfig()
  )

  // 3 个空格 ×64 + 12 号半堆余量 14
  assert.equal(warehouse.inventoryFreeCapacityForItem(TARGET.itemKey), 206)
  // 无法观测槽位时按"还有容量"处理，不做提前停止
  const opaque = new Warehouse(
    { username: 'BotA', inventory: { items: () => [] } },
    {},
    catalogStub,
    makeConfig()
  )
  assert.equal(opaque.inventoryFreeCapacityForItem(TARGET.itemKey), Number.POSITIVE_INFINITY)
})

function makeFullInventoryBot () {
  const slots = new Array(46).fill(null)
  const held = []
  for (let i = 9; i < 45; i++) {
    const junk = { name: 'stone', count: 64, stackSize: 64, key: `k:junk-${i}`, slot: i }
    slots[i] = junk
    held.push(junk)
  }
  return { username: 'BotA', inventory: { items: () => held, slots } }
}

function makeDb () {
  return {
    getItemByKey: key => {
      if (key === TARGET.itemKey) return { ...TARGET }
      if (key === BOX.itemKey) return { ...BOX }
      return null
    },
    listSlotsForItemKey: key => key === BOX.itemKey
      ? [{ chestId: 'chest-1', x: 1, y: 2, z: 3, blockName: 'barrel', slot: 0, amount: 1, itemKey: key }]
      : [{ chestId: 'chest-2', x: 4, y: 5, z: 6, blockName: 'barrel', slot: 0, amount: 183, itemKey: key }],
    getOwnerShulkersContainingItemKey: () => [],
    getShulkerRepackRecovery: () => null,
    clearShulkerRepackRecovery: () => {},
    beginShulkerRepackRecovery: () => {},
    markShulkerRepackPhysicalChange: () => ({}),
    commitShulkerRepackRecovery: () => {},
    hasOpenInventoryMismatch: () => false,
    addInventoryMismatch: () => {},
    getBalance: () => 0,
    upsertChest: () => {},
    replaceChestSlots: () => {}
  }
}

test('barrel withdrawal stops early and tags missing as inventory-full when inventory is full', async () => {
  const bot = makeFullInventoryBot()
  const warehouse = new Warehouse(bot, makeDb(), catalogStub, makeConfig())
  const opened = []
  warehouse.openContainerAt = async chest => {
    opened.push(chest.chestId)
    throw new Error('背包已满时不应开桶')
  }

  const result = await warehouse.withdrawAllocationsLocked([{ ...TARGET, amount: 183, ownerUuid: 'vault:1' }])

  assert.equal(opened.length, 0, '背包已满时不应再白跑木桶')
  assert.equal(result.withdrawn.length, 0)
  assert.equal(result.missing.length, 1)
  assert.equal(result.missing[0].amount, 183)
  assert.equal(result.missing[0].inventoryFull, true)
})

test('shulker extraction stops before taking a box and tags missing as inventory-full', async () => {
  const bot = makeFullInventoryBot()
  const warehouse = new Warehouse(bot, makeDb(), catalogStub, makeConfig())
  const tookBoxes = []
  warehouse.takeOneShulkerFromChest = async () => {
    tookBoxes.push('take')
    throw new Error('背包已满时不应取盒')
  }

  const allocation = {
    ...TARGET,
    amount: 64,
    ownerUuid: 'vault:1',
    withdrawMode: 'shulker_extract',
    sourceShulkerItemKey: BOX.itemKey,
    sourceBoxCount: 1
  }
  const result = await warehouse.withdrawFromShulkerBoxes(allocation)

  assert.equal(tookBoxes.length, 0, '背包已满时不应再从木桶取潜影盒')
  assert.equal(result.withdrawn.length, 0)
  assert.equal(result.missing.length, 1)
  assert.equal(result.missing[0].amount, 64)
  assert.equal(result.missing[0].inventoryFull, true)
})

test('takeOneShulkerFromChest reports the plain inventory-full reason on failure', async () => {
  const bot = makeFullInventoryBot()
  const warehouse = new Warehouse(bot, makeDb(), catalogStub, makeConfig())
  warehouse.openContainerAt = async () => makeWindow({
    container: { 0: { name: 'shulker_box', count: 1, stackSize: 1, key: BOX.itemKey } }
  })
  warehouse.refreshChestSnapshot = () => {}
  warehouse.tryWithdrawExactFrom = async () => 0

  await assert.rejects(
    () => warehouse.takeOneShulkerFromChest({ chestId: 'chest-1', x: 1, y: 2, z: 3, blockName: 'barrel' }, BOX.itemKey),
    /背包已满/
  )
})

test('service separates inventory-full shortfall from stock shortfall in missing notices', () => {
  const svc = Object.create(CloudStoreService.prototype)
  svc.catalog = { getDisplayName: () => '石头' }
  const planned = [{ itemKey: TARGET.itemKey, itemId: TARGET.itemId, amount: 10 }]
  const delivered = [{ itemKey: TARGET.itemKey, amount: 6 }]

  const fullNotice = svc.groupMissingByDisplay(planned, delivered, [
    { itemKey: TARGET.itemKey, amount: 4, inventoryFull: true }
  ])
  assert.equal(fullNotice.length, 1)
  assert.match(fullNotice[0], /背包已满/)
  assert.match(fullNotice[0], /未扣库存/)

  const stockNotice = svc.groupMissingByDisplay(planned, delivered, [
    { itemKey: TARGET.itemKey, amount: 4 }
  ])
  assert.equal(stockNotice.length, 1)
  assert.match(stockNotice[0], /仓库实际库存不足/)
})

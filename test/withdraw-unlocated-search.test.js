const test = require('node:test')
const assert = require('node:assert/strict')
const Warehouse = require('../src/warehouse')
const Vec3 = require('vec3')
const { DEFAULT_CONFIG } = require('../src/config')

const ITEM = { itemKey: 'minecraft:stone|plain', itemId: 'minecraft:stone', displayName: '石头' }

// 假木桶窗口：contents 为 [{ itemKey, count, slot }]
function createContainer (contents) {
  const slots = new Array(27).fill(null)
  for (const entry of contents) {
    slots[entry.slot] = { name: 'stone', itemKey: entry.itemKey, count: entry.count, slot: entry.slot }
  }
  const container = {
    inventoryStart: 27,
    inventoryEnd: 63,
    slots,
    selectedItem: null,
    items: () => slots.filter(Boolean),
    containerItems: () => slots.map((item, slot) => (item ? { ...item, slot } : null)).filter(Boolean),
    close: () => {}
  }
  return container
}

function createFixture (options = {}) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.timing.containerSettleMs = 0
  config.timing.containerClickIntervalMs = 0
  config.timing.dropIntervalMs = 0
  config.timing.withdrawMaxUnlocatedBarrels = options.limit ?? 12
  config.timing.unlocatedBarrelWaitMs = options.waitMs ?? 50

  const chests = options.chests || [
    { chestId: 'a', x: 1, y: 64, z: 1, blockName: 'barrel' },
    { chestId: 'b', x: 2, y: 64, z: 1, blockName: 'barrel' }
  ]
  const refreshed = []
  const pendingStacks = new Map()
  const inventory = []

  const db = {
    listChests: () => chests,
    listSlotsForItemKey: () => [],          // 账本没有任何位置记录
    getItemByKey: () => ({ ...ITEM }),
    upsertChest: () => {},
    replaceChestSlots: (chestId, slots) => {
      refreshed.push({ chestId, slots: slots.map(s => ({ itemKey: s.itemKey, slot: s.slot, amount: s.amount })) })
      pendingStacks.set(chestId, slots.map(s => ({ ...s })))
    },
    addInventoryMismatch: () => {},
    hasOpenInventoryMismatch: () => false
  }

  const catalog = {
    fromPrismarineItem: item => ({ ...item, itemKey: item.itemKey || ITEM.itemKey })
  }

  const opened = []
  const bot = {
    players: {},
    currentWindow: null,
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inventory.slice() },
    blockAt: pos => (options.blockAt ? options.blockAt(pos) : { name: 'barrel', position: pos }),
    clickWindow: async (slot, button) => {
      // mode 4 button 0 从窗口容器槽丢单件到背包；这里简化为整格入包
      const stack = inventory.find(entry => entry.slot === slot)
      if (!stack) inventory.push({ ...itemStack(slot) })
    }
  }

  function itemStack (slot) { return { name: 'stone', itemKey: ITEM.itemKey, count: 1, slot } }

  const warehouse = new Warehouse(bot, db, catalog, config)
  warehouse.homePosition = new Vec3(0, 64, 0)

  // 覆盖打开逻辑：按 chest 顺序返回预设结果
  const openPlan = options.openPlan || []
  warehouse.openContainerBlock = async block => {
    const index = opened.length
    opened.push(block.position)
    const step = openPlan[index] || { kind: 'timeout' }
    if (step.kind === 'timeout') {
      const error = new Error('打开箱子超时')
      error.openResult = 'timeout'
      throw error
    }
    if (step.kind === 'refused') {
      const error = new Error('打开箱子后没有收到窗口')
      error.openResult = 'refused'
      throw error
    }
    return createContainer(step.contents || [])
  }

  return { warehouse, config, bot, db, catalog, opened, refreshed, inventory }
}

test('unlocated search opens barrels, takes the item and refreshes the record', async () => {
  const { warehouse, opened, refreshed } = createFixture({
    openPlan: [
      { kind: 'ok', contents: [{ itemKey: ITEM.itemKey, count: 6, slot: 0 }] },
      { kind: 'ok', contents: [{ itemKey: ITEM.itemKey, count: 4, slot: 1 }] }
    ]
  })
  // 让取物真的把物品移出容器窗口
  warehouse.tryWithdrawExactFrom = async (container, itemKey, amount) => amount

  const result = await warehouse.withdrawAllocations([{ ...ITEM, amount: 10, ownerUuid: 'vault-1' }])

  assert.equal(opened.length, 2, '两批各开一个桶')
  assert.equal(result.searchedUnlocatedBarrels, 2)
  assert.equal(result.withdrawn[0].amount, 10)
  assert.equal(refreshed.length, 2, '每个读到内容的桶都要刷新记录')
  assert.equal(result.missing.length, 0)
})

test('unlocated search refreshes a barrel that does not hold the item and keeps searching', async () => {
  const { warehouse, opened, refreshed } = createFixture({
    openPlan: [
      { kind: 'ok', contents: [{ itemKey: 'minecraft:dirt|plain', count: 3, slot: 0 }] },
      { kind: 'ok', contents: [{ itemKey: ITEM.itemKey, count: 10, slot: 2 }] }
    ]
  })
  warehouse.tryWithdrawExactFrom = async (container, itemKey, amount) => amount

  const result = await warehouse.withdrawAllocations([{ ...ITEM, amount: 10, ownerUuid: 'vault-1' }])

  assert.equal(opened.length, 2)
  assert.equal(refreshed.length, 2, '没有目标物品的桶也要按实测内容刷新')
  assert.equal(refreshed[0].slots[0].itemKey, 'minecraft:dirt|plain')
  assert.equal(result.withdrawn[0].amount, 10)
})

test('an empty window is skipped without writing an empty record', async () => {
  const { warehouse, opened, refreshed } = createFixture({
    openPlan: [
      { kind: 'ok', contents: [] },
      { kind: 'ok', contents: [{ itemKey: ITEM.itemKey, count: 10, slot: 0 }] }
    ]
  })
  warehouse.tryWithdrawExactFrom = async (container, itemKey, amount) => amount

  const result = await warehouse.withdrawAllocations([{ ...ITEM, amount: 10, ownerUuid: 'vault-1' }])

  assert.equal(opened.length, 2)
  assert.equal(refreshed.length, 1, '空桶不能写空记录')
  assert.equal(result.withdrawn[0].amount, 10)
})

test('a barrel that never answers within the wait is treated as empty', async () => {
  const { warehouse, opened, refreshed } = createFixture({
    waitMs: 30,
    openPlan: [{ kind: 'timeout' }, { kind: 'timeout' }]
  })

  const result = await warehouse.withdrawAllocations([{ ...ITEM, amount: 10, ownerUuid: 'vault-1' }])

  assert.equal(opened.length, 2, '超时后继续下一个桶')
  assert.equal(refreshed.length, 0, '超时不写记录')
  assert.equal(result.withdrawn.length, 0)
  assert.equal(result.missing[0].amount, 10)
  assert.equal(result.unlocated.length, 1, '无位置标记保留，供上层跳过重试')
})

test('close_window alone is refused, not counted as an empty barrel', async () => {
  const { warehouse, opened, refreshed } = createFixture({
    openPlan: [
      { kind: 'refused' },
      { kind: 'ok', contents: [{ itemKey: ITEM.itemKey, count: 10, slot: 0 }] }
    ]
  })
  warehouse.tryWithdrawExactFrom = async (container, itemKey, amount) => amount

  const result = await warehouse.withdrawAllocations([{ ...ITEM, amount: 10, ownerUuid: 'vault-1' }])

  assert.equal(opened.length, 2, '被拒绝后继续下一个桶')
  assert.equal(refreshed.length, 1, '被拒绝的桶不写记录')
  assert.equal(result.withdrawn[0].amount, 10)
})

test('a coordinate that is no longer a barrel is skipped without throwing', async () => {
  const { warehouse, opened } = createFixture({
    blockAt: () => ({ name: 'stone' }),
    openPlan: []
  })

  const result = await warehouse.withdrawAllocations([{ ...ITEM, amount: 10, ownerUuid: 'vault-1' }])

  assert.equal(opened.length, 0, '不是木桶的坐标不该尝试打开')
  assert.equal(result.withdrawn.length, 0)
  assert.equal(result.missing[0].amount, 10)
})

test('the barrel search cap is honoured', async () => {
  const { warehouse, opened } = createFixture({
    limit: 2,
    chests: [
      { chestId: 'a', x: 1, y: 64, z: 1, blockName: 'barrel' },
      { chestId: 'b', x: 2, y: 64, z: 1, blockName: 'barrel' },
      { chestId: 'c', x: 3, y: 64, z: 1, blockName: 'barrel' },
      { chestId: 'd', x: 4, y: 64, z: 1, blockName: 'barrel' },
      { chestId: 'e', x: 5, y: 64, z: 1, blockName: 'barrel' }
    ],
    openPlan: [{ kind: 'timeout' }, { kind: 'timeout' }, { kind: 'timeout' }]
  })

  const result = await warehouse.withdrawAllocations([{ ...ITEM, amount: 10, ownerUuid: 'vault-1' }])

  assert.equal(opened.length, 2, '上限 2 时最多只开 2 个桶')
  assert.equal(result.searchedUnlocatedBarrels, 2)
})

test('a limit of 0 restores the old behavior and opens nothing', async () => {
  const { warehouse, opened } = createFixture({ limit: 0 })

  const result = await warehouse.withdrawAllocations([{ ...ITEM, amount: 10, ownerUuid: 'vault-1' }])

  assert.equal(opened.length, 0)
  assert.equal(result.searchedUnlocatedBarrels, 0)
  assert.equal(result.missing[0].amount, 10)
  assert.equal(result.unlocated.length, 1)
})

test('candidate barrels are ordered by distance from home', () => {
  const { warehouse } = createFixture({
    chests: [
      { chestId: 'far', x: 40, y: 64, z: 0, blockName: 'barrel' },
      { chestId: 'near', x: 2, y: 64, z: 0, blockName: 'barrel' },
      { chestId: 'mid', x: 10, y: 64, z: 0, blockName: 'barrel' }
    ]
  })

  const groups = warehouse.buildUnlocatedSearchGroups()

  assert.deepEqual(groups.map(group => group.chestId), ['near', 'mid', 'far'])
  assert.equal(groups[0].recordedAmount, null, '无记录不能伪装成 0')
})

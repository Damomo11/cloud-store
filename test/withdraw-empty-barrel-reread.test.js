const test = require('node:test')
const assert = require('node:assert/strict')
const Warehouse = require('../src/warehouse')
const { DEFAULT_CONFIG } = require('../src/config')

const ITEM = {
  itemKey: 'minecraft:stone|plain',
  itemId: 'minecraft:stone',
  displayName: '石头'
}

const DIRT = {
  itemKey: 'minecraft:dirt|plain',
  itemId: 'minecraft:dirt',
  displayName: '泥土'
}

function makeContainer (readSlots) {
  const slots = readSlots.map(entry => ({ ...entry }))
  return {
    inventoryStart: 27,
    inventoryEnd: 63,
    items: () => slots.filter(entry => entry.count > 0),
    close: () => {}
  }
}

// chests: [{ chestId, recorded: number, reads: [[contents], ...] }]
function createWarehouse (chests, configOverrides = {}) {
  const readsByChest = new Map(chests.map(chest => [chest.chestId, chest.reads.map(read => read.map(entry => ({ ...entry })))]))
  const openCalls = []
  const snapshotCalls = []

  const db = {
    getItemByKey: key => key === ITEM.itemKey ? { ...ITEM } : null,
    listSlotsForItemKey: () => chests.flatMap(chest => [
      {
        chestId: chest.chestId,
        x: 1, y: 2, z: 3,
        blockName: 'barrel',
        slot: 0,
        amount: chest.recorded,
        itemKey: ITEM.itemKey
      }
    ]),
    upsertChest: () => {},
    replaceChestSlots: (chestId, slots) => snapshotCalls.push({ chestId, slots })
  }
  const catalog = {
    fromPrismarineItem: entry => entry.name === 'dirt' ? { ...DIRT } : { ...ITEM }
  }
  const bot = { username: 'BotA' }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.debug = false
  config.timing.containerSettleMs = 0
  Object.assign(config.timing, configOverrides)

  const warehouse = new Warehouse(bot, db, catalog, config)
  warehouse.openContainerAt = async chest => {
    openCalls.push(chest.chestId)
    const queue = readsByChest.get(chest.chestId) || []
    return makeContainer(queue.length ? queue.shift() : [])
  }
  warehouse.tryWithdrawExactFrom = async (container, itemKey, amount) => {
    let remaining = amount
    for (const slot of container.items()) {
      if (remaining <= 0) break
      if (slot.name === 'dirt') continue
      const take = Math.min(remaining, slot.count)
      slot.count -= take
      remaining -= take
    }
    return amount - remaining
  }

  return { warehouse, openCalls, snapshotCalls }
}

const allocation = { ...ITEM, amount: 10 }

test('completely empty barrel read is retried and withdrawal succeeds after the window recovers', async () => {
  const { warehouse, openCalls, snapshotCalls } = createWarehouse([
    { chestId: 'chest-1', recorded: 10, reads: [[], [{ slot: 0, count: 10, name: 'stone' }]] }
  ])

  const result = await warehouse.withdrawAllocationsLocked([allocation])

  assert.equal(openCalls.length, 2, 'empty window must be reopened once before trusting the read')
  assert.equal(result.withdrawn.reduce((sum, item) => sum + item.amount, 0), 10)
  assert.equal(result.missing.length, 0)
  assert.equal(snapshotCalls.length, 1, 'chest record is refreshed from the trusted read')
})

test('barrel that keeps reading empty keeps its old record and is skipped, not wiped', async () => {
  const { warehouse, openCalls, snapshotCalls } = createWarehouse([
    { chestId: 'chest-1', recorded: 10, reads: [[], [], []] }
  ])

  const result = await warehouse.withdrawAllocationsLocked([allocation])

  assert.equal(openCalls.length, Math.max(1, Number(DEFAULT_CONFIG.timing.barrelEmptyRereadAttempts ?? 3)))
  assert.equal(result.withdrawn.length, 0)
  assert.deepEqual(result.missing.map(item => item.amount), [10])
  assert.equal(snapshotCalls.length, 0, 'a suspected lagged empty read must not overwrite the chest record')
})

test('barrel holding fewer items than recorded is refreshed in place and the rest is missing', async () => {
  const { warehouse, openCalls, snapshotCalls } = createWarehouse([
    { chestId: 'chest-1', recorded: 10, reads: [[{ slot: 0, count: 4, name: 'stone' }, { slot: 5, count: 9, name: 'dirt' }]] }
  ])

  const result = await warehouse.withdrawAllocationsLocked([allocation])

  assert.equal(openCalls.length, 1, 'a non-empty read is trusted without re-opening')
  assert.equal(result.withdrawn.reduce((sum, item) => sum + item.amount, 0), 4)
  assert.deepEqual(result.missing.map(item => item.amount), [6])
  assert.equal(snapshotCalls.length, 1)
  assert.deepEqual(
    snapshotCalls[0].slots.map(slot => [slot.itemKey, slot.slot, slot.amount]),
    [[DIRT.itemKey, 5, 9]],
    'the refreshed barrel record keeps the non-target item that is really inside'
  )
})

function sixShortBarrels () {
  return Array.from({ length: 6 }, (_, index) => ({
    chestId: `chest-${index + 1}`,
    recorded: 2,
    reads: [[{ slot: 0, count: 1, name: 'stone' }]]
  }))
}

test('chasing short barrels stops after the configured hop limit', async () => {
  const { warehouse, openCalls } = createWarehouse(sixShortBarrels())

  const result = await warehouse.withdrawAllocationsLocked([allocation])

  assert.equal(openCalls.length, 5, 'default limit is 5 short barrels per item')
  assert.deepEqual([...new Set(openCalls)], ['chest-1', 'chest-2', 'chest-3', 'chest-4', 'chest-5'])
  assert.equal(result.withdrawn.reduce((sum, item) => sum + item.amount, 0), 5)
  assert.deepEqual(result.missing.map(item => item.amount), [5])
})

test('the short-barrel hop limit is configurable and accurate barrels are not counted', async () => {
  const chests = sixShortBarrels()
  // 记录准确的桶（记录 4 实际 4）按记录量排序排最前，不占缺货换桶次数
  chests.push({ chestId: 'chest-7', recorded: 4, reads: [[{ slot: 0, count: 4, name: 'stone' }]] })
  const { warehouse, openCalls } = createWarehouse(chests, { withdrawMaxMissingBarrels: 6 })

  const result = await warehouse.withdrawAllocationsLocked([{ ...ITEM, amount: 12 }])

  assert.equal(openCalls.length, 7, 'the accurate barrel is visited on top of the six short ones')
  assert.equal(result.withdrawn.reduce((sum, item) => sum + item.amount, 0), 10)
  assert.deepEqual(result.missing.map(item => item.amount), [2])
})

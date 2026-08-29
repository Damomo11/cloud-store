const test = require('node:test')
const assert = require('node:assert/strict')

const Warehouse = require('../src/warehouse')
const { DEFAULT_CONFIG } = require('../src/config')

function createWarehouse (blocks) {
  const calls = {
    clear: 0,
    reconcile: 0,
    replacedSlots: [],
    reconcileTotals: null,
    openCalls: []
  }
  const db = {
    listChests: () => [{ chestId: 'old' }],
    clearChests: () => { calls.clear++ },
    upsertChest: () => {},
    replaceChestSlots: (chestId, slots) => { calls.replacedSlots.push({ chestId, slots }) },
    reconcileTotalsToMomo: totals => {
      calls.reconcile++
      calls.reconcileTotals = totals
      return {}
    },
    addTransaction: () => {}
  }
  const bot = { username: 'BotA', inventory: { items: () => [] } }
  const catalog = { fromPrismarineItem: item => item }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.debug = false
  const warehouse = new Warehouse(bot, db, catalog, config)
  warehouse.goHome = async () => {}
  warehouse.findContainerBlocks = () => blocks
  warehouse.describeBlock = block => block.chest.chestId
  warehouse.blockToChest = block => block.chest
  warehouse.assertConnectionHealthy = () => {}
  warehouse.containerContentItems = container => container.items || []
  return { warehouse, calls }
}

const totem = (slot, count) => ({ name: 'totem_of_undying', itemKey: 'totem', slot, count })

test('warehouse sync preserves old snapshots when any container cannot be read', async () => {
  const blocks = [
    { chest: { chestId: 'one', x: 1, y: 2, z: 3, blockName: 'barrel' } },
    { chest: { chestId: 'two', x: 4, y: 5, z: 6, blockName: 'barrel' } }
  ]
  const { warehouse, calls } = createWarehouse(blocks)
  warehouse.openContainerAt = async chest => {
    if (chest.chestId === 'two') throw new Error('simulated read failure')
    return { items: [], close: () => {} }
  }

  await assert.rejects(() => warehouse.syncWarehouse(16), /有 1 个读取失败.*保留全部旧记录/)
  assert.equal(calls.clear, 0)
  assert.equal(calls.reconcile, 0)
})

test('warehouse sync refuses to reconcile an empty container scan', async () => {
  const { warehouse, calls } = createWarehouse([])

  await assert.rejects(() => warehouse.syncWarehouse(16), /没有找到可读取的仓库容器.*不会生成库存异常/)
  assert.equal(calls.clear, 0)
  assert.equal(calls.reconcile, 0)
})

test('warehouse sync rescans a chest mutated by concurrent business before applying', async () => {
  const blocks = [
    { chest: { chestId: 'one', x: 1, y: 2, z: 3, blockName: 'barrel' } },
    { chest: { chestId: 'two', x: 4, y: 5, z: 6, blockName: 'barrel' } }
  ]
  const { warehouse, calls } = createWarehouse(blocks)
  const openCount = { one: 0, two: 0 }
  warehouse.openContainerAt = async chest => {
    openCount[chest.chestId]++
    if (chest.chestId === 'one') {
      // 扫描阶段读到 1 个；重读阶段读到业务变更后的 3 个
      return { items: openCount.one === 1 ? [totem(0, 1)] : [totem(0, 3)], close: () => {} }
    }
    // 扫描 chest two 时，模拟另一台 bot 正在往 chest one 存货
    if (openCount.two === 1) warehouse.noteChestMutation('one')
    return { items: [], close: () => {} }
  }

  const result = await warehouse.syncWarehouse(16)

  assert.equal(openCount.one, 2)
  assert.equal(result.rescanCount, 1)
  assert.equal(calls.clear, 1)
  assert.equal(calls.reconcile, 1)
  const oneSlots = calls.replacedSlots.find(entry => entry.chestId === 'one')
  assert.equal(oneSlots.slots[0].amount, 3)
  const total = calls.reconcileTotals.find(item => item.itemKey === 'totem')
  assert.equal(total.amount, 3)
})

test('warehouse sync keeps old inventory when the mutation rescan fails', async () => {
  const blocks = [
    { chest: { chestId: 'one', x: 1, y: 2, z: 3, blockName: 'barrel' } }
  ]
  const { warehouse, calls } = createWarehouse(blocks)
  let opens = 0
  warehouse.openContainerAt = async () => {
    opens++
    if (opens === 1) {
      // 刚读完就有业务写入该木桶
      warehouse.noteChestMutation('one')
      return { items: [totem(0, 1)], close: () => {} }
    }
    throw new Error('simulated rescan failure')
  }

  await assert.rejects(() => warehouse.syncWarehouse(16), /simulated rescan failure/)
  assert.equal(calls.clear, 0)
  assert.equal(calls.reconcile, 0)
})

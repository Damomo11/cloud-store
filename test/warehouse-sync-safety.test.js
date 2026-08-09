const test = require('node:test')
const assert = require('node:assert/strict')

const Warehouse = require('../src/warehouse')
const { DEFAULT_CONFIG } = require('../src/config')

function createWarehouse (blocks) {
  const calls = { clear: 0, reconcile: 0 }
  const db = {
    listChests: () => [{ chestId: 'old' }],
    clearChests: () => { calls.clear++ },
    upsertChest: () => {},
    replaceChestSlots: () => {},
    reconcileTotalsToMomo: () => { calls.reconcile++; return {} },
    addTransaction: () => {}
  }
  const bot = { username: 'BotA', inventory: { items: () => [] } }
  const catalog = { fromPrismarineItem: item => item.normalized }
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

  await assert.rejects(() => warehouse.syncWarehouseLocked(16), /有 1 个读取失败.*保留全部旧记录/)
  assert.equal(calls.clear, 0)
  assert.equal(calls.reconcile, 0)
})

test('warehouse sync refuses to reconcile an empty container scan', async () => {
  const { warehouse, calls } = createWarehouse([])

  await assert.rejects(() => warehouse.syncWarehouseLocked(16), /没有找到可读取的仓库容器.*不会生成库存异常/)
  assert.equal(calls.clear, 0)
  assert.equal(calls.reconcile, 0)
})

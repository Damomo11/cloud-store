const test = require('node:test')
const assert = require('node:assert/strict')
const Warehouse = require('../src/warehouse')
const { DEFAULT_CONFIG } = require('../src/config')

const TARGET = {
  itemKey: 'target-key',
  itemId: 'minecraft:white_stained_glass',
  displayName: '白色染色玻璃'
}

const STALE_BOX = {
  itemKey: 'box-stale',
  itemId: 'minecraft:shulker_box',
  displayName: '潜影盒',
  nbtJson: 'null',
  metaJson: '{}'
}

const REAL_BOX = {
  itemKey: 'box-real',
  itemId: 'minecraft:shulker_box',
  displayName: '潜影盒',
  nbtJson: 'null',
  metaJson: '{}'
}

function createFixture ({ realBoxPhysical = true, realRow = true } = {}) {
  const mismatches = []
  const fallbackQueries = []
  const slotLookups = []

  const db = {
    getItemByKey: key => {
      if (key === TARGET.itemKey) return { ...TARGET }
      if (key === STALE_BOX.itemKey) return { ...STALE_BOX }
      if (key === REAL_BOX.itemKey) return { ...REAL_BOX }
      return null
    },
    // 计划源盒（stale）没有任何木桶位置记录；回退盒有
    listSlotsForItemKey: key => {
      slotLookups.push(key)
      if (key === REAL_BOX.itemKey && realBoxPhysical) {
        return [{ chestId: 'chest-1', x: 1, y: 2, z: 3, blockName: 'barrel', slot: 0, amount: 1 }]
      }
      return []
    },
    getOwnerShulkersContainingItemKey: (ownerUuid, itemKey) => {
      fallbackQueries.push({ ownerUuid, itemKey })
      if (!realRow) return []
      return [{
        shulkerItemKey: REAL_BOX.itemKey,
        shulkerAmount: 1,
        containedAmount: 1728
      }]
    },
    getShulkerRepackRecovery: () => null,
    clearShulkerRepackRecovery: () => {},
    beginShulkerRepackRecovery: () => {},
    markShulkerRepackPhysicalChange: () => ({}),
    commitShulkerRepackRecovery: () => {},
    getBalance: (ownerUuid, key) => key === STALE_BOX.itemKey ? 1 : 0,
    hasOpenInventoryMismatch: () => false,
    addInventoryMismatch: (kind, ownerUuid, username, item, amount, note) => {
      mismatches.push({ kind, ownerUuid, username, itemKey: item.itemKey, amount, note })
    }
  }
  const catalog = {
    fromPrismarineItem: item => item.name === 'shulker_box'
      ? { ...(item.itemKeyHint === 'after' ? { ...REAL_BOX, itemKey: 'box-real-after' } : REAL_BOX) }
      : { ...TARGET },
    isShulkerBox: itemId => String(itemId).endsWith('shulker_box')
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.debug = false
  config.timing.containerSettleMs = 0

  const warehouse = new Warehouse({ username: 'BotA', inventory: { items: () => [] } }, db, catalog, config)
  warehouse.takeOneShulkerFromChest = async () => ({ name: 'shulker_box', slot: 36, count: 1 })
  warehouse.equipItemInHand = async () => {}
  warehouse.openQuickShulkerWindow = async () => ({
    inventoryStart: 27,
    inventoryEnd: 63,
    items: () => [{ slot: 0, count: 1728, name: 'glass' }],
    close: () => {}
  })
  warehouse.waitForContainerItemCount = async () => 1728
  warehouse.tryWithdrawExactFrom = async () => 64
  warehouse.waitForChangedShulkerItem = async () => ({ name: 'shulker_box', itemKeyHint: 'after', slot: 36, count: 1 })
  warehouse.verifyShulkerExtraction = () => {}
  warehouse.returnShulkerToChest = async () => ({ ...REAL_BOX })

  return { warehouse, mismatches, fallbackQueries, slotLookups }
}

const allocation = {
  ...TARGET,
  amount: 64,
  ownerUuid: 'vault:椰汁橙',
  ownerUsername: '椰汁橙',
  withdrawMode: 'shulker_extract',
  sourceShulkerItemKey: STALE_BOX.itemKey,
  sourceBoxCount: 1
}

test('planned source box without physical records falls back to another owned box', async () => {
  const { warehouse, mismatches, fallbackQueries } = createFixture()

  const result = await warehouse.withdrawFromShulkerBoxes(structuredClone(allocation))

  assert.deepEqual(fallbackQueries, [{ ownerUuid: 'vault:椰汁橙', itemKey: TARGET.itemKey }])
  assert.equal(result.withdrawn.reduce((sum, item) => sum + item.amount, 0), 64)
  assert.equal(result.missing.length, 0)
  // 漂移的计划源盒记一条 missing 异常，供 Web 管理页对账
  assert.equal(mismatches.length, 1)
  assert.equal(mismatches[0].kind, 'missing')
  assert.equal(mismatches[0].itemKey, STALE_BOX.itemKey)
  assert.equal(mismatches[0].amount, 1)
  assert.equal(mismatches[0].ownerUuid, 'vault:椰汁橙')
})

test('no physical box anywhere reports missing without throwing', async () => {
  const { warehouse, mismatches } = createFixture({ realBoxPhysical: false })

  const result = await warehouse.withdrawFromShulkerBoxes(structuredClone(allocation))

  assert.equal(result.withdrawn.length, 0)
  assert.deepEqual(result.missing.map(item => item.amount), [64])
  assert.equal(mismatches.length, 1, 'the stale planned box is still reported as mismatched')
})

test('no fallback row available still reports missing', async () => {
  const { warehouse, mismatches } = createFixture({ realRow: false })

  const result = await warehouse.withdrawFromShulkerBoxes(structuredClone(allocation))

  assert.equal(result.withdrawn.length, 0)
  assert.deepEqual(result.missing.map(item => item.amount), [64])
  assert.equal(mismatches.length, 1)
})

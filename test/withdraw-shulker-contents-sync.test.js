const test = require('node:test')
const assert = require('node:assert/strict')
const Warehouse = require('../src/warehouse')
const { DEFAULT_CONFIG } = require('../src/config')

const TARGET = {
  itemKey: 'target-key',
  itemId: 'minecraft:diamond',
  displayName: '钻石'
}

const BOX_RECORD = {
  itemKey: 'box-key',
  itemId: 'minecraft:purple_shulker_box',
  displayName: '紫色潜影盒',
  nbtJson: 'null',
  metaJson: '{}'
}

// 快捷开盒窗口里只有泥土、没有目标物品：盒子的内容记录已过期
function createFixture () {
  const upsertedItems = []
  const returnedBoxes = []
  const openCalls = []
  let windowReads = 0

  const boxHeldItem = {
    name: 'purple_shulker_box',
    slot: 36,
    count: 1
  }

  const db = {
    getItemByKey: key => {
      if (key === TARGET.itemKey) return { ...TARGET }
      if (key === 'box-key') return { ...BOX_RECORD }
      return null
    },
    listSlotsForItemKey: () => [
      { chestId: 'chest-1', x: 1, y: 2, z: 3, blockName: 'barrel', slot: 0, amount: 3, itemKey: 'box-key' }
    ],
    upsertItem: item => upsertedItems.push(item),
    getShulkerRepackRecovery: () => null,
    clearShulkerRepackRecovery: () => {}
  }
  const catalog = {
    fromPrismarineItem: item => item.name === 'purple_shulker_box'
      ? {
          itemKey: 'box-key',
          itemId: 'minecraft:purple_shulker_box',
          displayName: '紫色潜影盒',
          nbtJson: item.nbtJson ?? 'null',
          metaJson: item.metaJson ?? '{"components":{"minecraft:container":{"contents":[]}}}'
        }
      : { itemKey: 'other-key', itemId: 'minecraft:dirt', displayName: '泥土', nbtJson: '', metaJson: '{}' },
    isShulkerBox: itemId => String(itemId).endsWith('shulker_box')
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.debug = false
  config.timing.containerSettleMs = 0

  const warehouse = new Warehouse({ username: 'BotA' }, db, catalog, config)
  warehouse.takeOneShulkerFromChest = async () => ({ ...boxHeldItem })
  warehouse.equipItemInHand = async () => {}
  warehouse.openQuickShulkerWindow = async () => {
    openCalls.push(1)
    return {
      inventoryStart: 27,
      inventoryEnd: 63,
      items: () => [{ slot: 0, count: 9, name: 'dirt' }],
      close: () => {}
    }
  }
  warehouse.waitForContainerItemCount = async () => {
    windowReads++
    return 0
  }
  warehouse.tryWithdrawExactFrom = async () => 0
  warehouse.findInventoryItemByKey = () => ({ ...boxHeldItem })
  warehouse.returnShulkerToChest = async (chest, item) => {
    returnedBoxes.push(item)
    return { ...BOX_RECORD }
  }

  return { warehouse, upsertedItems, returnedBoxes, openCalls, getWindowReads: () => windowReads }
}

test('box without the target item is re-indexed from the held box NBT and skipped', async () => {
  const fixture = createFixture()

  const result = await fixture.warehouse.withdrawFromShulkerBoxes({
    ...TARGET,
    amount: 10,
    ownerUuid: 'owner-1',
    withdrawMode: 'shulker_extract',
    sourceShulkerItemKey: 'box-key',
    sourceBoxCount: 1
  })

  assert.equal(fixture.getWindowReads(), 3, 'the empty window is retried before giving up on the box')
  assert.equal(fixture.upsertedItems.length, 1, 'the box contents record is rebuilt from the held box NBT')
  assert.equal(fixture.upsertedItems[0].itemKey, 'box-key')
  assert.equal(fixture.returnedBoxes.length, 1, 'the box is put back into the chest')
  assert.equal(result.withdrawn.length, 0)
  assert.deepEqual(result.missing.map(item => item.amount), [10], 'the shortfall is reported as missing')
})

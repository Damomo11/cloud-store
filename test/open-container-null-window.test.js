const test = require('node:test')
const assert = require('node:assert/strict')
const Warehouse = require('../src/warehouse')
const { DEFAULT_CONFIG } = require('../src/config')

function createWarehouse (openContainerImpl) {
  const block = {
    name: 'barrel',
    position: {
      x: 1, y: 2, z: 3,
      plus: () => ({ x: 1, y: 2, z: 4 }),
      offset: (x, y, z) => ({ x: 1 + x, y: 2 + y, z: 3 + z })
    }
  }
  const openCalls = []
  const bot = {
    username: 'BotA',
    entity: { position: { x: 1.5, y: 2, z: 4.5, distanceTo: () => 2 } },
    blockAt: pos => (pos.x === 1 && pos.y === 2 && pos.z === 3) ? block : null,
    currentWindow: null,
    openContainer: async (...args) => {
      openCalls.push(1)
      return openContainerImpl(...args)
    }
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.debug = false
  config.timing.containerSettleMs = 0

  const warehouse = new Warehouse(bot, {}, {}, config)
  warehouse.assertConnectionHealthy = () => {}
  warehouse.gotoForContainer = async () => {}
  warehouse.lookAtBlock = async () => {}
  warehouse.ensureSafeHandForContainerOpen = () => {}
  return { warehouse, block, getOpenCalls: () => openCalls.length }
}

test('a null window from bot.openContainer is retried and reported as a clear open failure', async () => {
  const { warehouse, block, getOpenCalls } = createWarehouse(async () => null)

  await assert.rejects(
    warehouse.openContainerAt({ chestId: '1,2,3', x: 1, y: 2, z: 3, blockName: 'barrel' }),
    /打开箱子后没有收到窗口/
  )

  assert.equal(getOpenCalls(), Math.max(1, Number(DEFAULT_CONFIG.timing.openContainerAttempts ?? 3)),
    'the empty-window open failure must exhaust the normal retry budget')
  assert.ok(block.name)
})

test('a real window from bot.openContainer is returned untouched', async () => {
  const window = { inventoryStart: 27, inventoryEnd: 63, items: () => [], close: () => {} }
  const { warehouse, getOpenCalls } = createWarehouse(async () => window)

  const container = await warehouse.openContainerAt({ chestId: '1,2,3', x: 1, y: 2, z: 3, blockName: 'barrel' })

  assert.equal(container, window)
  assert.equal(getOpenCalls(), 1)
})

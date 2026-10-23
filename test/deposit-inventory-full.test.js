const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

function stone (amount) {
  return { itemKey: 'minecraft:stone|plain', itemId: 'minecraft:stone', displayName: '石头', amount }
}

function createFixture ({ emptySlotCount = 36, depositResult } = {}) {
  const said = []
  const deposits = []
  const teleports = []
  const bot = {
    username: 'BotA',
    players: {},
    entities: {},
    chat: text => said.push(text),
    entity: { position: null },
    inventory: {
      items: () => [],
      emptySlotCount: () => emptySlotCount
    }
  }
  const db = {
    addCommandReply: () => {},
    saveRecoveryTask: () => {},
    clearRecoveryTask: () => {},
    getRecoveryTask: () => null,
    addTransaction: () => {}
  }
  const warehouse = {
    attachTrace: () => {},
    detachTrace: () => {},
    goHomeIfAway: async () => {},
    goHome: async () => {},
    // 模拟真实循环：进来先问一次是否该停。
    collectNearbyDropsUntil: async (deadline, shouldStop) => {
      if (typeof shouldStop === 'function') shouldStop()
    },
    waitForPickupSettle: async () => {},
    depositInventoryForOwner: async (ownerUuid, ownerName) => {
      deposits.push({ ownerUuid, ownerName })
      return depositResult || { deposited: [], leftover: [], stopReason: '' }
    }
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.debug = false
  config.debugChat = false
  config.timing.pickupWindowMs = 10
  const service = new CloudStoreService(bot, db, { aggregatePrismarineItems: () => [] }, warehouse, config)
  // 模拟 runExclusive 挂上的任务上下文
  service.active = { type: 'deposit', phase: '', cancelled: false }
  service.getPlayer = () => ({ uuid: 'uuid-alice', username: 'Alice', scope: 'personal' })
  service.getStorageQuota = () => ({ usedSlots: 0, quotaSlots: 270 })
  service.teleportToPlayer = async () => {
    teleports.push(teleports.length)
    return true
  }
  return { service, said, deposits, teleports }
}

test('collecting stops early with inventory_full when the backpack has no empty slot', async () => {
  const { service, said, deposits, teleports } = createFixture({
    emptySlotCount: 0,
    depositResult: { deposited: [stone(64)], leftover: [], stopReason: '' }
  })

  await service.handleDeposit('Alice', { uuid: 'uuid-alice', username: 'Alice', scope: 'personal' })

  assert.equal(service.active.depositStopReason, 'inventory_full', '与玩家远离同级的提前结束标记')
  assert.equal(teleports.length, 1, '不往返：只有最初传送到玩家这一次')
  assert.equal(deposits.length, 1, '提前结束后直接回仓入库一次')
  assert.ok(said.some(text => text.includes('存入完成')), '玩家照常收到存入反馈')
})

test('collecting with free slots keeps the original behavior', async () => {
  const { service, deposits, teleports } = createFixture({
    emptySlotCount: 18,
    depositResult: { deposited: [stone(4)], leftover: [], stopReason: '' }
  })

  await service.handleDeposit('Alice', { uuid: 'uuid-alice', username: 'Alice', scope: 'personal' })

  assert.equal(service.active.depositStopReason, undefined, '背包没满不会提前结束')
  assert.equal(teleports.length, 1)
  assert.equal(deposits.length, 1)
})

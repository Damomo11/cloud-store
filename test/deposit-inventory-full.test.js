const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

function stone (amount) {
  return { itemKey: 'minecraft:stone|plain', itemId: 'minecraft:stone', displayName: '石头', amount }
}

function dirt (amount) {
  return { itemKey: 'minecraft:dirt|plain', itemId: 'minecraft:dirt', displayName: '泥土', amount }
}

function createFixture ({ emptySlots = [0, 36], depositResults = [], teleportResults = [true, true] } = {}) {
  const said = []
  const deposits = []
  const teleports = []
  const momoResidual = []
  const bot = {
    username: 'BotA',
    players: {},
    entities: {},
    chat: text => said.push(text),
    entity: { position: null },
    inventory: {
      items: () => [],
      emptySlotCount: () => (emptySlots.length ? emptySlots.shift() : 36)
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
    // 模拟真实循环：进来先问一次是否该停（用来触发背包满的提前结束）。
    collectNearbyDropsUntil: async (deadline, shouldStop) => {
      if (typeof shouldStop === 'function') shouldStop()
    },
    waitForPickupSettle: async () => {},
    depositInventoryForOwner: async (ownerUuid, ownerName) => {
      deposits.push({ ownerUuid, ownerName })
      return depositResults.length
        ? depositResults.shift()
        : { deposited: [], leftover: [], stopReason: '' }
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
    return teleportResults.length ? teleportResults.shift() : true
  }
  service.accountResidualAsMomo = items => momoResidual.push(items)
  return { service, said, deposits, teleports, momoResidual }
}

test('full inventory at the player triggers an early warehouse run, then collecting resumes', async () => {
  const { service, said, deposits, teleports } = createFixture({
    emptySlots: [0, 36],
    depositResults: [
      { deposited: [stone(36)], leftover: [], stopReason: '' },
      { deposited: [stone(5)], leftover: [], stopReason: '' }
    ],
    teleportResults: [true, true]
  })

  await service.handleDeposit('Alice', { uuid: 'uuid-alice', username: 'Alice', scope: 'personal' })

  assert.equal(teleports.length, 2, '腾包后要传送回玩家身边继续收集')
  assert.equal(deposits.length, 2, '腾包入库一次 + 终轮入库一次')
  assert.ok(said.some(text => text.includes('背包已满')), '要告知玩家先回仓入库')
  assert.ok(said.some(text => text.includes('已先存入')), '腾包入库结果要先反馈')
  assert.ok(said.some(text => text.includes('存入完成')), '终轮照常反馈存入结果')
})

test('warehouse full after the flush ends the task without returning to the player', async () => {
  const { service, said, deposits, teleports, momoResidual } = createFixture({
    emptySlots: [0, 36],
    depositResults: [
      { deposited: [stone(5)], leftover: [dirt(3)], stopReason: '仓库空间不足' }
    ],
    teleportResults: [true]
  })

  await service.handleDeposit('Alice', { uuid: 'uuid-alice', username: 'Alice', scope: 'personal' })

  assert.equal(teleports.length, 1, '仓库已满，回去也腾不出背包，不再传送')
  assert.equal(deposits.length, 1, '直接用腾包入库结果收尾，不重复入库')
  assert.equal(momoResidual.length, 1, '入库剩余物品转记 momo')
  assert.deepEqual(momoResidual[0].map(item => item.amount), [3])
  assert.ok(said.some(text => text.includes('转记为 momo')))
})

test('failed return teleport finalizes with the flushed result', async () => {
  const { service, said, deposits, teleports } = createFixture({
    emptySlots: [0, 36],
    depositResults: [
      { deposited: [stone(8)], leftover: [], stopReason: '' }
    ],
    teleportResults: [true, false]
  })

  await service.handleDeposit('Alice', { uuid: 'uuid-alice', username: 'Alice', scope: 'personal' })

  assert.equal(teleports.length, 2, '腾包后尝试传送回去')
  assert.equal(deposits.length, 1, '传送失败不再入库，直接用腾包结果收尾')
  assert.ok(said.some(text => text.includes('存入完成')), '玩家仍能收到存入反馈')
})

test('normal deposit without inventory pressure keeps the single round-trip behavior', async () => {
  const { service, deposits, teleports } = createFixture({
    emptySlots: [36],
    depositResults: [
      { deposited: [stone(4)], leftover: [], stopReason: '' }
    ],
    teleportResults: [true]
  })

  await service.handleDeposit('Alice', { uuid: 'uuid-alice', username: 'Alice', scope: 'personal' })

  assert.equal(teleports.length, 1)
  assert.equal(deposits.length, 1, '背包没满就只有终轮一次入库')
})

const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

function createFixture (withdrawAmounts, options = {}) {
  const item = {
    itemKey: 'minecraft:stone|plain',
    itemId: 'minecraft:stone',
    displayName: '石头'
  }
  const allocation = {
    ...item,
    amount: 10,
    ownerUuid: 'vault-1',
    ownerUsername: 'Vault',
    ownerScope: 'custom',
    ownerVaultName: '测试仓库'
  }
  let inventory = []
  let withdrawCalls = 0
  let teleportCalls = 0
  const depositCalls = []
  const deductMissingCalls = []
  const syncCalls = []
  const dropRequests = []
  const balanceChanges = []
  const sent = []

  const bot = {
    username: 'BotA',
    players: { Alice: { uuid: 'uuid-alice' } },
    inventory: { items: () => inventory },
    chat: message => sent.push(message)
  }
  const db = {
    upsertPlayer: () => {},
    currentCommandLogId: () => 1,
    addCommandReply: () => {},
    runWithCommandContext: (commandLogId, fn) => fn(),
    runWithBotContext: (botContext, fn) => fn(),
    getRecoveryTask: () => null,
    reserveInventory: () => {},
    releaseInventoryReservation: () => {},
    saveRecoveryTask: () => {},
    clearRecoveryTask: () => {},
    transaction: fn => fn(),
    getItemByKey: itemKey => itemKey === item.itemKey
      ? { ...item, nbtJson: 'null', metaJson: '{"components":null,"metadata":null}' }
      : null,
    upsertItem: () => {},
    adjustBalance: (ownerUuid, itemKey, amount) => balanceChanges.push({ ownerUuid, itemKey, amount }),
    addTransaction: () => {},
    deductConfirmedMissing: (ownerUuid, username, items, note) => {
      deductMissingCalls.push({ ownerUuid, username, items, note })
      return items.map(entry => ({ itemKey: entry.itemKey, requested: entry.amount, deducted: entry.amount }))
    }
  }
  const catalog = {
    aggregatePrismarineItems: items => items.map(entry => ({
      ...item,
      amount: Number(entry.count ?? entry.amount ?? 0)
    })),
    getStackSize: () => 64,
    getDisplayName: () => item.displayName,
    fromPrismarineItem: entry => ({ ...item, amount: entry.count })
  }
  const warehouse = {
    goHomeIfAway: async () => {},
    goHome: async () => {},
    withdrawAllocations: async () => {
      const amount = withdrawAmounts[Math.min(withdrawCalls, withdrawAmounts.length - 1)]
      withdrawCalls++
      inventory = amount > 0 ? [{ ...item, count: amount }] : []
      if (options.unlocatedMissing && amount === 0) {
        return {
          withdrawn: [],
          missing: [{ ...item, amount: 10 }],
          unlocated: [{ ...item, amount: 10 }],
          searchedUnlocatedBarrels: options.searchedBarrels ?? 0
        }
      }
      if (options.missingOnZero && amount === 0) {
        return { withdrawn: [], missing: [{ ...item, amount: 10 }], unlocated: [] }
      }
      return { withdrawn: amount > 0 ? [{ ...item, amount }] : [], missing: [] }
    },
    depositInventoryWithoutBalance: async type => {
      depositCalls.push(type)
      if (type === 'withdraw_failed_return' && options.failedReturnLeftover) {
        return { deposited: [], leftover: options.failedReturnLeftover }
      }
      const deposited = catalog.aggregatePrismarineItems(inventory)
      inventory = []
      return { deposited, leftover: [] }
    },
    syncWarehouse: async radius => {
      syncCalls.push(radius)
      return { unresolved: [], addedToMomo: [], removedFromMomo: [] }
    },
    dropItemsToPlayer: async (username, requested) => {
      dropRequests.push({ username, requested })
      const dropped = requested.map(entry => ({ ...entry }))
      const requestedByKey = new Map(requested.map(entry => [entry.itemKey, entry.amount]))
      inventory = inventory
        .map(entry => ({ ...entry, count: entry.count - Number(requestedByKey.get(entry.itemKey) || 0) }))
        .filter(entry => entry.count > 0)
      return dropped
    }
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.commands.msg = '/msg {player} {message}'
  config.timing.containerSettleMs = 0
  config.debugChat = false

  const service = new CloudStoreService(bot, db, catalog, warehouse, config)
  service.buildWithdrawPlanForRequest = () => ({ notices: [], allocations: [allocation] })
  service.teleportToPlayer = async () => {
    teleportCalls++
    return true
  }

  return {
    service,
    allocation,
    item,
    depositCalls,
    dropRequests,
    balanceChanges,
    syncCalls,
    deductMissingCalls,
    sent,
    getWithdrawCalls: () => withdrawCalls,
    getTeleportCalls: () => teleportCalls
  }
}

const owner = { uuid: 'vault-1', username: 'Vault', scope: 'custom', vaultName: '测试仓库' }
const request = [{
  itemId: 'minecraft:stone',
  displayName: '石头',
  amount: 10
}]

test('empty physical withdrawal retries immediately on refreshed barrel records', async () => {
  const fixture = createFixture([0, 10])

  await fixture.service.handleWithdraw('Alice', '', owner, request)

  assert.equal(fixture.getWithdrawCalls(), 2)
  assert.deepEqual(fixture.syncCalls, [], 'full warehouse sync must not run in the withdraw path')
  assert.equal(fixture.getTeleportCalls(), 1)
  assert.equal(fixture.depositCalls.filter(type => type === 'withdraw_failed_return').length, 1)
  assert.ok(fixture.sent.some(message => message.includes('已逐个木桶核对实际库存')))
  assert.ok(fixture.sent.some(message => message.includes('取货完成：1种物品，共10个。')))
  assert.deepEqual(fixture.balanceChanges, [{
    ownerUuid: 'vault-1',
    itemKey: fixture.item.itemKey,
    amount: -10
  }])
})

test('retry after barrel recheck still failing reports shortage for later retry', async () => {
  const fixture = createFixture([0, 0])

  await fixture.service.handleWithdraw('Alice', '', owner, request)

  assert.equal(fixture.getWithdrawCalls(), 2)
  assert.equal(fixture.syncCalls.length, 0)
  const finalMessage = fixture.sent.find(message => message.includes('账本有库存，但按本地木桶记录没有取出'))
  assert.ok(finalMessage)
  assert.ok(finalMessage.includes('已就地核对各木桶并重试仍未取到'))
  assert.ok(finalMessage.includes('账本已按实物自动修正并登记异常'))
  assert.ok(!finalMessage.includes('请管理员执行 !同步'))
  assert.deepEqual(fixture.balanceChanges, [])
  assert.deepEqual(fixture.deductMissingCalls, [], '该场景桩未产生 missing，不应触发自动修账')
})

test('confirmed shortage after the recheck retry is auto-reconciled on the spot', async () => {
  const fixture = createFixture([0, 0], { missingOnZero: true })

  await fixture.service.handleWithdraw('Alice', '', owner, request)

  assert.equal(fixture.getWithdrawCalls(), 2)
  assert.equal(fixture.deductMissingCalls.length, 1, '任务收尾自动修账一次')
  const call = fixture.deductMissingCalls[0]
  assert.equal(call.ownerUuid, 'vault-1')
  assert.deepEqual(call.items.map(entry => entry.amount), [10])
  assert.ok(fixture.sent.some(message => message.includes('账本已按实物自动修正并登记异常')))
})

test('items that cannot be returned to chests skip the retry', async () => {
  const fixture = createFixture([0, 10], {
    failedReturnLeftover: [{ ...fixtureItem(), amount: 5 }]
  })

  await fixture.service.handleWithdraw('Alice', '', owner, request)

  assert.equal(fixture.getWithdrawCalls(), 1)
  assert.equal(fixture.syncCalls.length, 0)
  const finalMessage = fixture.sent.find(message => message.includes('账本有库存，但按本地木桶记录没有取出'))
  assert.ok(finalMessage)
  assert.ok(fixture.sent.some(message => message.includes('机器人身上仍有未能放回仓库的物品')))
  assert.deepEqual(fixture.balanceChanges, [])
})

test('fully unlocated missing searches barrels, skips the recheck retry and leaves residual in the bag', async () => {
  const fixture = createFixture([0], { unlocatedMissing: true, searchedBarrels: 5 })

  await fixture.service.handleWithdraw('Alice', '', owner, request)

  assert.equal(fixture.getWithdrawCalls(), 1, 'no second round when nothing has a barrel record')
  assert.equal(fixture.syncCalls.length, 0)
  assert.equal(
    fixture.depositCalls.filter(type => type === 'withdraw_failed_return').length,
    0,
    'residual items must stay in the bot inventory, not be deposited'
  )
  const finalMessage = fixture.sent.find(message => message.includes('已逐个打开'))
  assert.ok(finalMessage, 'the player is told how many barrels were searched')
  assert.ok(finalMessage.includes('5 个木桶'))
  assert.ok(finalMessage.includes('已自动同步账本'), '缺口当场修账，不再要求管理员 !同步')
  assert.deepEqual(fixture.balanceChanges, [], 'nothing is deducted')
  assert.equal(fixture.deductMissingCalls.length, 1, 'unlocated 缺口确认后自动修账')
  assert.deepEqual(fixture.deductMissingCalls[0].items.map(entry => entry.amount), [10])
})

function fixtureItem () {
  return {
    itemKey: 'minecraft:stone|plain',
    itemId: 'minecraft:stone',
    displayName: '石头'
  }
}

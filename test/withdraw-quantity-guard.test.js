const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

function createFixture (withdrawAmounts) {
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
  let teleportResult = true
  const depositCalls = []
  const dropRequests = []
  const balanceChanges = []
  const upsertedItems = []
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
    upsertItem: entry => {
      assert.notEqual(entry.nbtJson, undefined)
      assert.notEqual(entry.metaJson, undefined)
      upsertedItems.push(entry)
    },
    adjustBalance: (ownerUuid, itemKey, amount) => balanceChanges.push({ ownerUuid, itemKey, amount }),
    addTransaction: () => {}
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
      return { withdrawn: amount > 0 ? [{ ...item, amount }] : [], missing: [] }
    },
    depositInventoryWithoutBalance: async type => {
      depositCalls.push(type)
      const deposited = catalog.aggregatePrismarineItems(inventory)
      inventory = []
      return { deposited, leftover: [] }
    },
    dropItemsToPlayer: async (username, requested) => {
      dropRequests.push({ username, requested })
      const dropped = requested.map(entry => ({ ...entry }))
      const requestedByKey = new Map(requested.map(entry => [entry.itemKey, entry.amount]))
      inventory = inventory
        .map(entry => ({ ...entry, count: entry.count - Number(requestedByKey.get(entry.itemKey) || 0) }))
        .filter(entry => entry.count > 0)
      return dropped
    },
    repairPlayerWithExperienceBottles: async () => {
      const used = catalog.aggregatePrismarineItems(inventory)
      inventory = []
      return used
    },
    dropInventoryToPlayer: async () => {
      throw new Error('full inventory delivery must not be used')
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
    return teleportResult
  }

  return {
    service,
    allocation,
    depositCalls,
    dropRequests,
    balanceChanges,
    upsertedItems,
    sent,
    setTeleportResult: result => {
      teleportResult = result
    },
    getWithdrawCalls: () => withdrawCalls,
    getTeleportCalls: () => teleportCalls
  }
}

test('over-withdrawn loose stack is returned and only the requested amount is delivered', async () => {
  const fixture = createFixture([64, 10])
  const owner = { uuid: 'vault-1', username: 'Vault', scope: 'custom', vaultName: '测试仓库' }

  await fixture.service.handleWithdraw('Alice', '', owner, [{
    itemId: 'minecraft:stone',
    displayName: '石头',
    amount: 10
  }])

  assert.equal(fixture.getWithdrawCalls(), 2)
  assert.equal(fixture.getTeleportCalls(), 1)
  assert.equal(fixture.depositCalls.filter(type => type === 'withdraw_overage_return').length, 1)
  assert.equal(fixture.dropRequests.length, 1)
  assert.equal(fixture.dropRequests[0].requested[0].amount, 10)
  assert.deepEqual(fixture.balanceChanges, [{
    ownerUuid: 'vault-1',
    itemKey: fixture.allocation.itemKey,
    amount: -10
  }])
  assert.equal(fixture.upsertedItems[0].nbtJson, 'null')
  assert.equal(fixture.upsertedItems[0].metaJson, '{"components":null,"metadata":null}')
})

test('delivery result is sent to both recipient and actor when withdrawing for another player', async () => {
  const fixture = createFixture([10])
  const owner = { uuid: 'vault-1', username: 'Vault', scope: 'custom', vaultName: '测试仓库' }

  await fixture.service.handleWithdraw('Alice', '', owner, [{
    itemId: 'minecraft:stone',
    displayName: '石头',
    amount: 10
  }], 'Bob')

  assert.ok(fixture.sent.includes('/msg Bob Alice 给你的取货已送达：1种物品，共10个。'))
  assert.ok(fixture.sent.includes('/msg Alice 给 Bob 的取货已送达：1种物品，共10个。'))
})

test('self-withdraw sends only one final result', async () => {
  const fixture = createFixture([10])
  const owner = { uuid: 'vault-1', username: 'Vault', scope: 'custom', vaultName: '测试仓库' }

  await fixture.service.handleWithdraw('Alice', '', owner, [{
    itemId: 'minecraft:stone',
    displayName: '石头',
    amount: 10
  }])

  assert.equal(fixture.sent.filter(message => message.includes('取货完成')).length, 1)
  assert.equal(fixture.sent.filter(message => message.includes('取货已送达')).length, 0)
})

test('actor is told when recipient does not accept the teleport request', async () => {
  const fixture = createFixture([10])
  const owner = { uuid: 'vault-1', username: 'Vault', scope: 'custom', vaultName: '测试仓库' }
  fixture.setTeleportResult(false)

  await fixture.service.handleWithdraw('Alice', '', owner, [{
    itemId: 'minecraft:stone',
    displayName: '石头',
    amount: 10
  }], 'Bob')

  assert.ok(fixture.sent.includes('/msg Alice 给 Bob 的取货已取消：对方未接受传送请求。'))
})

test('actor and recipient are both told when requested inventory is unavailable', async () => {
  const fixture = createFixture([0])
  const owner = { uuid: 'vault-1', username: 'Vault', scope: 'custom', vaultName: '测试仓库' }
  fixture.service.buildWithdrawPlanForRequest = () => ({ notices: [], allocations: [] })

  await fixture.service.handleWithdraw('Alice', '', owner, [{
    itemId: 'minecraft:stone',
    displayName: '石头',
    amount: 10
  }], 'Bob')

  assert.ok(fixture.sent.includes('/msg Bob Alice 想给你取物品，但仓库没有可取出的物品。'))
  assert.ok(fixture.sent.includes('/msg Alice 给 Bob 的取货失败：仓库没有可取出的物品。'))
})

test('repair result is sent to both recipient and actor', async () => {
  const fixture = createFixture([10])
  const owner = { uuid: 'vault-1', username: 'Vault', scope: 'custom', vaultName: '测试仓库' }

  await fixture.service.handleWithdraw('Alice', '', owner, [{
    itemId: 'minecraft:experience_bottle',
    displayName: '附魔之瓶',
    amount: 10
  }], 'Bob', { deliveryMode: 'repair' })

  assert.ok(fixture.sent.some(message => message.startsWith('/msg Bob Alice 给你修装备已完成：共用了 10 个')))
  assert.ok(fixture.sent.some(message => message.startsWith('/msg Alice 给 Bob 修装备已完成：共用了 10 个')))
})

test('generic delegated-withdraw error is sent to both recipient and actor', async () => {
  const fixture = createFixture([10])
  const error = new Error('测试异常')
  error.commandContext = {
    type: 'withdraw',
    targetUsername: 'Bob',
    deliveryMode: 'drop'
  }

  fixture.service.handleCommandError('Alice', error)

  assert.ok(fixture.sent.includes('/msg Bob Alice 给你的取货失败：测试异常'))
  assert.ok(fixture.sent.includes('/msg Alice 给 Bob 的取货失败：测试异常'))
})

test('repeated over-withdraw aborts before teleporting or delivering items', async () => {
  const fixture = createFixture([64, 64])
  const owner = { uuid: 'vault-1', username: 'Vault', scope: 'custom', vaultName: '测试仓库' }

  await assert.rejects(
    fixture.service.handleWithdraw('Alice', '', owner, [{
      itemId: 'minecraft:stone',
      displayName: '石头',
      amount: 10
    }]),
    /散装取货数量连续异常/
  )

  assert.equal(fixture.getWithdrawCalls(), 2)
  assert.equal(fixture.getTeleportCalls(), 0)
  assert.equal(fixture.dropRequests.length, 0)
  assert.equal(fixture.depositCalls.filter(type => type === 'withdraw_overage_return').length, 2)
  assert.deepEqual(fixture.balanceChanges, [])
})

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
  const depositCalls = []
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
    reserveInventory: () => {},
    saveRecoveryTask: () => {},
    clearRecoveryTask: () => {},
    transaction: fn => fn(),
    upsertItem: () => {},
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
    return true
  }

  return {
    service,
    allocation,
    depositCalls,
    dropRequests,
    balanceChanges,
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

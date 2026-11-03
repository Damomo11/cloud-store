const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

function createFixture () {
  const items = new Map([
    ['minecraft:oak_planks|plain', {
      itemKey: 'minecraft:oak_planks|plain', itemId: 'minecraft:oak_planks', displayName: '橡木板'
    }],
    ['minecraft:stick|plain', {
      itemKey: 'minecraft:stick|plain', itemId: 'minecraft:stick', displayName: '木棍'
    }]
  ])
  const calls = { reservations: 0, balances: 0 }
  const db = {
    canWebUserAccessOwner: () => true,
    getCustomWarehouse: () => null,
    getItemByKey: itemKey => items.get(itemKey) || null,
    reserveInventory: () => { calls.reservations++ },
    adjustBalance: () => { calls.balances++ }
  }
  const catalog = {
    getDisplayName: itemId => items.get(`${itemId}|plain`)?.displayName || itemId,
    resolveName: name => {
      const item = [...items.values()].find(entry => entry.itemId === name || entry.displayName === name)
      if (!item) throw new Error(`unknown item ${name}`)
      return item
    }
  }
  const bot = { username: 'BotA', players: {}, chat: () => {} }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  const service = new CloudStoreService(bot, db, catalog, {}, config)
  service.craftLedger = () => ({
    getCraftAvailableItems: () => [{
      ownerUuid: 'uuid-alice', itemKey: 'minecraft:oak_planks|plain',
      itemId: 'minecraft:oak_planks', displayName: '橡木板', amount: 2
    }]
  })
  service.buildWithdrawPlanForRequest = (player, owner, requests) => ({
    notices: [],
    allocations: requests
      .filter(request => request.requestIndex === 0)
      .map(request => ({
        ...request,
        amount: 2,
        ownerUuid: owner.uuid,
        ownerScope: owner.scope,
        itemKey: request.itemKey
      }))
  })
  return { service, calls }
}

test('previewWithdrawShortage returns direct allocations and craft candidates without mutations', () => {
  const { service, calls } = createFixture()
  const result = service.previewWithdrawShortage(
    { uuid: 'uuid-alice', username: 'Alice' },
    'uuid-alice',
    [
      { itemKey: 'minecraft:stick|plain', amount: 4 },
      { itemKey: 'minecraft:oak_planks|plain', amount: 2 }
    ]
  )

  assert.equal(result.allocations.length, 1)
  assert.equal(result.shortages[0].itemId, 'minecraft:stick')
  assert.equal(result.shortages[0].missing, 2)
  assert.equal(result.craft[0].status, 'planned')
  assert.equal(calls.reservations, 0)
  assert.equal(calls.balances, 0)
})

test('shortage craft stock excludes an exact item key consumed by direct allocation', () => {
  const { service } = createFixture()
  service.buildWithdrawPlanForRequest = (player, owner, requests) => ({
    notices: [],
    allocations: [{
      ...requests[0], amount: 2, ownerUuid: owner.uuid, ownerScope: owner.scope
    }]
  })
  const result = service.previewWithdrawShortage(
    { uuid: 'uuid-alice', username: 'Alice' },
    'uuid-alice',
    [
      { itemKey: 'minecraft:oak_planks|plain', amount: 2 },
      { itemKey: 'minecraft:stick|plain', amount: 4 }
    ]
  )

  assert.equal(result.shortages[0].itemId, 'minecraft:stick')
  assert.equal(result.craft[0].status, 'unavailable')
  assert.equal(result.craft[0].reason, 'needs_collection')
})

test('post-reservation planning does not subtract the same allocation twice', () => {
  const { service } = createFixture()
  const requests = [{
    itemKey: 'minecraft:stick|plain', itemId: 'minecraft:stick', displayName: '木棍', amount: 4, requestIndex: 0
  }]
  const allocations = [{
    itemKey: 'minecraft:stick|plain', itemId: 'minecraft:stick', amount: 2,
    requestIndex: 0, ownerUuid: 'uuid-alice', ownerScope: 'personal'
  }]

  const result = service.buildShortageCraftPlan(
    { uuid: 'uuid-alice', username: 'Alice', scope: 'personal' },
    requests,
    allocations,
    { reservationsAlreadyApplied: true }
  )

  assert.equal(result.craft[0].status, 'planned')
})

test('empty withdraw plans still return craft candidates for the full shortage', async () => {
  const { service, calls } = createFixture()
  service.warehouse = { goHomeIfAway: async () => {} }
  service.flushResidual = async () => {}
  service.msg = () => {}
  service.buildWithdrawPlanForRequest = () => ({ notices: [], allocations: [] })

  const result = await service.runWithdrawFlow({
    username: 'Alice',
    player: { uuid: 'uuid-alice', username: 'Alice' },
    storageOwner: { uuid: 'uuid-alice', username: 'Alice', scope: 'personal' },
    requests: [{ itemId: 'minecraft:stick', displayName: '木棍', amount: 4 }],
    deliveryTarget: 'Alice',
    deliveryToOther: false,
    deliveryMode: 'drop',
    continueWithDeposit: false,
    trace: null
  })

  assert.equal(result.status, 'empty_plan')
  assert.equal(result.shortagePlan.shortages[0].missing, 4)
  assert.equal(result.shortagePlan.craft[0].status, 'planned')
  assert.equal(calls.reservations, 0)
  assert.equal(calls.balances, 0)
})

test('preview uses the database craft snapshot without lazily creating a craft ledger', () => {
  const { service } = createFixture()
  service.db.getCraftAvailableItems = () => [{
    ownerUuid: 'uuid-alice', itemKey: 'minecraft:oak_planks|plain',
    itemId: 'minecraft:oak_planks', displayName: '橡木板', amount: 2
  }]
  service.craftLedger = () => {
    throw new Error('preview must not initialize CraftLedger')
  }

  const result = service.previewWithdrawShortage(
    { uuid: 'uuid-alice', username: 'Alice' },
    'uuid-alice',
    [{ itemKey: 'minecraft:stick|plain', amount: 4 }]
  )

  assert.equal(result.craft[0].status, 'planned')
})

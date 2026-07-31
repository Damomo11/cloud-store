const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

function createFixture () {
  const items = [
    enchantedBook('durability-1', '耐久一', '耐久', 1),
    enchantedBook('durability-3', '耐久三', '耐久', 3),
    enchantedBook('durability-5', '耐久五', '耐久', 5),
    enchantedBook('efficiency-5', '效率五', '效率', 5)
  ]
  const looseStock = new Map()
  const shulkerStock = new Set()
  const customWarehouses = []
  const ordinary = new Map([
    ['石头', { itemId: 'minecraft:stone', displayName: '石头' }],
    ['绿宝石', { itemId: 'minecraft:emerald', displayName: '绿宝石' }],
    ['钻石', { itemId: 'minecraft:diamond', displayName: '钻石' }]
  ])
  const db = {
    findItemByPlayerAlias: () => null,
    findItemByGlobalAlias: () => null,
    isGlobalItemAliasDisabled: () => false,
    findItemsByDisplayQuery: query => items.filter(item => item.displayName.includes(query)),
    getOwnerItemsByItemKey: (ownerUuid, itemKey) => {
      const amount = looseStock.get(`${ownerUuid}:${itemKey}`) || 0
      const item = items.find(entry => entry.itemKey === itemKey)
      return amount > 0 ? [{ ...item, amount }] : []
    },
    getOwnerShulkersContainingItemKey: (ownerUuid, itemKey) => (
      shulkerStock.has(`${ownerUuid}:${itemKey}`) ? [{ shulkerItemKey: 'box-1' }] : []
    ),
    listCustomWarehousesForPlayer: () => customWarehouses
  }
  const catalog = {
    resolveName: name => {
      const item = ordinary.get(name)
      if (!item) throw new Error(`未知物品：${name}`)
      return item
    },
    parseStoredJson: text => JSON.parse(text),
    extractEnchantments: components => components.enchantments || []
  }
  const bot = { username: 'BotA', players: {}, chat: () => {} }
  const config = structuredClone(DEFAULT_CONFIG)
  const service = new CloudStoreService(bot, db, catalog, {}, config)
  const owner = { uuid: 'vault:test', username: '仓库:测试', scope: 'custom', vaultName: '测试' }

  return {
    service,
    owner,
    stockLoose: (itemKey, amount = 1, ownerUuid = owner.uuid) => looseStock.set(`${ownerUuid}:${itemKey}`, amount),
    stockInShulker: (itemKey, ownerUuid = owner.uuid) => shulkerStock.add(`${ownerUuid}:${itemKey}`),
    addAccessibleWarehouse: (name, nameLower = name.toLowerCase()) => customWarehouses.push({ name, nameLower })
  }
}

function enchantedBook (itemKey, displayName, enchantmentName, level) {
  return {
    itemKey,
    itemId: 'minecraft:enchanted_book',
    displayName,
    metaJson: JSON.stringify({
      components: {
        enchantments: [{ displayName: enchantmentName, level }]
      }
    })
  }
}

test('items without quantities default to one', () => {
  const fixture = createFixture()

  const requests = fixture.service.parseWithdraw('石头 绿宝石1 钻石', 'player-1', fixture.owner)

  assert.deepEqual(requests.map(request => [request.itemId, request.amount]), [
    ['minecraft:stone', 1],
    ['minecraft:emerald', 1],
    ['minecraft:diamond', 1]
  ])
})

test('spaced quantities still apply to the preceding item', () => {
  const fixture = createFixture()

  const requests = fixture.service.parseWithdraw('石头 64 绿宝石', 'player-1', fixture.owner)

  assert.deepEqual(requests.map(request => [request.itemId, request.amount]), [
    ['minecraft:stone', 64],
    ['minecraft:emerald', 1]
  ])
})

test('a trailing target player is still separated from a quantity-less item', () => {
  const fixture = createFixture()

  const parsed = fixture.service.parseWithdrawCommand('!取 石头 Bob', fixture.owner, 'Alice', 'player-1')

  assert.equal(parsed.targetUsername, 'Bob')
  assert.equal(parsed.requests.length, 1)
  assert.equal(parsed.requests[0].itemId, 'minecraft:stone')
  assert.equal(parsed.requests[0].amount, 1)
})

test('bare enchantment name uses the highest level currently in stock', () => {
  const fixture = createFixture()
  fixture.stockLoose('durability-1', 10)
  fixture.stockLoose('durability-3', 10)

  const [request] = fixture.service.parseWithdraw('耐久2', 'player-1', fixture.owner)

  assert.equal(request.itemKey, 'durability-3')
  assert.equal(request.displayName, '耐久三')
  assert.equal(request.amount, 2)
})

test('bare enchantment name also considers stock inside shulker boxes', () => {
  const fixture = createFixture()
  fixture.stockLoose('durability-1', 10)
  fixture.stockInShulker('durability-5')

  const [request] = fixture.service.parseWithdraw('耐久', 'player-1', fixture.owner)

  assert.equal(request.itemKey, 'durability-5')
  assert.equal(request.amount, 1)
})

test('bare enchantment name considers organization warehouses used for personal fallback', () => {
  const fixture = createFixture()
  const personalOwner = { uuid: 'player-1', username: 'Alice', scope: 'personal' }
  fixture.addAccessibleWarehouse('团队仓库', 'team')
  fixture.stockLoose('durability-1', 10, personalOwner.uuid)
  fixture.stockLoose('durability-5', 10, 'vault:team')

  const [request] = fixture.service.parseWithdraw('耐久', 'player-1', personalOwner)

  assert.equal(request.itemKey, 'durability-5')
})

test('explicit Chinese enchantment level stays fixed and defaults quantity to one', () => {
  const fixture = createFixture()
  fixture.stockLoose('durability-1', 10)

  const [request] = fixture.service.parseWithdraw('耐久五', 'player-1', fixture.owner)

  assert.equal(request.itemKey, 'durability-5')
  assert.equal(request.amount, 1)
})

test('Arabic suffix after an enchantment name is quantity', () => {
  const fixture = createFixture()
  fixture.stockLoose('durability-1', 10)
  fixture.stockLoose('efficiency-5', 10)

  const requests = fixture.service.parseWithdraw('耐久2 效率五3', 'player-1', fixture.owner)

  assert.deepEqual(requests.map(request => [request.itemKey, request.amount]), [
    ['durability-1', 2],
    ['efficiency-5', 3]
  ])
})

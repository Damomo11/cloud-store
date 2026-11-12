const test = require('node:test')
const assert = require('node:assert/strict')
const ItemCatalog = require('../src/itemCatalog')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

const catalog = new ItemCatalog('1.21.11', {}, { file: 'data/zh_cn.json' })

function fixture (overrides = {}) {
  const db = new Proxy({
    findItemByShortCode: () => null,
    findItemByPlayerAlias: () => null,
    findItemByGlobalAlias: () => null,
    isGlobalItemAliasDisabled: () => false,
    findItemsByDisplayQuery: () => [],
    ...overrides
  }, {
    get (target, key) {
      if (!(key in target)) throw new Error(`Unexpected database access: ${String(key)}`)
      return target[key]
    }
  })
  return new CloudStoreService({ username: 'Bot', players: {} }, db, catalog, {}, structuredClone(DEFAULT_CONFIG))
}

test('withdraw recognizes full pinyin with attached, spaced and default quantities without stock access', () => {
  const service = fixture()
  const requests = service.parseWithdraw('hongshifen64 HUOSAI 16 lvbaoshi', 'player')
  assert.deepEqual(requests.map(item => [item.itemId, item.amount]), [
    ['minecraft:redstone', 64], ['minecraft:piston', 16], ['minecraft:emerald', 1]
  ])
  assert.equal(service.parseWithdraw('zhongzhicezhongyaliban')[0].itemId, 'minecraft:heavy_weighted_pressure_plate')
})

test('pinyin recognition is limited to withdrawal and uses the configured catalog language', () => {
  const service = fixture()
  assert.throws(() => service.resolveStoredItem('hongshifen'), /未知物品/)
  assert.throws(() => catalog.resolveName('hongshifen'), /未知物品/)
  const unlocalized = new ItemCatalog('1.21.11')
  service.catalog = unlocalized
  assert.throws(() => service.parseWithdraw('hongshifen'), /未知物品/)
})

test('game-specific polyphonic names accept their correct full pronunciation', () => {
  const service = fixture()
  for (const [spelling, id] of [
    ['fengdan', 'wind_charge'], ['huoyandan', 'fire_charge'],
    ['zuanshigao', 'diamond_pickaxe'], ['mugao', 'wooden_pickaxe'],
    ['yunshanmu', 'spruce_wood']
  ]) {
    assert.equal(service.parseWithdraw(`${spelling}1`)[0].itemId, `minecraft:${id}`)
  }
})

test('full pinyin never selects one of several catalog candidates', () => {
  const service = fixture()
  assert.throws(() => service.parseWithdraw('qizhituan'), /物品名不够精确.*旗帜图案/)
  assert.throws(() => service.parseWithdraw('qizhituan', 'player', { uuid: 'owner', scope: 'personal' }), /物品名不够精确.*旗帜图案/)
  assert.throws(() => service.parseWithdraw('notanitem'), /未知物品/)
  assert.throws(() => service.parseWithdraw('hongsh'), /未知物品/)
})

test('configured Chinese aliases also support full pinyin without changing exact resolution', () => {
  const service = fixture()
  service.catalog = new ItemCatalog('1.21.11', { 红石: 'redstone' }, { file: 'data/zh_cn.json' })
  assert.equal(service.parseWithdraw('hongshi64')[0].itemId, 'minecraft:redstone')
  assert.equal(service.catalog.resolveName('红石').itemId, 'minecraft:redstone')
})

test('existing exact names, personal/global aliases and short codes retain priority', () => {
  const custom = { itemId: 'minecraft:diamond', itemKey: 'minecraft:diamond|abcdef', displayName: '自定义钻石' }
  for (const method of ['findItemByPlayerAlias', 'findItemByGlobalAlias']) {
    const service = fixture({ [method]: (first, second) => [first, second].includes('hongshifen') ? custom : null })
    assert.equal(service.parseWithdraw('hongshifen64', 'player')[0].itemKey, custom.itemKey)
  }
  const service = fixture({ findItemByShortCode: code => code === 'abcdef' ? custom : null })
  assert.equal(service.parseWithdraw('abcdef16')[0].itemKey, custom.itemKey)
  assert.equal(service.parseWithdraw('redstone64')[0].itemId, 'minecraft:redstone')
  assert.equal(service.parseWithdraw('红石粉64')[0].itemId, 'minecraft:redstone')
})

test('disabled aliases and ambiguous stored display matches cannot fall through to pinyin', () => {
  assert.throws(() => fixture({ isGlobalItemAliasDisabled: () => true }).parseWithdraw('hongshifen'), /你已禁用全局别名/)
  const rows = [
    { itemId: 'minecraft:stone', displayName: 'hongshifen stone' },
    { itemId: 'minecraft:diamond', displayName: 'hongshifen diamond' }
  ]
  const service = fixture({ findItemsByDisplayQuery: () => rows })
  assert.throws(() => service.parseWithdraw('hongshifen'), /物品名不够精确.*hongshifen stone/)
  const exact = fixture({ findItemsByDisplayQuery: () => [rows[0]] })
  assert.equal(exact.parseWithdraw('hongshifen')[0].itemId, 'minecraft:stone')
})

test('pinyin quantities are validated and the existing trailing player syntax is preserved', () => {
  const service = fixture()
  const owner = { uuid: 'owner', username: 'Alice', scope: 'personal' }
  for (const input of ['hongshifen0', 'hongshifen9007199254740992']) {
    assert.throws(() => service.parseWithdraw(input), /必须是大于 0 的整数/)
  }
  const parsed = service.parseWithdrawCommand('!取 hongshifen64 Bob', owner, 'Alice', 'player')
  assert.equal(parsed.targetUsername, 'Bob')
  assert.equal(parsed.requests[0].itemId, 'minecraft:redstone')
  assert.equal(parsed.requests[0].amount, 64)
  const collision = service.parseWithdrawCommand('!取 石头 hongshifen', owner, 'Alice', 'player')
  assert.equal(collision.targetUsername, 'hongshifen')
  assert.equal(collision.requests[0].itemId, 'minecraft:stone')
})

test('withdraw accepts initials and full/initial mixtures at every syllable boundary', () => {
  const service = fixture()
  for (const spelling of ['hsk', 'hskuai', 'hongsk', 'hshikuai', 'hongshik', 'hshik', 'hongskuai', 'hongshikuai', 'HONGSK']) {
    const [item] = service.parseWithdraw(`${spelling}64`)
    assert.equal(item.itemId, 'minecraft:redstone_block', spelling)
    assert.equal(item.amount, 64)
  }
  const requests = service.parseWithdraw('zsk16 hsk 8 hongsk', 'player', { uuid: 'owner', scope: 'personal' })
  assert.deepEqual(requests.map(item => [item.itemId, item.amount]), [
    ['minecraft:diamond_block', 16], ['minecraft:redstone_block', 8], ['minecraft:redstone_block', 1]
  ])
  assert.equal(service.parseWithdraw('zzczylb')[0].itemId, 'minecraft:heavy_weighted_pressure_plate')
  assert.equal(service.parseWithdraw('zuanshig')[0].itemId, 'minecraft:diamond_pickaxe')
})

test('ambiguous initials preserve every candidate without inventory-based selection', () => {
  const service = fixture()
  assert.throws(() => service.parseWithdraw('hs', 'player', { uuid: 'owner', scope: 'personal' }), error => {
    assert.equal(error.code, 'WITHDRAW_PINYIN_AMBIGUOUS')
    for (const id of ['red_sand', 'piston', 'blackstone']) assert.ok(error.message.includes(`minecraft:${id}`))
    return true
  })
  assert.throws(() => service.parseWithdraw('h'), /未知物品/)
  assert.throws(() => service.parseWithdraw('hongshikuaijunk'), /未知物品/)
})

test('Chinese item names containing Latin letters preserve those letters in phonetic matching', () => {
  const service = fixture()
  for (const spelling of ['tntkuangche', 'tntkc', 'TNTkuangc']) {
    const [item] = service.parseWithdraw(`${spelling}16`)
    assert.equal(item.itemId, 'minecraft:tnt_minecart')
    assert.equal(item.amount, 16)
  }
  assert.equal(service.parseWithdraw('TNT16')[0].itemId, 'minecraft:tnt')
})

test('full spellings win over abbreviation matches and matching aliases deduplicate by item', () => {
  const service = fixture()
  service.catalog = new ItemCatalog('1.21.11', { 红: 'redstone', 海欧牛瓜: 'diamond', 红石坎: 'redstone_block' }, { file: 'data/zh_cn.json' })
  assert.equal(service.parseWithdraw('hong')[0].itemId, 'minecraft:redstone')
  assert.equal(service.parseWithdraw('hsk')[0].itemId, 'minecraft:redstone_block')
})

test('initials and mixtures retain legacy alias, short-code and target priority', () => {
  const custom = { itemId: 'minecraft:diamond', itemKey: 'minecraft:diamond|abcdef', displayName: '自定义钻石' }
  for (const spelling of ['hsk', 'hongsk']) {
    for (const method of ['findItemByPlayerAlias', 'findItemByGlobalAlias']) {
      assert.equal(fixture({ [method]: () => custom }).parseWithdraw(`${spelling}16`)[0].itemKey, custom.itemKey)
    }
    assert.throws(() => fixture({ isGlobalItemAliasDisabled: () => true }).parseWithdraw(spelling), /你已禁用全局别名/)
  }
  const service = fixture({ findItemByShortCode: () => custom })
  service.catalog = new ItemCatalog('1.21.11', { hsk: 'stone', 艾波草的饿风: 'stone' }, { file: 'data/zh_cn.json' })
  assert.equal(service.parseWithdraw('hsk16')[0].itemId, 'minecraft:stone')
  assert.equal(service.parseWithdraw('abcdef16')[0].itemKey, custom.itemKey)
  const owner = { uuid: 'owner', username: 'Alice', scope: 'personal' }
  const parsed = service.parseWithdrawCommand('!取 hongsk16 Bob', owner, 'Alice', 'player')
  assert.equal(parsed.targetUsername, 'Bob')
  assert.equal(parsed.requests[0].itemId, 'minecraft:redstone_block')
  assert.equal(parsed.requests[0].amount, 16)
  const collision = service.parseWithdrawCommand('!取 石头 hongsk', owner, 'Alice', 'player')
  assert.equal(collision.targetUsername, 'hongsk')
  assert.equal(collision.requests[0].itemId, 'minecraft:stone')
  assert.throws(() => service.resolveStoredItem('hongsk'), /未知物品/)
})

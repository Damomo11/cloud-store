const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const StoreDb = require('../src/db')
const ItemCatalog = require('../src/itemCatalog')
const CloudStoreWebServer = require('../src/webServer')
const { DEFAULT_CONFIG } = require('../src/config')

function createFixture () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-admin-chests-'))
  const config = structuredClone(DEFAULT_CONFIG)
  const db = new StoreDb(path.join(directory, 'store.sqlite'), config)
  const catalog = new ItemCatalog('1.21.11', {}, { file: path.join(process.cwd(), 'data', 'zh_cn.json') })
  db.setCatalog(catalog)
  const server = new CloudStoreWebServer(db, config, () => null)
  server.requireAdmin = () => ({ username: 'admin' })
  return {
    db,
    catalog,
    server,
    close: () => {
      db.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

function seedChests (fixture) {
  const { db, catalog } = fixture
  const diamondNumeric = Object.values(catalog.mcData.items).find(entry => entry.name === 'diamond')
  const stone = { itemKey: 'minecraft:stone|aaa111', itemId: 'minecraft:stone', displayName: '石头', nbtJson: '', metaJson: '' }
  const shulkerMeta = JSON.stringify({
    components: [{ type: 'container', data: { contents: [{ itemId: diamondNumeric.id, itemCount: 5, components: [] }] } }]
  })
  const shulker = {
    itemKey: 'minecraft:blue_shulker_box|bbb222',
    itemId: 'minecraft:blue_shulker_box',
    displayName: '蓝色潜影盒',
    nbtJson: '',
    metaJson: shulkerMeta
  }
  db.upsertItem(stone)
  db.upsertItem(shulker)
  db.upsertChest({ chestId: '10,64,-5', x: 10, y: 64, z: -5, blockName: 'barrel' })
  db.upsertChest({ chestId: '12,64,-5', x: 12, y: 64, z: -5, blockName: 'barrel' })
  db.upsertChest({ chestId: '10,65,-5', x: 10, y: 65, z: -5, blockName: 'barrel' })
  db.replaceChestSlots('10,64,-5', [
    { ...stone, slot: 0, amount: 64 },
    { ...shulker, slot: 1, amount: 1 }
  ])
  db.replaceChestSlots('10,65,-5', [{ ...stone, slot: 3, amount: 7 }])
  return { stone, shulker }
}

test('admin chest list returns per-chest slot stats and shulker counts', () => {
  const fixture = createFixture()
  try {
    seedChests(fixture)
    const data = fixture.server.apiAdminChests({}, new URL('http://localhost/api/admin/chests'))
    assert.equal(data.ok, true)
    assert.equal(data.rows.length, 3)
    const byId = new Map(data.rows.map(row => [row.chestId, row]))
    assert.equal(byId.get('10,64,-5').slotCount, 2)
    assert.equal(byId.get('10,64,-5').totalAmount, 65)
    assert.equal(byId.get('10,64,-5').shulkerAmount, 1)
    assert.equal(byId.get('12,64,-5').slotCount, 0)
    assert.equal(byId.get('12,64,-5').totalAmount, 0)
    assert.equal(byId.get('10,65,-5').slotCount, 1)
    // 默认按坐标排序：y=64 的两桶在前
    assert.equal(data.rows[0].chestId, '10,64,-5')
    assert.ok(data.nowLabel)
  } finally {
    fixture.close()
  }
})

test('admin chest list searches by item name, short code and shulker contents', () => {
  const fixture = createFixture()
  try {
    seedChests(fixture)
    const server = fixture.server
    // 按物品名
    const byName = server.apiAdminChests({}, new URL(`http://localhost/api/admin/chests?q=${encodeURIComponent('石头')}`))
    assert.deepEqual(byName.rows.map(row => row.chestId), ['10,64,-5', '10,65,-5'])
    assert.equal(byName.rows[0].matchedSlots, 1)
    assert.equal(byName.rows[0].matchedAmount, 64)
    // 按短码（itemKey 末 6 位）：石头两桶都命中
    const byShort = server.apiAdminChests({}, new URL(`http://localhost/api/admin/chests?q=aaa111`))
    assert.deepEqual(byShort.rows.map(row => row.chestId), ['10,64,-5', '10,65,-5'])
    // 按盒内物品名（潜影盒内的钻石）：盒子在哪个桶，桶就命中
    const byInner = server.apiAdminChests({}, new URL(`http://localhost/api/admin/chests?q=${encodeURIComponent('钻石')}`))
    assert.equal(byInner.rows.length, 1)
    assert.equal(byInner.rows[0].chestId, '10,64,-5')
    assert.equal(byInner.rows[0].matchedSlots, 1)
    // 潜影盒名本身也能搜到
    const byBox = server.apiAdminChests({}, new URL(`http://localhost/api/admin/chests?q=${encodeURIComponent('潜影盒')}`))
    assert.equal(byBox.rows.length, 1)
    assert.equal(byBox.rows[0].chestId, '10,64,-5')
    // 按坐标文本
    const byCoord = server.apiAdminChests({}, new URL(`http://localhost/api/admin/chests?q=12,64`))
    assert.equal(byCoord.rows.length, 1)
    assert.equal(byCoord.rows[0].chestId, '12,64,-5')
  } finally {
    fixture.close()
  }
})

test('admin chest list supports coordinate range filters and sorts', () => {
  const fixture = createFixture()
  try {
    seedChests(fixture)
    const server = fixture.server
    // X 范围过滤
    const range = server.apiAdminChests({}, new URL('http://localhost/api/admin/chests?x=11..99'))
    assert.deepEqual(range.rows.map(row => row.chestId), ['12,64,-5'])
    // 单值精确匹配
    const exact = server.apiAdminChests({}, new URL('http://localhost/api/admin/chests?y=65'))
    assert.deepEqual(exact.rows.map(row => row.chestId), ['10,65,-5'])
    // 开区间
    const openEnd = server.apiAdminChests({}, new URL('http://localhost/api/admin/chests?x=11..'))
    assert.equal(openEnd.rows.length, 1)
    // 排序：按总数
    const byAmount = server.apiAdminChests({}, new URL('http://localhost/api/admin/chests?sort=amount'))
    assert.equal(byAmount.rows[0].chestId, '10,64,-5')
    // 排序：按格数
    const bySlots = server.apiAdminChests({}, new URL('http://localhost/api/admin/chests?sort=slots'))
    assert.equal(bySlots.rows[0].chestId, '10,64,-5')
    assert.equal(bySlots.rows[0].slotCount, 2)
    // 非法过滤格式被拒绝
    assert.throws(() => server.apiAdminChests({}, new URL('http://localhost/api/admin/chests?x=abc')), /坐标过滤格式/)
  } finally {
    fixture.close()
  }
})

test('admin chest detail expands shulker box contents', () => {
  const fixture = createFixture()
  try {
    seedChests(fixture)
    const data = fixture.server.apiAdminChest({}, new URL('http://localhost/api/admin/chest?chest=10,64,-5'))
    assert.equal(data.ok, true)
    assert.equal(data.chestLabel, '10,64,-5')
    assert.equal(data.types, 2)
    assert.equal(data.total, 65)
    const shulkerItem = data.items.find(item => item.isShulker)
    assert.ok(shulkerItem, 'expected the shulker box item to be flagged')
    assert.equal(shulkerItem.amount, 1)
    assert.equal(shulkerItem.shulkerContents.length, 1)
    assert.equal(shulkerItem.shulkerContents[0].itemId, 'minecraft:diamond')
    assert.equal(shulkerItem.shulkerContents[0].displayName, '钻石')
    assert.equal(shulkerItem.shulkerContents[0].amount, 5)
    assert.ok(shulkerItem.shulkerContents[0].shortCode)
    // 普通物品不带 shulkerContents
    const stoneItem = data.items.find(item => !item.isShulker)
    assert.equal(stoneItem.displayName, '石头')
    assert.equal(stoneItem.amount, 64)
    // 不存在的桶
    assert.throws(() => fixture.server.apiAdminChest({}, new URL('http://localhost/api/admin/chest?chest=999,1,1')), /找不到木桶/)
  } finally {
    fixture.close()
  }
})

test('admin chest live resync validates coordinates and requires an online service', async () => {
  const fixture = createFixture()
  try {
    const server = fixture.server
    await assert.rejects(() => server.apiAdminChestLive({}, { chest: 'not-coords' }), /格式/)
    await assert.rejects(() => server.apiAdminChestLive({}, { chest: '1,2,3' }), /机器人还没有进入服务器/)
  } finally {
    fixture.close()
  }
})

test('service resyncBarrelForAdmin routes through the exclusive task queue', async () => {
  const fixture = createFixture()
  let captured = null
  const fakeService = {
    enqueueTask: async (actor, type, run, options) => {
      captured = { actor, type, options }
      return run(fakeService)
    },
    attachWarehouseTrace () {},
    detachWarehouseTrace () {},
    warehouse: {
      syncSingleBarrel: async coords => ({
        chest: { x: coords.x, y: coords.y, z: coords.z, describe: `${coords.x},${coords.y},${coords.z}` },
        types: 1,
        total: 5,
        items: []
      })
    }
  }
  try {
    const CloudStoreService = require('../src/service')
    const detail = await CloudStoreService.prototype.resyncBarrelForAdmin.call(fakeService, { x: 1, y: 2, z: 3 }, { username: 'admin' })
    assert.equal(detail.total, 5)
    assert.equal(captured.type, 'sync')
    assert.equal(captured.options.exclusive, true)
    assert.equal(captured.actor, 'admin')
  } finally {
    fixture.close()
  }
})

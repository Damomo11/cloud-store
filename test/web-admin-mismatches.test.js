const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const StoreDb = require('../src/db')
const CloudStoreWebServer = require('../src/webServer')
const { DEFAULT_CONFIG } = require('../src/config')

function createFixture () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-mismatches-'))
  const config = structuredClone(DEFAULT_CONFIG)
  const db = new StoreDb(path.join(directory, 'store.sqlite'), config)
  const server = new CloudStoreWebServer(db, config, () => null)
  server.requireAdmin = () => ({ username: 'admin' })
  return {
    db,
    server,
    close: () => {
      db.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

test('admin mismatches include indexed shulker contents and search them', () => {
  const fixture = createFixture()
  const box = {
    itemKey: 'blue-box-key',
    itemId: 'minecraft:blue_shulker_box',
    displayName: '蓝色潜影盒',
    nbtJson: '{}',
    metaJson: '{}'
  }
  const content = {
    itemKey: 'diamond-key',
    itemId: 'minecraft:diamond',
    displayName: '钻石',
    nbtJson: '',
    metaJson: ''
  }

  try {
    fixture.db.addInventoryMismatch('extra', fixture.db.momoOwner, 'momo', box, 1)
    fixture.db.upsertItem(content)
    fixture.db.db.prepare(`
      INSERT INTO shulker_contents (
        shulker_item_key, contained_item_key, contained_item_id, amount, slot_count
      ) VALUES (?, ?, ?, ?, ?)
    `).run(box.itemKey, content.itemKey, content.itemId, 12, 1)

    const result = fixture.server.apiAdminMismatches({}, new URL('http://localhost/api/admin/mismatches?item=%E9%92%BB%E7%9F%B3'))

    assert.equal(result.rows.length, 1)
    assert.equal(result.rows[0].shulkerContents.length, 1)
    assert.equal(result.rows[0].shulkerContents[0].displayName, '钻石')
    assert.equal(result.rows[0].shulkerContents[0].amount, 12)
  } finally {
    fixture.close()
  }
})

test('resolving an extra mismatch transfers its balance out of momo', () => {
  const fixture = createFixture()
  const item = {
    itemKey: 'extra-diamond-key',
    itemId: 'minecraft:diamond',
    displayName: '钻石',
    nbtJson: '',
    metaJson: ''
  }
  const targetOwnerUuid = 'target-player'

  try {
    fixture.db.addBalanceItems(fixture.db.momoOwner, [{ ...item, amount: 5 }])
    fixture.db.addInventoryMismatch('extra', fixture.db.momoOwner, 'momo', item, 3)
    const mismatch = fixture.db.db.prepare("SELECT id FROM inventory_mismatches WHERE status = 'open'").get()
    fixture.server.resolveAdminOwnerArgument = () => targetOwnerUuid

    fixture.server.apiAdminMismatchResolve({}, { id: mismatch.id, targetOwnerUuid })

    assert.equal(fixture.db.getBalance(fixture.db.momoOwner, item.itemKey), 2)
    assert.equal(fixture.db.getBalance(targetOwnerUuid, item.itemKey), 3)
    assert.equal(fixture.db.db.prepare('SELECT status FROM inventory_mismatches WHERE id = ?').get(mismatch.id).status, 'resolved')
    assert.deepEqual(
      fixture.db.db.prepare("SELECT type FROM transactions WHERE type LIKE 'web_admin_mismatch_transfer%' ORDER BY id").all().map(row => row.type),
      ['web_admin_mismatch_transfer_out', 'web_admin_mismatch_transfer']
    )
  } finally {
    fixture.close()
  }
})

test('assigning an extra mismatch to momo does not duplicate its balance', () => {
  const fixture = createFixture()
  const item = {
    itemKey: 'momo-iron-key',
    itemId: 'minecraft:iron_ingot',
    displayName: '铁锭',
    nbtJson: '',
    metaJson: ''
  }

  try {
    fixture.db.addBalanceItems(fixture.db.momoOwner, [{ ...item, amount: 4 }])
    fixture.db.addInventoryMismatch('extra', fixture.db.momoOwner, 'momo', item, 4)
    const mismatch = fixture.db.db.prepare("SELECT id FROM inventory_mismatches WHERE status = 'open'").get()
    fixture.server.resolveAdminOwnerArgument = () => fixture.db.momoOwner

    fixture.server.apiAdminMismatchResolve({}, { id: mismatch.id, targetOwnerUuid: fixture.db.momoOwner })

    assert.equal(fixture.db.getBalance(fixture.db.momoOwner, item.itemKey), 4)
    assert.equal(fixture.db.db.prepare('SELECT status FROM inventory_mismatches WHERE id = ?').get(mismatch.id).status, 'resolved')
  } finally {
    fixture.close()
  }
})

function makeItem (key, itemId, displayName) {
  return { itemKey: key, itemId, displayName, nbtJson: '', metaJson: '' }
}

test('batch deduct closes balance-empty missing rows instead of failing them', () => {
  const fixture = createFixture()
  const okItem = makeItem('missing-diamond-key', 'minecraft:diamond', '钻石')
  const brokeItem = makeItem('missing-iron-key', 'minecraft:iron_ingot', '铁锭')
  const ownerUuid = 'player-a'

  try {
    fixture.db.addBalanceItems(ownerUuid, [{ ...okItem, amount: 5 }])
    fixture.db.addInventoryMismatch('missing', ownerUuid, 'player-a', okItem, 2)
    fixture.db.addInventoryMismatch('missing', ownerUuid, 'player-a', brokeItem, 1)
    const open = fixture.db.db.prepare("SELECT id FROM inventory_mismatches WHERE status = 'open' ORDER BY id").all()

    const result = fixture.server.apiAdminMismatchBatchDeduct({}, { ids: open.map(row => row.id) })

    assert.equal(result.ok, true)
    assert.deepEqual(result.results.map(row => row.ok), [true, true], '账面为空的记录不再失败，而是关闭留痕')
    assert.match(result.message, /成功 2 条/)
    assert.equal(fixture.db.getBalance(ownerUuid, okItem.itemKey), 3)
    assert.equal(fixture.db.getBalance(ownerUuid, brokeItem.itemKey), 0)
    assert.equal(
      fixture.db.db.prepare("SELECT COUNT(*) AS count FROM inventory_mismatches WHERE status = 'resolved'").get().count,
      2
    )
    const closedRow = fixture.db.db.prepare('SELECT note FROM inventory_mismatches WHERE id = ?').get(open[1].id)
    assert.match(closedRow.note, /账面已无可扣除数量/)
  } finally {
    fixture.close()
  }
})

test('batch deduct rejects an empty selection', () => {
  const fixture = createFixture()
  try {
    assert.throws(() => fixture.server.apiAdminMismatchBatchDeduct({}, { ids: [] }), /请先勾选/)
    assert.throws(() => fixture.server.apiAdminMismatchBatchDeduct({}, {}), /请先勾选/)
  } finally {
    fixture.close()
  }
})

test('batch resolve transfers many extras to one target and skips failures', () => {
  const fixture = createFixture()
  const okItem = makeItem('extra-diamond-key', 'minecraft:diamond', '钻石')
  const shortItem = makeItem('extra-emerald-key', 'minecraft:emerald', '绿宝石')
  const targetOwnerUuid = 'target-player'

  try {
    fixture.db.addBalanceItems(fixture.db.momoOwner, [{ ...okItem, amount: 5 }])
    fixture.db.addInventoryMismatch('extra', fixture.db.momoOwner, 'momo', okItem, 3)
    fixture.db.addInventoryMismatch('extra', fixture.db.momoOwner, 'momo', shortItem, 3)
    const open = fixture.db.db.prepare("SELECT id FROM inventory_mismatches WHERE status = 'open' ORDER BY id").all()
    fixture.server.resolveAdminOwnerArgument = value => (value === targetOwnerUuid ? targetOwnerUuid : '')

    assert.throws(
      () => fixture.server.apiAdminMismatchBatchResolve({}, { ids: open.map(row => row.id) }),
      /请先选择批量转入的目标仓库/
    )

    const result = fixture.server.apiAdminMismatchBatchResolve({}, { ids: open.map(row => row.id), targetOwnerUuid })

    assert.equal(result.ok, true)
    assert.deepEqual(result.results.map(row => row.ok), [true, false])
    assert.match(result.message, /成功 1 条，失败 1 条/)
    assert.equal(fixture.db.getBalance(targetOwnerUuid, okItem.itemKey), 3)
    assert.equal(fixture.db.getBalance(targetOwnerUuid, shortItem.itemKey), 0)
    assert.equal(fixture.db.getBalance(fixture.db.momoOwner, okItem.itemKey), 2)
    assert.equal(
      fixture.db.db.prepare("SELECT COUNT(*) AS count FROM inventory_mismatches WHERE status = 'resolved'").get().count,
      1
    )
  } finally {
    fixture.close()
  }
})

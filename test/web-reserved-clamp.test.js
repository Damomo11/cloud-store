const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const StoreDb = require('../src/db')
const { DEFAULT_CONFIG } = require('../src/config')

function createDb () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-reserved-'))
  const config = structuredClone(DEFAULT_CONFIG)
  const db = new StoreDb(path.join(directory, 'store.sqlite'), config)
  return {
    db,
    close: () => {
      db.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

function diamond (amount) {
  return { itemKey: 'diamond-key', itemId: 'minecraft:diamond', displayName: '钻石', nbtJson: '', metaJson: '', amount }
}

test('web inventory exposes reserved and available per item plus reservedAmount stats', () => {
  const fixture = createDb()
  try {
    fixture.db.addBalanceItems('player-a', [diamond(5)])
    fixture.db.db.prepare(`
      INSERT INTO inventory_reservations (reservation_id, owner_uuid, item_key, amount)
      VALUES ('res-1', 'player-a', 'diamond-key', 2)
    `).run()

    const data = fixture.db.getWebInventory('player-a', '')

    const row = data.items.find(item => item.itemKey === 'diamond-key')
    assert.equal(row.amount, 5, '账面总量照常展示')
    assert.equal(row.reserved, 2)
    assert.equal(row.available, 3)
    assert.equal(data.stats.totalAmount, 5)
    assert.equal(data.stats.reservedAmount, 2)
  } finally {
    fixture.close()
  }
})

test('withdraw deduction clamps to balance and registers the shortfall as a mismatch', () => {
  const fixture = createDb()
  try {
    fixture.db.addBalanceItems('player-a', [diamond(1)])

    const result = fixture.db.applyWithdrawDeduction('withdraw:test:1', [
      { ownerUuid: 'player-a', username: 'player-a', items: [diamond(3)] }
    ], 'test')

    assert.equal(result.applied, true, '扣账事务照常提交，不回滚')
    assert.equal(fixture.db.getBalance('player-a', 'diamond-key'), 0, '按现有余额钳制扣到 0')
    const tx = fixture.db.db.prepare("SELECT items_json FROM transactions WHERE type = 'withdraw' AND deduction_key = 'withdraw:test:1'").get()
    assert.ok(tx, '交付流水已记录')
    const mismatch = fixture.db.db.prepare("SELECT amount, note FROM inventory_mismatches WHERE status = 'open'").get()
    assert.equal(mismatch.amount, 2, '缺额登记异常留痕')
    assert.match(mismatch.note, /账面余额不足/)
  } finally {
    fixture.close()
  }
})

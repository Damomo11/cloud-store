const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const StoreDb = require('../src/db')
const { DEFAULT_CONFIG } = require('../src/config')

function createDb () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-auto-reconcile-'))
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

test('deductConfirmedMissing deducts balance, writes sync_deduct transaction and one mismatch', () => {
  const fixture = createDb()
  try {
    fixture.db.addBalanceItems('player-a', [diamond(4)])

    const results = fixture.db.deductConfirmedMissing('player-a', 'player-a', [diamond(3)], '取货时确认缺失')

    assert.deepEqual(results, [{ itemKey: 'diamond-key', requested: 3, deducted: 3 }])
    assert.equal(fixture.db.getBalance('player-a', 'diamond-key'), 1)
    const tx = fixture.db.db.prepare("SELECT * FROM transactions WHERE type = 'sync_deduct'").get()
    assert.ok(tx, '写入 sync_deduct 流水')
    assert.match(tx.message, /取货时确认缺失/)
    const mismatches = fixture.db.db.prepare("SELECT * FROM inventory_mismatches WHERE status = 'open'").all()
    assert.equal(mismatches.length, 1)
    assert.match(mismatches[0].note, /已自动扣除 3/)

    // 重复调用：修账照常执行，但 open 异常不重复登记。
    fixture.db.addBalanceItems('player-a', [diamond(2)])
    fixture.db.deductConfirmedMissing('player-a', 'player-a', [diamond(1)], '取货时确认缺失')
    const stillOpen = fixture.db.db.prepare("SELECT COUNT(*) AS count FROM inventory_mismatches WHERE status = 'open'").get()
    assert.equal(stillOpen.count, 1, '同 owner+item 不重复登记 open 异常')
  } finally {
    fixture.close()
  }
})

test('deductConfirmedMissing clamps to the current balance', () => {
  const fixture = createDb()
  try {
    fixture.db.addBalanceItems('player-a', [diamond(1)])

    const results = fixture.db.deductConfirmedMissing('player-a', 'player-a', [diamond(5)], '取货时确认缺失')

    assert.deepEqual(results, [{ itemKey: 'diamond-key', requested: 5, deducted: 1 }])
    assert.equal(fixture.db.getBalance('player-a', 'diamond-key'), 0)
    const row = fixture.db.db.prepare('SELECT note FROM inventory_mismatches WHERE status = \'open\'').get()
    assert.match(row.note, /账面仅剩 1/)
  } finally {
    fixture.close()
  }
})

test('creditExtraToMomo credits momo, writes transaction and extra mismatch', () => {
  const fixture = createDb()
  try {
    const result = fixture.db.creditExtraToMomo(diamond(2), 2, 'withdraw_barrel_extra; chest=c1')

    assert.deepEqual(result, { itemKey: 'diamond-key', amount: 2 })
    assert.equal(fixture.db.getBalance(fixture.db.momoOwner, 'diamond-key'), 2)
    const tx = fixture.db.db.prepare("SELECT * FROM transactions WHERE type = 'sync' AND player_uuid = ?").get(fixture.db.momoOwner)
    assert.ok(tx, '写入 sync 流水')
    const row = fixture.db.db.prepare("SELECT kind, amount FROM inventory_mismatches WHERE status = 'open'").get()
    assert.equal(row.kind, 'extra')
    assert.equal(row.amount, 2)
  } finally {
    fixture.close()
  }
})

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const StoreDb = require('../src/db')
const { DEFAULT_CONFIG } = require('../src/config')

function createDb () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-reconcile-'))
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

test('sync reconcile deducts owner balance for missing items and writes a sync_deduct transaction', () => {
  const fixture = createDb()
  try {
    fixture.db.addBalanceItems('player-a', [diamond(3)])

    const result = fixture.db.reconcileTotalsToMomo([])

    assert.equal(fixture.db.getBalance('player-a', 'diamond-key'), 0, '账面余额与实物一致')
    assert.equal(result.unresolved.length, 1)
    assert.equal(result.unresolved[0].amount, 3, '缺失量照常进入 unresolved 统计')
    const tx = fixture.db.db.prepare("SELECT * FROM transactions WHERE type = 'sync_deduct'").get()
    assert.ok(tx, '写入 sync_deduct 流水')
    assert.equal(tx.player_uuid, 'player-a')
    const mismatch = fixture.db.db.prepare("SELECT * FROM inventory_mismatches WHERE status = 'open'").get()
    assert.ok(mismatch, '异常仍登记留痕')
    assert.match(mismatch.note, /已自动扣除账面 x3/)
  } finally {
    fixture.close()
  }
})

test('momo covers the shortage first, owners pay only the remainder', () => {
  const fixture = createDb()
  try {
    fixture.db.addBalanceItems(fixture.db.momoOwner, [diamond(1)])
    fixture.db.addBalanceItems('player-a', [diamond(4)])

    const result = fixture.db.reconcileTotalsToMomo([])

    assert.equal(fixture.db.getBalance(fixture.db.momoOwner, 'diamond-key'), 0)
    assert.equal(fixture.db.getBalance('player-a', 'diamond-key'), 0)
    assert.equal(result.removedFromMomo[0].amount, 1, 'momo 先兜底 1 个')
    assert.equal(result.unresolved[0].amount, 4, 'unresolved 统计的是 momo 兜底后的剩余缺口')
  } finally {
    fixture.close()
  }
})

test('shortage spread across vault and player deducts both owners', () => {
  const fixture = createDb()
  try {
    fixture.db.addBalanceItems('vault:main', [diamond(2)])
    fixture.db.addBalanceItems('player-a', [diamond(3)])

    fixture.db.reconcileTotalsToMomo([])

    assert.equal(fixture.db.getBalance('vault:main', 'diamond-key'), 0)
    assert.equal(fixture.db.getBalance('player-a', 'diamond-key'), 0)
    const notes = fixture.db.db.prepare("SELECT owner_uuid AS owner FROM inventory_mismatches WHERE status = 'open' ORDER BY id").all()
    assert.deepEqual(notes.map(row => row.owner), ['vault:main', 'player-a'])
  } finally {
    fixture.close()
  }
})

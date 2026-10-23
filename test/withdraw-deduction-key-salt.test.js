const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const StoreDb = require('../src/db')
const { DEFAULT_CONFIG } = require('../src/config')

// 模拟进程重启：清掉 service 模块缓存后重新加载，DEDUCTION_KEY_SALT 会重新生成，
// 而真实数据库（StoreDb）保持不变——正是“重启后任务序号归零、账本跨进程存活”的现场。
function loadFreshServiceModule () {
  const resolved = require.resolve('../src/service')
  delete require.cache[resolved]
  return require(resolved)
}

function createDb () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-dedup-'))
  const db = new StoreDb(path.join(directory, 'store.sqlite'), structuredClone(DEFAULT_CONFIG))
  return {
    db,
    close: () => {
      db.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

const ITEM = {
  itemKey: 'minecraft:shulker_box|a41e81',
  itemId: 'minecraft:shulker_box',
  displayName: '潜影盒',
  nbtJson: '',
  metaJson: ''
}
const OWNER = { uuid: 'vault:test', username: '测试仓库', scope: 'custom', vaultName: '测试仓库' }

// 用真实 StoreDb + 桩 warehouse 直接驱动 runWithdrawBatches：
// 这条链路里生成的扣账幂等键 batchId 决定 applyWithdrawDeduction 是否真扣账。
function createService (ServiceClass, db, options = {}) {
  let inventory = []
  const bot = {
    username: 'BotA',
    players: {},
    inventory: { items: () => inventory },
    chat: () => {}
  }
  const catalog = {
    aggregatePrismarineItems: items => items.map(entry => ({
      ...ITEM,
      amount: Number(entry.count ?? entry.amount ?? 0)
    })),
    getStackSize: () => 64,
    fromPrismarineItem: entry => ({ ...ITEM, amount: entry.count })
  }
  const warehouse = {
    goHomeIfAway: async () => {},
    goHome: async () => {},
    withdrawAllocations: async () => {
      inventory = [{ ...ITEM, count: 1 }]
      return { withdrawn: [{ ...ITEM, amount: 1 }], missing: [], unlocated: [], searchedUnlocatedBarrels: 0 }
    },
    depositInventoryWithoutBalance: async () => {
      inventory = []
      return { deposited: [], leftover: [] }
    },
    dropItemsToPlayer: async (username, requested) => {
      inventory = []
      return requested.map(entry => ({ ...entry }))
    }
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.timing.containerSettleMs = 0

  const service = new ServiceClass(bot, db, catalog, warehouse, config)
  service.active = { type: 'withdraw', username: 'Alice', taskId: options.taskId ?? 7, cancelled: false, dead: false }
  service.teleportToPlayer = async () => true

  return { service }
}

async function runOneWithdraw (ServiceClass, db, options = {}) {
  const { service } = createService(ServiceClass, db, options)
  const result = await service.runWithdrawBatches({
    username: 'Alice',
    storageOwner: OWNER,
    deliveryTarget: 'Alice',
    deliveryToOther: false,
    deliveryMode: 'deliver',
    batches: [[{ ...ITEM, amount: 1, ownerUuid: OWNER.uuid, ownerUsername: OWNER.username }]],
    continueWithDeposit: false,
    msgActor: () => {},
    msgTarget: () => {},
    trace: null
  })
  return { service, result }
}

function withdrawTransactions (db) {
  return db.db.prepare(`
    SELECT deduction_key AS deductionKey, player_uuid AS playerUuid
    FROM transactions
    WHERE type = 'withdraw' AND player_uuid = ?
    ORDER BY id
  `).all(OWNER.uuid)
}

test('delivered withdrawals deduct the balance and stamp a salted idempotency key', async () => {
  const fixture = createDb()
  try {
    fixture.db.addBalanceItems(OWNER.uuid, [{ ...ITEM, amount: 1 }])

    const { result } = await runOneWithdraw(require('../src/service'), fixture.db)

    assert.equal(fixture.db.getBalance(OWNER.uuid, ITEM.itemKey), 0, '交付后必须扣账')
    assert.equal(result.allDeducted.length, 1)
    const rows = withdrawTransactions(fixture.db)
    assert.equal(rows.length, 1)
    assert.match(rows[0].deductionKey, /^withdraw:bota:7:1:[0-9a-z]{6,}$/, '幂等键末段必须是进程盐')
  } finally {
    fixture.close()
  }
})

test('same process keeps retry dedupe semantics for an identical key', async () => {
  const fixture = createDb()
  try {
    fixture.db.addBalanceItems(OWNER.uuid, [{ ...ITEM, amount: 1 }])
    fixture.db.addBalanceItems(OWNER.uuid, [{ ...ITEM, amount: 1 }])

    const ServiceClass = require('../src/service')
    const first = await runOneWithdraw(ServiceClass, fixture.db)
    const second = await runOneWithdraw(ServiceClass, fixture.db)

    assert.equal(fixture.db.getBalance(OWNER.uuid, ITEM.itemKey), 1, '同进程同键只扣一次（防双扣语义不变）')
    assert.equal(first.result.allDeducted.length, 1)
    assert.equal(second.result.allDeducted.length, 1)
    const rows = withdrawTransactions(fixture.db)
    assert.equal(rows.length, 1, '第二次命中幂等键，不产生新交易')
  } finally {
    fixture.close()
  }
})

test('a restart (fresh salt) with a reused task id still deducts the balance', async () => {
  const fixture = createDb()
  try {
    // 重启前：任务 taskId=7 正常交付并扣账。
    fixture.db.addBalanceItems(OWNER.uuid, [{ ...ITEM, amount: 1 }])
    await runOneWithdraw(loadFreshServiceModule(), fixture.db)
    assert.equal(fixture.db.getBalance(OWNER.uuid, ITEM.itemKey), 0)

    // 重启后：任务序号归零，新任务的 taskId 仍是 7（旧实现会生成完全相同的幂等键）。
    fixture.db.addBalanceItems(OWNER.uuid, [{ ...ITEM, amount: 1 }])
    const { result } = await runOneWithdraw(loadFreshServiceModule(), fixture.db)

    assert.equal(fixture.db.getBalance(OWNER.uuid, ITEM.itemKey), 0, '重启后同 taskId 的交付必须照常扣账')
    assert.equal(result.allDeducted.length, 1)
    const rows = withdrawTransactions(fixture.db)
    assert.equal(rows.length, 2, '两次交付各有交易记录')
    assert.notEqual(rows[0].deductionKey, rows[1].deductionKey, '幂等键必须随进程盐变化')
  } finally {
    fixture.close()
  }
})

test('applyWithdrawDeduction reports applied=false instead of double deducting', () => {
  const fixture = createDb()
  try {
    fixture.db.addBalanceItems(OWNER.uuid, [{ ...ITEM, amount: 1 }])

    const groups = [{ ownerUuid: OWNER.uuid, username: OWNER.username, items: [{ ...ITEM, amount: 1 }] }]
    const first = fixture.db.applyWithdrawDeduction('withdraw:bota:7:1:saltA', groups)
    const second = fixture.db.applyWithdrawDeduction('withdraw:bota:7:1:saltA', groups)

    assert.equal(first.applied, true)
    assert.equal(second.applied, false)
    assert.equal(fixture.db.getBalance(OWNER.uuid, ITEM.itemKey), 0)
  } finally {
    fixture.close()
  }
})

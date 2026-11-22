'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const StoreDb = require('../../src/db')
const ItemCatalog = require('../../src/itemCatalog')
const CraftLedger = require('../../src/craft/ledger')
const CloudStoreService = require('../../src/service')
const { DEFAULT_CONFIG } = require('../../src/config')

function fixture () {
  const config = structuredClone(DEFAULT_CONFIG)
  const db = new StoreDb(':memory:', config)
  const catalog = new ItemCatalog(config.server.version, {}, { serverEnchantmentsFile: '/missing-test-mappings.json' })
  const Item = require('prismarine-item')(catalog.mcData)
  const planks = catalog.aggregatePrismarineItems([new Item(catalog.mcData.itemsByName.oak_planks.id, 2)])
  db.addBalanceItems('alice', planks)
  return { db, config, catalog, planks, close: () => db.close() }
}

function pendingJournal (f, botId) {
  const ledger = new CraftLedger(f.db)
  const id = `craft:${botId}`
  const data = { held: [], pending: null, physicalTotals: f.planks, stepIndex: 0 }
  ledger.begin({ id, botId, owner: { uuid: 'alice', username: 'Alice' }, allocations: f.planks, data })
  ledger.markRecovery(id, 'interrupted craft', data)
  return id
}

test('a journal owned by another bot is visible globally but not per bot', async () => {
  const f = fixture()
  try {
    pendingJournal(f, 'bot-b')
    assert.equal(f.db.hasPendingCraft(), true)
    assert.equal(f.db.hasPendingCraft('bot-a'), false)
    assert.equal(f.db.hasPendingCraft('bot-b'), true)
    assert.deepEqual(f.db.pendingCraftBotIds(), ['bot-b'])
  } finally { f.close() }
})

test('a journal owned by another bot no longer locks the whole store', async () => {
  const f = fixture()
  try {
    pendingJournal(f, 'bot-b')
    // 新行为（2026-11-22 生产事故）：其他机器人在途的恢复记录不再全库锁死。
    // bot-a 的存/取照常放行；在途 bot-b 的账由预留行单独保护。
    assert.doesNotThrow(() => f.db.assertNoPendingCraft('', 'bot-a'))
    assert.doesNotThrow(() => f.db.addBalanceItems('bob', f.planks))
    // 待恢复机器人自己仍被挡：恢复完成前它不能改自己的账。
    assert.throws(() => f.db.assertNoPendingCraft('', 'bot-b'), /待恢复机器人：bot-b/)
  } finally { f.close() }
})

test('reconciliation defers pending-craft reservation keys instead of draining them', async () => {
  const f = fixture()
  try {
    pendingJournal(f, 'bot-b')
    // bob 账面与实物一致的对账：alice 被 bot-b 预留的 planks 不参与，
    // 既不划走也不抽干；其他物品照常对账。
    const planks = f.planks.map(item => ({ itemKey: item.itemKey, itemId: item.itemId, displayName: item.displayName, amount: item.amount }))
    const result = f.db.reconcileTotalsToMomo([])
    assert.ok(result.deferredForCraft?.some(key => planks.some(item => item.itemKey === key)),
      'pending craft reservation keys must be deferred, not reconciled')
    assert.equal(f.db.getBalance('alice', planks[0].itemKey), 2)
  } finally { f.close() }
})

test('recovery settlement reconciliation keeps its own operation keys', async () => {
  const f = fixture()
  try {
    const id = pendingJournal(f, 'bot-b')
    // 恢复对账事务自己（allowedOperationId）：不剔除自己的键，照常结算。
    const planks = f.planks.map(item => ({ itemKey: item.itemKey, itemId: item.itemId, displayName: item.displayName, amount: item.amount }))
    assert.doesNotThrow(() => f.db.reconcileRecoveryDeltaToMomo(planks, planks, id))
  } finally { f.close() }
})

test('assertNoPendingCraft keeps its original message when there is no journal', async () => {
  const f = fixture()
  try {
    assert.doesNotThrow(() => f.db.assertNoPendingCraft())
    assert.deepEqual(f.db.pendingCraftBotIds(), [])
  } finally { f.close() }
})

test('flushResidual keeps the upstream bot-specific journal guard', async () => {
  const f = fixture()
  try {
    pendingJournal(f, 'bot-b')
    const service = Object.create(CloudStoreService.prototype)
    service.db = f.db
    service.botId = 'bot-a'
    service.catalog = f.catalog
    service.bot = { inventory: { items: () => [] } }
    await service.flushResidual()
    service.botId = 'bot-b'
    await assert.rejects(service.flushResidual(), /合成恢复记录/)
  } finally { f.close() }
})

function recoveryService (f, result) {
  const messages = []
  const owner = { botId: 'bot-b', getCraftController: () => ({ recover: async () => result }) }
  const service = Object.assign(Object.create(CloudStoreService.prototype), {
    botId: 'receiver', db: f.db,
    isAdmin: () => true,
    msg: (_user, text) => messages.push(text),
    taskPool: { workers: new Set([owner]), eligibleWorkerForTask: () => owner },
    enqueueTask: (username, type, run, options) => {
      assert.equal(type, 'craft_recovery')
      assert.equal(options.exclusive, true)
      assert.equal(options.stickyWorker, owner)
      return run(owner)
    }
  })
  return { service, messages }
}

test('craft recovery on another bot routes to the journal owner', async () => {
  const f = fixture()
  try {
    pendingJournal(f, 'bot-b')
    const { service, messages } = recoveryService(f, { status: 'empty' })
    await service.handleCraftRecovery('kelemiao')
    assert.equal(messages.length, 1)
    assert.match(messages[0], /没有待恢复/)
    assert.match(messages[0], /bot-b/)
  } finally { f.close() }
})

test('craft recovery keeps the original empty reply when no journal exists anywhere', async () => {
  const f = fixture()
  try {
    const { service, messages } = recoveryService(f, { status: 'empty' })
    await service.handleCraftRecovery('kelemiao')
    assert.deepEqual(messages, ['本机器人没有待恢复的合成任务。'])
  } finally { f.close() }
})

test('manual recovery tells the admin to review registered inventory diffs', async () => {
  const f = fixture()
  try {
    pendingJournal(f, 'bot-b')
    const { service, messages } = recoveryService(f, { status: 'recovered', diffRegistered: true })
    await service.handleCraftRecovery('kelemiao')
    assert.equal(messages.length, 1)
    assert.match(messages[0], /差异已登记库存异常/)
    assert.match(messages[0], /Web 管理页复核/)
  } finally { f.close() }
})

test('manual recovery keeps the plain success reply when no diff was registered', async () => {
  const f = fixture()
  try {
    pendingJournal(f, 'bot-b')
    const { service, messages } = recoveryService(f, { status: 'recovered', diffRegistered: false })
    await service.handleCraftRecovery('kelemiao')
    assert.deepEqual(messages, ['合成中断状态已核验，物品已回云仓；可重新提交合成。'])
  } finally { f.close() }
})

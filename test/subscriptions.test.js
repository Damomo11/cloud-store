const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const StoreDb = require('../src/db')
const SubscriptionManager = require('../src/subscriptions')

function createContext () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-subscriptions-'))
  const config = {
    admins: [],
    momoOwner: '__momo__',
    storage: { defaultQuotaSlots: 270, defaultCustomWarehouseQuotaSlots: 270 }
  }
  const db = new StoreDb(path.join(directory, 'store.sqlite'), config)
  return {
    db,
    config,
    directory,
    close: manager => {
      manager?.close()
      db.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

test('subscription migration preserves existing quotas while new warehouses use plans', () => {
  const context = createContext()
  context.db.upsertPlayer('uuid-old', 'OldPlayer')
  context.db.createPersonalWarehouse('uuid-old', 'OldPlayer', { username: 'admin' })
  context.db.createCustomWarehouse('OldVault', 'uuid-old', 'OldPlayer')
  const manager = new SubscriptionManager(context.db, context.config, { disableNetworkTime: true })

  assert.equal(manager.getOwnerEntitlement('uuid-old').quotaMode, 'custom')
  assert.equal(manager.getOwnerEntitlement('uuid-old').quotaSlots, 270)
  assert.equal(manager.getOwnerEntitlement('vault:oldvault').quotaSlots, 270)

  context.db.upsertPlayer('uuid-new', 'NewPlayer')
  context.db.setQuotaSlots('uuid-new', 270)
  context.db.createPersonalWarehouse('uuid-new', 'NewPlayer', { username: 'admin' })
  assert.equal(manager.getOwnerEntitlement('uuid-new').quotaMode, 'plan')
  assert.equal(manager.getOwnerEntitlement('uuid-new').quotaSlots, 27)
  context.close(manager)
})

test('admin player list only includes players with personal warehouses', () => {
  const context = createContext()
  const manager = new SubscriptionManager(context.db, context.config, { disableNetworkTime: true })
  context.db.upsertPlayer('uuid-with', 'WithWarehouse')
  context.db.upsertPlayer('uuid-without', 'WithoutWarehouse')
  context.db.createPersonalWarehouse('uuid-with', 'WithWarehouse', { username: 'admin' })

  const rows = manager.listAdminUsers()

  assert.deepEqual(rows.map(row => row.uuid), ['uuid-with'])
  context.close(manager)
})

test('payments, purchases, renewals, hot plan changes and cancellation use integer cents', () => {
  const context = createContext()
  const manager = new SubscriptionManager(context.db, context.config, { disableNetworkTime: true })
  const now = 1_800_000_000_000
  manager.networkTime.trusted = true
  manager.networkTime.now = () => now
  context.db.upsertPlayer('uuid-alice', 'Alice')
  context.db.createPersonalWarehouse('uuid-alice', 'Alice', { username: 'admin' })

  const payment = manager.handleSystemMessage('[12:36:38] [TSLLLLL] 你收到了来自 Alice 的 5.00 C', 'BotOne')
  assert.equal(payment.amountCents, 500)
  assert.equal(manager.getWallet('uuid-alice').balanceCents, 500)
  const paymentRecords = manager.listPaymentRecords()
  assert.equal(paymentRecords.total, 1)
  assert.equal(paymentRecords.rows[0].username, 'Alice')
  assert.equal(paymentRecords.rows[0].amountCents, 500)
  assert.equal(paymentRecords.rows[0].botName, 'BotOne')

  const first = manager.purchase({ uuid: 'uuid-alice', username: 'Alice' }, 'uuid-alice', 'personal_pro')
  assert.equal(first.priceCents, 299)
  assert.equal(first.wallet.balanceCents, 201)
  assert.equal(first.newExpiresAtMs, now + (30 * 24 * 60 * 60 * 1000))
  assert.equal(manager.getOwnerEntitlement('uuid-alice', now).quotaSlots, 270)

  manager.updatePlan('personal_pro', {
    name: '高级版', description: '热更新', quotaSlots: 300, priceCents: 199,
    features: ['300 格'], visible: true
  })
  assert.equal(manager.getOwnerEntitlement('uuid-alice', now).quotaSlots, 300)
  const renewed = manager.purchase({ uuid: 'uuid-alice', username: 'Alice' }, 'uuid-alice', 'personal_pro')
  assert.equal(renewed.priceCents, 199)
  assert.equal(renewed.wallet.balanceCents, 2)
  assert.equal(renewed.newExpiresAtMs, now + (60 * 24 * 60 * 60 * 1000))

  context.db.setQuotaSlots('uuid-alice', 999)
  assert.equal(manager.getOwnerEntitlement('uuid-alice', now).quotaSlots, 999)
  assert.equal(manager.restorePlanQuota('uuid-alice').quotaSlots, 300)
  const balanceBeforeCancel = manager.getWallet('uuid-alice').balanceCents
  manager.cancelSubscription('uuid-alice', { uuid: 'admin', username: 'Admin' })
  assert.equal(manager.getWallet('uuid-alice').balanceCents, balanceBeforeCancel)
  assert.equal(manager.getOwnerEntitlement('uuid-alice', now).activePlanId, 'personal_free')
  assert.equal(manager.getOwnerEntitlement('uuid-alice', now).quotaSlots, 27)
  context.close(manager)
})

test('automatic registration respects trigger switches and daily limit', () => {
  const context = createContext()
  const manager = new SubscriptionManager(context.db, context.config, { disableNetworkTime: true })
  manager.networkTime.trusted = true
  manager.networkTime.now = () => 1_800_000_000_000
  manager.updateSettings({
    ...manager.getSettings(),
    autoRegisterOnDeposit: true,
    autoRegisterOnWebLogin: false,
    dailyAutoRegistrationLimit: 1
  })
  context.db.upsertPlayer('uuid-a', 'PlayerA')
  context.db.upsertPlayer('uuid-b', 'PlayerB')
  assert.equal(manager.maybeAutoRegister({ uuid: 'uuid-a', username: 'PlayerA' }, 'deposit').changed, 1)
  assert.throws(() => manager.maybeAutoRegister({ uuid: 'uuid-b', username: 'PlayerB' }, 'deposit'), /名额已满/)
  assert.equal(manager.maybeAutoRegister({ uuid: 'uuid-b', username: 'PlayerB' }, 'web_login').reason, 'disabled')
  context.close(manager)
})

test('new server payment format is recognized and balance suffix is ignored', () => {
  const context = createContext()
  const manager = new SubscriptionManager(context.db, context.config, { disableNetworkTime: true })
  manager.networkTime.trusted = true
  manager.networkTime.now = () => 1_800_000_000_000
  context.db.upsertPlayer('uuid-amu', 'AMU471')

  const payment = manager.handleSystemMessage('✔ 收到「AMU471」转来的 5.00 TSLC，当前余额 29.00', 'BotOne')
  assert.equal(payment.matched, true)
  assert.equal(payment.player.username, 'AMU471')
  assert.equal(payment.amountCents, 500)
  assert.equal(manager.getWallet('uuid-amu').balanceCents, 500)

  const logs = manager.listUnrecognizedPaymentLogs()
  assert.equal(logs.length, 0)
  context.close(manager)
})

test('bot outgoing transfer receipt is not mistaken for a deposit', () => {
  const context = createContext()
  const manager = new SubscriptionManager(context.db, context.config, { disableNetworkTime: true })
  manager.networkTime.trusted = true
  manager.networkTime.now = () => 1_800_000_000_000
  context.db.upsertPlayer('uuid-nan', 'NanKinz2')

  // bot 向别人转账成功的回执：任何层都不能把它记成对方的充值。
  const outgoing = manager.handleSystemMessage('✔ 已向「NanKinz2」转账 25.00 TSLC，剩余 5.00', 'XMCBot01')
  assert.equal(outgoing.matched, false)
  assert.equal(manager.getWallet('uuid-nan').balanceCents, 0)
  // 「向你转账」是收款方向，不拦。
  const incoming = manager.handleSystemMessage('✔ 已向你转账 25.00 TSLC', 'XMCBot01')
  assert.equal(incoming.matched, false)
  // 转出措辞变体同样拦住。
  for (const text of ['已向 NanKinz2 转入 25.00 TSLC', '「NanKinz2」 转出 25.00 TSLC']) {
    assert.equal(manager.handleSystemMessage(text, 'XMCBot01').matched, false)
  }
  assert.equal(manager.getWallet('uuid-nan').balanceCents, 0)
  context.close(manager)
})

test('payment heuristic handles format variants, amounts and non-payment messages', () => {
  const context = createContext()
  const manager = new SubscriptionManager(context.db, context.config, { disableNetworkTime: true })
  manager.networkTime.trusted = true
  manager.networkTime.now = () => 1_800_000_000_000
  context.db.upsertPlayer('uuid-alice', 'Alice')
  context.db.upsertPlayer('uuid-bob', 'Bob')
  // 用一条绝不会命中的自定义正则，逼管道走到启发式层。
  manager.updateSettings({ ...manager.getSettings(), paymentRegex: String.raw`\[NEVER\]\s*(?<player>\S+)\s+的\s+(?<amount>\d+\.\d{2})\s+C` })

  assert.equal(manager.handleSystemMessage('收到来自 Alice 的 3.5 TSLC', 'BotOne').amountCents, 350)
  assert.equal(manager.handleSystemMessage('「Bob」 转入 5 TSLC', 'BotOne').amountCents, 500)
  assert.equal(manager.handleSystemMessage('✔ 收到「Alice」转来 0.5 TSLC，余额 1.00', 'BotOne').amountCents, 50)
  // 金额格式非法（三位小数）→ 不入账，进未识别日志。
  assert.equal(manager.handleSystemMessage('收到来自 Alice 的 5.555 TSLC', 'BotOne').matched, false)
  // 含关键词但不是到账消息 → 不入账，进未识别日志。
  assert.equal(manager.handleSystemMessage('你收到了一封邮件', 'BotOne').matched, false)
  // 与到账无关的 system 消息既不入账也不留日志。
  assert.equal(manager.handleSystemMessage('Steve 加入了游戏', 'BotOne').matched, false)
  const logs = manager.listUnrecognizedPaymentLogs()
  assert.equal(logs.length, 2)
  assert.ok(logs.every(row => row.message.includes('收到')))
  assert.equal(manager.getWallet('uuid-alice').balanceCents, 400)
  assert.equal(manager.getWallet('uuid-bob').balanceCents, 500)
  context.close(manager)
})

test('payment regex list matches per line and skips broken lines at runtime', () => {
  const context = createContext()
  const manager = new SubscriptionManager(context.db, context.config, { disableNetworkTime: true })
  manager.networkTime.trusted = true
  manager.networkTime.now = () => 1_800_000_000_000
  context.db.upsertPlayer('uuid-nan', 'NanKinz1')
  // 先用合法的两行过保存校验，再直接写 DB 把第一行改成语法坏行（模拟存量脏数据）：
  // 运行时应跳过坏行、由第二行命中。
  const validButNeverLine = String.raw`\[NEVER\]\s*(?<player>\S+)\s+(?<amount>\d+) 坏行`
  const goodLine = String.raw`\[TSLLLLL\]\s*你收到了来自\s+(?<player>\S+)\s+的\s+(?<amount>\d+(?:\.\d{1,2})?)\s*C`
  manager.updateSettings({ ...manager.getSettings(), paymentRegex: [validButNeverLine, goodLine].join('\n') })
  manager.setSetting('paymentRegex', [String.raw`\[NEVER\]\s*(?<player>\S+)(`, goodLine].join('\n'))

  const payment = manager.handleSystemMessage('[12:36:38] [TSLLLLL] 你收到了来自 NanKinz1 的 1.00 C', 'BotOne')
  assert.equal(payment.matched, true)
  assert.equal(payment.player.username, 'NanKinz1')
  assert.equal(payment.amountCents, 100)

  const probe = manager.testPaymentRegex(manager.getSettings().paymentRegex, '✔ 收到「AMU471」转来的 5.00 TSLC，当前余额 29.00')
  assert.equal(probe.matched, true)
  assert.equal(probe.lineIndex, 0)
  assert.equal(probe.player, 'AMU471')
  assert.equal(probe.amountCents, 500)
  context.close(manager)
})

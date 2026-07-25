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

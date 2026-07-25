const crypto = require('node:crypto')
const NetworkTime = require('./networkTime')

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_PAYMENT_REGEX = String.raw`\[TSLLLLL\]\s*你收到了来自\s+(?<player>\S+)\s+的\s+(?<amount>\d+\.\d{2})\s+C`

const DEFAULT_SETTINGS = {
  autoRegisterOnDeposit: false,
  autoRegisterOnWebLogin: false,
  dailyAutoRegistrationLimit: -1,
  maxCustomWarehousesPerPlayer: 1,
  paymentRegex: DEFAULT_PAYMENT_REGEX,
  paymentSummaryWindowMs: 5000,
  paymentMessageIntervalMs: 1200,
  paymentLogRetentionDays: 100,
  networkTimeSources: ['ntp.aliyun.com', 'ntp.tencent.com'],
  networkTimeSyncIntervalMs: 60 * 60 * 1000
}

const DEFAULT_PLANS = [
  {
    id: 'personal_free',
    scope: 'personal',
    name: '免费版',
    description: '适合轻量存储和初次体验',
    quotaSlots: 27,
    priceCents: 0,
    features: ['27 格个人仓库', '长期有效', '基础存取功能'],
    visible: true,
    sortOrder: 10
  },
  {
    id: 'personal_pro',
    scope: 'personal',
    name: '高级版',
    description: '为高频玩家提供更充裕的个人空间',
    quotaSlots: 270,
    priceCents: 299,
    features: ['270 格个人仓库', '固定 30 天有效期', '支持提前续费'],
    visible: true,
    sortOrder: 20
  },
  {
    id: 'organization_pro',
    scope: 'custom',
    name: '高级版',
    description: '适合团队共同管理和共享物资',
    quotaSlots: 540,
    priceCents: 799,
    features: ['540 格组织仓库', '多管理员共同续费', '固定 30 天有效期'],
    visible: true,
    sortOrder: 30
  }
]

class SubscriptionManager {
  constructor (db, config = {}, options = {}) {
    this.db = db
    this.config = config
    this.paymentSummaries = new Map()
    this.outgoingQueue = []
    this.outgoingTimer = null
    this.cleanupTimer = null
    this.initDefaults()
    const settings = this.getSettings()
    this.networkTime = new NetworkTime({
      sources: settings.networkTimeSources,
      intervalMs: settings.networkTimeSyncIntervalMs,
      loadPersisted: () => this.getSetting('networkTimeState', null),
      savePersisted: value => this.setSetting('networkTimeState', value)
    })
    if (!options.disableNetworkTime) this.networkTime.start()
    this.cleanupUnrecognizedPaymentLogs()
    this.cleanupTimer = setInterval(() => this.cleanupUnrecognizedPaymentLogs(), 24 * 60 * 60 * 1000)
    this.cleanupTimer.unref?.()
  }

  close () {
    this.networkTime.stop()
    for (const summary of this.paymentSummaries.values()) clearTimeout(summary.timer)
    if (this.outgoingTimer) clearTimeout(this.outgoingTimer)
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
  }

  initDefaults () {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      this.db.db.prepare(`
        INSERT OR IGNORE INTO subscription_settings (key, value_json)
        VALUES (?, ?)
      `).run(key, JSON.stringify(value))
    }
    for (const plan of DEFAULT_PLANS) {
      this.db.db.prepare(`
        INSERT OR IGNORE INTO subscription_plans (
          id, scope, name, description, quota_slots, price_cents,
          features_json, visible, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(plan.id, plan.scope, plan.name, plan.description, plan.quotaSlots, plan.priceCents, JSON.stringify(plan.features), plan.visible ? 1 : 0, plan.sortOrder)
    }
    if (!this.getSetting('legacyQuotaMigrationComplete', false)) {
      const personalDefault = Number(this.config.storage?.defaultQuotaSlots || 270)
      const customDefault = Number(this.config.storage?.defaultCustomWarehouseQuotaSlots || personalDefault)
      this.db.transaction(() => {
        this.db.db.prepare(`
          INSERT OR IGNORE INTO player_quotas (owner_uuid, quota_slots)
          SELECT owner_uuid, ? FROM personal_warehouses
        `).run(personalDefault)
        this.db.db.prepare(`
          INSERT OR IGNORE INTO player_quotas (owner_uuid, quota_slots)
          SELECT 'vault:' || name_lower, ? FROM custom_warehouses
        `).run(customDefault)
        this.setSetting('legacyQuotaMigrationComplete', true)
      })
    }
  }

  getSetting (key, fallback = null) {
    const row = this.db.db.prepare('SELECT value_json AS valueJson FROM subscription_settings WHERE key = ?').get(key)
    if (!row) return fallback
    try { return JSON.parse(row.valueJson) } catch { return fallback }
  }

  setSetting (key, value) {
    this.db.db.prepare(`
      INSERT INTO subscription_settings (key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(key, JSON.stringify(value))
  }

  getSettings () {
    const result = { ...DEFAULT_SETTINGS }
    for (const row of this.db.db.prepare('SELECT key, value_json AS valueJson FROM subscription_settings').all()) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, row.key)) continue
      try { result[row.key] = JSON.parse(row.valueJson) } catch {}
    }
    return result
  }

  updateSettings (input = {}) {
    const current = this.getSettings()
    const next = {
      autoRegisterOnDeposit: Boolean(input.autoRegisterOnDeposit),
      autoRegisterOnWebLogin: Boolean(input.autoRegisterOnWebLogin),
      dailyAutoRegistrationLimit: this.integer(input.dailyAutoRegistrationLimit, -1, 100000, '每日自动注册上限'),
      maxCustomWarehousesPerPlayer: this.integer(input.maxCustomWarehousesPerPlayer, 0, 1000, '组织仓库创建上限'),
      paymentRegex: String(input.paymentRegex || '').trim(),
      paymentSummaryWindowMs: this.integer(input.paymentSummaryWindowMs, 500, 600000, '到账汇总时间'),
      paymentMessageIntervalMs: this.integer(input.paymentMessageIntervalMs, 250, 60000, '发信间隔'),
      paymentLogRetentionDays: this.integer(input.paymentLogRetentionDays, 1, 3650, '日志保留天数'),
      networkTimeSources: (Array.isArray(input.networkTimeSources) ? input.networkTimeSources : String(input.networkTimeSources || '').split(','))
        .map(value => String(value || '').trim()).filter(Boolean),
      networkTimeSyncIntervalMs: this.integer(input.networkTimeSyncIntervalMs, 60000, 7 * 24 * 60 * 60 * 1000, '时间同步间隔')
    }
    if (!next.paymentRegex) throw new Error('充值正则不能为空。')
    this.compilePaymentRegex(next.paymentRegex)
    if (!next.networkTimeSources.length) throw new Error('至少需要一个网络时间源。')
    for (const key of Object.keys(DEFAULT_SETTINGS)) this.setSetting(key, next[key])
    this.networkTime.configure({ sources: next.networkTimeSources, intervalMs: next.networkTimeSyncIntervalMs })
    this.cleanupUnrecognizedPaymentLogs()
    return { ...current, ...next }
  }

  integer (value, min, max, label) {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label}必须是 ${min} 到 ${max} 的整数。`)
    return parsed
  }

  planRow (row) {
    if (!row) return null
    let features = []
    try { features = JSON.parse(row.featuresJson || '[]') } catch {}
    return {
      id: row.id,
      scope: row.scope,
      name: row.name,
      description: row.description,
      quotaSlots: Number(row.quotaSlots),
      priceCents: Number(row.priceCents),
      price: this.formatCents(row.priceCents),
      features,
      visible: Boolean(row.visible),
      sortOrder: Number(row.sortOrder || 0)
    }
  }

  listPlans (options = {}) {
    const where = options.visibleOnly ? 'WHERE visible = 1' : ''
    return this.db.db.prepare(`
      SELECT id, scope, name, description, quota_slots AS quotaSlots,
             price_cents AS priceCents, features_json AS featuresJson,
             visible, sort_order AS sortOrder
      FROM subscription_plans ${where}
      ORDER BY sort_order ASC, id ASC
    `).all().map(row => this.planRow(row))
  }

  getPlan (id) {
    return this.planRow(this.db.db.prepare(`
      SELECT id, scope, name, description, quota_slots AS quotaSlots,
             price_cents AS priceCents, features_json AS featuresJson,
             visible, sort_order AS sortOrder
      FROM subscription_plans WHERE id = ?
    `).get(id))
  }

  updatePlan (id, input = {}) {
    const existing = this.getPlan(id)
    if (!existing) throw new Error('找不到套餐。')
    const name = String(input.name || '').trim()
    const description = String(input.description || '').trim()
    const quotaSlots = this.integer(input.quotaSlots, 0, 1000000, '套餐额度')
    const priceCents = this.integer(input.priceCents, 0, 100000000, '套餐价格')
    const features = (Array.isArray(input.features) ? input.features : String(input.features || '').split('\n'))
      .map(value => String(value || '').trim()).filter(Boolean).slice(0, 5)
    const visible = id === 'personal_free' ? true : Boolean(input.visible)
    if (!name) throw new Error('套餐名称不能为空。')
    if (id === 'personal_free' && priceCents !== 0) throw new Error('个人免费版价格必须为 0。')
    this.db.db.prepare(`
      UPDATE subscription_plans
      SET name = ?, description = ?, quota_slots = ?, price_cents = ?,
          features_json = ?, visible = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name, description, quotaSlots, priceCents, JSON.stringify(features), visible ? 1 : 0, id)
    return this.getPlan(id)
  }

  compilePaymentRegex (source) {
    let regex
    try { regex = new RegExp(source, 'i') } catch (error) { throw new Error(`充值正则无效：${error.message}`) }
    if (!String(source).includes('(?<player>') || !String(source).includes('(?<amount>')) {
      throw new Error('充值正则必须包含命名捕获组 player 和 amount。')
    }
    return regex
  }

  testPaymentRegex (source, sample) {
    const regex = this.compilePaymentRegex(source)
    const match = regex.exec(String(sample || ''))
    return {
      matched: Boolean(match),
      player: match?.groups?.player || '',
      amount: match?.groups?.amount || ''
    }
  }

  handleSystemMessage (message, botName, sendNotice) {
    const text = String(message || '').trim()
    if (!text) return { matched: false }
    const regex = this.compilePaymentRegex(this.getSettings().paymentRegex)
    const match = regex.exec(text)
    if (!match) {
      if (text.includes('收到')) this.saveUnrecognizedPaymentLog(botName, text)
      return { matched: false }
    }
    const username = String(match.groups.player || '').trim()
    const amountText = String(match.groups.amount || '').trim()
    if (!username || !/^\d+\.\d{2}$/.test(amountText)) {
      this.saveUnrecognizedPaymentLog(botName, text)
      return { matched: false }
    }
    const amountCents = Number.parseInt(amountText.replace('.', ''), 10)
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      this.saveUnrecognizedPaymentLog(botName, text)
      return { matched: false }
    }
    const player = this.resolveWalletIdentity(username)
    const wallet = this.adjustBalance(player.uuid, player.username, amountCents, {
      type: 'server_payment',
      referenceType: 'minecraft_bot',
      referenceId: String(botName || ''),
      message: text,
      now: this.networkTime.trusted ? this.networkTime.now() : Date.now()
    })
    this.queuePaymentSummary(player.username, amountCents, wallet.balanceCents, sendNotice)
    return { matched: true, player, amountCents, balanceCents: wallet.balanceCents }
  }

  resolveWalletIdentity (username) {
    const clean = String(username || '').trim()
    const realPlayers = this.db.db.prepare(`
      SELECT uuid, username FROM players
      WHERE uuid NOT LIKE 'name:%' AND lower(username) = lower(?)
      ORDER BY last_seen_at DESC
    `).all(clean)
    if (realPlayers.length === 1) return realPlayers[0]
    const player = { uuid: `name:${clean}`, username: clean }
    this.db.upsertPlayer(player.uuid, player.username)
    if (realPlayers.length > 1) {
      const exists = this.db.db.prepare(`
        SELECT 1 FROM wallet_identity_conflicts
        WHERE lower(username) = lower(?) AND ghost_uuid = ? AND status = 'open'
        LIMIT 1
      `).get(clean, player.uuid)
      if (!exists) {
        this.db.db.prepare(`
          INSERT INTO wallet_identity_conflicts (username, ghost_uuid, real_uuid, created_at_ms)
          VALUES (?, ?, ?, ?)
        `).run(clean, player.uuid, realPlayers.map(row => row.uuid).join(','), this.networkTime.trusted ? this.networkTime.now() : Date.now())
      }
    }
    return player
  }

  ensureWallet (playerUuid, username) {
    this.db.db.prepare(`
      INSERT INTO wallet_accounts (player_uuid, username, balance_cents)
      VALUES (?, ?, 0)
      ON CONFLICT(player_uuid) DO UPDATE SET username = excluded.username, updated_at = CURRENT_TIMESTAMP
    `).run(playerUuid, username)
    return this.getWallet(playerUuid, username)
  }

  getWallet (playerUuid, username = '') {
    const row = this.db.db.prepare(`
      SELECT player_uuid AS playerUuid, username, balance_cents AS balanceCents,
             updated_at AS updatedAt
      FROM wallet_accounts WHERE player_uuid = ?
    `).get(playerUuid)
    if (!row) return { playerUuid, username, balanceCents: 0, balance: '0.00' }
    return { ...row, balanceCents: Number(row.balanceCents), balance: this.formatCents(row.balanceCents) }
  }

  adjustBalance (playerUuid, username, amountCents, meta = {}) {
    const amount = Number(amountCents)
    if (!Number.isSafeInteger(amount)) throw new Error('余额变动金额无效。')
    return this.db.transaction(() => this.adjustBalanceInTransaction(playerUuid, username, amount, meta))
  }

  adjustBalanceInTransaction (playerUuid, username, amountCents, meta = {}) {
    this.ensureWallet(playerUuid, username)
    const before = this.getWallet(playerUuid, username)
    const afterCents = before.balanceCents + amountCents
    if (afterCents < 0) throw new Error('TSLC 余额不足。')
    this.db.db.prepare(`
      UPDATE wallet_accounts SET username = ?, balance_cents = ?, updated_at = CURRENT_TIMESTAMP
      WHERE player_uuid = ?
    `).run(username, afterCents, playerUuid)
    const now = Number(meta.now || (this.networkTime.trusted ? this.networkTime.now() : Date.now()))
    this.db.db.prepare(`
      INSERT INTO wallet_ledger (
        player_uuid, username, type, amount_cents, balance_before_cents,
        balance_after_cents, reference_type, reference_id, admin_uuid,
        admin_username, message, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(playerUuid, username, meta.type || 'admin_adjust', amountCents, before.balanceCents, afterCents,
      meta.referenceType || '', meta.referenceId || '', meta.adminUuid || '', meta.adminUsername || '', meta.message || '', now)
    return { playerUuid, username, balanceCents: afterCents, balance: this.formatCents(afterCents) }
  }

  setBalance (playerUuid, username, balanceCents, meta = {}) {
    const next = Number(balanceCents)
    if (!Number.isSafeInteger(next) || next < 0) throw new Error('余额必须是大于等于 0 的整数分。')
    const current = this.getWallet(playerUuid, username)
    return this.adjustBalance(playerUuid, username, next - current.balanceCents, { ...meta, type: meta.type || 'admin_set_balance' })
  }

  queuePaymentSummary (username, amountCents, balanceCents, sendNotice) {
    if (typeof sendNotice !== 'function') return
    const key = String(username || '').toLowerCase()
    const settings = this.getSettings()
    const current = this.paymentSummaries.get(key) || { username, count: 0, amountCents: 0, balanceCents, sendNotice, timer: null }
    current.count++
    current.amountCents += amountCents
    current.balanceCents = balanceCents
    current.sendNotice = sendNotice
    if (current.timer) clearTimeout(current.timer)
    current.timer = setTimeout(() => {
      this.paymentSummaries.delete(key)
      this.enqueueOutgoing(() => current.sendNotice(current.username,
        `充值到账：${current.count} 笔，共 ${this.formatCents(current.amountCents)} TSLC，当前余额 ${this.formatCents(current.balanceCents)} TSLC。`))
    }, settings.paymentSummaryWindowMs)
    current.timer.unref?.()
    this.paymentSummaries.set(key, current)
  }

  enqueueOutgoing (fn) {
    this.outgoingQueue.push(fn)
    if (!this.outgoingTimer) this.drainOutgoing()
  }

  drainOutgoing () {
    const fn = this.outgoingQueue.shift()
    if (!fn) {
      this.outgoingTimer = null
      return
    }
    try { fn() } catch (error) { console.error('[subscription] payment notice failed:', error) }
    this.outgoingTimer = setTimeout(() => this.drainOutgoing(), this.getSettings().paymentMessageIntervalMs)
    this.outgoingTimer.unref?.()
  }

  saveUnrecognizedPaymentLog (botName, message) {
    const now = this.networkTime.trusted ? this.networkTime.now() : Date.now()
    this.db.db.prepare(`
      INSERT INTO unrecognized_payment_logs (bot_name, message, created_at_ms)
      VALUES (?, ?, ?)
    `).run(String(botName || ''), String(message || ''), now)
  }

  cleanupUnrecognizedPaymentLogs () {
    const days = Number(this.getSettings().paymentLogRetentionDays || 100)
    const cutoff = (this.networkTime?.trusted ? this.networkTime.now() : Date.now()) - (days * 24 * 60 * 60 * 1000)
    return this.db.db.prepare('DELETE FROM unrecognized_payment_logs WHERE created_at_ms < ?').run(cutoff).changes
  }

  listUnrecognizedPaymentLogs (limit = 200) {
    return this.db.db.prepare(`
      SELECT id, bot_name AS botName, message, created_at_ms AS createdAtMs, created_at AS createdAt
      FROM unrecognized_payment_logs ORDER BY id DESC LIMIT ?
    `).all(Math.max(1, Math.min(1000, Number(limit) || 200)))
  }

  listPaymentRecords (options = {}) {
    const pageSize = Math.max(1, Math.min(200, Number(options.pageSize) || 100))
    const total = Number(this.db.db.prepare(`
      SELECT COUNT(*) AS count FROM wallet_ledger WHERE type = 'server_payment'
    `).get()?.count || 0)
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const page = Math.max(1, Math.min(totalPages, Number(options.page) || 1))
    const rows = this.db.db.prepare(`
      SELECT id, player_uuid AS playerUuid, username, amount_cents AS amountCents,
             balance_after_cents AS balanceAfterCents, reference_id AS botName,
             message, created_at_ms AS createdAtMs
      FROM wallet_ledger
      WHERE type = 'server_payment'
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(pageSize, (page - 1) * pageSize).map(row => ({
      ...row,
      amountCents: Number(row.amountCents),
      balanceAfterCents: Number(row.balanceAfterCents)
    }))
    return { rows, page, pageSize, total, totalPages }
  }

  listIdentityConflicts (limit = 200) {
    return this.db.db.prepare(`
      SELECT id, username, ghost_uuid AS ghostUuid, real_uuid AS realUuid,
             status, created_at_ms AS createdAtMs
      FROM wallet_identity_conflicts
      WHERE status = 'open' ORDER BY id DESC LIMIT ?
    `).all(Math.max(1, Math.min(1000, Number(limit) || 200)))
  }

  maybeAutoRegister (player, trigger) {
    if (this.db.hasPersonalWarehouse(player.uuid)) return { changed: false, reason: 'exists' }
    const settings = this.getSettings()
    const enabled = trigger === 'deposit' ? settings.autoRegisterOnDeposit : settings.autoRegisterOnWebLogin
    if (!enabled) return { changed: false, reason: 'disabled' }
    const now = this.networkTime.assertTrusted()
    const dayKey = this.beijingDayKey(now)
    const limit = Number(settings.dailyAutoRegistrationLimit)
    return this.db.transaction(() => {
      const row = this.db.db.prepare('SELECT registration_count AS count FROM auto_registration_daily WHERE day_key = ?').get(dayKey)
      const count = Number(row?.count || 0)
      if (limit >= 0 && count >= limit) {
        const error = new Error('今日个人仓库自动注册名额已满，请联系管理员。')
        error.code = 'AUTO_REGISTRATION_LIMIT'
        throw error
      }
      const result = this.db.createPersonalWarehouse(player.uuid, player.username, { username: `自动注册:${trigger}` })
      if (result.changed) {
        this.db.db.prepare(`
          INSERT INTO auto_registration_daily (day_key, registration_count, updated_at)
          VALUES (?, 1, CURRENT_TIMESTAMP)
          ON CONFLICT(day_key) DO UPDATE SET
            registration_count = registration_count + 1,
            updated_at = CURRENT_TIMESTAMP
        `).run(dayKey)
      }
      return { ...result, reason: result.changed ? 'created' : 'exists' }
    })
  }

  beijingDayKey (timestamp) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp))
  }

  ownerScope (ownerUuid) {
    return String(ownerUuid || '').startsWith('vault:') ? 'custom' : 'personal'
  }

  getOwnerEntitlement (ownerUuid, now = null) {
    const timestamp = now === null || now === undefined
      ? (this.networkTime.trusted ? this.networkTime.now() : 0)
      : Number(now)
    const scope = this.ownerScope(ownerUuid)
    const override = this.db.getQuotaOverride(ownerUuid)
    const warehouseExists = scope === 'custom'
      ? Boolean(this.db.getCustomWarehouse(String(ownerUuid).slice(6)))
      : this.db.hasPersonalWarehouse(ownerUuid)
    if (!warehouseExists) {
      const fallbackQuota = scope === 'custom'
        ? 0
        : Number(this.config.storage?.defaultQuotaSlots || 270)
      return {
        ownerUuid,
        scope,
        status: 'system',
        plan: null,
        activePlanId: '',
        expiresAtMs: 0,
        cancelledAtMs: 0,
        quotaMode: override ? 'custom' : 'system',
        quotaSlots: override ? Number(override.quotaSlots) : fallbackQuota,
        overrideQuotaSlots: override ? Number(override.quotaSlots) : null
      }
    }
    const subscription = this.db.db.prepare(`
      SELECT owner_uuid AS ownerUuid, plan_id AS planId, expires_at_ms AS expiresAtMs,
             cancelled_at_ms AS cancelledAtMs, updated_at_ms AS updatedAtMs
      FROM warehouse_subscriptions WHERE owner_uuid = ?
    `).get(ownerUuid)
    const active = Boolean(subscription && !Number(subscription.cancelledAtMs) && Number(subscription.expiresAtMs) > timestamp)
    let plan = active ? this.getPlan(subscription.planId) : null
    if (!plan || plan.scope !== scope) plan = scope === 'personal' ? this.getPlan('personal_free') : null
    const quotaSlots = override ? Number(override.quotaSlots) : Number(plan?.quotaSlots || 0)
    const status = scope === 'custom' && !active ? 'unsubscribed' : (active ? 'active' : 'free')
    return {
      ownerUuid,
      scope,
      status,
      plan,
      activePlanId: active ? subscription.planId : (scope === 'personal' ? 'personal_free' : ''),
      expiresAtMs: active ? Number(subscription.expiresAtMs) : 0,
      cancelledAtMs: Number(subscription?.cancelledAtMs || 0),
      quotaMode: override ? 'custom' : 'plan',
      quotaSlots,
      overrideQuotaSlots: override ? Number(override.quotaSlots) : null
    }
  }

  purchase (payer, ownerUuid, planId) {
    const now = this.networkTime.assertTrusted()
    const plan = this.getPlan(planId)
    if (!plan || plan.id === 'personal_free' || !plan.visible) throw new Error('这个套餐当前不可购买。')
    const scope = this.ownerScope(ownerUuid)
    if (plan.scope !== scope) throw new Error('套餐与仓库类型不匹配。')
    if (scope === 'personal') {
      if (ownerUuid !== payer.uuid || !this.db.hasPersonalWarehouse(payer.uuid)) throw new Error('只能为自己的个人仓库购买套餐。')
    } else {
      const warehouse = this.db.getCustomWarehouse(ownerUuid.slice(6))
      if (!warehouse) throw new Error('找不到组织仓库。')
      if (!this.db.isCustomWarehouseAdmin(warehouse.name, payer.uuid)) throw new Error('只有仓库管理员可以购买或续费。')
    }
    return this.db.transaction(() => {
      const current = this.db.db.prepare(`
        SELECT expires_at_ms AS expiresAtMs, cancelled_at_ms AS cancelledAtMs
        FROM warehouse_subscriptions WHERE owner_uuid = ?
      `).get(ownerUuid)
      const previousExpiresAtMs = current && !Number(current.cancelledAtMs) && Number(current.expiresAtMs) > now
        ? Number(current.expiresAtMs)
        : now
      const newExpiresAtMs = previousExpiresAtMs + THIRTY_DAYS_MS
      const orderId = crypto.randomUUID()
      this.adjustBalanceInTransaction(payer.uuid, payer.username, -plan.priceCents, {
        type: 'subscription_purchase',
        referenceType: 'subscription_order',
        referenceId: orderId,
        message: `${ownerUuid}:${plan.id}`,
        now
      })
      this.db.db.prepare(`
        INSERT INTO subscription_orders (
          id, owner_uuid, plan_id, payer_uuid, payer_username, price_cents,
          duration_ms, previous_expires_at_ms, new_expires_at_ms,
          plan_name_snapshot, quota_slots_snapshot, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(orderId, ownerUuid, plan.id, payer.uuid, payer.username, plan.priceCents,
        THIRTY_DAYS_MS, previousExpiresAtMs, newExpiresAtMs, plan.name, plan.quotaSlots, now)
      this.db.db.prepare(`
        INSERT INTO warehouse_subscriptions (owner_uuid, plan_id, expires_at_ms, cancelled_at_ms, updated_at_ms, updated_at)
        VALUES (?, ?, ?, 0, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(owner_uuid) DO UPDATE SET
          plan_id = excluded.plan_id,
          expires_at_ms = excluded.expires_at_ms,
          cancelled_at_ms = 0,
          updated_at_ms = excluded.updated_at_ms,
          updated_at = CURRENT_TIMESTAMP
      `).run(ownerUuid, plan.id, newExpiresAtMs, now)
      return {
        orderId,
        ownerUuid,
        plan,
        priceCents: plan.priceCents,
        newExpiresAtMs,
        wallet: this.getWallet(payer.uuid, payer.username),
        entitlement: this.getOwnerEntitlement(ownerUuid, now)
      }
    })
  }

  cancelSubscription (ownerUuid, admin) {
    const now = this.networkTime.trusted ? this.networkTime.now() : Date.now()
    return this.db.transaction(() => {
      const current = this.db.db.prepare(`
        SELECT plan_id AS planId, expires_at_ms AS expiresAtMs, cancelled_at_ms AS cancelledAtMs
        FROM warehouse_subscriptions WHERE owner_uuid = ?
      `).get(ownerUuid)
      if (!current || Number(current.cancelledAtMs) || Number(current.expiresAtMs) <= now) throw new Error('这个仓库当前没有生效中的付费订阅。')
      this.db.db.prepare(`
        UPDATE warehouse_subscriptions
        SET expires_at_ms = ?, cancelled_at_ms = ?, updated_at_ms = ?, updated_at = CURRENT_TIMESTAMP
        WHERE owner_uuid = ?
      `).run(now, now, now, ownerUuid)
      this.db.db.prepare(`
        INSERT INTO subscription_cancellations (
          owner_uuid, plan_id, previous_expires_at_ms, admin_uuid, admin_username, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(ownerUuid, current.planId, current.expiresAtMs, admin.uuid || '', admin.username || '', now)
      return this.getOwnerEntitlement(ownerUuid, now)
    })
  }

  restorePlanQuota (ownerUuid) {
    this.db.clearQuotaSlots(ownerUuid)
    return this.getOwnerEntitlement(ownerUuid)
  }

  createOrganization (user, name) {
    const clean = String(name || '').trim()
    if (!clean) throw new Error('组织仓库名不能为空。')
    if (/\s/.test(clean)) throw new Error('组织仓库名不能包含空格。')
    if ([...clean].length > 15) throw new Error('组织仓库名最多 15 个字。')
    if (this.db.getCustomWarehouse(clean)) throw new Error(`仓库名已存在：${clean}`)
    const max = Number(this.getSettings().maxCustomWarehousesPerPlayer)
    const count = this.db.countWarehousesCreatedBy(user.uuid)
    if (max >= 0 && count >= max) throw new Error(`每位玩家最多创建 ${max} 个组织仓库。`)
    this.db.createCustomWarehouse(clean, user.uuid, user.username)
    return this.db.getCustomWarehouse(clean)
  }

  mySubscriptionData (user) {
    this.ensureWallet(user.uuid, user.username)
    const personalOwnerUuid = this.db.hasPersonalWarehouse(user.uuid) ? user.uuid : ''
    const organizations = this.db.listCustomWarehousesForPlayer(user.uuid)
      .filter(row => row.role === 'admin')
      .map(row => ({ ...row, ownerUuid: `vault:${row.nameLower}`, entitlement: this.getOwnerEntitlement(`vault:${row.nameLower}`) }))
    const permittedOwners = new Set([user.uuid, ...organizations.map(row => row.ownerUuid)])
    const ownerEntitlements = {}
    for (const owner of this.db.listWebOwnersForUser(user)) ownerEntitlements[owner.ownerUuid] = this.getOwnerEntitlement(owner.ownerUuid)
    const orders = this.db.db.prepare(`
      SELECT id, owner_uuid AS ownerUuid, plan_id AS planId, payer_uuid AS payerUuid,
             payer_username AS payerUsername, price_cents AS priceCents,
             duration_ms AS durationMs, previous_expires_at_ms AS previousExpiresAtMs,
             new_expires_at_ms AS newExpiresAtMs, plan_name_snapshot AS planName,
             quota_slots_snapshot AS quotaSlots, status, created_at_ms AS createdAtMs
      FROM subscription_orders
      WHERE payer_uuid = ? OR owner_uuid IN (${[...permittedOwners].map(() => '?').join(',')})
      ORDER BY created_at_ms DESC LIMIT 200
    `).all(user.uuid, ...permittedOwners)
    return {
      wallet: this.getWallet(user.uuid, user.username),
      plans: this.listPlans({ visibleOnly: true }),
      personal: personalOwnerUuid ? this.getOwnerEntitlement(personalOwnerUuid) : null,
      organizations,
      ownerEntitlements,
      canCreateOrganization: this.db.countWarehousesCreatedBy(user.uuid) < Number(this.getSettings().maxCustomWarehousesPerPlayer),
      organizationLimit: Number(this.getSettings().maxCustomWarehousesPerPlayer),
      orders: orders.map(row => ({ ...row, price: this.formatCents(row.priceCents) })),
      time: this.networkTime.status()
    }
  }

  listAdminUsers (query = '') {
    const q = String(query || '').trim().toLowerCase()
    return this.db.db.prepare(`
      SELECT p.uuid, p.username, p.last_seen_at AS lastSeenAt,
             COALESCE(w.balance_cents, 0) AS balanceCents,
             CASE WHEN pw.owner_uuid IS NULL THEN 0 ELSE 1 END AS hasPersonalWarehouse
      FROM players p
      LEFT JOIN wallet_accounts w ON w.player_uuid = p.uuid
      LEFT JOIN personal_warehouses pw ON pw.owner_uuid = p.uuid
      WHERE pw.owner_uuid IS NOT NULL
      ORDER BY p.username COLLATE NOCASE ASC
    `).all().filter(row => !q || row.username.toLowerCase().includes(q) || row.uuid.toLowerCase().includes(q)).map(row => ({
      ...row,
      balanceCents: Number(row.balanceCents),
      balance: this.formatCents(row.balanceCents),
      hasPersonalWarehouse: Boolean(row.hasPersonalWarehouse),
      personal: row.hasPersonalWarehouse ? this.getOwnerEntitlement(row.uuid) : null
    }))
  }

  adminUserDetail (playerUuid) {
    const player = this.db.db.prepare('SELECT uuid, username, last_seen_at AS lastSeenAt FROM players WHERE uuid = ?').get(playerUuid)
    if (!player) throw new Error('找不到玩家。')
    this.ensureWallet(player.uuid, player.username)
    const organizations = this.db.listCustomWarehousesForPlayer(player.uuid)
      .filter(row => row.role === 'admin')
      .map(row => ({ ...row, ownerUuid: `vault:${row.nameLower}`, entitlement: this.getOwnerEntitlement(`vault:${row.nameLower}`) }))
    const ledger = this.db.db.prepare(`
      SELECT id, type, amount_cents AS amountCents, balance_before_cents AS balanceBeforeCents,
             balance_after_cents AS balanceAfterCents, reference_type AS referenceType,
             reference_id AS referenceId, admin_username AS adminUsername, message,
             created_at_ms AS createdAtMs
      FROM wallet_ledger WHERE player_uuid = ? ORDER BY id DESC LIMIT 200
    `).all(player.uuid)
    const orders = this.db.db.prepare(`
      SELECT id, owner_uuid AS ownerUuid, plan_id AS planId, payer_username AS payerUsername,
             price_cents AS priceCents, new_expires_at_ms AS newExpiresAtMs,
             plan_name_snapshot AS planName, quota_slots_snapshot AS quotaSlots,
             status, created_at_ms AS createdAtMs
      FROM subscription_orders WHERE payer_uuid = ? ORDER BY created_at_ms DESC LIMIT 200
    `).all(player.uuid)
    return {
      player,
      wallet: this.getWallet(player.uuid, player.username),
      personal: this.db.hasPersonalWarehouse(player.uuid) ? this.getOwnerEntitlement(player.uuid) : null,
      organizations,
      ledger,
      orders
    }
  }

  formatCents (value) {
    return (Number(value || 0) / 100).toFixed(2)
  }
}

module.exports = SubscriptionManager

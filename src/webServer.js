const http = require('node:http')
const crypto = require('node:crypto')
const path = require('node:path')
const { parseLitematicData } = require('../scripts/litematic-materials')

class CloudStoreWebServer {
  constructor (db, config, serviceProvider) {
    this.db = db
    this.config = config
    this.serviceProvider = serviceProvider
    this.sessions = new Map()
    this.loginFailures = new Map()
    this.loginChallenges = new Map()
    this.server = null
    this.lastSessionCleanupAt = 0
  }

  start () {
    if (this.server || this.config.web?.enabled === false) return
    const { host, port } = this.resolveListenOptions()
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.listen(port, host, () => {
      const actualPort = this.server.address()?.port || port
      console.log(`[web] cloud store panel listening on ${this.publicUrl(actualPort)}`)
    })
  }

  resolveListenOptions () {
    const host = this.config.web?.host || '127.0.0.1'
    let port = Number.parseInt(this.config.web?.port, 10)
    if (!Number.isFinite(port)) {
      try {
        port = Number.parseInt(new URL(this.config.web?.dashboardUrl || '').port, 10)
      } catch {
        port = NaN
      }
    }
    return { host, port: Number.isFinite(port) ? port : 8787 }
  }

  publicUrl (actualPort = null) {
    const configured = String(this.config.web?.dashboardUrl || '').trim()
    if (configured) return configured
    const { host, port } = this.resolveListenOptions()
    const displayHost = ['0.0.0.0', '::', '[::]'].includes(host) ? '127.0.0.1' : host
    const parsedActualPort = actualPort === null || actualPort === undefined ? NaN : Number(actualPort)
    const finalPort = Number.isFinite(parsedActualPort) ? parsedActualPort : port
    const hostText = displayHost.includes(':') && !displayHost.startsWith('[') ? `[${displayHost}]` : displayHost
    const portText = finalPort === 80 ? '' : `:${finalPort}`
    return `http://${hostText}${portText}/`
  }

  async handle (req, res) {
    const url = new URL(req.url, 'http://localhost')
    const session = this.getSession(req, res)
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) return this.sendHtml(res, HTML)
      if (req.method === 'GET' && url.pathname === '/api/me') return this.sendJson(res, this.apiMe(session))
      if (req.method === 'GET' && url.pathname === '/api/inventory') return this.sendJson(res, this.apiInventory(session, url))
      if (req.method === 'GET' && url.pathname === '/api/online-players') return this.sendJson(res, this.apiOnlinePlayers(session, url))
      if (req.method === 'GET' && url.pathname === '/api/transactions') return this.sendJson(res, this.apiTransactions(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/owners') return this.sendJson(res, this.apiAdminOwners(session))
      if (req.method === 'GET' && url.pathname === '/api/admin/inventory') return this.sendJson(res, this.apiAdminInventory(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/mismatches') return this.sendJson(res, this.apiAdminMismatches(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/transactions') return this.sendJson(res, this.apiAdminTransactions(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/chests') return this.sendJson(res, this.apiAdminChests(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/chest') return this.sendJson(res, this.apiAdminChest(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/aliases') return this.sendJson(res, this.apiAdminAliases(session, url))
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiLogin(session, body, this.clientIp(req)))
      }
      if (req.method === 'POST' && url.pathname === '/api/login/challenge') {
        await this.readBody(req)
        return this.sendJson(res, this.apiLoginChallengeCreate(session))
      }
      if (req.method === 'GET' && url.pathname === '/api/login/challenge') {
        return this.sendJson(res, this.apiLoginChallengeStatus(session))
      }
      if (req.method === 'POST' && url.pathname === '/api/login/challenge/cancel') {
        await this.readBody(req)
        return this.sendJson(res, this.apiLoginChallengeCancel(session))
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        await this.readBody(req)
        return this.apiLogout(res, session)
      }
      if (req.method === 'POST' && url.pathname === '/api/action/deposit') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiDeposit(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/action/withdraw') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiWithdraw(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/default-owner') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiDefaultOwner(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/litematic/plan') {
        const body = await this.readBody(req, 12 * 1024 * 1024)
        return this.sendJson(res, await this.apiLitematicPlan(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/item-alias/save') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiItemAliasSave(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/adjust') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminAdjust(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/transfer') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminTransfer(session, body))
      }
      if (req.method === 'POST' && (url.pathname === '/api/admin/mismatch/delete' || url.pathname === '/api/admin/mismatch/deduct')) {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminMismatchDeduct(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/alias/save') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminAliasSave(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/alias/delete') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminAliasDelete(session, body))
      }
      this.sendText(res, 404, 'Not found')
    } catch (error) {
      this.sendJson(res, { ok: false, error: error.message }, error.status || 400)
    }
  }

  apiMe (session) {
    if (!session.user) {
      return {
        ok: true,
        loggedIn: false,
        botName: this.botDisplayName(),
        hint: `请先在游戏内输入：/msg ${this.botDisplayName()} 设置密码 你的密码`
      }
    }
    const user = this.decorateUser(session.user)
    return {
      ok: true,
      loggedIn: true,
      user,
      botName: this.botDisplayName(),
      owners: this.db.listWebOwnersForUser(user),
      defaultOwnerUuid: this.db.getEffectiveDefaultOwnerUuid(user.uuid),
      active: this.activeSnapshot()
    }
  }

  apiInventory (session, url) {
    const user = this.requireUser(session)
    const ownerUuid = url.searchParams.get('owner') || user.uuid
    this.requireOwnerAccess(user, ownerUuid)
    const startedAt = Date.now()
    const result = { ok: true, ...this.db.getWebInventory(ownerUuid, user.uuid), active: this.activeSnapshot() }
    const elapsed = Date.now() - startedAt
    if (this.config.debug && elapsed > 100) {
      console.warn(`[web] slow inventory ${ownerUuid}: ${elapsed}ms, ${result.items?.length || 0} rows`)
    }
    return result
  }

  apiTransactions (session, url) {
    const user = this.requireUser(session)
    const ownerUuid = url.searchParams.get('owner') || user.uuid
    this.requireOwnerAccess(user, ownerUuid)
    return {
      ok: true,
      ownerUuid,
      ownerLabel: this.db.ownerLabel(ownerUuid),
      rows: this.db.listWebTransactions(ownerUuid, 100).map(row => this.decorateTransaction(row))
    }
  }

  apiOnlinePlayers (session, url) {
    const user = this.requireUser(session)
    const query = String(url.searchParams.get('q') || '').trim().toLowerCase()
    const service = this.serviceProvider()
    const bot = service?.bot
    if (!bot) return { ok: true, rows: [] }

    const rows = Object.entries(bot.players || {})
      .map(([name, player]) => ({
        username: player.username || name,
        uuid: player.uuid || '',
        ping: Number.isFinite(player.ping) ? player.ping : null,
        self: this.isSameUsername(player.username || name, bot.username)
      }))
      .filter(player => player.username && !player.self)
      .filter(player => !query || player.username.toLowerCase().includes(query))
      .sort((a, b) => a.username.localeCompare(b.username, 'zh-CN', { sensitivity: 'base' }))

    const ownName = String(user.username || '').trim()
    if (ownName && (!query || ownName.toLowerCase().includes(query)) && !rows.some(row => this.isSameUsername(row.username, ownName))) {
      rows.unshift({ username: ownName, uuid: user.uuid || '', ping: null, self: false, currentUser: true })
    }

    return { ok: true, rows }
  }

  apiDeposit (session, body) {
    const user = this.requireUser(session)
    const ownerUuid = String(body.ownerUuid || user.uuid)
    this.requireOwnerAccess(user, ownerUuid)
    this.assertBotIdleForWebAction()
    const service = this.requireService()
    const message = service.startWebDeposit(user, ownerUuid)
    return { ok: true, message, active: this.activeSnapshot() }
  }

  apiWithdraw (session, body) {
    const user = this.requireUser(session)
    const ownerUuid = String(body.ownerUuid || user.uuid)
    this.requireOwnerAccess(user, ownerUuid)
    this.assertBotIdleForWebAction()
    const service = this.requireService()
    const message = Array.isArray(body.items)
      ? service.startWebWithdrawMany(user, ownerUuid, body.items, body.targetUsername)
      : service.startWebWithdraw(user, ownerUuid, body.item, body.amount, body.targetUsername)
    return { ok: true, message, active: this.activeSnapshot() }
  }

  apiDefaultOwner (session, body) {
    const user = this.requireUser(session)
    const ownerUuid = String(body.ownerUuid || user.uuid).trim()
    this.requireOwnerAccess(user, ownerUuid)
    if (!this.db.isPlayerOwnerAccessible(user.uuid, ownerUuid)) {
      throw new Error('默认仓库只能设置为自己的个人仓库或已加入的组织仓库。')
    }
    if (ownerUuid === this.db.momoOwner || ownerUuid.startsWith('name:')) {
      throw new Error('这个归属不能设为默认仓库。')
    }
    this.db.setPlayerDefaultOwnerUuid(user.uuid, ownerUuid)
    const owners = this.db.listWebOwnersForUser(user)
    return {
      ok: true,
      message: `已设置默认仓库：${this.db.ownerLabel(ownerUuid)}`,
      defaultOwnerUuid: this.db.getEffectiveDefaultOwnerUuid(user.uuid),
      owners
    }
  }

  async apiLitematicPlan (session, body) {
    const user = this.requireUser(session)
    const ownerUuid = String(body.ownerUuid || user.uuid)
    this.requireOwnerAccess(user, ownerUuid)

    const fileName = String(body.fileName || 'uploaded.litematic').trim()
    const dataBase64 = String(body.dataBase64 || '').replace(/^data:.*?;base64,/, '')
    if (!dataBase64) throw new Error('请先选择投影文件。')
    if (!/\.litematic$/i.test(fileName)) throw new Error('只支持 .litematic 投影文件。')

    const buffer = Buffer.from(dataBase64, 'base64')
    if (!buffer.length) throw new Error('投影文件为空。')
    if (buffer.length > 8 * 1024 * 1024) throw new Error('投影文件过大，请控制在 8MB 以内。')

    const materials = await parseLitematicData(buffer, {
      filePath: fileName,
      version: this.config.server?.version || '1.21.1',
      languageFile: path.resolve(process.cwd(), this.config.language?.file || 'data/zh_cn.json'),
      maxSlots: Number.MAX_SAFE_INTEGER
    })
    return {
      ok: true,
      ...this.buildLitematicWithdrawPlan(ownerUuid, materials, user.uuid)
    }
  }

  buildLitematicWithdrawPlan (ownerUuid, parsed, viewerUuid = '') {
    const selected = []
    const missing = []
    const unavailable = parsed.unavailable || []
    let usedSlots = 0

    for (const material of parsed.materials || []) {
      const rows = this.db.getOwnerItemsByItemId(ownerUuid, material.itemId)
      const aliases = this.db.getPlayerItemNameOverrides(viewerUuid, rows.map(row => row.itemKey))
      let remaining = Number(material.amount || 0)
      const available = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
      const wanted = remaining
      const takeTotal = Math.min(wanted, available)

      if (takeTotal <= 0) {
        missing.push({ ...material, available: 0, selected: 0, missing: wanted, reason: 'unavailable' })
        continue
      }

      if (available < wanted) {
        missing.push({ ...material, available, selected: takeTotal, missing: wanted - available, reason: 'short' })
      }

      remaining = takeTotal
      for (const row of rows) {
        if (remaining <= 0) break
        const stackSize = Number(material.stackSize || 64)
        const amount = Math.min(Number(row.amount || 0), remaining)
        const slots = Math.ceil(amount / Math.max(1, stackSize))
        if (amount <= 0 || slots <= 0) continue
        selected.push({
          itemKey: row.itemKey,
          itemId: row.itemId,
          displayName: aliases.get(row.itemKey) || row.displayName || material.displayName || row.itemId,
          amount,
          max: Number(row.amount || 0),
          required: wanted,
          available,
          stackSize,
          slots,
          sourceItemId: material.itemId,
          sourceDisplayName: material.displayName || material.itemId
        })
        usedSlots += slots
        remaining -= amount
      }
    }

    const selectedAmount = selected.reduce((sum, row) => sum + row.amount, 0)
    return {
      blueprint: {
        name: parsed.name,
        author: parsed.author,
        totalBlocks: parsed.totalBlocks,
        materialTypes: (parsed.materials || []).length,
        requiredSlots: parsed.requiredSlots,
        overBotInventory: parsed.overBotInventory
      },
      selected,
      missing,
      unavailable,
      stats: {
        selectedTypes: selected.length,
        selectedAmount,
        usedSlots,
        maxSlots: null,
        missingTypes: missing.length,
        unavailableTypes: unavailable.length
      }
    }
  }

  assertBotIdleForWebAction () {
    const active = this.activeSnapshot()
    if (!active) return
    const error = new Error(`机器人忙，玩家${active.username}使用中，请稍后再试。`)
    error.status = 409
    throw error
  }

  apiLogin (session, body, ip) {
    this.assertLoginAllowed(ip)
    const token = String(body.token || '').trim()
    if (!token) throw new Error('请填写登录密码。')
    const user = this.db.getWebUserByToken(token)
    if (!user) {
      this.recordLoginFailure(ip)
      const error = new Error(`登录密码错误。请在游戏内输入：/msg ${this.botDisplayName()} 设置密码 你的密码`)
      error.status = 401
      throw error
    }
    this.clearLoginFailure(ip)
    session.user = {
      uuid: user.uuid,
      username: user.username
    }
    session.loggedInAt = Date.now()
    this.persistWebSession(session)
    return {
      ok: true,
      user: this.decorateUser(session.user)
    }
  }

  apiLoginChallengeCreate (session) {
    if (session.user) return { ok: true, loggedIn: true, user: this.decorateUser(session.user) }

    this.cancelLoginChallengeForSession(session, 'replaced')
    const ttlMs = Number.parseInt(this.config.web?.loginCodeTtlMs, 10) || 2 * 60 * 1000
    const code = this.generateLoginCode()
    const challenge = {
      id: crypto.randomBytes(12).toString('hex'),
      sid: session.sid,
      code,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      consumedAt: 0,
      cancelledAt: 0,
      user: null
    }
    this.loginChallenges.set(challenge.id, challenge)
    session.loginChallengeId = challenge.id
    return {
      ok: true,
      id: challenge.id,
      code,
      command: `/msg ${this.botDisplayName()} 登录 ${code}`,
      expiresAt: challenge.expiresAt,
      ttlMs
    }
  }

  apiLoginChallengeStatus (session) {
    const challenge = this.currentLoginChallenge(session)
    if (!challenge) return { ok: true, status: 'none' }
    const status = this.loginChallengeStatus(challenge)
    if (status === 'approved') {
      session.user = { ...challenge.user }
      session.loggedInAt = Date.now()
      this.persistWebSession(session)
      this.loginChallenges.delete(challenge.id)
      session.loginChallengeId = null
      return { ok: true, status: 'approved', user: this.decorateUser(session.user) }
    }
    if (status !== 'pending') {
      this.loginChallenges.delete(challenge.id)
      session.loginChallengeId = null
    }
    return {
      ok: true,
      status,
      code: challenge.code,
      command: `/msg ${this.botDisplayName()} 登录 ${challenge.code}`,
      expiresAt: challenge.expiresAt,
      remainingMs: Math.max(0, challenge.expiresAt - Date.now())
    }
  }

  apiLoginChallengeCancel (session) {
    this.cancelLoginChallengeForSession(session, 'cancelled')
    return { ok: true }
  }

  generateLoginCode () {
    for (let i = 0; i < 20; i++) {
      const code = String(crypto.randomInt(100000, 1000000))
      if (![...this.loginChallenges.values()].some(challenge => challenge.code === code && this.loginChallengeStatus(challenge) === 'pending')) return code
    }
    return String(crypto.randomInt(100000, 1000000))
  }

  currentLoginChallenge (session) {
    const id = session.loginChallengeId
    if (!id) return null
    const challenge = this.loginChallenges.get(id)
    if (!challenge || challenge.sid !== session.sid) return null
    return challenge
  }

  loginChallengeStatus (challenge) {
    if (!challenge) return 'none'
    if (challenge.cancelledAt) return 'cancelled'
    if (challenge.consumedAt && challenge.user) return 'approved'
    if (challenge.expiresAt <= Date.now()) return 'expired'
    return 'pending'
  }

  cancelLoginChallengeForSession (session, reason = 'cancelled') {
    const challenge = this.currentLoginChallenge(session)
    if (challenge && this.loginChallengeStatus(challenge) === 'pending') {
      challenge.cancelledAt = Date.now()
      challenge.cancelReason = reason
    }
    session.loginChallengeId = null
  }

  approveLoginChallenge (username, code) {
    const text = String(code || '').trim()
    if (!/^\d{6}$/.test(text)) return { ok: false, reason: 'invalid_code' }
    const matches = [...this.loginChallenges.values()]
      .filter(challenge => challenge.code === text && this.loginChallengeStatus(challenge) === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
    const challenge = matches[0]
    if (!challenge) return { ok: false, reason: 'not_found' }

    const service = this.serviceProvider()
    const player = service?.resolvePlayer ? service.resolvePlayer(username) : this.db.getPlayerByUsername(username)
    if (!player?.uuid || player.uuid.startsWith('name:')) {
      return { ok: false, reason: 'unknown_player' }
    }

    challenge.user = {
      uuid: player.uuid,
      username: player.username || username
    }
    challenge.consumedAt = Date.now()
    return { ok: true, username: challenge.user.username }
  }

  assertLoginAllowed (ip) {
    const record = this.loginFailures.get(ip)
    if (!record?.blockedUntil) return
    if (record.blockedUntil <= Date.now()) {
      this.loginFailures.delete(ip)
      return
    }
    const seconds = Math.ceil((record.blockedUntil - Date.now()) / 1000)
    const error = new Error(`登录失败次数过多，请 ${seconds} 秒后再试。`)
    error.status = 429
    throw error
  }

  recordLoginFailure (ip) {
    const now = Date.now()
    const windowMs = this.config.web?.loginFailWindowMs || 10 * 60 * 1000
    const blockMs = this.config.web?.loginBlockMs || 10 * 60 * 1000
    const maxFailures = this.config.web?.maxLoginFailures || 5
    const record = this.loginFailures.get(ip) || { count: 0, firstFailedAt: now, blockedUntil: 0 }

    if (now - record.firstFailedAt > windowMs) {
      record.count = 0
      record.firstFailedAt = now
      record.blockedUntil = 0
    }

    record.count += 1
    if (record.count >= maxFailures) {
      record.blockedUntil = now + blockMs
      console.warn(`[web] blocked login attempts from ${ip}: ${record.count} failures, ${Math.ceil(blockMs / 1000)}s`)
    }
    this.loginFailures.set(ip, record)
  }

  clearLoginFailure (ip) {
    this.loginFailures.delete(ip)
  }

  apiLogout (res, session) {
    this.deletePersistedWebSession(session)
    session.user = null
    this.cancelLoginChallengeForSession(session, 'logout')
    res.setHeader('Set-Cookie', 'cs_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
    this.sendJson(res, { ok: true })
  }

  requireUser (session) {
    if (!session.user) {
      const error = new Error('请先登录。')
      error.status = 401
      throw error
    }
    return this.decorateUser(session.user)
  }

  decorateUser (user) {
    return {
      uuid: user.uuid,
      username: user.username,
      isAdmin: this.db.isAdmin(user.username, user.uuid)
    }
  }

  isSameUsername (a, b) {
    return String(a || '').toLowerCase() === String(b || '').toLowerCase()
  }

  requireOwnerAccess (user, ownerUuid) {
    if (!this.db.canWebUserAccessOwner(user, ownerUuid)) {
      const error = new Error('你没有权限查看或操作这个仓库。')
      error.status = 403
      throw error
    }
  }

  requireAdmin (session) {
    const user = this.requireUser(session)
    if (!user.isAdmin) {
      const error = new Error('只有管理员可以打开管理界面。')
      error.status = 403
      throw error
    }
    return user
  }

  requireService () {
    const service = this.serviceProvider()
    if (!service) throw new Error('机器人还没有进入服务器，请稍后再试。')
    return service
  }

  apiAdminOwners (session) {
    this.requireAdmin(session)
    const owners = new Map()
    const addOwner = ownerUuid => {
      if (!ownerUuid || owners.has(ownerUuid)) return
      owners.set(ownerUuid, {
        ownerUuid,
        label: this.db.ownerLabel(ownerUuid),
        totalAmount: this.db.ownerTotalAmount(ownerUuid)
      })
    }

    for (const row of this.db.db.prepare('SELECT DISTINCT owner_uuid AS ownerUuid FROM balances ORDER BY owner_uuid').all()) addOwner(row.ownerUuid)
    for (const row of this.db.db.prepare('SELECT uuid FROM players ORDER BY username COLLATE NOCASE ASC').all()) addOwner(row.uuid)
    for (const row of this.db.db.prepare('SELECT name_lower AS nameLower FROM custom_warehouses ORDER BY name COLLATE NOCASE ASC').all()) addOwner(`vault:${row.nameLower}`)
    addOwner(this.config.momoOwner)

    return { ok: true, rows: [...owners.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')) }
  }

  apiAdminInventory (session, url) {
    this.requireAdmin(session)
    const ownerQ = String(url.searchParams.get('owner') || '').trim().toLowerCase()
    const itemQ = String(url.searchParams.get('item') || '').trim().toLowerCase()
    const limit = this.clampLimit(url.searchParams.get('limit'), 500, 2000)
    const rows = this.db.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid, i.item_key AS itemKey, i.item_id AS itemId,
             i.display_name AS displayName, i.nbt_json AS nbtJson,
             i.meta_json AS metaJson, b.amount
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.amount > 0
      ORDER BY b.owner_uuid COLLATE NOCASE ASC, i.display_name COLLATE NOCASE ASC
      LIMIT ?
    `).all(limit * 3)

    const result = []
    const owners = new Set()
    const itemKeys = new Set()
    let totalAmount = 0
    for (const row of rows) {
      const ownerLabel = this.db.ownerLabel(row.ownerUuid)
      const item = this.adminItem(row)
      if (ownerQ && !this.textMatches(ownerLabel, ownerQ) && !this.textMatches(row.ownerUuid, ownerQ)) continue
      if (itemQ && !this.adminItemMatches(item, itemQ)) continue
      result.push({ ...item, ownerUuid: row.ownerUuid, ownerLabel, amount: Number(row.amount || 0) })
      owners.add(row.ownerUuid)
      itemKeys.add(row.itemKey)
      totalAmount += Number(row.amount || 0)
      if (result.length >= limit) break
    }

    return { ok: true, stats: { owners: owners.size, itemTypes: itemKeys.size, totalAmount }, rows: result }
  }

  apiAdminMismatches (session, url) {
    this.requireAdmin(session)
    const status = String(url.searchParams.get('status') || 'open').trim()
    const kind = String(url.searchParams.get('kind') || '').trim()
    const itemQ = String(url.searchParams.get('item') || '').trim().toLowerCase()
    const ownerQ = String(url.searchParams.get('owner') || '').trim().toLowerCase()
    if (status && !['open', 'resolved'].includes(status)) throw new Error('异常状态必须是 open 或 resolved。')
    if (kind && !['extra', 'missing'].includes(kind)) throw new Error('异常类型必须是 extra 或 missing。')
    const where = []
    const params = []
    if (status) {
      where.push('status = ?')
      params.push(status)
    }
    if (kind) {
      where.push('kind = ?')
      params.push(kind)
    }
    const rows = this.db.db.prepare(`
      SELECT id, kind, status, owner_uuid AS ownerUuid, username,
             item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson, amount, note,
             created_at AS createdAt, resolved_at AS resolvedAt
      FROM inventory_mismatches
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY status = 'open' DESC, id DESC
      LIMIT 1000
    `).all(...params)

    const result = []
    let extraAmount = 0
    let missingAmount = 0
    for (const row of rows) {
      const ownerLabel = row.ownerUuid ? this.db.ownerLabel(row.ownerUuid) : (row.username || '未知归属')
      const item = this.adminItem(row)
      if (ownerQ && !this.textMatches(ownerLabel, ownerQ) && !this.textMatches(row.username, ownerQ) && !this.textMatches(row.ownerUuid, ownerQ)) continue
      if (itemQ && !this.adminItemMatches(item, itemQ)) continue
      const amount = Number(row.amount || 0)
      if (row.kind === 'extra') extraAmount += amount
      if (row.kind === 'missing') missingAmount += amount
      result.push({ ...item, id: row.id, kind: row.kind, status: row.status, ownerUuid: row.ownerUuid, ownerLabel, username: row.username, amount, note: row.note, createdAt: row.createdAt, resolvedAt: row.resolvedAt })
    }

    return { ok: true, stats: { openRows: result.filter(row => row.status === 'open').length, extraAmount, missingAmount }, rows: result }
  }

  apiAdminTransactions (session, url) {
    this.requireAdmin(session)
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
    const limit = this.clampLimit(url.searchParams.get('limit'), 200, 1000)
    const rows = this.db.db.prepare(`
      SELECT id, type, status, player_uuid AS playerUuid, username,
             items_json AS itemsJson, message, created_at AS createdAt
      FROM transactions
      ORDER BY id DESC
      LIMIT ?
    `).all(limit * 3)

    const result = []
    for (const row of rows) {
      const ownerLabel = this.db.ownerLabel(row.playerUuid)
      const items = this.parseItemsJson(row.itemsJson)
      if (q && !this.textMatches(ownerLabel, q) && !this.textMatches(row.username, q) && !this.textMatches(row.type, q) && !this.textMatches(row.message, q) && !items.some(item => this.adminItemMatches(this.adminItem(item), q))) continue
      result.push({
        id: row.id,
        type: row.type,
        typeLabel: this.transactionTypeLabel(row.type),
        status: row.status,
        statusLabel: this.transactionStatusLabel(row.status),
        playerUuid: row.playerUuid,
        username: row.username,
        ownerLabel,
        message: row.message,
        messageLabel: this.transactionMessageLabel(row.message),
        createdAt: row.createdAt,
        createdAtLabel: this.formatBeijingTime(row.createdAt),
        items: items.map(item => ({ ...this.adminItem(item), amount: Number(item.amount || 0) }))
      })
      if (result.length >= limit) break
    }
    return { ok: true, rows: result }
  }

  apiAdminChests (session, url) {
    this.requireAdmin(session)
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
    const rows = this.db.db.prepare(`
      SELECT c.chest_id AS chestId, c.x, c.y, c.z, c.block_name AS blockName,
             c.last_seen_at AS lastSeenAt,
             COUNT(cs.slot) AS slotCount,
             COALESCE(SUM(cs.amount), 0) AS totalAmount
      FROM chests c
      LEFT JOIN chest_slots cs ON cs.chest_id = c.chest_id
      GROUP BY c.chest_id
      ORDER BY c.y, c.x, c.z
    `).all()
    const result = rows
      .filter(row => !q || this.textMatches(row.chestId, q))
      .map(row => ({ ...row, slotCount: Number(row.slotCount || 0), totalAmount: Number(row.totalAmount || 0) }))
    return { ok: true, rows: result }
  }

  apiAdminChest (session, url) {
    this.requireAdmin(session)
    const chestId = String(url.searchParams.get('chest') || '').trim()
    if (!chestId) throw new Error('缺少木桶 ID。')
    const chest = this.db.db.prepare(`
      SELECT chest_id AS chestId, x, y, z, block_name AS blockName, last_seen_at AS lastSeenAt
      FROM chests
      WHERE chest_id = ?
    `).get(chestId)
    if (!chest) throw new Error(`找不到木桶：${chestId}`)
    const rows = this.db.db.prepare(`
      SELECT cs.slot, cs.amount, i.item_key AS itemKey, i.item_id AS itemId,
             i.display_name AS displayName, i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM chest_slots cs
      JOIN items i ON i.item_key = cs.item_key
      WHERE cs.chest_id = ?
      ORDER BY cs.slot
    `).all(chestId)
    return { ok: true, chest, items: rows.map(row => ({ ...this.adminItem(row), slot: row.slot, amount: Number(row.amount || 0) })) }
  }

  apiAdminAliases (session, url) {
    this.requireAdmin(session)
    const q = String(url.searchParams.get('q') || '').trim()
    return {
      ok: true,
      rows: this.db.listItemNameOverrides(q).map(row => ({
        shortCode: row.shortCode,
        itemKey: row.itemKey || '',
        itemId: row.itemId || '',
        displayName: row.displayName,
        nbtJson: row.nbtJson || '',
        metaJson: row.metaJson || '',
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      }))
    }
  }

  apiAdminAdjust (session, body) {
    this.requireAdmin(session)
    const ownerUuid = String(body.ownerUuid || '').trim()
    const itemKey = this.resolveAdminItemKey(body.itemKey || '')
    const action = String(body.action || '').trim()
    const amount = Number.parseInt(body.amount, 10)
    if (!ownerUuid || !itemKey) throw new Error('缺少归属或物品。')
    if (!['add', 'subtract', 'set'].includes(action)) throw new Error('动作必须是 add / subtract / set。')
    if (!Number.isInteger(amount) || amount < 0) throw new Error('数量必须是非负整数。')
    const item = this.db.getItemByKey(itemKey)
    if (!item) throw new Error('找不到物品。')
    const current = this.db.getBalance(ownerUuid, itemKey)
    const delta = action === 'add' ? amount : action === 'subtract' ? -Math.min(amount, current) : amount - current
    if (delta === 0) return { ok: true, message: '数量没有变化。' }

    const changed = [{ ...item, amount: Math.abs(delta) }]
    this.db.transaction(() => {
      this.db.adjustBalance(ownerUuid, itemKey, delta)
      this.db.addTransaction(`web_admin_${action}`, 'ok', ownerUuid, this.db.ownerLabel(ownerUuid), changed, `admin ${action} ${itemKey} ${amount}`)
    })
    return { ok: true, message: `已更新 ${this.db.ownerLabel(ownerUuid)} 的 ${item.displayName}：${current} -> ${current + delta}。` }
  }

  apiAdminTransfer (session, body) {
    this.requireAdmin(session)
    const fromOwnerUuid = this.resolveAdminOwnerArgument(body.fromOwnerUuid || body.fromOwnerText || '')
    const toOwnerUuid = this.resolveAdminOwnerArgument(body.toOwnerUuid || body.toOwnerText || '')
    const itemKey = this.resolveAdminItemKey(body.itemKey || '')
    const amount = Number.parseInt(body.amount, 10)
    if (!fromOwnerUuid || !toOwnerUuid || !itemKey) throw new Error('缺少原归属、新归属或物品。')
    if (fromOwnerUuid === toOwnerUuid) throw new Error('原归属和新归属不能相同。')
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('转移数量必须大于 0。')
    const item = this.db.getItemByKey(itemKey)
    if (!item) throw new Error('找不到物品。')
    const current = this.db.getBalance(fromOwnerUuid, itemKey)
    const movedAmount = Math.min(current, amount)
    if (movedAmount <= 0) throw new Error('原归属没有这个物品。')
    const moved = [{ ...item, amount: movedAmount }]
    this.db.transaction(() => {
      this.db.adjustBalance(fromOwnerUuid, itemKey, -movedAmount)
      this.db.adjustBalance(toOwnerUuid, itemKey, movedAmount)
      this.db.addTransaction('web_admin_transfer_out', 'ok', fromOwnerUuid, this.db.ownerLabel(fromOwnerUuid), moved, `admin transfer to ${toOwnerUuid}`)
      this.db.addTransaction('web_admin_transfer_in', 'ok', toOwnerUuid, this.db.ownerLabel(toOwnerUuid), moved, `admin transfer from ${fromOwnerUuid}`)
    })
    return { ok: true, message: `已转移 ${item.displayName} x${movedAmount}：${this.db.ownerLabel(fromOwnerUuid)} -> ${this.db.ownerLabel(toOwnerUuid)}。` }
  }

  apiAdminMismatchDeduct (session, body) {
    this.requireAdmin(session)
    const id = Number.parseInt(body.id, 10)
    if (!Number.isInteger(id) || id <= 0) throw new Error('异常 ID 必须是正整数。')
    const row = this.db.db.prepare(`
      SELECT id, kind, status, owner_uuid AS ownerUuid, username,
             item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson, amount
      FROM inventory_mismatches
      WHERE id = ?
      LIMIT 1
    `).get(id)
    if (!row) throw new Error('没有找到这条异常记录。')
    if (row.status !== 'open') return { ok: true, message: '这条异常已经处理过。' }
    if (!row.ownerUuid) throw new Error('这条异常没有明确归属，不能直接扣除。')
    const item = this.db.getItemByKey(row.itemKey) || this.db.rowToItem(row)
    const current = this.db.getBalance(row.ownerUuid, row.itemKey)
    const amount = Math.min(current, Number(row.amount || 0))
    if (amount <= 0) throw new Error(`${this.db.ownerLabel(row.ownerUuid)} 没有可扣除的 ${row.displayName || row.itemId}。`)

    const changed = [{ ...item, amount }]
    this.db.transaction(() => {
      this.db.adjustBalance(row.ownerUuid, row.itemKey, -amount)
      this.db.addTransaction('web_admin_mismatch_deduct', 'ok', row.ownerUuid, this.db.ownerLabel(row.ownerUuid), changed, `mismatch ${row.kind} #${row.id} deduct ${amount}`)
      this.db.db.prepare(`
        UPDATE inventory_mismatches
        SET status = 'resolved',
            resolved_at = CURRENT_TIMESTAMP,
            note = CASE
              WHEN note = '' THEN ?
              ELSE note || '；' || ?
            END
        WHERE id = ?
      `).run(`Web已扣除账本库存 x${amount}`, `Web已扣除账本库存 x${amount}`, id)
    })
    return { ok: true, message: `已扣除 ${this.db.ownerLabel(row.ownerUuid)} 的 ${row.displayName || row.itemId} x${amount}，异常已处理。` }
  }

  resolveAdminOwnerArgument (value) {
    const raw = String(value || '').trim()
    if (!raw) return ''
    if (raw === this.config.momoOwner || raw === 'momo') return this.config.momoOwner
    if (raw.startsWith('vault:')) {
      const warehouse = this.db.getCustomWarehouse(raw.slice(6))
      if (!warehouse) throw new Error(`找不到仓库：${raw}`)
      return `vault:${warehouse.nameLower}`
    }
    if (raw.startsWith('仓库:')) {
      const warehouse = this.db.getCustomWarehouse(raw.slice(3))
      if (!warehouse) throw new Error(`找不到仓库：${raw.slice(3)}`)
      return `vault:${warehouse.nameLower}`
    }

    const directPlayer = this.db.db.prepare('SELECT uuid FROM players WHERE uuid = ? LIMIT 1').get(raw)
    if (directPlayer) return directPlayer.uuid

    const warehouse = this.db.getCustomWarehouse(raw)
    if (warehouse) return `vault:${warehouse.nameLower}`

    const service = this.serviceProvider()
    const onlineName = service?.bot?.players
      ? Object.keys(service.bot.players).find(name => name.toLowerCase() === raw.toLowerCase())
      : ''
    const online = onlineName ? service.bot.players[onlineName] : null
    if (online?.uuid) {
      this.db.upsertPlayer(online.uuid, onlineName)
      return online.uuid
    }

    const player = this.db.getPlayerByUsername(raw)
    if (!player?.uuid || player.uuid.startsWith('name:')) {
      throw new Error(`找不到玩家或仓库：${raw}。玩家需要在线，或之前已用正版 UUID 使用过机器人。`)
    }
    return player.uuid
  }

  resolveAdminItemKey (value) {
    const raw = String(value || '').trim().replace(/^#/, '')
    if (!raw) return ''
    if (this.db.getItemByKey(raw)) return raw
    if (/^[0-9a-fA-F]{6}$/.test(raw)) {
      const item = this.db.findItemByShortCode(raw)
      if (item) return item.itemKey
    }
    throw new Error(`找不到物品：${raw}`)
  }

  apiItemAliasSave (session, body) {
    const user = this.requireUser(session)
    const itemKey = String(body.itemKey || '').trim()
    const displayName = String(body.displayName || '').trim()
    const item = this.db.savePlayerItemNameOverride(user.uuid, itemKey, displayName)
    return {
      ok: true,
      itemKey,
      displayName: item.displayName,
      personalAlias: item.personalAlias || '',
      message: item.personalAlias
        ? `已设置个人别名：${item.shortCode || item.itemId} -> ${item.personalAlias}。`
        : `已清除个人别名：${item.shortCode || item.itemId}。`
    }
  }

  apiAdminAliasSave (session, body) {
    const user = this.requireAdmin(session)
    const itemKey = String(body.itemKey || '').trim()
    const displayName = String(body.displayName || '').trim()
    const item = this.db.saveItemNameOverride(itemKey, displayName)
    this.db.addTransaction('web_admin_alias_save', 'ok', this.config.momoOwner, user.username, [{ ...item, amount: 0 }], `alias ${item.shortCode}: ${item.oldDisplayName} -> ${item.displayName}`)
    return { ok: true, message: `已设置别名：${item.shortCode} -> ${item.displayName}。` }
  }

  apiAdminAliasDelete (session, body) {
    const user = this.requireAdmin(session)
    const shortCode = String(body.shortCode || '').trim()
    const result = this.db.deleteItemNameOverride(shortCode)
    if (result.changed) {
      this.db.addTransaction('web_admin_alias_delete', 'ok', this.config.momoOwner, user.username, [], `delete alias ${result.shortCode}`)
    }
    return { ok: true, message: result.changed ? `已删除别名：${result.shortCode}。` : '没有找到这条别名。' }
  }

  adminItem (row) {
    const itemKey = row.itemKey || row.item_key || ''
    return {
      itemKey,
      itemId: row.itemId || row.item_id || '',
      displayName: row.displayName || row.display_name || row.itemId || row.item_id || '',
      nbtJson: row.nbtJson || row.nbt_json || '',
      metaJson: row.metaJson || row.meta_json || '',
      shortCode: this.db.shortCodeForItemKey(itemKey)
    }
  }

  adminItemMatches (item, query) {
    return [item.displayName, item.itemId, item.itemKey, item.shortCode, item.nbtJson, item.metaJson].some(value => this.textMatches(value, query))
  }

  textMatches (value, query) {
    return String(value || '').toLowerCase().includes(String(query || '').toLowerCase())
  }

  parseItemsJson (text) {
    try {
      const value = JSON.parse(text || '[]')
      return Array.isArray(value) ? value : []
    } catch {
      return []
    }
  }

  decorateTransaction (row) {
    return {
      ...row,
      typeLabel: this.transactionTypeLabel(row.type),
      statusLabel: this.transactionStatusLabel(row.status),
      messageLabel: this.transactionMessageLabel(row.message),
      createdAtLabel: this.formatBeijingTime(row.createdAt)
    }
  }

  formatBeijingTime (value) {
    if (!value) return ''
    const text = String(value).trim()
    const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`)
    if (Number.isNaN(date.getTime())) return text
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date).reduce((result, part) => {
      if (part.type !== 'literal') result[part.type] = part.value
      return result
    }, {})
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
  }

  transactionTypeLabel (type) {
    const labels = {
      withdraw: '取货',
      deposit: '存货',
      deposit_session: '存货记录',
      sync: '同步仓库',
      residual_to_momo: '残留记入 momo',
      momo_residual_physical_store: '残留实物入库',
      withdraw_failed_return: '取货失败回收入库',
      withdraw_tpa_timeout: '取货超时回收入库',
      withdraw_residual_return: '取货残留回收入库',
      withdraw_death_recovery: '死亡恢复取货',
      disconnect_recovery_deposit: '重连恢复存货',
      disconnect_recovery_withdraw: '重连恢复取货',
      web_admin_add: '管理员增加库存',
      web_admin_subtract: '管理员减少库存',
      web_admin_set: '管理员设置库存',
      web_admin_transfer_out: '管理员转出',
      web_admin_transfer_in: '管理员转入',
      web_admin_mismatch_deduct: '异常扣除',
      web_admin_alias_save: '保存物品别名',
      web_admin_alias_delete: '删除物品别名'
    }
    return labels[type] || String(type || '')
  }

  transactionStatusLabel (status) {
    const labels = {
      ok: '成功',
      partial: '部分完成',
      empty: '空操作',
      no_space: '空间不足',
      cancelled: '已取消',
      error: '失败',
      teleport_timeout: '传送超时',
      quota_full: '额度已满',
      open: '未处理',
      resolved: '已处理'
    }
    return labels[status] || String(status || '')
  }

  transactionMessageLabel (message) {
    const text = String(message || '').trim()
    if (!text) return ''
    const fixed = {
      already_accounted_as_momo: '已提前记入 momo',
      'flush residual before task': '任务前清理残留'
    }
    if (fixed[text]) return fixed[text]

    const keyLabels = {
      actor: '操作人',
      target: '目标',
      owner: '归属',
      scope: '范围',
      phase: '阶段',
      depositedAmount: '存入数量',
      leftoverAmount: '剩余数量',
      finishedByUser: '玩家提前结束',
      vault: '仓库',
      radius: '半径',
      chests: '木桶数',
      leftOver_items: '剩余种类',
      leftover_items: '剩余种类',
      leftover_amount: '剩余数量',
      timeoutMs: '超时',
      recovery: '恢复方式',
      error: '错误'
    }
    const valueLabels = {
      personal: '个人仓库',
      custom: '自定义仓库',
      true: '是',
      false: '否',
      deposit_storing: '入库中',
      deposit_teleport_to_player: '等待玩家接受传送',
      deposit_collecting: '收集物品中',
      deposit_return_home: '返回仓库中',
      prepare_deposit: '准备存货',
      prepare_withdraw: '准备取货',
      withdraw_from_chests: '从木桶取货',
      withdraw_teleport_to_player: '等待玩家接受传送',
      withdraw_tpa_timeout_return_home: '传送超时返回仓库',
      withdraw_dropping: '交付物品',
      withdraw_return_home: '返回仓库',
      disconnect: '断线重连',
      quota_check: '检查额度'
    }
    const pairs = text.split(/\s*,\s*/).map(part => {
      const index = part.indexOf('=')
      if (index <= 0) return part
      const key = part.slice(0, index).trim()
      const value = part.slice(index + 1).trim()
      const displayValue = value.startsWith('vault:') ? `仓库:${value.slice(6)}` : (valueLabels[value] || value)
      return `${keyLabels[key] || key}：${displayValue}`
    })
    return pairs.join('，')
  }

  clampLimit (value, fallback, max) {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isInteger(parsed)) return fallback
    return Math.max(1, Math.min(max, parsed))
  }

  activeSnapshot () {
    const active = this.serviceProvider()?.active
    if (!active) return null
    return {
      type: active.type,
      username: active.username,
      targetUsername: active.targetUsername || active.username,
      phase: active.phase || 'running',
      batchIndex: active.batchIndex || 0,
      totalBatches: active.totalBatches || 0,
      message: this.activePhaseMessage(active)
    }
  }

  activePhaseMessage (active) {
    const target = active.targetUsername || active.username
    const labels = {
      start: '任务启动中',
      prepare_deposit: '准备存货',
      deposit_teleport_to_player: '发送 tpa 中',
      deposit_collecting: '收集物品中',
      deposit_return_home: '返回仓库中',
      deposit_storing: '入库中',
      prepare_withdraw: '准备取货',
      withdraw_from_chests: '正在从木桶取货',
      withdraw_teleport_to_player: `已发送 tpa，等待 ${target} 接受`,
      withdraw_tpa_timeout_return_home: '对方未接受，正在回仓库',
      withdraw_dropping: `${target} 已接受，正在丢物品`,
      withdraw_return_home: '取货完成，正在回仓库',
      quota_check: '检查额度中'
    }
    const message = labels[active.phase] || '任务进行中'
    if (String(active.phase || '').startsWith('withdraw_') && Number(active.totalBatches || 0) > 1) {
      return `${message}（${active.batchIndex || 1}/${active.totalBatches} 批）`
    }
    return message
  }

  botDisplayName () {
    return this.serviceProvider()?.bot?.username || this.config.server?.botName || this.config.server?.username || '机器人名'
  }

  getSession (req, res) {
    this.cleanupExpiredWebSessions()
    const cookies = parseCookies(req.headers.cookie || '')
    let sid = cookies.cs_sid
    let session = sid ? this.sessions.get(sid) : null

    if (session && this.isWebSessionExpired(session)) {
      this.sessions.delete(sid)
      session = null
    }

    if (!session && sid) {
      session = this.loadPersistedWebSession(sid)
      if (session) this.sessions.set(sid, session)
    }

    if (!sid || !session) {
      sid = crypto.randomBytes(18).toString('hex')
      session = { sid, createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + this.webSessionTtlMs(), user: null }
      this.sessions.set(sid, session)
    }
    const now = Date.now()
    session.lastSeenAt = now
    session.expiresAt = now + this.webSessionTtlMs()
    this.setSessionCookie(res, sid)
    if (session.user && now - Number(session.lastPersistedAt || 0) > 60 * 1000) this.persistWebSession(session)
    return session
  }

  webSessionTtlMs () {
    const configured = Number.parseInt(this.config.web?.sessionTtlMs, 10)
    return Number.isFinite(configured) && configured > 0 ? configured : 30 * 24 * 60 * 60 * 1000
  }

  webSessionCookieMaxAge () {
    return Math.max(60, Math.floor(this.webSessionTtlMs() / 1000))
  }

  setSessionCookie (res, sid) {
    res.setHeader('Set-Cookie', `cs_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${this.webSessionCookieMaxAge()}`)
  }

  webSessionHash (sid) {
    return crypto.createHash('sha256').update(String(sid || '')).digest('hex')
  }

  isWebSessionExpired (session) {
    return Boolean(session?.expiresAt && session.expiresAt <= Date.now())
  }

  loadPersistedWebSession (sid) {
    const row = this.db.db.prepare(`
      SELECT owner_uuid AS uuid, username, expires_at AS expiresAt
      FROM web_sessions
      WHERE session_hash = ?
    `).get(this.webSessionHash(sid))
    if (!row || Number(row.expiresAt || 0) <= Date.now()) {
      if (row) this.db.db.prepare('DELETE FROM web_sessions WHERE session_hash = ?').run(this.webSessionHash(sid))
      return null
    }
    return {
      sid,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      expiresAt: Number(row.expiresAt),
      lastPersistedAt: Date.now(),
      user: {
        uuid: row.uuid,
        username: row.username
      }
    }
  }

  persistWebSession (session) {
    if (!session?.sid || !session.user?.uuid || !session.user?.username) return
    const expiresAt = session.expiresAt || (Date.now() + this.webSessionTtlMs())
    session.expiresAt = expiresAt
    session.lastPersistedAt = Date.now()
    this.db.db.prepare(`
      INSERT INTO web_sessions (session_hash, owner_uuid, username, expires_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_hash) DO UPDATE SET
        owner_uuid = excluded.owner_uuid,
        username = excluded.username,
        expires_at = excluded.expires_at,
        updated_at = CURRENT_TIMESTAMP
    `).run(this.webSessionHash(session.sid), session.user.uuid, session.user.username, expiresAt)
  }

  deletePersistedWebSession (session) {
    if (!session?.sid) return
    this.db.db.prepare('DELETE FROM web_sessions WHERE session_hash = ?').run(this.webSessionHash(session.sid))
  }

  cleanupExpiredWebSessions () {
    const now = Date.now()
    if (now - this.lastSessionCleanupAt < 10 * 60 * 1000) return
    this.lastSessionCleanupAt = now
    this.db.db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(now)
    for (const [sid, session] of this.sessions) {
      if (this.isWebSessionExpired(session)) this.sessions.delete(sid)
    }
  }

  clientIp (req) {
    if (this.config.web?.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim()
      if (forwarded) return forwarded
      const realIp = String(req.headers['x-real-ip'] || '').trim()
      if (realIp) return realIp
    }
    return req.socket.remoteAddress || 'unknown'
  }

  readBody (req, maxBytes = 1024 * 128) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', chunk => {
        size += chunk.length
        if (size > maxBytes) {
          reject(new Error('请求体过大。'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text) return resolve({})
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error('请求体必须是 JSON。'))
        }
      })
      req.on('error', reject)
    })
  }

  sendHtml (res, html) {
    const data = Buffer.from(html, 'utf8')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': data.length
    })
    res.end(data)
  }

  sendJson (res, payload, status = 200) {
    const data = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': data.length
    })
    res.end(data)
  }

  sendText (res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(text)
  }
}

function parseCookies (header) {
  const result = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return result
}

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>云仓库</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101012;
      --side: #17171a;
      --panel: #18181c;
      --panel2: #202022;
      --line: #2a2a2f;
      --text: #f1efe8;
      --muted: #8c8b91;
      --gold: #f4c15d;
      --orange: #f0a96a;
      --danger: #ff6b6b;
      --green: #50d05f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 15px/1.5 "Microsoft YaHei", system-ui, sans-serif;
      letter-spacing: 0;
    }
    .app { min-height: 100vh; display: grid; grid-template-columns: 250px 1fr; }
    aside {
      background: var(--side);
      border-right: 1px solid var(--line);
      padding: 28px 15px;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }
    .brand { font-size: 30px; font-weight: 800; color: var(--text); }
    .brand span { color: var(--orange); }
    nav { border-top: 1px solid var(--line); padding-top: 14px; display: grid; gap: 8px; }
    .navbtn {
      width: 100%;
      display: block;
      border: 0;
      background: transparent;
      color: #b8b5ad;
      text-align: left;
      padding: 13px 18px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 16px;
      text-decoration: none;
    }
    .navbtn.active { background: #2a251e; color: var(--gold); }
    .userbox { margin-top: auto; border-top: 1px solid var(--line); padding-top: 20px; color: var(--gold); }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 99px; background: var(--green); margin-right: 9px; }
    button, input, select {
      border: 1px solid var(--line);
      background: #121214;
      color: var(--text);
      border-radius: 7px;
      padding: 9px 12px;
      font: inherit;
    }
    button { cursor: pointer; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    button.primary { color: var(--gold); border-color: #4a3921; background: #1b1712; }
    button.solid { background: var(--gold); color: #1a1510; border-color: var(--gold); font-weight: 700; }
    button.ghost { color: var(--muted); }
    main { padding: 40px; }
    .hero {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 9px;
      padding: 24px 30px;
      font-size: 23px;
      margin-bottom: 26px;
    }
    .hero strong { color: #fff; font-weight: 800; }
    .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 18px; flex-wrap: wrap; }
    .toolbar input { min-width: 260px; }
    .toolbar select { min-width: 210px; }
    .title { font-size: 22px; margin-right: auto; }
    .muted { color: var(--muted); }
    .panel {
      min-height: 155px;
      border: 1px dashed var(--line);
      border-radius: 9px;
      background: var(--panel);
      padding: 20px;
    }
    .help-layout { display: grid; gap: 18px; }
    .help-section {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      overflow: hidden;
    }
    .help-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 14px;
      padding: 16px 18px;
      background: #1f1f22;
      border-bottom: 1px solid var(--line);
    }
    .help-head h3 { margin: 0; color: var(--gold); font-size: 18px; }
    .help-head span { color: var(--muted); font-size: 13px; }
    .command-list { display: grid; }
    .command-row {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      gap: 14px;
      align-items: center;
      padding: 14px 18px;
      border-top: 1px solid rgba(255,255,255,.04);
    }
    .command-row:first-child { border-top: 0; }
    .command-name { color: #f1efe8; font-weight: 700; }
    .command-desc { color: var(--muted); font-size: 13px; margin-top: 3px; }
    .cmd {
      display: inline-block;
      max-width: 100%;
      border: 1px solid #3a352b;
      background: #121214;
      color: #f8d98b;
      border-radius: 6px;
      padding: 7px 9px;
      overflow-wrap: anywhere;
      font-family: Consolas, "Microsoft YaHei", monospace;
      font-size: 14px;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, 78px); gap: 10px; align-items: start; }
    .item {
      width: 78px;
      background: #151518;
      border: 1px solid #25252a;
      border-radius: 8px;
      padding: 7px;
      min-height: 94px;
      position: relative;
      cursor: pointer;
    }
    .item:hover { border-color: #5d492a; }
    .item.selected { border-color: var(--gold); background: #211b12; }
    .icon { width: 62px; height: 62px; display: grid; place-items: center; background: #232327; border-radius: 6px; overflow: hidden; position: relative; }
    .icon img { max-width: 52px; max-height: 52px; image-rendering: pixelated; }
    .fallback { display: none; color: var(--gold); font-size: 12px; text-align: center; }
    .icon img:not([src]) { display: none; }
    .icon img:not([src]) + .fallback { display: block; }
    .icon img[src] + .fallback { display: none; }
    .name {
      font-size: 12px;
      color: #d8d4ca;
      margin-top: 5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: center;
    }
    .count {
      position: absolute;
      right: 3px;
      bottom: 2px;
      color: #fff;
      font-size: 13px;
      text-shadow: 1px 1px 0 #000, -1px -1px 0 #000;
      pointer-events: none;
    }
    .code { color: var(--muted); font-size: 12px; }
    .withdrawbar { display: grid; grid-template-columns: minmax(0, 1fr) 190px auto; gap: 10px; align-items: start; margin-bottom: 18px; }
    .admin-transferbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 230px auto;
      gap: 10px;
      align-items: center;
      margin: -8px 0 18px;
      padding: 10px;
      border: 1px solid #3b3020;
      border-radius: 8px;
      background: #16130f;
    }
    .admin-transferbar input { width: 100%; }
    .admin-transferbar .muted { font-size: 13px; }
    .target-player-box { position: relative; min-width: 0; }
    .target-player-box input { width: 100%; }
    .player-menu {
      position: absolute;
      z-index: 60;
      left: 0;
      right: 0;
      top: calc(100% + 6px);
      max-height: 230px;
      overflow: auto;
      border: 1px solid #4b3d28;
      border-radius: 8px;
      background: #141416;
      box-shadow: 0 14px 42px rgba(0,0,0,.5);
      padding: 6px;
    }
    .player-option {
      width: 100%;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      border: 0;
      background: transparent;
      color: #e5dfd4;
      text-align: left;
      padding: 8px 9px;
      border-radius: 6px;
    }
    .player-option:hover, .player-option.active { background: #2a251e; color: var(--gold); }
    .player-option .ping { color: var(--muted); font-size: 12px; }
    .player-empty { padding: 9px; color: var(--muted); font-size: 13px; }
    .litematicbar { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start; margin: -6px 0 14px; }
    .litematic-result {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #121214;
      padding: 10px 12px;
      color: #d8d4ca;
      min-height: 40px;
    }
    .litematic-title { color: var(--gold); font-weight: 800; margin-bottom: 4px; }
    .litematic-lines { display: flex; gap: 10px; flex-wrap: wrap; font-size: 13px; }
    .litematic-warn { color: var(--orange); margin-top: 5px; font-size: 13px; line-height: 1.55; max-height: 180px; overflow: auto; }
    .selected-list {
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #121214;
      padding: 7px;
      display: flex;
      gap: 7px;
      flex-wrap: wrap;
      align-items: center;
    }
    .selected-empty { color: var(--muted); padding: 4px 6px; }
    .pick {
      display: inline-grid;
      grid-template-columns: minmax(80px, auto) 64px 28px;
      align-items: center;
      gap: 5px;
      border: 1px solid #3d3323;
      background: #1d1811;
      border-radius: 7px;
      padding: 4px 5px;
      max-width: 260px;
    }
    .pick-name { color: var(--gold); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pick input { min-width: 0; width: 64px; padding: 5px 6px; }
    .pick button { width: 28px; height: 28px; padding: 0; min-width: 0; color: var(--muted); }
    .selected-clear { padding: 6px 9px; min-width: 0; align-self: stretch; }
    .tooltip {
      position: fixed;
      z-index: 50;
      max-width: 360px;
      pointer-events: none;
      background: rgba(12, 12, 14, .97);
      border: 1px solid #4b3d28;
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--text);
      box-shadow: 0 12px 36px rgba(0,0,0,.45);
      display: none;
    }
    .tooltip .tip-title { color: var(--gold); font-weight: 800; margin-bottom: 4px; }
    .tooltip .tip-line { color: #d8d4ca; font-size: 13px; margin-top: 2px; }
    .tip-grid { display: grid; grid-template-columns: repeat(7, 28px); gap: 4px; margin-top: 8px; }
    .tip-slot { width: 28px; height: 28px; display: grid; place-items: center; background: #242428; border: 1px solid #33343a; border-radius: 4px; position: relative; overflow: hidden; }
    .tip-slot img { max-width: 24px; max-height: 24px; image-rendering: pixelated; }
    .tip-slot span { position: absolute; right: 1px; bottom: 0; font-size: 10px; text-shadow: 1px 1px #000; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--line); padding: 11px 9px; text-align: left; vertical-align: top; }
    th { color: var(--gold); font-weight: 700; }
    .subnav { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
    .subnav button.active { background: #2a251e; color: var(--gold); border-color: #4a3921; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .stat { border: 1px solid var(--line); background: #141416; border-radius: 8px; padding: 12px; }
    .stat strong { display: block; font-size: 22px; color: var(--gold); }
    .tablewrap { overflow: auto; max-height: 68vh; }
    .compact-input { width: 86px; padding: 6px 7px; }
    .compact-select { width: 150px; padding: 6px 7px; }
    .ops { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .ops button { padding: 6px 8px; }
    .wrap { max-width: 360px; white-space: normal; word-break: break-word; }
    .nbt-modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 90;
      background: rgba(0,0,0,.68);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .nbt-modal {
      width: min(920px, 100%);
      max-height: 86vh;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #151518;
      box-shadow: 0 18px 60px rgba(0,0,0,.55);
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    .nbt-head { display: flex; gap: 10px; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    .nbt-title { color: var(--gold); font-size: 18px; font-weight: 800; margin-right: auto; }
    .nbt-body { overflow: auto; padding: 14px 16px; }
    .alias-form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }
    .alias-note { grid-column: 1 / -1; color: var(--muted); font-size: 13px; }
    .nbt-body pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: 13px/1.45 Consolas, "Courier New", monospace;
      color: #e7e2d8;
    }
    .nbt-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
    .login {
      max-width: 560px;
      margin: 11vh auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 32px;
    }
    .codebox {
      font-size: 44px;
      font-weight: 800;
      color: var(--gold);
      letter-spacing: 6px;
      background: #111;
      border: 1px solid #2c2c33;
      border-radius: 8px;
      padding: 16px;
      text-align: center;
      margin: 18px 0;
    }
    .login-tabs { display: flex; gap: 8px; margin: 18px 0 10px; }
    .login-tabs button { flex: 1; }
    .login-tabs button.active { color: var(--gold); border-color: #4a3921; background: #1b1712; }
    .login-wait {
      border: 1px solid var(--line);
      background: #121214;
      border-radius: 8px;
      padding: 14px;
      margin-top: 14px;
    }
    .login-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .toast { min-height: 24px; color: var(--gold); }
    .statusbar { min-height: 24px; color: var(--green); margin: -8px 0 14px; }
    .alias-mode .item { outline: 1px solid #5d492a; }
    .alias-mode .item:hover { border-color: var(--gold); background: #211b12; }
    .hidden { display: none !important; }
    @media (max-width: 860px) {
      .app { grid-template-columns: 1fr; }
      aside { min-height: auto; }
      main { padding: 20px; }
      .withdrawbar, .admin-transferbar { grid-template-columns: 1fr; }
      .litematicbar { grid-template-columns: 1fr; }
      .command-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div id="login" class="login hidden">
    <div class="brand"><span>云</span>仓库</div>
    <div class="login-tabs">
      <button id="loginCodeTab" class="active" type="button">临时验证码</button>
      <button id="loginTokenTab" type="button">密码登录</button>
    </div>
    <section id="loginCodePanel">
      <p class="muted">点击获取验证码，然后复制命令到游戏内发送。</p>
      <button id="loginCodeStart" class="solid" style="width:100%">获取验证码</button>
      <div id="loginCodeWait" class="login-wait hidden">
        <div class="muted">请在游戏内发送：</div>
        <div class="codebox" id="loginCodeCommand" style="font-size:20px;letter-spacing:0;text-align:left;word-break:break-all">/msg bot 登录 000000</div>
        <div id="loginCodeStatus" class="muted">等待验证...</div>
        <div class="login-actions">
          <button id="loginCodeCopy" class="primary" type="button">复制命令</button>
          <button id="loginCodeCancel" class="ghost" type="button">取消</button>
        </div>
      </div>
    </section>
    <section id="loginTokenPanel" class="hidden">
      <p class="muted">首次使用请在游戏内输入：</p>
      <div class="codebox" id="loginCommand" style="font-size:22px;letter-spacing:0">/msg bot 设置密码 xxx</div>
      <div class="withdrawbar" style="grid-template-columns:1fr auto;margin:18px 0 8px">
        <input id="tokenInput" type="password" placeholder="输入你设置的登录密码">
        <button id="loginBtn" class="solid">登录</button>
      </div>
      <p class="muted">例如：<code id="loginExample">/msg bot 设置密码 1234</code>。每次设置都会覆盖旧密码。</p>
    </section>
  </div>

  <div id="app" class="app hidden">
    <aside>
      <div class="brand"><span>云</span>仓库</div>
      <nav>
        <button class="navbtn active" data-view="inventory">▦　库存</button>
        <button class="navbtn" data-view="transactions">▤　交易记录</button>
        <button class="navbtn" data-view="help">？　帮助</button>
        <button id="adminLink" class="navbtn hidden" data-view="admin">▣　管理</button>
      </nav>
      <div class="userbox">
        <div><span class="dot"></span><span id="username">-</span></div>
        <button id="logout" class="ghost" style="width:100%;margin-top:18px">登出</button>
      </div>
    </aside>
    <main>
      <div class="hero">欢迎回来，<strong id="heroName">-</strong>。 共 <strong id="heroTypes">0</strong> 种物品，<strong id="heroAmount">0</strong> 件。</div>
      <section id="inventoryView">
        <div class="toolbar">
          <div class="title">远程存储 <span id="loaded" class="muted">0/0 种已加载</span></div>
          <select id="owner"></select>
          <button id="setDefaultOwner" class="primary">设为默认</button>
          <input id="search" placeholder="搜索物品、ID、6位码...">
          <button id="aliasMode" class="primary">物品别名</button>
          <button id="deposit" class="primary">远程存储</button>
          <button id="refresh" class="primary">刷新</button>
        </div>
        <div class="withdrawbar">
          <div id="selectedList" class="selected-list"><span class="selected-empty">点击物品加入待取列表</span></div>
          <div class="target-player-box">
            <input id="targetPlayer" autocomplete="off" placeholder="目标玩家，默认自己">
            <div id="onlinePlayers" class="player-menu hidden"></div>
          </div>
          <button id="withdraw" class="solid">取货</button>
        </div>
        <div id="inventoryAdminTransfer" class="admin-transferbar hidden">
          <div class="muted">管理员账本转账：把上方已选物品从当前仓库转给目标。</div>
          <input id="inventoryTransferTarget" placeholder="目标：玩家ID / 仓库名 / 仓库:仓库名 / momo">
          <button id="inventoryTransferRun" class="solid">转账</button>
        </div>
        <div class="litematicbar">
          <button id="litematicPick" class="primary">上传投影</button>
          <input id="litematicFile" class="hidden" type="file" accept=".litematic">
          <div id="litematicResult" class="litematic-result hidden"></div>
        </div>
        <div id="activeStatus" class="statusbar hidden"></div>
        <div id="inventory" class="panel"></div>
      </section>
      <section id="transactionsView" class="hidden">
        <div class="toolbar">
          <div class="title">交易记录</div>
          <button id="refreshTx" class="primary">刷新</button>
        </div>
        <div id="transactions" class="panel"></div>
      </section>
      <section id="helpView" class="hidden">
        <div class="toolbar">
          <div class="title">帮助</div>
        </div>
        <div class="help-layout">
          <section class="help-section">
            <div class="help-head">
              <h3>网页登录</h3>
              <span>私聊机器人</span>
            </div>
            <div class="command-list">
              <div class="command-row">
                <div>
                  <div class="command-name">设置网页密码</div>
                  <div class="command-desc">每次设置都会覆盖旧密码。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 设置密码 1234</code>
              </div>
            </div>
          </section>

          <section class="help-section">
            <div class="help-head">
              <h3>默认仓库</h3>
              <span>常用存取</span>
            </div>
            <div class="command-list">
              <div class="command-row">
                <div>
                  <div class="command-name">设置默认仓库</div>
                  <div class="command-desc">直接“存/取/查”会使用这个仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 设置默认仓库 椰汁橙</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">存物品</div>
                  <div class="command-desc">存入当前默认仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 存</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">取物品</div>
                  <div class="command-desc">从当前默认仓库取出，可以一次填写多种物品。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 取 石头64 红石块3</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">代取给别人</div>
                  <div class="command-desc">扣自己的默认仓库，交给目标玩家。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 取 石头5 玩家ID</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">查询物品</div>
                  <div class="command-desc">查询当前默认仓库，一次只查询一种物品。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 查 石头</code>
              </div>
            </div>
          </section>

          <section class="help-section">
            <div class="help-head">
              <h3>个人仓库</h3>
              <span>只操作自己</span>
            </div>
            <div class="command-list">
              <div class="command-row">
                <div>
                  <div class="command-name">个人取物品</div>
                  <div class="command-desc">只从个人仓库取，不自动补组织仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 个人 取 石头64</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">个人存物品</div>
                  <div class="command-desc">强制存入个人仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 个人 存</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">默认改回个人</div>
                  <div class="command-desc">以后直接“存/取/查”会使用个人仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 设置默认仓库 个人</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">个人查询</div>
                  <div class="command-desc">只查询个人仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 个人 查 石头</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">查看额度</div>
                  <div class="command-desc">查看当前仓库已占用格数。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 额度</code>
              </div>
            </div>
          </section>

          <section class="help-section">
            <div class="help-head">
              <h3>组织仓库</h3>
              <span>多人共享库存</span>
            </div>
            <div class="command-list">
              <div class="command-row">
                <div>
                  <div class="command-name">创建仓库</div>
                  <div class="command-desc">每个人最多创建 3 个组织仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 创建仓库 椰汁橙</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">我的仓库</div>
                  <div class="command-desc">查看自己关联的组织仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 我的仓库</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">组织存物品</div>
                  <div class="command-desc">物品会进入指定组织仓库。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 椰汁橙 存</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">组织取物品</div>
                  <div class="command-desc">从指定组织仓库取出物品。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 椰汁橙 取 石头64</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">组织查询</div>
                  <div class="command-desc">查询指定组织仓库的单种物品。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 椰汁橙 查 石头</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">查看成员</div>
                  <div class="command-desc">查看组织仓库成员列表。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 椰汁橙 仓库成员</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">添加成员</div>
                  <div class="command-desc">组织仓库管理员可用。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 椰汁橙 添加成员 玩家ID</code>
              </div>
              <div class="command-row">
                <div>
                  <div class="command-name">删除成员</div>
                  <div class="command-desc">组织仓库管理员可用。</div>
                </div>
                <code class="cmd">/msg <span class="help-bot">bot</span> 椰汁橙 删除成员 玩家ID</code>
              </div>
            </div>
          </section>
        </div>
      </section>
      <section id="adminView" class="hidden">
        <div class="toolbar">
          <div class="title">管理面板</div>
          <button id="adminRefresh" class="primary">刷新</button>
        </div>
        <div class="subnav">
          <button class="primary active" data-admin-tab="inventory">总库存</button>
          <button class="primary" data-admin-tab="mismatches">库存异常</button>
          <button class="primary" data-admin-tab="transfer">物品转账</button>
          <button class="primary" data-admin-tab="chests">木桶位置</button>
          <button class="primary" data-admin-tab="transactions">交易记录</button>
          <button class="primary" data-admin-tab="aliases">别名管理</button>
        </div>
        <section id="adminInventory">
          <div class="toolbar">
            <input id="adminInvOwner" placeholder="按归属筛选">
            <input id="adminInvItem" placeholder="按物品/ID/短码筛选">
            <button id="adminInvLoad" class="primary">查询</button>
          </div>
          <div id="adminInvStats" class="stats"></div>
          <div id="adminInvTable" class="panel tablewrap"></div>
        </section>
        <section id="adminMismatches" class="hidden">
          <div class="toolbar">
            <select id="adminMmStatus"><option value="open">未处理</option><option value="resolved">已处理</option></select>
            <select id="adminMmKind"><option value="">全部类型</option><option value="extra">多余</option><option value="missing">缺失</option></select>
            <input id="adminMmItem" placeholder="按物品筛选">
            <button id="adminMmLoad" class="primary">查询</button>
          </div>
          <div id="adminMmStats" class="stats"></div>
          <div id="adminMmTable" class="panel tablewrap"></div>
        </section>
        <section id="adminTransfer" class="hidden">
          <div class="toolbar">
            <input id="adminTransferFrom" placeholder="来源：玩家ID / 仓库名 / 仓库:仓库名 / momo">
            <input id="adminTransferTo" placeholder="目标：玩家ID / 仓库名 / 仓库:仓库名 / momo">
            <input id="adminTransferItem" placeholder="物品短码或完整 itemKey">
            <input id="adminTransferAmount" type="number" min="1" placeholder="数量">
            <button id="adminTransferRun" class="solid">转账</button>
          </div>
          <div class="panel" style="padding:14px;color:var(--muted)">数据库转账只修改账本，不移动木桶实物。玩家需存在于记录中或当前在线；组织仓库必须已创建。</div>
        </section>
        <section id="adminChests" class="hidden">
          <div class="toolbar">
            <input id="adminChestQ" placeholder="按木桶坐标筛选">
            <button id="adminChestLoad" class="primary">查询</button>
          </div>
          <div id="adminChestTable" class="panel tablewrap"></div>
          <div id="adminChestDetail" class="panel tablewrap" style="margin-top:14px"></div>
        </section>
        <section id="adminTransactions" class="hidden">
          <div class="toolbar">
            <input id="adminTxQ" placeholder="按归属/类型/物品/备注筛选">
            <button id="adminTxLoad" class="primary">查询</button>
          </div>
          <div id="adminTxTable" class="panel tablewrap"></div>
        </section>
        <section id="adminAliases" class="hidden">
          <div class="toolbar">
            <input id="adminAliasQ" placeholder="按别名/短码/ID/NBT筛选">
            <button id="adminAliasLoad" class="primary">查询</button>
          </div>
          <div id="adminAliasTable" class="panel tablewrap"></div>
        </section>
      </section>
      <p id="toast" class="toast"></p>
    </main>
  </div>
  <div id="nbtModal" class="nbt-modal-backdrop hidden">
    <div class="nbt-modal" role="dialog" aria-modal="true">
      <div class="nbt-head">
        <div id="nbtModalTitle" class="nbt-title">物品详情</div>
        <button id="nbtCopy" class="primary">复制</button>
        <button id="nbtClose" class="ghost">关闭</button>
      </div>
      <div class="nbt-body">
        <div id="aliasEditor" class="alias-form hidden">
          <input id="aliasInput" placeholder="填写你的个人别名，留空可清除">
          <button id="aliasSave" class="solid">保存别名</button>
          <button id="aliasClear" class="ghost">清除</button>
          <div id="aliasNote" class="alias-note"></div>
        </div>
        <pre id="nbtModalText"></pre>
      </div>
      <div class="nbt-foot"><span id="nbtModalHint" class="muted"></span></div>
    </div>
  </div>
  <div id="tooltip" class="tooltip"></div>

  <script>
    const state = { view: 'inventory', user: null, owners: [], owner: '', items: [], tx: [], selected: new Map(), aliasMode: false, aliasItem: null, adminTab: 'inventory', adminOwners: [], adminInventoryRows: new Map(), actionCooldownUntil: 0, actionCooldownTimer: null, iconRenderId: 0, activePoll: null, iconCache: new Map(), inventoryCache: new Map(), inventoryLoadId: 0, iconScrollTimer: null, onlinePlayersTimer: null, loginChallengeTimer: null, loginChallengeExpiresAt: 0, loginChallengeCommand: '' };
    const $ = id => document.getElementById(id);
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const num = value => Number(value || 0).toLocaleString('zh-CN');
    const toast = text => { $('toast').textContent = text || ''; };

    async function api(path, params = {}) {
      const url = new URL(path, location.origin);
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
      });
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        if (res.status === 401 && path !== '/api/me') loadMe().catch(() => {});
        throw new Error(data.error || res.statusText);
      }
      return data;
    }

    async function post(path, body = {}) {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        if (res.status === 401) loadMe().catch(() => {});
        throw new Error(data.error || res.statusText);
      }
      return data;
    }

    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取投影文件失败。'));
        reader.readAsDataURL(file);
      });
    }

    async function copyText(text) {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (!ok) throw new Error('浏览器禁止自动复制，请手动选中验证码命令复制。');
      return true;
    }

    function actionButtons() {
      return [$('deposit'), $('withdraw')].filter(Boolean);
    }

    function updateActionCooldown() {
      const remainingMs = state.actionCooldownUntil - Date.now();
      const cooling = remainingMs > 0;
      for (const button of actionButtons()) {
        if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
        button.disabled = cooling;
        button.textContent = cooling ? '冷却 ' + Math.ceil(remainingMs / 1000) + 's' : button.dataset.defaultText;
      }
      if (!cooling && state.actionCooldownTimer) {
        clearInterval(state.actionCooldownTimer);
        state.actionCooldownTimer = null;
      }
    }

    function startActionCooldown(ms = 3000) {
      state.actionCooldownUntil = Date.now() + ms;
      updateActionCooldown();
      if (state.actionCooldownTimer) clearInterval(state.actionCooldownTimer);
      state.actionCooldownTimer = setInterval(updateActionCooldown, 200);
    }

    async function runWebAction(action) {
      if (Date.now() < state.actionCooldownUntil) {
        toast('操作冷却中，请稍后再点。');
        return;
      }
      startActionCooldown(3000);
      await action();
    }

    async function runButtonTask(button, runningText, doneText, action) {
      if (!button || button.disabled) return;
      const oldText = button.textContent;
      button.disabled = true;
      button.textContent = runningText;
      try {
        await action();
        button.textContent = doneText;
        toast(doneText);
        setTimeout(() => {
          button.textContent = oldText;
          button.disabled = false;
        }, 900);
      } catch (error) {
        button.textContent = oldText;
        button.disabled = false;
        throw error;
      }
    }

    function iconUrl(itemId, type = 'item') {
      return 'https://blocksitems.com/api/v1/' + type + 's/' + encodeURIComponent(itemId || 'minecraft:stone') + '/icon?size=64';
    }

    function setIcon(img, item, done) {
      const cached = state.iconCache.get(item.itemId);
      img.loading = 'lazy';
      img.decoding = 'async';
      img.onload = () => {
        state.iconCache.set(item.itemId, img.src);
        if (typeof done === 'function') done();
      };
      img.onerror = () => {
        if (img.dataset.fallback) {
          img.style.display = 'none';
          img.parentElement.querySelector('.fallback').style.display = 'block';
          if (typeof done === 'function') done();
          return;
        }
        img.dataset.fallback = '1';
        img.src = iconUrl(item.itemId, 'block');
      };
      img.src = cached || iconUrl(item.itemId, 'item');
    }

    function scheduleIconLoading(rows) {
      const renderId = ++state.iconRenderId;
      const images = new Map([...document.querySelectorAll('.icon img[data-key]')].map(img => [img.dataset.key, img]));
      const visibleKeys = new Set();
      const viewportBottom = window.innerHeight + 260;
      for (const img of images.values()) {
        const rect = img.getBoundingClientRect();
        if (rect.top <= viewportBottom && rect.bottom >= -160) visibleKeys.add(img.dataset.key);
      }
      const queue = rows.filter(row => visibleKeys.has(row.itemKey)).slice(0, 180);
      let active = 0;
      const limit = 4;
      const pump = () => {
        if (renderId !== state.iconRenderId) return;
        while (active < limit && queue.length) {
          const item = queue.shift();
          const img = images.get(item.itemKey);
          if (!img || img.dataset.loaded) continue;
          active += 1;
          img.dataset.loaded = '1';
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            active -= 1;
            pump();
          };
          setIcon(img, item, finish);
        }
      };
      setTimeout(pump, 0);
    }

    function updateActiveStatus(active) {
      const el = $('activeStatus');
      if (!active) {
        el.classList.add('hidden');
        el.textContent = '';
        if (state.activePoll) {
          clearInterval(state.activePoll);
          state.activePoll = null;
        }
        return;
      }
      el.classList.remove('hidden');
      const target = active.targetUsername && active.targetUsername !== active.username ? '，目标 ' + active.targetUsername : '';
      el.textContent = (active.message || '任务进行中') + '：' + active.username + target;
      if (!state.activePoll) {
        state.activePoll = setInterval(async () => {
          try {
            const data = await api('/api/me');
            updateActiveStatus(data.active);
          } catch {}
        }, 1000);
      }
    }

    function updateBotNameLabels(botName) {
      for (const el of document.querySelectorAll('.help-bot')) {
        el.textContent = botName || 'bot';
      }
    }

    async function loadMe() {
      const data = await api('/api/me');
      if (!data.loggedIn) {
        $('app').classList.add('hidden');
        $('login').classList.remove('hidden');
        $('inventoryAdminTransfer')?.classList.add('hidden');
        const botName = data.botName || 'bot';
        $('loginCommand').textContent = '/msg ' + botName + ' 设置密码 xxx';
        $('loginExample').textContent = '/msg ' + botName + ' 设置密码 1234';
        updateBotNameLabels(botName);
        resetLoginChallengeUi(true);
        return;
      }
      stopLoginChallengePoll();
      $('login').classList.add('hidden');
      $('app').classList.remove('hidden');
      state.user = data.user;
      state.owners = data.owners || [];
      state.defaultOwnerUuid = data.defaultOwnerUuid || state.user.uuid;
      updateBotNameLabels(data.botName || 'bot');
      $('username').textContent = state.user.username;
      $('heroName').textContent = state.user.username;
      $('adminLink').classList.toggle('hidden', !state.user.isAdmin);
      $('inventoryAdminTransfer').classList.toggle('hidden', !state.user.isAdmin);
      renderOwners();
      await loadInventory();
      loadOnlinePlayers('').catch(error => toast(error.message));
      if (state.user.isAdmin && location.pathname === '/admin') setView('admin');
    }

    async function loginWithToken() {
      const token = $('tokenInput').value.trim();
      if (!token) return toast('请填写登录密码。');
      try {
        await post('/api/login', { token });
        $('tokenInput').value = '';
        await loadMe();
        toast('');
      } catch (error) {
        toast(error.message);
      }
    }

    function setLoginMode(mode) {
      const codeMode = mode === 'code';
      $('loginCodeTab').classList.toggle('active', codeMode);
      $('loginTokenTab').classList.toggle('active', !codeMode);
      $('loginCodePanel').classList.toggle('hidden', !codeMode);
      $('loginTokenPanel').classList.toggle('hidden', codeMode);
      if (!codeMode) cancelLoginChallenge().catch(() => {});
    }

    function stopLoginChallengePoll() {
      if (state.loginChallengeTimer) {
        clearInterval(state.loginChallengeTimer);
        state.loginChallengeTimer = null;
      }
    }

    function resetLoginChallengeUi(showStart = true) {
      stopLoginChallengePoll();
      state.loginChallengeExpiresAt = 0;
      state.loginChallengeCommand = '';
      if ($('loginCodeStart')) $('loginCodeStart').classList.toggle('hidden', !showStart);
      if ($('loginCodeWait')) $('loginCodeWait').classList.add('hidden');
      if ($('loginCodeStatus')) $('loginCodeStatus').textContent = '等待验证...';
    }

    function updateLoginChallengeCountdown() {
      if (!state.loginChallengeExpiresAt) return;
      const remaining = Math.max(0, state.loginChallengeExpiresAt - Date.now());
      $('loginCodeStatus').textContent = remaining > 0
        ? '等待游戏内验证，剩余 ' + Math.ceil(remaining / 1000) + ' 秒。'
        : '验证码已过期，请重新获取。';
    }

    async function startLoginChallenge() {
      try {
        const data = await post('/api/login/challenge');
        if (data.loggedIn) {
          await loadMe();
          return;
        }
        state.loginChallengeExpiresAt = Number(data.expiresAt || 0);
        state.loginChallengeCommand = data.command || '';
        $('loginCodeCommand').textContent = state.loginChallengeCommand;
        $('loginCodeStart').classList.add('hidden');
        $('loginCodeWait').classList.remove('hidden');
        updateLoginChallengeCountdown();
        stopLoginChallengePoll();
        state.loginChallengeTimer = setInterval(pollLoginChallenge, 1000);
        pollLoginChallenge().catch(error => toast(error.message));
      } catch (error) {
        toast(error.message);
      }
    }

    async function pollLoginChallenge() {
      const data = await api('/api/login/challenge');
      if (data.status === 'approved') {
        stopLoginChallengePoll();
        await loadMe();
        toast('');
        return;
      }
      if (data.status === 'expired') {
        stopLoginChallengePoll();
        $('loginCodeStatus').textContent = '验证码已过期，请重新获取。';
        $('loginCodeStart').classList.remove('hidden');
        return;
      }
      if (data.status === 'cancelled' || data.status === 'none') {
        resetLoginChallengeUi(true);
        return;
      }
      if (data.command) {
        state.loginChallengeCommand = data.command;
        $('loginCodeCommand').textContent = data.command;
      }
      if (data.expiresAt) state.loginChallengeExpiresAt = Number(data.expiresAt);
      updateLoginChallengeCountdown();
    }

    async function cancelLoginChallenge() {
      stopLoginChallengePoll();
      try {
        await post('/api/login/challenge/cancel');
      } finally {
        resetLoginChallengeUi(true);
      }
    }

    async function copyLoginChallengeCommand() {
      if (!state.loginChallengeCommand) return toast('还没有可复制的验证码命令。');
      await copyText(state.loginChallengeCommand);
      const button = $('loginCodeCopy');
      const oldText = button.textContent;
      button.textContent = '已复制';
      button.disabled = true;
      toast('已复制临时验证码命令。');
      setTimeout(() => {
        button.textContent = oldText;
        button.disabled = false;
      }, 1200);
    }

    function renderOwners() {
      $('owner').innerHTML = state.owners.map(owner => {
        const label = owner.label + (owner.isDefault ? '（默认）' : '');
        return '<option value="' + esc(owner.ownerUuid) + '">' + esc(label) + '</option>';
      }).join('');
      const fallbackOwner = state.owners.find(owner => owner.ownerUuid === state.defaultOwnerUuid)?.ownerUuid || state.owners[0]?.ownerUuid || state.user.uuid;
      state.owner = state.owner && state.owners.some(owner => owner.ownerUuid === state.owner) ? state.owner : fallbackOwner;
      $('owner').value = state.owner;
      const selected = state.owners.find(owner => owner.ownerUuid === state.owner);
      if ($('setDefaultOwner')) {
        $('setDefaultOwner').textContent = selected?.isDefault ? '默认仓库' : '设为默认';
        $('setDefaultOwner').disabled = Boolean(selected?.isDefault);
      }
    }

    async function setDefaultOwner() {
      const ownerUuid = $('owner').value || state.owner;
      if (!ownerUuid) return toast('请先选择仓库。');
      const data = await post('/api/default-owner', { ownerUuid });
      state.owners = data.owners || state.owners;
      state.defaultOwnerUuid = data.defaultOwnerUuid || ownerUuid;
      renderOwners();
      toast(data.message || '已设置默认仓库。');
    }

    function applyInventoryData(data) {
      state.items = data.items || [];
      updateActiveStatus(data.active);
      state.selected.clear();
      renderLitematicPlan(null);
      $('heroTypes').textContent = num(data.stats?.itemTypes || 0);
      $('heroAmount').textContent = num(data.stats?.totalAmount || 0);
      renderSelected();
      renderInventory();
    }

    async function loadInventory(options = {}) {
      state.owner = $('owner').value || state.owner;
      const loadId = ++state.inventoryLoadId;
      const cached = state.inventoryCache.get(state.owner);
      if (cached && !options.force) {
        applyInventoryData(cached);
      }
      const data = await api('/api/inventory', { owner: state.owner });
      if (loadId !== state.inventoryLoadId) return;
      state.inventoryCache.set(state.owner, data);
      applyInventoryData(data);
    }

    async function loadOnlinePlayers(query = '') {
      const data = await api('/api/online-players', { q: query });
      const rows = data.rows || [];
      renderOnlinePlayers(rows);
    }

    function renderOnlinePlayers(rows) {
      const menu = $('onlinePlayers');
      if (!document.activeElement || document.activeElement !== $('targetPlayer')) return;
      menu.classList.remove('hidden');
      if (!rows.length) {
        menu.innerHTML = '<div class="player-empty">没有匹配的在线玩家</div>';
        return;
      }
      menu.innerHTML = rows.slice(0, 30).map(row => {
        const label = row.currentUser ? row.username + '（自己）' : row.username;
        const ping = Number.isFinite(row.ping) ? row.ping + 'ms' : 'tab';
        return '<button type="button" class="player-option" data-online-player="' + esc(row.username) + '">' +
          '<span>' + esc(label) + '</span>' +
          '<span class="ping">' + esc(ping) + '</span>' +
        '</button>';
      }).join('');
    }

    function scheduleOnlinePlayersLoad() {
      if (state.onlinePlayersTimer) clearTimeout(state.onlinePlayersTimer);
      state.onlinePlayersTimer = setTimeout(() => {
        loadOnlinePlayers($('targetPlayer').value).catch(error => toast(error.message));
      }, 180);
    }

    function hideOnlinePlayers() {
      $('onlinePlayers').classList.add('hidden');
    }

    function itemText(item) {
      return [item.displayName, item.adminDisplayName, item.personalAlias, item.itemId, item.itemKey, item.shortCode, item.nbtJson, item.metaJson, ...(item.shulkerContents || []).map(x => x.displayName + ' ' + x.adminDisplayName + ' ' + x.itemId + ' ' + x.shortCode)].join(' ').toLowerCase();
    }

    function shortCount(value) {
      const n = Number(value || 0);
      if (n >= 1000000) return Math.floor(n / 100000) / 10 + 'm';
      if (n >= 10000) return Math.floor(n / 1000) + 'k';
      return String(n);
    }

    function tooltipHtml(item) {
      const shulker = item.shulkerContents || [];
      const lines = [
        '<div class="tip-title">' + esc(item.displayName || item.itemId) + '</div>',
        item.personalAlias ? '<div class="tip-line">个人别名：' + esc(item.personalAlias) + '</div>' : '',
        item.adminDisplayName && item.adminDisplayName !== item.displayName ? '<div class="tip-line">默认名：' + esc(item.adminDisplayName) + '</div>' : '',
        '<div class="tip-line">数量：' + num(item.amount) + '</div>',
        '<div class="tip-line">ID：' + esc(item.itemId) + '</div>'
      ].filter(Boolean);
      if (shulker.length) {
        lines.push('<div class="tip-line">潜影盒内容：</div>');
        lines.push('<div class="tip-grid">' + shulker.slice(0, 21).map(x =>
          '<div class="tip-slot" title="' + esc(x.displayName || x.itemId) + '">' +
          '<img data-tip-icon="' + esc(x.itemId) + '" alt="">' +
          '<span>' + esc(shortCount(x.amount)) + '</span>' +
          '</div>'
        ).join('') + '</div>');
        if (shulker.length > 21) lines.push('<div class="tip-line">还有 ' + (shulker.length - 21) + ' 种未显示</div>');
      }
      return lines.join('');
    }

    function showTip(event, item) {
      if (!canHoverTooltip()) return;
      const tip = $('tooltip');
      tip.innerHTML = tooltipHtml(item);
      tip.style.display = 'block';
      moveTip(event);
      for (const img of tip.querySelectorAll('[data-tip-icon]')) {
        const itemId = img.dataset.tipIcon;
        img.src = iconUrl(itemId, 'item');
        img.onerror = () => { img.style.display = 'none'; };
      }
    }

    function moveTip(event) {
      if (!canHoverTooltip()) return;
      const tip = $('tooltip');
      if (tip.style.display === 'none') return;
      const pad = 14;
      let x = event.clientX + pad;
      let y = event.clientY + pad;
      const rect = tip.getBoundingClientRect();
      if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
      if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
      tip.style.left = Math.max(8, x) + 'px';
      tip.style.top = Math.max(8, y) + 'px';
    }

    function hideTip() {
      $('tooltip').style.display = 'none';
    }

    function canHoverTooltip() {
      return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    }

    function defaultPickAmount(item) {
      return Math.max(1, Math.min(Number(item.amount || 1), 64));
    }

    function toggleSelected(item) {
      hideTip();
      if (state.aliasMode) {
        openAliasModal(item);
        return;
      }
      if (state.selected.has(item.itemKey)) {
        state.selected.delete(item.itemKey);
      } else {
        state.selected.set(item.itemKey, {
          itemKey: item.itemKey,
          displayName: item.displayName || item.itemId,
          amount: defaultPickAmount(item),
          max: Number(item.amount || 0)
        });
      }
      renderSelected();
      renderInventory();
    }

    function setAliasMode(enabled) {
      state.aliasMode = Boolean(enabled);
      $('aliasMode').classList.toggle('solid', state.aliasMode);
      $('aliasMode').textContent = state.aliasMode ? '退出别名' : '物品别名';
      $('inventory').classList.toggle('alias-mode', state.aliasMode);
      $('selectedList').innerHTML = state.aliasMode
        ? '<span class="selected-empty">改名模式：点击物品图标查看 NBT 并设置你的个人别名</span>'
        : (state.selected.size ? $('selectedList').innerHTML : '<span class="selected-empty">点击物品加入待取列表</span>');
      if (!state.aliasMode) renderSelected();
    }

    function renderSelected() {
      if (state.aliasMode) {
        $('selectedList').innerHTML = '<span class="selected-empty">改名模式：点击物品图标查看 NBT 并设置你的个人别名</span>';
        return;
      }
      const rows = [...state.selected.values()];
      if (!rows.length) {
        $('selectedList').innerHTML = '<span class="selected-empty">点击物品加入待取列表</span>';
        return;
      }
      $('selectedList').innerHTML = rows.map(row =>
        '<div class="pick" data-pick="' + esc(row.itemKey) + '">' +
        '<span class="pick-name" title="' + esc(row.displayName) + '">' + esc(row.displayName) + '</span>' +
        '<input type="number" min="1" max="' + esc(row.max || '') + '" value="' + esc(row.amount) + '" data-pick-amount>' +
        '<button class="ghost" data-pick-remove title="取消">×</button>' +
        '</div>'
      ).join('') + '<button id="clearSelected" class="ghost selected-clear" type="button">清空</button>';
      for (const input of document.querySelectorAll('[data-pick-amount]')) {
        input.addEventListener('change', () => {
          const key = input.closest('[data-pick]').dataset.pick;
          const row = state.selected.get(key);
          if (!row) return;
          const value = Number.parseInt(input.value, 10);
          row.amount = Math.max(1, Math.min(Number(row.max || value || 1), Number.isFinite(value) && value > 0 ? value : 1));
          input.value = row.amount;
        });
      }
      for (const button of document.querySelectorAll('[data-pick-remove]')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          const key = button.closest('[data-pick]').dataset.pick;
          state.selected.delete(key);
          renderSelected();
          renderInventory();
        });
      }
      $('clearSelected')?.addEventListener('click', event => {
        event.stopPropagation();
        state.selected.clear();
        renderSelected();
        renderInventory();
        toast('已清空取货列表。');
      });
    }

    function renderLitematicPlan(plan) {
      const el = $('litematicResult');
      if (!plan) {
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
      }

      const missing = plan.missing || [];
      const unavailable = plan.unavailable || [];
      const warnings = [];
      if (missing.length) {
        warnings.push('缺少：' + missing.map(row => esc(row.displayName || row.itemId) + ' x' + num(row.missing || row.amount)).join('，'));
      }
      if (unavailable.length) {
        warnings.push('不可直接准备：' + unavailable.map(row => esc(row.displayName || row.blockId) + ' x' + num(row.amount)).join('，'));
      }

      el.classList.remove('hidden');
      el.innerHTML =
        '<div class="litematic-title">' + esc(plan.blueprint?.name || '投影') + '</div>' +
        '<div class="litematic-lines">' +
          '<span>已选 ' + num(plan.stats?.selectedTypes || 0) + ' 行</span>' +
          '<span>物品 ' + num(plan.stats?.selectedAmount || 0) + ' 个</span>' +
          '<span>预计格数 ' + num(plan.stats?.usedSlots || 0) + '</span>' +
          '<span>蓝图材料 ' + num(plan.blueprint?.materialTypes || 0) + ' 种</span>' +
        '</div>' +
        (warnings.length ? '<div class="litematic-warn">' + warnings.join('<br>') + '</div>' : '<div class="muted" style="margin-top:5px">材料已按当前库存自动加入待取列表。</div>');
    }

    function applyLitematicSelection(plan) {
      state.selected.clear();
      for (const row of plan.selected || []) {
        if (!row.itemKey || Number(row.amount || 0) <= 0) continue;
        state.selected.set(row.itemKey, {
          itemKey: row.itemKey,
          displayName: row.displayName || row.itemId,
          amount: Number(row.amount || 0),
          max: Number(row.max || row.amount || 0)
        });
      }
      renderSelected();
      renderInventory();
    }

    async function uploadLitematic() {
      const input = $('litematicFile');
      const file = input.files?.[0];
      if (!file) return;
      try {
        if (!/\\.litematic$/i.test(file.name)) throw new Error('只支持 .litematic 投影文件。');
        if (file.size > 8 * 1024 * 1024) throw new Error('投影文件过大，请控制在 8MB 以内。');
        toast('正在解析投影...');
        const dataUrl = await fileToDataUrl(file);
        const data = await post('/api/litematic/plan', {
          ownerUuid: state.owner,
          fileName: file.name,
          dataBase64: dataUrl
        });
        applyLitematicSelection(data);
        renderLitematicPlan(data);
        toast((data.selected || []).length ? '已按投影自动加入待取列表。' : '投影已解析，但当前仓库没有可取材料。');
      } catch (error) {
        renderLitematicPlan(null);
        toast(error.message);
      } finally {
        input.value = '';
      }
    }

    function currentInventoryRows() {
      const q = $('search').value.trim().toLowerCase();
      return q ? state.items.filter(item => itemText(item).includes(q)) : state.items;
    }

    function renderInventory() {
      const rows = currentInventoryRows();
      $('loaded').textContent = rows.length + '/' + state.items.length + ' 种已加载';
      if (!rows.length) {
        $('inventory').innerHTML = '<p class="muted" style="text-align:center;margin:46px 0">账户为空，暂无物品存储。</p>';
        return;
      }
      $('inventory').innerHTML = '<div class="grid">' + rows.map(item => {
        const selected = state.selected.has(item.itemKey) ? ' selected' : '';
        const aliasTitle = item.personalAlias ? '个人别名：' + item.personalAlias : (item.adminDisplayName && item.adminDisplayName !== item.displayName ? '默认名：' + item.adminDisplayName : '');
        return '<div class="item' + selected + '" data-key="' + esc(item.itemKey) + '">' +
          '<div class="icon"><img data-key="' + esc(item.itemKey) + '" alt="" loading="lazy" decoding="async"><span class="fallback">' + esc((item.displayName || item.itemId).slice(0, 4)) + '</span><span class="count">' + esc(shortCount(item.amount)) + '</span></div>' +
          '<div class="name" title="' + esc(aliasTitle) + '">' + esc(item.displayName || item.itemId) + '</div>' +
          '</div>';
      }).join('') + '</div>';
      $('inventory').classList.toggle('alias-mode', state.aliasMode);
      scheduleIconLoading(rows);
      for (const el of document.querySelectorAll('.item[data-key]')) {
        const item = rows.find(row => row.itemKey === el.dataset.key);
        if (!item) continue;
        el.addEventListener('click', () => {
          toggleSelected(item);
        });
        if (canHoverTooltip()) {
          el.addEventListener('mouseenter', event => showTip(event, item));
          el.addEventListener('mousemove', moveTip);
          el.addEventListener('mouseleave', hideTip);
        }
      }
    }

    async function loadTransactions() {
      const data = await api('/api/transactions', { owner: state.owner });
      state.tx = data.rows || [];
      if (!state.tx.length) {
        $('transactions').innerHTML = '<p class="muted" style="text-align:center;margin:46px 0">暂无交易记录。</p>';
        return;
      }
      $('transactions').innerHTML = '<table><thead><tr><th>时间</th><th>类型</th><th>状态</th><th>物品</th><th>备注</th></tr></thead><tbody>' + state.tx.map(row => {
        const items = row.items?.length ? row.items.map(item => esc(item.displayName || item.itemId) + ' x' + num(item.amount)).join('，') : '<span class="muted">无</span>';
        return '<tr><td>' + esc(row.createdAtLabel || row.createdAt) + '</td><td>' + esc(row.typeLabel || row.type) + '</td><td>' + esc(row.statusLabel || row.status) + '</td><td>' + items + '</td><td class="muted">' + esc(row.messageLabel || row.message || '') + '</td></tr>';
      }).join('') + '</tbody></table>';
    }

    function renderTable(target, headers, rows, emptyText = '没有数据。') {
      if (!rows.length) {
        $(target).innerHTML = '<p class="muted" style="text-align:center;margin:30px 0">' + esc(emptyText) + '</p>';
        return;
      }
      $(target).innerHTML = '<table><thead><tr>' + headers.map(header => '<th>' + esc(header) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
    }

    function renderStats(target, stats) {
      $(target).innerHTML = Object.entries(stats).map(([label, value]) =>
        '<div class="stat"><span class="muted">' + esc(label) + '</span><strong>' + num(value) + '</strong></div>'
      ).join('');
    }

    async function loadAdminOwners() {
      if (!state.user?.isAdmin) return;
      if (state.adminOwners.length) return;
      const data = await api('/api/admin/owners');
      state.adminOwners = data.rows || [];
    }

    function ownerOptions(selected = '') {
      return state.adminOwners.map(owner =>
        '<option value="' + esc(owner.ownerUuid) + '"' + (owner.ownerUuid === selected ? ' selected' : '') + '>' + esc(owner.label) + '</option>'
      ).join('');
    }

    function formatJsonText(value) {
      const text = String(value || '').trim();
      if (!text) return '';
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return text;
      }
    }

    function adminItemDetailText(row) {
      return [
        '归属: ' + (row.ownerLabel || row.ownerUuid || ''),
        '短码: ' + (row.shortCode || ''),
        '名称: ' + (row.displayName || ''),
        row.personalAlias ? '个人别名: ' + row.personalAlias : '',
        row.adminDisplayName && row.adminDisplayName !== row.displayName ? '默认名: ' + row.adminDisplayName : '',
        'ID: ' + (row.itemId || ''),
        '数量: ' + Number(row.amount || 0),
        'itemKey: ' + (row.itemKey || ''),
        '',
        'NBT:',
        formatJsonText(row.nbtJson) || '无',
        '',
        'meta:',
        formatJsonText(row.metaJson) || '无'
      ].filter(line => line !== '').join('\\n');
    }

    function openNbtModal(row) {
      state.aliasItem = null;
      $('aliasEditor').classList.add('hidden');
      $('nbtModalTitle').textContent = (row.displayName || row.itemId || '物品详情') + (row.shortCode ? ' #' + row.shortCode : '');
      $('nbtModalText').textContent = adminItemDetailText(row);
      $('nbtModalHint').textContent = row.nbtJson || row.metaJson ? '可以按 NBT 或 meta 里的关键词筛选总库存。' : '这个物品没有额外 NBT/meta。';
      $('nbtModal').classList.remove('hidden');
    }

    function openAliasModal(item) {
      state.aliasItem = item;
      $('aliasEditor').classList.remove('hidden');
      $('aliasInput').value = item.personalAlias || '';
      $('aliasNote').textContent = '默认名：' + (item.adminDisplayName || item.itemId || '') + '；短码：' + (item.shortCode || '无');
      $('nbtModalTitle').textContent = (item.displayName || item.itemId || '物品详情') + (item.shortCode ? ' #' + item.shortCode : '');
      $('nbtModalText').textContent = adminItemDetailText(item);
      $('nbtModalHint').textContent = item.nbtJson || item.metaJson ? '这里保存的是你的个人别名，不会影响其他玩家。' : '这个物品没有额外 NBT/meta；个人别名只影响你自己看到的名字。';
      $('nbtModal').classList.remove('hidden');
      $('aliasInput').focus();
    }

    function closeNbtModal() {
      $('nbtModal').classList.add('hidden');
      $('nbtModalText').textContent = '';
      $('aliasEditor').classList.add('hidden');
      state.aliasItem = null;
    }

    async function copyNbtModal() {
      const text = $('nbtModalText').textContent || '';
      if (!text) return;
      await navigator.clipboard.writeText(text);
      toast('已复制物品详情。');
    }

    function applyAliasToLocalItem(itemKey, displayName, personalAlias) {
      for (const item of state.items) {
        if (item.itemKey !== itemKey) continue;
        item.displayName = displayName || item.adminDisplayName || item.itemId;
        item.personalAlias = personalAlias || '';
      }
      const picked = state.selected.get(itemKey);
      if (picked) picked.displayName = displayName || picked.displayName;
      state.inventoryCache.delete(state.owner);
      renderSelected();
      renderInventory();
    }

    async function savePersonalAlias(displayName = null) {
      if (!state.aliasItem) return;
      const nextName = displayName === null ? $('aliasInput').value.trim() : String(displayName || '').trim();
      const data = await post('/api/item-alias/save', {
        itemKey: state.aliasItem.itemKey,
        displayName: nextName
      });
      applyAliasToLocalItem(data.itemKey, data.displayName, data.personalAlias);
      const updated = state.items.find(item => item.itemKey === data.itemKey) || {
        ...state.aliasItem,
        displayName: data.displayName,
        personalAlias: data.personalAlias
      };
      openAliasModal(updated);
      toast(data.message);
    }

    async function loadAdminInventory() {
      await loadAdminOwners();
      const data = await api('/api/admin/inventory', {
        owner: $('adminInvOwner').value,
        item: $('adminInvItem').value
      });
      renderStats('adminInvStats', {
        '归属数': data.stats?.owners || 0,
        '物品种类': data.stats?.itemTypes || 0,
        '物品总数': data.stats?.totalAmount || 0
      });
      state.adminInventoryRows = new Map();
      renderTable('adminInvTable', ['归属', '短码', '物品', '数量', '操作'], (data.rows || []).map((row, index) => {
        const rowId = String(index);
        state.adminInventoryRows.set(rowId, row);
        return '<tr data-owner="' + esc(row.ownerUuid) + '" data-item="' + esc(row.itemKey) + '" data-admin-row="' + esc(rowId) + '">' +
          '<td>' + esc(row.ownerLabel) + '</td>' +
          '<td>' + esc(row.shortCode) + '</td>' +
          '<td class="wrap">' + esc(row.displayName) + '<div class="muted">' + esc(row.itemId) + '</div></td>' +
          '<td>' + num(row.amount) + '</td>' +
          '<td><div class="ops">' +
            '<button data-admin-nbt>查看 NBT</button>' +
            '<input class="compact-input" type="number" min="0" value="' + esc(row.amount) + '" data-admin-amount>' +
            '<button data-admin-set>设置</button>' +
            '<select class="compact-select" data-admin-target>' + ownerOptions(row.ownerUuid) + '</select>' +
            '<input class="compact-input" type="number" min="1" value="' + esc(Math.min(Number(row.amount || 1), 64)) + '" data-admin-transfer-amount>' +
            '<button data-admin-transfer>转移</button>' +
            '<input class="compact-select" style="width:170px" value="' + esc(row.displayName) + '" data-admin-alias placeholder="给物品起别名">' +
            '<button data-admin-alias-save>保存别名</button>' +
          '</div></td>' +
        '</tr>';
      }), '没有库存。');
    }

    async function loadAdminMismatches() {
      const data = await api('/api/admin/mismatches', {
        status: $('adminMmStatus').value,
        kind: $('adminMmKind').value,
        item: $('adminMmItem').value
      });
      renderStats('adminMmStats', {
        '未处理行数': data.stats?.openRows || 0,
        '多余数量': data.stats?.extraAmount || 0,
        '缺失数量': data.stats?.missingAmount || 0
      });
      renderTable('adminMmTable', ['时间', '类型', '归属', '短码', '物品', '数量', '说明', '操作'], (data.rows || []).map(row =>
        '<tr data-mm-owner="' + esc(row.ownerLabel || row.username || '') + '" data-mm-item="' + esc(row.displayName || row.itemId || '') + '" data-mm-amount="' + esc(row.amount) + '">' +
          '<td>' + esc(row.createdAt) + (row.resolvedAt ? '<div class="muted">处理：' + esc(row.resolvedAt) + '</div>' : '') + '</td>' +
          '<td>' + (row.kind === 'extra' ? '多余' : '缺失') + '<div class="muted">' + (row.status === 'open' ? '未处理' : '已处理') + '</div></td>' +
          '<td>' + esc(row.ownerLabel || row.username || '') + '</td>' +
          '<td>' + esc(row.shortCode) + '</td>' +
          '<td class="wrap">' + esc(row.displayName) + '<div class="muted">' + esc(row.itemId) + '</div></td>' +
          '<td>' + num(row.amount) + '</td>' +
          '<td class="wrap muted">' + esc(row.note || '') + '</td>' +
          '<td>' + (row.status === 'open' ? '<button data-admin-mm-deduct="' + esc(row.id) + '">扣除库存</button>' : '') + '</td>' +
        '</tr>'
      ), '没有库存异常。');
    }

    async function runAdminTransfer() {
      const fromOwnerText = $('adminTransferFrom').value.trim();
      const toOwnerText = $('adminTransferTo').value.trim();
      const itemKey = $('adminTransferItem').value.trim();
      const amount = $('adminTransferAmount').value;
      const data = await post('/api/admin/transfer', { fromOwnerText, toOwnerText, itemKey, amount });
      toast(data.message);
      state.adminOwnersLoaded = false;
      if (state.adminTab === 'transfer') {
        $('adminTransferAmount').value = '';
      }
    }

    async function runInventoryAdminTransfer() {
      if (!state.user?.isAdmin) return;
      const target = $('inventoryTransferTarget').value.trim();
      if (!target) return toast('请填写转账目标。');
      const rows = [...state.selected.values()].filter(row => Number(row.amount || 0) > 0);
      if (!rows.length) return toast('请先点击物品加入待转账列表。');
      const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
      const ok = confirm('确认从当前仓库转账 ' + rows.length + ' 种、共 ' + total + ' 个物品给 ' + target + ' 吗？');
      if (!ok) return;

      for (const row of rows) {
        await post('/api/admin/transfer', {
          fromOwnerUuid: state.owner,
          toOwnerText: target,
          itemKey: row.itemKey,
          amount: row.amount
        });
      }
      toast('账本转账完成：' + rows.length + ' 种，共 ' + total + ' 个。');
      state.selected.clear();
      state.inventoryCache.delete(state.owner);
      state.adminOwnersLoaded = false;
      await loadInventory({ force: true });
    }

    async function loadAdminChests() {
      const data = await api('/api/admin/chests', { q: $('adminChestQ').value });
      renderTable('adminChestTable', ['木桶', '方块', '槽位', '物品数', '最后同步', '操作'], (data.rows || []).map(row =>
        '<tr>' +
          '<td>' + esc(row.chestId) + '</td>' +
          '<td>' + esc(row.blockName) + '</td>' +
          '<td>' + num(row.slotCount) + '</td>' +
          '<td>' + num(row.totalAmount) + '</td>' +
          '<td>' + esc(row.lastSeenAt || '') + '</td>' +
          '<td><button data-admin-chest="' + esc(row.chestId) + '">查看</button></td>' +
        '</tr>'
      ), '没有木桶记录。');
    }

    async function loadAdminChestDetail(chestId) {
      const data = await api('/api/admin/chest', { chest: chestId });
      $('adminChestDetail').innerHTML = '<div class="title" style="font-size:18px;margin-bottom:10px">' + esc(data.chest.chestId) + '</div>';
      renderTable('adminChestDetail', ['槽位', '短码', '物品', '数量'], (data.items || []).map(row =>
        '<tr><td>' + esc(row.slot) + '</td><td>' + esc(row.shortCode) + '</td><td class="wrap">' + esc(row.displayName) + '<div class="muted">' + esc(row.itemId) + '</div></td><td>' + num(row.amount) + '</td></tr>'
      ), '这个木桶没有记录物品。');
    }

    async function loadAdminTransactions() {
      const data = await api('/api/admin/transactions', { q: $('adminTxQ').value });
      renderTable('adminTxTable', ['时间', '类型', '归属', '物品', '备注'], (data.rows || []).map(row => {
        const items = row.items?.length ? row.items.map(item => esc(item.displayName || item.itemId) + ' x' + num(item.amount)).join('，') : '<span class="muted">无</span>';
        return '<tr><td>' + esc(row.createdAtLabel || row.createdAt) + '</td><td>' + esc(row.typeLabel || row.type) + '<div class="muted">' + esc(row.statusLabel || row.status) + '</div></td><td>' + esc(row.ownerLabel || row.username || '') + '</td><td class="wrap">' + items + '</td><td class="wrap muted">' + esc(row.messageLabel || row.message || '') + '</td></tr>';
      }), '没有交易记录。');
    }

    async function loadAdminAliases() {
      const data = await api('/api/admin/aliases', { q: $('adminAliasQ').value });
      renderTable('adminAliasTable', ['别名', '短码', '物品', '详细 NBT', '更新时间', '操作'], (data.rows || []).map(row => {
        const detail = [
          row.itemKey ? 'itemKey: ' + row.itemKey : '',
          row.nbtJson ? 'NBT: ' + row.nbtJson : '',
          row.metaJson ? 'meta: ' + row.metaJson : ''
        ].filter(Boolean).join('\\n');
        return '<tr>' +
          '<td>' + esc(row.displayName) + '</td>' +
          '<td>' + esc(row.shortCode) + '</td>' +
          '<td class="wrap">' + esc(row.itemId || '') + '<div class="muted">' + esc(row.itemKey || '') + '</div></td>' +
          '<td class="wrap">' + (detail ? '<details><summary>查看详情</summary><pre style="white-space:pre-wrap;max-width:520px">' + esc(detail) + '</pre></details>' : '<span class="muted">无</span>') + '</td>' +
          '<td>' + esc(row.updatedAt || row.createdAt || '') + '</td>' +
          '<td><button data-admin-alias-delete="' + esc(row.shortCode) + '">删除</button></td>' +
        '</tr>';
      }), '没有别名。');
    }

    async function loadAdminCurrent() {
      if (!state.user?.isAdmin) return;
      if (state.adminTab === 'inventory') return loadAdminInventory();
      if (state.adminTab === 'mismatches') return loadAdminMismatches();
      if (state.adminTab === 'transfer') return Promise.resolve();
      if (state.adminTab === 'chests') return loadAdminChests();
      if (state.adminTab === 'transactions') return loadAdminTransactions();
      if (state.adminTab === 'aliases') return loadAdminAliases();
    }

    function setAdminTab(tab) {
      state.adminTab = tab;
      document.querySelectorAll('[data-admin-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.adminTab === tab));
      $('adminInventory').classList.toggle('hidden', tab !== 'inventory');
      $('adminMismatches').classList.toggle('hidden', tab !== 'mismatches');
      $('adminTransfer').classList.toggle('hidden', tab !== 'transfer');
      $('adminChests').classList.toggle('hidden', tab !== 'chests');
      $('adminTransactions').classList.toggle('hidden', tab !== 'transactions');
      $('adminAliases').classList.toggle('hidden', tab !== 'aliases');
      loadAdminCurrent().catch(error => toast(error.message));
    }

    function setView(view) {
      if (view === 'admin' && !state.user?.isAdmin) return toast('只有管理员可以打开管理界面。');
      state.view = view;
      document.querySelectorAll('.navbtn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
      $('inventoryView').classList.toggle('hidden', view !== 'inventory');
      $('transactionsView').classList.toggle('hidden', view !== 'transactions');
      $('helpView').classList.toggle('hidden', view !== 'help');
      $('adminView').classList.toggle('hidden', view !== 'admin');
      if (view === 'transactions') loadTransactions().catch(error => toast(error.message));
      if (view === 'admin') loadAdminCurrent().catch(error => toast(error.message));
    }

    $('owner').addEventListener('change', () => {
      state.owner = $('owner').value || state.owner;
      renderOwners();
      loadInventory().catch(error => toast(error.message));
    });
    $('setDefaultOwner').addEventListener('click', () => setDefaultOwner().catch(error => toast(error.message)));
    $('search').addEventListener('input', renderInventory);
    $('targetPlayer').addEventListener('input', scheduleOnlinePlayersLoad);
    $('targetPlayer').addEventListener('focus', scheduleOnlinePlayersLoad);
    $('targetPlayer').addEventListener('keydown', event => {
      if (event.key === 'Escape') hideOnlinePlayers();
    });
    $('refresh').addEventListener('click', event => {
      runButtonTask(event.currentTarget, '刷新中...', '库存已刷新', () => loadInventory({ force: true })).catch(error => toast(error.message));
    });
    $('aliasMode').addEventListener('click', () => setAliasMode(!state.aliasMode));
    window.addEventListener('scroll', () => {
      hideTip();
      if (state.iconScrollTimer) clearTimeout(state.iconScrollTimer);
      state.iconScrollTimer = setTimeout(() => scheduleIconLoading(currentInventoryRows()), 80);
    }, { passive: true });
    window.addEventListener('touchstart', hideTip, { passive: true });
    $('litematicPick').addEventListener('click', () => $('litematicFile').click());
    $('litematicFile').addEventListener('change', uploadLitematic);
    $('refreshTx').addEventListener('click', event => {
      runButtonTask(event.currentTarget, '刷新中...', '记录已刷新', () => loadTransactions()).catch(error => toast(error.message));
    });
    $('adminRefresh').addEventListener('click', event => {
      runButtonTask(event.currentTarget, '刷新中...', '管理数据已刷新', () => loadAdminCurrent()).catch(error => toast(error.message));
    });
    $('adminInvLoad').addEventListener('click', () => loadAdminInventory().catch(error => toast(error.message)));
    $('adminMmLoad').addEventListener('click', () => loadAdminMismatches().catch(error => toast(error.message)));
    $('adminTransferRun').addEventListener('click', () => runAdminTransfer().catch(error => toast(error.message)));
    $('inventoryTransferRun').addEventListener('click', () => runInventoryAdminTransfer().catch(error => toast(error.message)));
    $('adminChestLoad').addEventListener('click', () => loadAdminChests().catch(error => toast(error.message)));
    $('adminTxLoad').addEventListener('click', () => loadAdminTransactions().catch(error => toast(error.message)));
    $('adminAliasLoad').addEventListener('click', () => loadAdminAliases().catch(error => toast(error.message)));
    $('nbtClose').addEventListener('click', closeNbtModal);
    $('nbtCopy').addEventListener('click', () => copyNbtModal().catch(error => toast(error.message)));
    $('aliasSave').addEventListener('click', () => savePersonalAlias().catch(error => toast(error.message)));
    $('aliasClear').addEventListener('click', () => savePersonalAlias('').catch(error => toast(error.message)));
    $('aliasInput').addEventListener('keydown', event => {
      if (event.key === 'Enter') savePersonalAlias().catch(error => toast(error.message));
    });
    $('nbtModal').addEventListener('click', event => {
      if (event.target === $('nbtModal')) closeNbtModal();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeNbtModal();
    });
    document.querySelectorAll('[data-admin-tab]').forEach(btn => btn.addEventListener('click', () => setAdminTab(btn.dataset.adminTab)));
    $('loginCodeTab').addEventListener('click', () => setLoginMode('code'));
    $('loginTokenTab').addEventListener('click', () => setLoginMode('token'));
    $('loginCodeStart').addEventListener('click', startLoginChallenge);
    $('loginCodeCancel').addEventListener('click', () => cancelLoginChallenge().catch(error => toast(error.message)));
    $('loginCodeCopy').addEventListener('click', () => copyLoginChallengeCommand().catch(error => toast(error.message)));
    $('loginBtn').addEventListener('click', loginWithToken);
    $('tokenInput').addEventListener('keydown', event => {
      if (event.key === 'Enter') loginWithToken();
    });
    window.addEventListener('beforeunload', () => {
      if (!state.loginChallengeTimer) return;
      navigator.sendBeacon?.('/api/login/challenge/cancel', new Blob(['{}'], { type: 'application/json' }));
    });
    $('withdraw').addEventListener('click', async () => {
      const items = [...state.selected.values()].map(row => ({
        itemKey: row.itemKey,
        displayName: row.displayName,
        amount: row.amount
      }));
      if (!items.length) return toast('请先点击物品加入待取列表。');
      try {
        await runWebAction(async () => {
          const data = await post('/api/action/withdraw', { ownerUuid: state.owner, items, targetUsername: $('targetPlayer').value.trim() || state.user.username });
          toast(data.message);
          updateActiveStatus(data.active);
        });
      } catch (error) { toast(error.message); }
    });
    $('deposit').addEventListener('click', async () => {
      try {
        await runWebAction(async () => {
          const data = await post('/api/action/deposit', { ownerUuid: state.owner });
          toast(data.message);
          updateActiveStatus(data.active);
        });
      } catch (error) { toast(error.message); }
    });
    $('logout').addEventListener('click', async () => { await post('/api/logout'); location.reload(); });
    document.querySelectorAll('.navbtn').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
    document.addEventListener('click', async event => {
      const onlinePlayer = event.target.closest('[data-online-player]');
      if (onlinePlayer) {
        $('targetPlayer').value = onlinePlayer.dataset.onlinePlayer;
        hideOnlinePlayers();
        return;
      }
      if (!event.target.closest('.target-player-box')) hideOnlinePlayers();
      const setBtn = event.target.closest('[data-admin-set]');
      const transferBtn = event.target.closest('[data-admin-transfer]');
      const mmDeduct = event.target.closest('[data-admin-mm-deduct]');
      const chestBtn = event.target.closest('[data-admin-chest]');
      const nbtBtn = event.target.closest('[data-admin-nbt]');
      const aliasSave = event.target.closest('[data-admin-alias-save]');
      const aliasDelete = event.target.closest('[data-admin-alias-delete]');
      try {
        if (setBtn) {
          const row = setBtn.closest('tr');
          const amount = row.querySelector('[data-admin-amount]').value;
          const data = await post('/api/admin/adjust', { ownerUuid: row.dataset.owner, itemKey: row.dataset.item, action: 'set', amount });
          toast(data.message);
          await loadAdminInventory();
        } else if (transferBtn) {
          const row = transferBtn.closest('tr');
          const toOwnerUuid = row.querySelector('[data-admin-target]').value;
          const amount = row.querySelector('[data-admin-transfer-amount]').value;
          const data = await post('/api/admin/transfer', { fromOwnerUuid: row.dataset.owner, toOwnerUuid, itemKey: row.dataset.item, amount });
          toast(data.message);
          state.adminOwnersLoaded = false;
          await loadAdminInventory();
        } else if (mmDeduct) {
          const row = mmDeduct.closest('tr');
          const ok = confirm('确认扣除 ' + (row?.dataset.mmOwner || '') + ' 的 ' + (row?.dataset.mmItem || '') + ' x' + (row?.dataset.mmAmount || '') + ' 吗？');
          if (!ok) return;
          const data = await post('/api/admin/mismatch/deduct', { id: mmDeduct.dataset.adminMmDeduct });
          toast(data.message);
          await loadAdminMismatches();
        } else if (chestBtn) {
          await loadAdminChestDetail(chestBtn.dataset.adminChest);
        } else if (nbtBtn) {
          const row = nbtBtn.closest('tr');
          const data = state.adminInventoryRows.get(row.dataset.adminRow);
          if (!data) throw new Error('找不到这一行的物品详情，请刷新后再试。');
          openNbtModal(data);
        } else if (aliasSave) {
          const row = aliasSave.closest('tr');
          const displayName = row.querySelector('[data-admin-alias]').value;
          const data = await post('/api/admin/alias/save', { itemKey: row.dataset.item, displayName });
          toast(data.message);
          await loadAdminInventory();
          if (state.adminTab === 'aliases') await loadAdminAliases();
        } else if (aliasDelete) {
          const data = await post('/api/admin/alias/delete', { shortCode: aliasDelete.dataset.adminAliasDelete });
          toast(data.message);
          await loadAdminAliases();
        }
      } catch (error) {
        toast(error.message);
      }
    });

    loadMe().catch(error => toast(error.message));
  </script>
</body>
</html>`

module.exports = CloudStoreWebServer

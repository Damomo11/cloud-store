const http = require('node:http')
const crypto = require('node:crypto')

class CloudStoreWebServer {
  constructor (db, config, serviceProvider) {
    this.db = db
    this.config = config
    this.serviceProvider = serviceProvider
    this.sessions = new Map()
    this.loginFailures = new Map()
    this.server = null
  }

  start () {
    if (this.server || this.config.web?.enabled === false) return
    const { host, port } = this.resolveListenOptions()
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.listen(port, host, () => {
      const actualPort = this.server.address()?.port || port
      const publicUrl = this.config.web?.dashboardUrl || `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}/`
      console.log(`[web] cloud store panel listening on ${publicUrl}`)
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

  async handle (req, res) {
    const url = new URL(req.url, 'http://localhost')
    const session = this.getSession(req, res)
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) return this.sendHtml(res, HTML)
      if (req.method === 'GET' && url.pathname === '/api/me') return this.sendJson(res, this.apiMe(session))
      if (req.method === 'GET' && url.pathname === '/api/inventory') return this.sendJson(res, this.apiInventory(session, url))
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
      if (req.method === 'POST' && url.pathname === '/api/admin/adjust') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminAdjust(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/transfer') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminTransfer(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/mismatch/delete') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminMismatchDelete(session, body))
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
        hint: `请先在游戏内输入：/msg ${this.botDisplayName()} 设置密钥 你的密码`
      }
    }
    const user = this.decorateUser(session.user)
    return {
      ok: true,
      loggedIn: true,
      user,
      owners: this.db.listWebOwnersForUser(user),
      active: this.activeSnapshot()
    }
  }

  apiInventory (session, url) {
    const user = this.requireUser(session)
    const ownerUuid = url.searchParams.get('owner') || user.uuid
    this.requireOwnerAccess(user, ownerUuid)
    return { ok: true, ...this.db.getWebInventory(ownerUuid), active: this.activeSnapshot() }
  }

  apiTransactions (session, url) {
    const user = this.requireUser(session)
    const ownerUuid = url.searchParams.get('owner') || user.uuid
    this.requireOwnerAccess(user, ownerUuid)
    return {
      ok: true,
      ownerUuid,
      ownerLabel: this.db.ownerLabel(ownerUuid),
      rows: this.db.listWebTransactions(ownerUuid, 100)
    }
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
    if (!token) throw new Error('请填写登录密钥。')
    const user = this.db.getWebUserByToken(token)
    if (!user) {
      this.recordLoginFailure(ip)
      const error = new Error(`登录密钥错误。请在游戏内输入：/msg ${this.botDisplayName()} 设置密钥 你的密码`)
      error.status = 401
      throw error
    }
    this.clearLoginFailure(ip)
    session.user = {
      uuid: user.uuid,
      username: user.username
    }
    session.loggedInAt = Date.now()
    return {
      ok: true,
      user: this.decorateUser(session.user)
    }
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
    session.user = null
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
        status: row.status,
        playerUuid: row.playerUuid,
        username: row.username,
        ownerLabel,
        message: row.message,
        createdAt: row.createdAt,
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
    const itemKey = String(body.itemKey || '').trim()
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
    const fromOwnerUuid = String(body.fromOwnerUuid || '').trim()
    const toOwnerUuid = String(body.toOwnerUuid || '').trim()
    const itemKey = String(body.itemKey || '').trim()
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

  apiAdminMismatchDelete (session, body) {
    this.requireAdmin(session)
    const id = Number.parseInt(body.id, 10)
    if (!Number.isInteger(id) || id <= 0) throw new Error('异常 ID 必须是正整数。')
    const changed = this.db.db.prepare('DELETE FROM inventory_mismatches WHERE id = ?').run(id).changes
    return { ok: true, message: changed ? '已删除异常记录。' : '没有找到这条异常记录。' }
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
    return [item.displayName, item.itemId, item.itemKey, item.shortCode].some(value => this.textMatches(value, query))
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
    return labels[active.phase] || '任务进行中'
  }

  botDisplayName () {
    return this.serviceProvider()?.bot?.username || this.config.server?.botName || this.config.server?.username || '机器人名'
  }

  getSession (req, res) {
    const cookies = parseCookies(req.headers.cookie || '')
    let sid = cookies.cs_sid
    if (!sid || !this.sessions.has(sid)) {
      sid = crypto.randomBytes(18).toString('hex')
      this.sessions.set(sid, { sid, createdAt: Date.now(), user: null })
      res.setHeader('Set-Cookie', `cs_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`)
    }
    const session = this.sessions.get(sid)
    session.lastSeenAt = Date.now()
    return session
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

  readBody (req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', chunk => {
        size += chunk.length
        if (size > 1024 * 128) {
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
    .toast { min-height: 24px; color: var(--gold); }
    .statusbar { min-height: 24px; color: var(--green); margin: -8px 0 14px; }
    .hidden { display: none !important; }
    @media (max-width: 860px) {
      .app { grid-template-columns: 1fr; }
      aside { min-height: auto; }
      main { padding: 20px; }
      .withdrawbar { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div id="login" class="login hidden">
    <div class="brand"><span>云</span>仓库</div>
    <p class="muted">首次使用请在游戏内输入：</p>
    <div class="codebox" id="loginCommand" style="font-size:22px;letter-spacing:0">/msg bot 设置密钥 xxx</div>
    <div class="withdrawbar" style="grid-template-columns:1fr auto;margin:18px 0 8px">
      <input id="tokenInput" type="password" placeholder="输入你设置的登录密钥">
      <button id="loginBtn" class="solid">登录</button>
    </div>
    <p class="muted">例如：<code id="loginExample">/msg bot 设置密钥 1234</code>。每次设置都会覆盖旧密钥。</p>
  </div>

  <div id="app" class="app hidden">
    <aside>
      <div class="brand"><span>云</span>仓库</div>
      <nav>
        <button class="navbtn active" data-view="inventory">▦　库存</button>
        <button class="navbtn" data-view="transactions">▤　交易记录</button>
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
          <input id="search" placeholder="搜索物品、ID、6位码...">
          <button id="deposit" class="primary">远程存储</button>
          <button id="refresh" class="primary">刷新</button>
        </div>
        <div class="withdrawbar">
          <div id="selectedList" class="selected-list"><span class="selected-empty">点击物品加入待取列表</span></div>
          <input id="targetPlayer" placeholder="目标玩家，默认自己">
          <button id="withdraw" class="solid">取货</button>
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
      <section id="adminView" class="hidden">
        <div class="toolbar">
          <div class="title">管理面板</div>
          <button id="adminRefresh" class="primary">刷新</button>
        </div>
        <div class="subnav">
          <button class="primary active" data-admin-tab="inventory">总库存</button>
          <button class="primary" data-admin-tab="mismatches">库存异常</button>
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
  <div id="tooltip" class="tooltip"></div>

  <script>
    const state = { view: 'inventory', user: null, owners: [], owner: '', items: [], tx: [], selected: new Map(), adminTab: 'inventory', adminOwners: [], actionCooldownUntil: 0, actionCooldownTimer: null, iconRenderId: 0, activePoll: null };
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
      if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
      return data;
    }

    async function post(path, body = {}) {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
      return data;
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

    function iconUrl(itemId, type = 'item') {
      return 'https://blocksitems.com/api/v1/' + type + 's/' + encodeURIComponent(itemId || 'minecraft:stone') + '/icon?size=64';
    }

    function setIcon(img, item) {
      img.src = iconUrl(item.itemId, 'item');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.onerror = () => {
        if (img.dataset.fallback) {
          img.style.display = 'none';
          img.parentElement.querySelector('.fallback').style.display = 'block';
          return;
        }
        img.dataset.fallback = '1';
        img.src = iconUrl(item.itemId, 'block');
      };
    }

    function scheduleIconLoading(rows) {
      const renderId = ++state.iconRenderId;
      const queue = rows.slice(0, 500);
      const images = new Map([...document.querySelectorAll('.icon img[data-key]')].map(img => [img.dataset.key, img]));
      let active = 0;
      const limit = 8;
      const pump = () => {
        if (renderId !== state.iconRenderId) return;
        while (active < limit && queue.length) {
          const item = queue.shift();
          const img = images.get(item.itemKey);
          if (!img || img.dataset.loaded) continue;
          active += 1;
          img.dataset.loaded = '1';
          setIcon(img, item);
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            active -= 1;
            pump();
          };
          const fallbackError = img.onerror;
          img.onload = finish;
          img.onerror = event => {
            if (typeof fallbackError === 'function') fallbackError.call(img, event);
            finish();
          };
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

    async function loadMe() {
      const data = await api('/api/me');
      if (!data.loggedIn) {
        $('app').classList.add('hidden');
        $('login').classList.remove('hidden');
        const botName = data.botName || 'bot';
        $('loginCommand').textContent = '/msg ' + botName + ' 设置密钥 xxx';
        $('loginExample').textContent = '/msg ' + botName + ' 设置密钥 1234';
        return;
      }
      $('login').classList.add('hidden');
      $('app').classList.remove('hidden');
      state.user = data.user;
      state.owners = data.owners || [];
      $('username').textContent = state.user.username;
      $('heroName').textContent = state.user.username;
      $('adminLink').classList.toggle('hidden', !state.user.isAdmin);
      renderOwners();
      await loadInventory();
      if (state.user.isAdmin && location.pathname === '/admin') setView('admin');
    }

    async function loginWithToken() {
      const token = $('tokenInput').value.trim();
      if (!token) return toast('请填写登录密钥。');
      try {
        await post('/api/login', { token });
        $('tokenInput').value = '';
        await loadMe();
        toast('');
      } catch (error) {
        toast(error.message);
      }
    }

    function renderOwners() {
      $('owner').innerHTML = state.owners.map(owner => '<option value="' + esc(owner.ownerUuid) + '">' + esc(owner.label) + '</option>').join('');
      state.owner = state.owner && state.owners.some(owner => owner.ownerUuid === state.owner) ? state.owner : (state.owners[0]?.ownerUuid || state.user.uuid);
      $('owner').value = state.owner;
    }

    async function loadInventory() {
      state.owner = $('owner').value || state.owner;
      const data = await api('/api/inventory', { owner: state.owner });
      state.items = data.items || [];
      updateActiveStatus(data.active);
      state.selected.clear();
      $('heroTypes').textContent = num(data.stats?.itemTypes || 0);
      $('heroAmount').textContent = num(data.stats?.totalAmount || 0);
      renderSelected();
      renderInventory();
    }

    function itemText(item) {
      return [item.displayName, item.itemId, item.itemKey, item.shortCode, ...(item.shulkerContents || []).map(x => x.displayName + ' ' + x.itemId + ' ' + x.shortCode)].join(' ').toLowerCase();
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
        '<div class="tip-line">数量：' + num(item.amount) + '</div>',
        '<div class="tip-line">ID：' + esc(item.itemId) + '</div>'
      ];
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

    function defaultPickAmount(item) {
      return Math.max(1, Math.min(Number(item.amount || 1), 64));
    }

    function toggleSelected(item) {
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

    function renderSelected() {
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
      ).join('');
      for (const input of document.querySelectorAll('[data-pick-amount]')) {
        input.addEventListener('change', () => {
          const key = input.closest('[data-pick]').dataset.pick;
          const row = state.selected.get(key);
          if (!row) return;
          const value = Number.parseInt(input.value, 10);
          row.amount = Number.isFinite(value) && value > 0 ? value : 1;
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
    }

    function renderInventory() {
      const q = $('search').value.trim().toLowerCase();
      const rows = q ? state.items.filter(item => itemText(item).includes(q)) : state.items;
      $('loaded').textContent = rows.length + '/' + state.items.length + ' 种已加载';
      if (!rows.length) {
        $('inventory').innerHTML = '<p class="muted" style="text-align:center;margin:46px 0">账户为空，暂无物品存储。</p>';
        return;
      }
      $('inventory').innerHTML = '<div class="grid">' + rows.map(item => {
        const selected = state.selected.has(item.itemKey) ? ' selected' : '';
        return '<div class="item' + selected + '" data-key="' + esc(item.itemKey) + '">' +
          '<div class="icon"><img data-key="' + esc(item.itemKey) + '" alt="" loading="lazy" decoding="async"><span class="fallback">' + esc((item.displayName || item.itemId).slice(0, 4)) + '</span><span class="count">' + esc(shortCount(item.amount)) + '</span></div>' +
          '<div class="name">' + esc(item.displayName || item.itemId) + '</div>' +
          '</div>';
      }).join('') + '</div>';
      scheduleIconLoading(rows);
      for (const el of document.querySelectorAll('.item[data-key]')) {
        const item = rows.find(row => row.itemKey === el.dataset.key);
        if (!item) continue;
        el.addEventListener('click', () => {
          toggleSelected(item);
        });
        el.addEventListener('mouseenter', event => showTip(event, item));
        el.addEventListener('mousemove', moveTip);
        el.addEventListener('mouseleave', hideTip);
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
        return '<tr><td>' + esc(row.createdAt) + '</td><td>' + esc(row.type) + '</td><td>' + esc(row.status) + '</td><td>' + items + '</td><td class="muted">' + esc(row.message || '') + '</td></tr>';
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
      renderTable('adminInvTable', ['归属', '短码', '物品', '数量', '操作'], (data.rows || []).map(row =>
        '<tr data-owner="' + esc(row.ownerUuid) + '" data-item="' + esc(row.itemKey) + '">' +
          '<td>' + esc(row.ownerLabel) + '</td>' +
          '<td>' + esc(row.shortCode) + '</td>' +
          '<td class="wrap">' + esc(row.displayName) + '<div class="muted">' + esc(row.itemId) + '</div></td>' +
          '<td>' + num(row.amount) + '</td>' +
          '<td><div class="ops">' +
            '<input class="compact-input" type="number" min="0" value="' + esc(row.amount) + '" data-admin-amount>' +
            '<button data-admin-set>设置</button>' +
            '<select class="compact-select" data-admin-target>' + ownerOptions(row.ownerUuid) + '</select>' +
            '<input class="compact-input" type="number" min="1" value="' + esc(Math.min(Number(row.amount || 1), 64)) + '" data-admin-transfer-amount>' +
            '<button data-admin-transfer>转移</button>' +
            '<input class="compact-select" style="width:170px" value="' + esc(row.displayName) + '" data-admin-alias placeholder="给物品起别名">' +
            '<button data-admin-alias-save>保存别名</button>' +
          '</div></td>' +
        '</tr>'
      ), '没有库存。');
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
        '<tr>' +
          '<td>' + esc(row.createdAt) + (row.resolvedAt ? '<div class="muted">处理：' + esc(row.resolvedAt) + '</div>' : '') + '</td>' +
          '<td>' + (row.kind === 'extra' ? '多余' : '缺失') + '<div class="muted">' + (row.status === 'open' ? '未处理' : '已处理') + '</div></td>' +
          '<td>' + esc(row.ownerLabel || row.username || '') + '</td>' +
          '<td>' + esc(row.shortCode) + '</td>' +
          '<td class="wrap">' + esc(row.displayName) + '<div class="muted">' + esc(row.itemId) + '</div></td>' +
          '<td>' + num(row.amount) + '</td>' +
          '<td class="wrap muted">' + esc(row.note || '') + '</td>' +
          '<td>' + (row.status === 'open' ? '<button data-admin-mm-delete="' + esc(row.id) + '">删除记录</button>' : '') + '</td>' +
        '</tr>'
      ), '没有库存异常。');
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
        return '<tr><td>' + esc(row.createdAt) + '</td><td>' + esc(row.type) + '<div class="muted">' + esc(row.status) + '</div></td><td>' + esc(row.ownerLabel || row.username || '') + '</td><td class="wrap">' + items + '</td><td class="wrap muted">' + esc(row.message || '') + '</td></tr>';
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
      if (state.adminTab === 'chests') return loadAdminChests();
      if (state.adminTab === 'transactions') return loadAdminTransactions();
      if (state.adminTab === 'aliases') return loadAdminAliases();
    }

    function setAdminTab(tab) {
      state.adminTab = tab;
      document.querySelectorAll('[data-admin-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.adminTab === tab));
      $('adminInventory').classList.toggle('hidden', tab !== 'inventory');
      $('adminMismatches').classList.toggle('hidden', tab !== 'mismatches');
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
      $('adminView').classList.toggle('hidden', view !== 'admin');
      if (view === 'transactions') loadTransactions().catch(error => toast(error.message));
      if (view === 'admin') loadAdminCurrent().catch(error => toast(error.message));
    }

    $('owner').addEventListener('change', () => { loadInventory().catch(error => toast(error.message)); });
    $('search').addEventListener('input', renderInventory);
    $('refresh').addEventListener('click', () => loadInventory().catch(error => toast(error.message)));
    $('refreshTx').addEventListener('click', () => loadTransactions().catch(error => toast(error.message)));
    $('adminRefresh').addEventListener('click', () => loadAdminCurrent().catch(error => toast(error.message)));
    $('adminInvLoad').addEventListener('click', () => loadAdminInventory().catch(error => toast(error.message)));
    $('adminMmLoad').addEventListener('click', () => loadAdminMismatches().catch(error => toast(error.message)));
    $('adminChestLoad').addEventListener('click', () => loadAdminChests().catch(error => toast(error.message)));
    $('adminTxLoad').addEventListener('click', () => loadAdminTransactions().catch(error => toast(error.message)));
    $('adminAliasLoad').addEventListener('click', () => loadAdminAliases().catch(error => toast(error.message)));
    document.querySelectorAll('[data-admin-tab]').forEach(btn => btn.addEventListener('click', () => setAdminTab(btn.dataset.adminTab)));
    $('loginBtn').addEventListener('click', loginWithToken);
    $('tokenInput').addEventListener('keydown', event => {
      if (event.key === 'Enter') loginWithToken();
    });
    $('withdraw').addEventListener('click', async () => {
      const items = [...state.selected.values()].map(row => ({
        itemKey: row.itemKey,
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
      const setBtn = event.target.closest('[data-admin-set]');
      const transferBtn = event.target.closest('[data-admin-transfer]');
      const mmDelete = event.target.closest('[data-admin-mm-delete]');
      const chestBtn = event.target.closest('[data-admin-chest]');
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
          await loadAdminInventory();
        } else if (mmDelete) {
          const data = await post('/api/admin/mismatch/delete', { id: mmDelete.dataset.adminMmDelete });
          toast(data.message);
          await loadAdminMismatches();
        } else if (chestBtn) {
          await loadAdminChestDetail(chestBtn.dataset.adminChest);
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

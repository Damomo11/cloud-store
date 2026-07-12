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
      if (req.method === 'GET' && url.pathname === '/api/my/organizations') return this.sendJson(res, this.apiMyOrganizations(session))
      if (req.method === 'GET' && url.pathname === '/api/my/aliases') return this.sendJson(res, this.apiMyAliases(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/owners') return this.sendJson(res, this.apiAdminOwners(session))
      if (req.method === 'GET' && url.pathname === '/api/admin/warehouse-provisioning') return this.sendJson(res, this.apiAdminWarehouseProvisioning(session))
      if (req.method === 'GET' && url.pathname === '/api/admin/organization-warehouse/detail') return this.sendJson(res, this.apiAdminOrganizationWarehouseDetail(session, url))
      if (req.method === 'GET' && url.pathname === '/api/warehouse-admin/organizations') return this.sendJson(res, this.apiWarehouseAdminOrganizations(session))
      if (req.method === 'GET' && url.pathname === '/api/admin/inventory') return this.sendJson(res, this.apiAdminInventory(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/mismatches') return this.sendJson(res, this.apiAdminMismatches(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/transactions') return this.sendJson(res, this.apiAdminTransactions(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/chests') return this.sendJson(res, this.apiAdminChests(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/chest') return this.sendJson(res, this.apiAdminChest(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/aliases') return this.sendJson(res, this.apiAdminAliases(session, url))
      if (req.method === 'GET' && url.pathname === '/api/admin/quotas') return this.sendJson(res, this.apiAdminQuotas(session, url))
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
      if (req.method === 'POST' && url.pathname === '/api/item-alias/delete') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiItemAliasDelete(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/my/global-alias/toggle') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiMyGlobalAliasToggle(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/warehouse-admin/member/add') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiWarehouseAdminMemberAdd(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/warehouse-admin/member/remove') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiWarehouseAdminMemberRemove(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/warehouse-admin/member/role') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiWarehouseAdminMemberRole(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/warehouse-admin/rename') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiWarehouseAdminRename(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/adjust') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminAdjust(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/personal-warehouse/create') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminCreatePersonalWarehouse(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/organization-warehouse/create') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminCreateOrganizationWarehouse(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/organization-warehouse/member/add') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminOrganizationMemberAdd(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/organization-warehouse/member/remove') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminOrganizationMemberRemove(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/organization-warehouse/member/role') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminOrganizationMemberRole(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/personal-warehouse/delete') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminDeletePersonalWarehouse(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/organization-warehouse/delete') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminDeleteOrganizationWarehouse(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/transfer') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminTransfer(session, body))
      }
      if (req.method === 'POST' && (url.pathname === '/api/admin/mismatch/delete' || url.pathname === '/api/admin/mismatch/deduct')) {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminMismatchDeduct(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/mismatch/resolve') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminMismatchResolve(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/alias/save') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminAliasSave(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/alias/delete') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminAliasDelete(session, body))
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/quota/save') {
        const body = await this.readBody(req)
        return this.sendJson(res, this.apiAdminQuotaSave(session, body))
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
    const isCustom = ownerUuid.startsWith('vault:')
    const defaultSlots = isCustom
      ? (this.config.storage?.defaultCustomWarehouseQuotaSlots || this.config.storage?.defaultQuotaSlots || 270)
      : (this.config.storage?.defaultQuotaSlots || 270)
    const quotaSlots = this.db.getQuotaSlots(ownerUuid, defaultSlots)
    const usedSlots = this.adminOwnerUsedSlots(ownerUuid)
    const result = {
      ok: true,
      ...this.db.getWebInventory(ownerUuid, user.uuid),
      quota: { usedSlots, quotaSlots, usagePercent: quotaSlots > 0 ? Math.round(usedSlots / quotaSlots * 1000) / 10 : 0 },
      active: this.activeSnapshot()
    }
    const elapsed = Date.now() - startedAt
    if (this.config.debug && elapsed > 100) {
      console.warn(`[web] slow inventory ${ownerUuid}: ${elapsed}ms, ${result.items?.length || 0} rows`)
    }
    return result
  }

  apiTransactions (session, url) {
    const user = this.requireUser(session)
    const ownerUuid = url.searchParams.get('owner') || this.db.getEffectiveDefaultOwnerUuid(user.uuid)
    const page = Math.max(1, Number.parseInt(url.searchParams.get('page'), 10) || 1)
    const pageSize = this.clampLimit(url.searchParams.get('pageSize'), 30, 100)
    if (!ownerUuid) return { ok: true, ownerUuid: '', ownerLabel: '', page: 1, pageSize, total: 0, totalPages: 1, rows: [] }
    this.requireOwnerAccess(user, ownerUuid)
    const typeQ = String(url.searchParams.get('type') || '').trim().toLowerCase()
    const operatorQ = String(url.searchParams.get('operator') || '').trim().toLowerCase()
    const itemQ = String(url.searchParams.get('item') || '').trim().toLowerCase()
    const statusQ = String(url.searchParams.get('status') || '').trim().toLowerCase()
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
    const dateFrom = String(url.searchParams.get('dateFrom') || '').trim()
    const dateTo = String(url.searchParams.get('dateTo') || '').trim()
    const rows = this.db.db.prepare(`
      SELECT id, type, status, player_uuid AS playerUuid, username,
             items_json AS itemsJson, message, created_at AS createdAt
      FROM transactions WHERE player_uuid = ? ORDER BY id DESC LIMIT 10000
    `).all(ownerUuid)
    const transactionItems = this.prepareTransactionItems(rows)
    const result = []
    for (const row of rows) {
      const details = this.transactionDetails(row.message)
      const operator = this.transactionOperator(row, details)
      const items = this.decorateTransactionItems(transactionItems.itemsById.get(row.id) || [], transactionItems.contentsByBox)
      const createdAtLabel = this.formatBeijingTime(row.createdAt)
      const createdDate = createdAtLabel.slice(0, 10)
      if (typeQ && !this.textMatches(row.type, typeQ) && !this.textMatches(this.transactionTypeLabel(row.type), typeQ)) continue
      if (operatorQ && !this.textMatches(operator, operatorQ)) continue
      if (statusQ && row.status.toLowerCase() !== statusQ) continue
      if (dateFrom && createdDate < dateFrom) continue
      if (dateTo && createdDate > dateTo) continue
      if (itemQ && !items.some(item => this.adminTransactionItemMatches(item, itemQ))) continue
      if (q && !this.textMatches(row.message, q) && !this.textMatches(operator, q) && !items.some(item => this.adminTransactionItemMatches(item, q))) continue
      result.push({
        ...row,
        typeLabel: this.transactionTypeLabel(row.type),
        statusLabel: this.transactionStatusLabel(row.status),
        ownerLabel: this.db.ownerLabel(row.playerUuid),
        operator,
        details,
        messageLabel: this.transactionMessageLabel(row.message),
        createdAtLabel,
        items
      })
    }
    const total = result.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const currentPage = Math.min(page, totalPages)
    return { ok: true, ownerUuid, ownerLabel: this.db.ownerLabel(ownerUuid), page: currentPage, pageSize, total, totalPages, rows: result.slice((currentPage - 1) * pageSize, currentPage * pageSize) }
  }

  apiMyOrganizations (session) {
    const user = this.requireUser(session)
    const rows = this.db.listCustomWarehousesForPlayer(user.uuid).map(warehouse => {
      const ownerUuid = `vault:${warehouse.nameLower}`
      const defaultSlots = this.config.storage?.defaultCustomWarehouseQuotaSlots || this.config.storage?.defaultQuotaSlots || 270
      const quotaSlots = this.db.getQuotaSlots(ownerUuid, defaultSlots)
      const usedSlots = this.adminOwnerUsedSlots(ownerUuid)
      return {
        ...warehouse,
        ownerUuid,
        isAdmin: warehouse.role === 'admin',
        usedSlots,
        quotaSlots,
        usagePercent: quotaSlots > 0 ? Math.round(usedSlots / quotaSlots * 1000) / 10 : 0,
        members: this.db.listCustomWarehouseMembers(warehouse.name)
      }
    })
    return { ok: true, rows }
  }

  apiWarehouseAdminOrganizations (session) {
    const user = this.requireUser(session)
    const warehouses = this.db.listCustomWarehousesForPlayer(user.uuid).filter(warehouse => warehouse.role === 'admin')
    if (!warehouses.length) {
      const error = new Error('你不是任何组织仓库的仓库管理员。')
      error.status = 403
      throw error
    }
    const rows = warehouses.map(warehouse => {
      const ownerUuid = `vault:${warehouse.nameLower}`
      const defaultSlots = this.config.storage?.defaultCustomWarehouseQuotaSlots || this.config.storage?.defaultQuotaSlots || 270
      const quotaSlots = this.db.getQuotaSlots(ownerUuid, defaultSlots)
      const usedSlots = this.adminOwnerUsedSlots(ownerUuid)
      return {
        ...warehouse,
        ownerUuid,
        usedSlots,
        quotaSlots,
        usagePercent: quotaSlots > 0 ? Math.round(usedSlots / quotaSlots * 1000) / 10 : 0,
        members: this.db.listCustomWarehouseMembers(warehouse.name)
      }
    })
    return { ok: true, rows }
  }

  requireWarehouseAdmin (session, name) {
    const user = this.requireUser(session)
    const warehouse = this.db.getCustomWarehouse(name)
    if (!warehouse) throw new Error(`找不到仓库：${name}`)
    if (!this.db.isCustomWarehouseAdmin(warehouse.name, user.uuid)) {
      const error = new Error('只有这个组织仓库的仓库管理员可以执行该操作。')
      error.status = 403
      throw error
    }
    return warehouse
  }

  apiMyAliases (session, url) {
    const user = this.requireUser(session)
    const q = String(url.searchParams.get('q') || '').trim()
    const personalRows = this.db.listPlayerItemAliases(user.uuid, '')
    const personalByItem = new Map()
    for (const row of personalRows) {
      if (!personalByItem.has(row.itemKey)) personalByItem.set(row.itemKey, { ...this.adminItem(row), aliases: [] })
      personalByItem.get(row.itemKey).aliases.push(row.alias)
    }
    const globalRows = this.db.listGlobalItemAliasesForPlayer(user.uuid, '')
    const matchingGlobalKeys = new Set(globalRows.filter(row => !q || this.adminItemMatches(this.adminItem(row), q) || this.textMatches(row.alias, q)).map(row => row.itemKey))
    return {
      ok: true,
      personal: [...personalByItem.values()].filter(row => !q || this.adminItemMatches(row, q) || row.aliases.some(alias => this.textMatches(alias, q))),
      global: globalRows.filter(row => !q || matchingGlobalKeys.has(row.itemKey)).map(row => ({ ...this.adminItem(row), alias: row.alias, enabled: row.enabled }))
    }
  }

  resolveKnownPlayer (value) {
    const raw = String(value || '').trim()
    if (!raw) throw new Error('请填写玩家 ID。')
    const service = this.serviceProvider()
    const onlineName = service?.bot?.players ? Object.keys(service.bot.players).find(name => name.toLowerCase() === raw.toLowerCase()) : ''
    const online = onlineName ? service.bot.players[onlineName] : null
    if (online?.uuid) {
      this.db.upsertPlayer(online.uuid, onlineName)
      return { uuid: online.uuid, username: onlineName }
    }
    const player = this.db.getPlayerByUsername(raw)
    if (!player?.uuid || player.uuid.startsWith('name:')) throw new Error(`找不到玩家：${raw}。玩家需要在线或曾经使用过云仓库。`)
    return player
  }

  apiWarehouseAdminMemberAdd (session, body) {
    const warehouse = this.requireWarehouseAdmin(session, body.warehouse)
    const player = this.resolveKnownPlayer(body.username)
    this.db.addCustomWarehouseMember(warehouse.name, player.uuid, player.username)
    return { ok: true, message: `已把 ${player.username} 添加到仓库 ${warehouse.name}。` }
  }

  apiWarehouseAdminMemberRemove (session, body) {
    const warehouse = this.requireWarehouseAdmin(session, body.warehouse)
    const playerUuid = String(body.playerUuid || '').trim()
    if (!playerUuid) throw new Error('缺少成员。')
    if (playerUuid === warehouse.creatorUuid) throw new Error('不能删除仓库创建者。')
    if (this.db.isCustomWarehouseAdmin(warehouse.name, playerUuid)) throw new Error('请先取消该成员的管理员身份。')
    const changed = this.db.removeCustomWarehouseMember(warehouse.name, playerUuid)
    return { ok: true, message: changed ? '已删除仓库成员。' : '该玩家不是普通成员。' }
  }

  apiWarehouseAdminMemberRole (session, body) {
    const warehouse = this.requireWarehouseAdmin(session, body.warehouse)
    const playerUuid = String(body.playerUuid || '').trim()
    const role = String(body.role || '').trim()
    if (!['admin', 'member'].includes(role)) throw new Error('成员角色无效。')
    if (playerUuid === warehouse.creatorUuid && role !== 'admin') throw new Error('不能取消仓库创建者的管理员身份。')
    const member = this.db.listCustomWarehouseMembers(warehouse.name).find(row => row.playerUuid === playerUuid)
    if (!member) throw new Error('找不到该仓库成员。')
    this.db.setCustomWarehouseMemberRole(warehouse.name, member.playerUuid, member.username, role)
    return { ok: true, message: `已把 ${member.username} 设置为${role === 'admin' ? '仓库管理员' : '普通成员'}。` }
  }

  apiWarehouseAdminRename (session, body) {
    const warehouse = this.requireWarehouseAdmin(session, body.warehouse)
    const newName = String(body.newName || '').trim()
    if (!newName) throw new Error('新仓库名不能为空。')
    if (/\s/.test(newName)) throw new Error('仓库名不能包含空格。')
    if ([...newName].length > 15) throw new Error('仓库名最多 15 个字。')
    const renamed = this.db.renameCustomWarehouse(warehouse.name, newName)
    return { ok: true, message: `仓库已改名为 ${renamed.name}。`, warehouse: renamed }
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
      isAdmin: this.db.isAdmin(user.username, user.uuid),
      isWarehouseAdmin: this.db.listCustomWarehousesForPlayer(user.uuid).some(warehouse => warehouse.role === 'admin')
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
    for (const row of this.db.listPersonalWarehouses()) addOwner(row.ownerUuid)
    for (const row of this.db.db.prepare('SELECT name_lower AS nameLower FROM custom_warehouses ORDER BY name COLLATE NOCASE ASC').all()) addOwner(`vault:${row.nameLower}`)
    addOwner(this.config.momoOwner)

    return { ok: true, rows: [...owners.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')) }
  }

  resolveProvisionPlayer (value) {
    const raw = String(value || '').trim()
    if (!/^[A-Za-z0-9_]{3,16}$/.test(raw)) throw new Error('玩家 ID 格式不正确。')
    const service = this.serviceProvider()
    const onlineName = service?.bot?.players ? Object.keys(service.bot.players).find(name => name.toLowerCase() === raw.toLowerCase()) : ''
    const online = onlineName ? service.bot.players[onlineName] : null
    if (online?.uuid) {
      this.db.upsertPlayer(online.uuid, onlineName)
      return { uuid: online.uuid, username: onlineName }
    }
    const known = this.db.getPlayerByUsername(raw)
    if (known?.uuid) return known
    const player = { uuid: `name:${raw}`, username: raw }
    this.db.upsertPlayer(player.uuid, player.username)
    return player
  }

  apiAdminWarehouseProvisioning (session) {
    this.requireAdmin(session)
    return {
      ok: true,
      personal: this.db.listPersonalWarehouses().map(row => ({ ...row, usedSlots: this.adminOwnerUsedSlots(row.ownerUuid), totalAmount: this.db.ownerTotalAmount(row.ownerUuid) })),
      organizations: this.db.db.prepare(`
        SELECT name_lower AS nameLower, name, creator_uuid AS creatorUuid,
               creator_username AS creatorUsername, created_at AS createdAt,
               (SELECT COUNT(*) FROM custom_warehouse_members m WHERE m.warehouse_name_lower = w.name_lower) AS memberCount
        FROM custom_warehouses w ORDER BY name COLLATE NOCASE ASC
      `).all().map(row => {
        const ownerUuid = `vault:${row.nameLower}`
        return { ...row, ownerUuid, usedSlots: this.adminOwnerUsedSlots(ownerUuid), totalAmount: this.db.ownerTotalAmount(ownerUuid) }
      })
    }
  }

  apiAdminOrganizationWarehouseDetail (session, url) {
    this.requireAdmin(session)
    const warehouse = this.db.getCustomWarehouse(url.searchParams.get('name') || '')
    if (!warehouse) throw new Error('找不到组织仓库。')
    const ownerUuid = `vault:${warehouse.nameLower}`
    const defaultSlots = this.config.storage?.defaultCustomWarehouseQuotaSlots || this.config.storage?.defaultQuotaSlots || 270
    const quotaSlots = this.db.getQuotaSlots(ownerUuid, defaultSlots)
    const usedSlots = this.adminOwnerUsedSlots(ownerUuid)
    return {
      ok: true,
      warehouse: {
        ...warehouse,
        ownerUuid,
        totalAmount: this.db.ownerTotalAmount(ownerUuid),
        usedSlots,
        quotaSlots,
        usagePercent: quotaSlots > 0 ? Math.round(usedSlots / quotaSlots * 1000) / 10 : 0,
        members: this.db.listCustomWarehouseMembers(warehouse.name)
      }
    }
  }

  apiAdminCreatePersonalWarehouse (session, body) {
    const admin = this.requireAdmin(session)
    const player = this.resolveProvisionPlayer(body.username)
    const result = this.db.createPersonalWarehouse(player.uuid, player.username, admin)
    return { ok: true, message: result.changed ? `已为 ${player.username} 创建个人仓库。` : `${player.username} 已经有个人仓库。`, warehouse: result }
  }

  apiAdminCreateOrganizationWarehouse (session, body) {
    this.requireAdmin(session)
    const name = String(body.name || '').trim()
    if (!name) throw new Error('组织仓库名不能为空。')
    if (/\s/.test(name)) throw new Error('组织仓库名不能包含空格。')
    if ([...name].length > 15) throw new Error('组织仓库名最多 15 个字。')
    if (this.db.getCustomWarehouse(name)) throw new Error(`仓库名已存在：${name}`)
    const creator = this.resolveProvisionPlayer(body.creatorUsername)
    this.db.createCustomWarehouse(name, creator.uuid, creator.username)
    return { ok: true, message: `已创建组织仓库 ${name}，仓库管理员为 ${creator.username}。` }
  }

  apiAdminOrganizationMemberAdd (session, body) {
    const admin = this.requireAdmin(session)
    const warehouse = this.db.getCustomWarehouse(body.warehouse)
    if (!warehouse) throw new Error('找不到组织仓库。')
    const player = this.resolveProvisionPlayer(body.username)
    const role = String(body.role || 'member').trim()
    if (!['admin', 'member'].includes(role)) throw new Error('成员角色无效。')
    this.db.setCustomWarehouseMemberRole(warehouse.name, player.uuid, player.username, role)
    this.db.addTransaction('web_admin_organization_member_add', 'ok', `vault:${warehouse.nameLower}`, `仓库:${warehouse.name}`, [], `admin=${admin.username}; member=${player.username}; role=${role}`)
    return { ok: true, message: `已添加 ${player.username}，身份为${role === 'admin' ? '仓库管理员' : '普通成员'}。` }
  }

  apiAdminOrganizationMemberRemove (session, body) {
    const admin = this.requireAdmin(session)
    const warehouse = this.db.getCustomWarehouse(body.warehouse)
    if (!warehouse) throw new Error('找不到组织仓库。')
    const playerUuid = String(body.playerUuid || '').trim()
    const member = this.db.listCustomWarehouseMembers(warehouse.name).find(row => row.playerUuid === playerUuid)
    if (!member) throw new Error('找不到该仓库成员。')
    this.db.removeCustomWarehouseMemberAny(warehouse.name, playerUuid)
    this.db.db.prepare("UPDATE players SET default_owner_uuid = '' WHERE uuid = ? AND default_owner_uuid = ?").run(playerUuid, `vault:${warehouse.nameLower}`)
    this.db.addTransaction('web_admin_organization_member_remove', 'ok', `vault:${warehouse.nameLower}`, `仓库:${warehouse.name}`, [], `admin=${admin.username}; member=${member.username}; role=${member.role}`)
    return { ok: true, message: `已从 ${warehouse.name} 删除成员 ${member.username}。` }
  }

  apiAdminOrganizationMemberRole (session, body) {
    const admin = this.requireAdmin(session)
    const warehouse = this.db.getCustomWarehouse(body.warehouse)
    if (!warehouse) throw new Error('找不到组织仓库。')
    const playerUuid = String(body.playerUuid || '').trim()
    const role = String(body.role || '').trim()
    if (!['admin', 'member'].includes(role)) throw new Error('成员角色无效。')
    const member = this.db.listCustomWarehouseMembers(warehouse.name).find(row => row.playerUuid === playerUuid)
    if (!member) throw new Error('找不到该仓库成员。')
    this.db.setCustomWarehouseMemberRole(warehouse.name, member.playerUuid, member.username, role)
    this.db.addTransaction('web_admin_organization_member_role', 'ok', `vault:${warehouse.nameLower}`, `仓库:${warehouse.name}`, [], `admin=${admin.username}; member=${member.username}; role=${role}`)
    return { ok: true, message: `已把 ${member.username} 设置为${role === 'admin' ? '仓库管理员' : '普通成员'}。` }
  }

  ensureWarehouseDeletionSafe (ownerUuid) {
    const service = this.serviceProvider()
    const activeOwnerUuid = service?.active?.owner?.uuid || service?.active?.player?.uuid || ''
    if (activeOwnerUuid === ownerUuid) throw new Error('该仓库正在进行存取操作，暂时不能删除。')
    const recovery = this.db.getRecoveryTask()
    if (recovery?.ownerUuid === ownerUuid) throw new Error('该仓库存在未完成的恢复任务，暂时不能删除。')
  }

  apiAdminDeletePersonalWarehouse (session, body) {
    const admin = this.requireAdmin(session)
    const ownerUuid = String(body.ownerUuid || '').trim()
    if (!ownerUuid || String(body.confirmOwnerUuid || '') !== ownerUuid) throw new Error('删除确认信息不正确。')
    this.ensureWarehouseDeletionSafe(ownerUuid)
    const result = this.db.deletePersonalWarehouseToMomo(ownerUuid, admin.username)
    return { ok: true, message: `已删除 ${result.ownerUsername} 的个人仓库，${result.itemTypes} 种、共 ${result.totalAmount} 件物品已转入 momo。` }
  }

  apiAdminDeleteOrganizationWarehouse (session, body) {
    const admin = this.requireAdmin(session)
    const warehouse = this.db.getCustomWarehouse(body.warehouse)
    if (!warehouse) throw new Error('找不到组织仓库。')
    if (this.db.normalizeWarehouseName(body.confirmName) !== warehouse.nameLower) throw new Error('删除确认信息不正确。')
    const ownerUuid = `vault:${warehouse.nameLower}`
    this.ensureWarehouseDeletionSafe(ownerUuid)
    const result = this.db.deleteCustomWarehouseToMomo(warehouse.name, admin.username)
    return { ok: true, message: `已删除组织仓库 ${warehouse.name}，${result.itemTypes} 种、共 ${result.totalAmount} 件物品已转入 momo。` }
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
    const allItemKeys = rows.map(row => row.itemKey)
    const aliases = this.db.getGlobalAliasesForItems(allItemKeys)
    const shulkerContents = this.db.getShulkerContentsByBox(rows.filter(row => row.itemId.endsWith('shulker_box')).map(row => row.itemKey))
    for (const row of rows) {
      const ownerLabel = this.db.ownerLabel(row.ownerUuid)
      const item = this.adminItem(row)
      if (ownerQ && !this.textMatches(ownerLabel, ownerQ) && !this.textMatches(row.ownerUuid, ownerQ)) continue
      const decorated = {
        ...item,
        ownerUuid: row.ownerUuid,
        ownerLabel,
        amount: Number(row.amount || 0),
        globalAliases: aliases.get(row.itemKey) || [],
        shulkerContents: shulkerContents.get(row.itemKey) || []
      }
      if (itemQ && !this.adminItemMatches(decorated, itemQ) && !decorated.globalAliases.some(alias => this.textMatches(alias, itemQ)) && !decorated.shulkerContents.some(content => this.adminItemMatches(content, itemQ))) continue
      result.push(decorated)
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
    const typeQ = String(url.searchParams.get('type') || '').trim().toLowerCase()
    const operatorQ = String(url.searchParams.get('operator') || '').trim().toLowerCase()
    const statusQ = String(url.searchParams.get('status') || '').trim().toLowerCase()
    const ownerQ = String(url.searchParams.get('owner') || '').trim().toLowerCase()
    const itemQ = String(url.searchParams.get('item') || '').trim().toLowerCase()
    const dateFrom = String(url.searchParams.get('dateFrom') || '').trim()
    const dateTo = String(url.searchParams.get('dateTo') || '').trim()
    const page = Math.max(1, Number.parseInt(url.searchParams.get('page'), 10) || 1)
    const pageSize = this.clampLimit(url.searchParams.get('pageSize'), 30, 100)
    const fetchLimit = 10000
    const rows = this.db.db.prepare(`
      SELECT id, type, status, player_uuid AS playerUuid, username,
             items_json AS itemsJson, message, created_at AS createdAt
      FROM transactions
      ORDER BY id DESC
      LIMIT ?
    `).all(fetchLimit)
    const transactionItems = this.prepareTransactionItems(rows)

    const result = []
    for (const row of rows) {
      const ownerLabel = this.db.ownerLabel(row.playerUuid)
      const decoratedItems = this.decorateTransactionItems(transactionItems.itemsById.get(row.id) || [], transactionItems.contentsByBox)
      const details = this.transactionDetails(row.message)
      const operator = this.transactionOperator(row, details)
      const createdAtLabel = this.formatBeijingTime(row.createdAt)
      const createdDate = createdAtLabel.slice(0, 10)
      if (typeQ && !this.textMatches(row.type, typeQ) && !this.textMatches(this.transactionTypeLabel(row.type), typeQ)) continue
      if (operatorQ && !this.textMatches(operator, operatorQ)) continue
      if (statusQ && row.status.toLowerCase() !== statusQ) continue
      if (ownerQ && !this.textMatches(ownerLabel, ownerQ) && !this.textMatches(row.username, ownerQ) && !this.textMatches(row.playerUuid, ownerQ)) continue
      if (dateFrom && createdDate < dateFrom) continue
      if (dateTo && createdDate > dateTo) continue
      if (itemQ && !decoratedItems.some(item => this.adminTransactionItemMatches(item, itemQ))) continue
      if (q && !this.textMatches(ownerLabel, q) && !this.textMatches(operator, q) && !this.textMatches(row.username, q) && !this.textMatches(row.type, q) && !this.textMatches(row.message, q) && !decoratedItems.some(item => this.adminTransactionItemMatches(item, q))) continue
      result.push({
        id: row.id,
        type: row.type,
        typeLabel: this.transactionTypeLabel(row.type),
        status: row.status,
        statusLabel: this.transactionStatusLabel(row.status),
        playerUuid: row.playerUuid,
        username: row.username,
        ownerLabel,
        operator,
        message: row.message,
        messageLabel: this.transactionMessageLabel(row.message),
        createdAt: row.createdAt,
        createdAtLabel,
        details,
        items: decoratedItems
      })
    }
    const total = result.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const currentPage = Math.min(page, totalPages)
    const offset = (currentPage - 1) * pageSize
    return { ok: true, page: currentPage, pageSize, total, totalPages, rows: result.slice(offset, offset + pageSize) }
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
    const aliasRows = this.db.listGlobalItemAliases('')
    const aliases = new Map()
    for (const row of aliasRows) {
      if (!aliases.has(row.itemKey)) aliases.set(row.itemKey, [])
      aliases.get(row.itemKey).push(row.alias)
    }
    const items = new Map()
    for (const row of aliasRows) {
      if (!items.has(row.itemKey)) items.set(row.itemKey, this.adminItem(row))
    }
    return {
      ok: true,
      rows: [...items.values()].map(row => ({ ...row, aliases: aliases.get(row.itemKey) || [] }))
        .filter(row => !q || this.adminItemMatches(row, q) || row.aliases.some(alias => this.textMatches(alias, q)))
    }
  }

  apiAdminQuotas (session, url) {
    this.requireAdmin(session)
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
    const owners = this.apiAdminOwners(session).rows
    const rows = owners.filter(owner => Number(owner.totalAmount || 0) > 0).map(owner => {
      const isCustom = owner.ownerUuid.startsWith('vault:')
      const defaultSlots = isCustom
        ? (this.config.storage?.defaultCustomWarehouseQuotaSlots || this.config.storage?.defaultQuotaSlots || 270)
        : (this.config.storage?.defaultQuotaSlots || 270)
      const quotaSlots = this.db.getQuotaSlots(owner.ownerUuid, defaultSlots)
      const usedSlots = this.adminOwnerUsedSlots(owner.ownerUuid)
      return { ...owner, usedSlots, quotaSlots, usagePercent: quotaSlots > 0 ? Math.round(usedSlots / quotaSlots * 1000) / 10 : 0 }
    }).filter(row => !q || this.textMatches(row.label, q) || this.textMatches(row.ownerUuid, q))
    const chestCount = Number(this.db.db.prepare('SELECT COUNT(*) AS count FROM chests').get().count || 0)
    const usedPhysicalSlots = Number(this.db.db.prepare('SELECT COUNT(*) AS count FROM chest_slots WHERE amount > 0').get().count || 0)
    const slotsPerChest = Number(this.config.warehouse?.containerSlots || 27)
    const totalPhysicalSlots = chestCount * slotsPerChest
    return {
      ok: true,
      overall: {
        chestCount,
        usedSlots: usedPhysicalSlots,
        totalSlots: totalPhysicalSlots,
        usagePercent: totalPhysicalSlots > 0 ? Math.round(usedPhysicalSlots / totalPhysicalSlots * 1000) / 10 : 0
      },
      rows
    }
  }

  apiAdminAdjust (session, body) {
    const user = this.requireAdmin(session)
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
      this.db.addTransaction(`web_admin_${action}`, 'ok', ownerUuid, this.db.ownerLabel(ownerUuid), changed, `admin=${user.username}; action=${action}; item=${itemKey}; amount=${amount}`)
    })
    return { ok: true, message: `已更新 ${this.db.ownerLabel(ownerUuid)} 的 ${item.displayName}：${current} -> ${current + delta}。` }
  }

  apiAdminTransfer (session, body) {
    const user = this.requireAdmin(session)
    if (Array.isArray(body.items)) return this.apiAdminTransferMany(body, user)
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
      this.db.addTransaction('web_admin_transfer_out', 'ok', fromOwnerUuid, this.db.ownerLabel(fromOwnerUuid), moved, `admin=${user.username}; to=${toOwnerUuid}`)
      this.db.addTransaction('web_admin_transfer_in', 'ok', toOwnerUuid, this.db.ownerLabel(toOwnerUuid), moved, `admin=${user.username}; from=${fromOwnerUuid}`)
    })
    return { ok: true, message: `已转移 ${item.displayName} x${movedAmount}：${this.db.ownerLabel(fromOwnerUuid)} -> ${this.db.ownerLabel(toOwnerUuid)}。` }
  }

  apiAdminTransferMany (body, user) {
    const toOwnerUuid = this.resolveAdminOwnerArgument(body.toOwnerUuid || body.toOwnerText || '')
    if (!toOwnerUuid) throw new Error('缺少目标玩家或仓库。')
    if (body.items.length > 200) throw new Error('单次最多转账 200 种物品。')
    const requested = body.items.map(entry => {
      const fromOwnerUuid = this.resolveAdminOwnerArgument(entry.fromOwnerUuid || '')
      const itemKey = this.resolveAdminItemKey(entry.itemKey || '')
      const amount = Number.parseInt(entry.amount, 10)
      if (!fromOwnerUuid || !itemKey || !Number.isInteger(amount) || amount <= 0) throw new Error('待转账物品数据无效。')
      if (fromOwnerUuid === toOwnerUuid) throw new Error(`目标不能与来源仓库 ${this.db.ownerLabel(fromOwnerUuid)} 相同。`)
      const item = this.db.getItemByKey(itemKey)
      const current = this.db.getBalance(fromOwnerUuid, itemKey)
      if (!item || current < amount) throw new Error(`${this.db.ownerLabel(fromOwnerUuid)} 的物品库存不足。`)
      return { fromOwnerUuid, itemKey, amount, item }
    })
    if (!requested.length) throw new Error('没有待转账物品。')
    this.db.transaction(() => {
      for (const row of requested) {
        const moved = [{ ...row.item, amount: row.amount }]
        this.db.adjustBalance(row.fromOwnerUuid, row.itemKey, -row.amount)
        this.db.adjustBalance(toOwnerUuid, row.itemKey, row.amount)
        this.db.addTransaction('web_admin_transfer_out', 'ok', row.fromOwnerUuid, this.db.ownerLabel(row.fromOwnerUuid), moved, `admin=${user.username}; to=${toOwnerUuid}`)
        this.db.addTransaction('web_admin_transfer_in', 'ok', toOwnerUuid, this.db.ownerLabel(toOwnerUuid), moved, `admin=${user.username}; from=${row.fromOwnerUuid}`)
      }
    })
    const total = requested.reduce((sum, row) => sum + row.amount, 0)
    return { ok: true, message: `已向 ${this.db.ownerLabel(toOwnerUuid)} 转账 ${requested.length} 种、共 ${total} 个物品。` }
  }

  apiAdminMismatchDeduct (session, body) {
    const user = this.requireAdmin(session)
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
      this.db.addTransaction('web_admin_mismatch_deduct', 'ok', row.ownerUuid, this.db.ownerLabel(row.ownerUuid), changed, `admin=${user.username}; mismatch=${row.kind}; id=${row.id}; deduct=${amount}`)
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

  apiAdminMismatchResolve (session, body) {
    const user = this.requireAdmin(session)
    const id = Number.parseInt(body.id, 10)
    if (!Number.isInteger(id) || id <= 0) throw new Error('异常 ID 必须是正整数。')
    const row = this.db.db.prepare(`
      SELECT id, kind, status, owner_uuid AS ownerUuid, username,
             item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson, amount
      FROM inventory_mismatches WHERE id = ? LIMIT 1
    `).get(id)
    if (!row) throw new Error('没有找到这条异常记录。')
    if (row.status !== 'open') return { ok: true, message: '这条异常已经处理过。' }
    if (row.kind === 'missing') return this.apiAdminMismatchDeduct(session, body)

    const targetOwnerUuid = this.resolveAdminOwnerArgument(body.targetOwnerUuid || body.targetOwnerText || '')
    if (!targetOwnerUuid) throw new Error('多余物品需要选择转入的目标仓库。')
    const amount = Number(row.amount || 0)
    if (amount <= 0) throw new Error('异常数量无效。')
    const item = this.db.getItemByKey(row.itemKey) || this.db.rowToItem(row)
    this.db.transaction(() => {
      this.db.upsertItem(item)
      this.db.adjustBalance(targetOwnerUuid, row.itemKey, amount)
      this.db.addTransaction('web_admin_mismatch_transfer', 'ok', targetOwnerUuid, this.db.ownerLabel(targetOwnerUuid), [{ ...item, amount }], `mismatch #${row.id}; admin=${user.username}; source=physical_extra`)
      this.db.db.prepare(`
        UPDATE inventory_mismatches
        SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP,
            owner_uuid = ?, username = ?,
            note = CASE WHEN note = '' THEN ? ELSE note || '；' || ? END
        WHERE id = ?
      `).run(targetOwnerUuid, this.db.ownerLabel(targetOwnerUuid), `Web已转入目标库存 x${amount}`, `Web已转入目标库存 x${amount}`, id)
    })
    return { ok: true, message: `已把多余的 ${row.displayName || row.itemId} x${amount} 转入 ${this.db.ownerLabel(targetOwnerUuid)}。` }
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
    if (directPlayer) {
      if (!this.db.hasPersonalWarehouse(directPlayer.uuid)) throw new Error(`${this.db.ownerLabel(directPlayer.uuid)} 还没有个人仓库。`)
      return directPlayer.uuid
    }

    const warehouse = this.db.getCustomWarehouse(raw)
    if (warehouse) return `vault:${warehouse.nameLower}`

    const service = this.serviceProvider()
    const onlineName = service?.bot?.players
      ? Object.keys(service.bot.players).find(name => name.toLowerCase() === raw.toLowerCase())
      : ''
    const online = onlineName ? service.bot.players[onlineName] : null
    if (online?.uuid) {
      this.db.upsertPlayer(online.uuid, onlineName)
      if (!this.db.hasPersonalWarehouse(online.uuid)) throw new Error(`${onlineName} 还没有个人仓库。请先由管理员创建。`)
      return online.uuid
    }

    const player = this.db.getPlayerByUsername(raw)
    if (!player?.uuid || player.uuid.startsWith('name:')) {
      throw new Error(`找不到玩家或仓库：${raw}。玩家需要在线，或之前已用正版 UUID 使用过机器人。`)
    }
    if (!this.db.hasPersonalWarehouse(player.uuid)) throw new Error(`${player.username} 还没有个人仓库。请先由管理员创建。`)
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
    const personalDisplayName = body.updateDisplayName
      ? this.db.setPlayerItemDisplayName(user.uuid, itemKey, displayName)
      : (this.db.getPlayerItemDisplayNames(user.uuid, [itemKey]).get(itemKey) || '')
    return {
      ok: true,
      itemKey,
      displayName: item.displayName,
      personalAlias: item.personalAlias || '',
      personalAliases: item.personalAliases || [],
      personalDisplayName,
      message: `已添加个人别名：${item.shortCode || item.itemId} -> ${item.personalAlias}。`
    }
  }

  apiItemAliasDelete (session, body) {
    const user = this.requireUser(session)
    const result = this.db.deletePlayerItemAlias(user.uuid, body.alias)
    if (result.itemKey) {
      const displayName = this.db.getPlayerItemDisplayNames(user.uuid, [result.itemKey]).get(result.itemKey) || ''
      if (displayName.toLowerCase() === String(result.alias || '').toLowerCase()) this.db.setPlayerItemDisplayName(user.uuid, result.itemKey, '')
    }
    return { ok: true, message: result.changed ? `已删除个人别名：${result.alias}。` : '没有找到这个个人别名。' }
  }

  apiMyGlobalAliasToggle (session, body) {
    const user = this.requireUser(session)
    const result = this.db.setGlobalItemAliasEnabled(user.uuid, body.alias, Boolean(body.enabled))
    return { ok: true, ...result, message: `已${result.enabled ? '启用' : '禁用'}全局别名：${result.alias}。` }
  }

  apiAdminAliasSave (session, body) {
    const user = this.requireAdmin(session)
    const itemKey = String(body.itemKey || '').trim()
    const alias = String(body.alias || body.displayName || '').trim()
    const item = this.db.saveGlobalItemAlias(itemKey, alias)
    if (body.updateDisplayName) this.db.saveItemNameOverride(itemKey, alias)
    this.db.addTransaction('web_admin_alias_save', 'ok', this.config.momoOwner, user.username, [{ ...item, amount: 0 }], `global_alias=${item.alias}; item=${item.shortCode}`)
    return { ok: true, message: `已添加全局别名：${item.alias} -> ${item.displayName}。${body.updateDisplayName ? '库存显示名称也已更新。' : ''}` }
  }

  apiAdminAliasDelete (session, body) {
    const user = this.requireAdmin(session)
    const alias = String(body.alias || '').trim()
    const result = this.db.deleteGlobalItemAlias(alias)
    if (result.changed) {
      this.db.addTransaction('web_admin_alias_delete', 'ok', this.config.momoOwner, user.username, [], `delete global_alias=${result.alias}`)
    }
    return { ok: true, message: result.changed ? `已删除全局别名：${result.alias}。` : '没有找到这条全局别名。' }
  }

  apiAdminQuotaSave (session, body) {
    const user = this.requireAdmin(session)
    const ownerUuid = this.resolveAdminOwnerArgument(body.ownerUuid || body.ownerText || '')
    const quotaSlots = Number.parseInt(body.quotaSlots, 10)
    if (!ownerUuid) throw new Error('缺少仓库。')
    if (!Number.isInteger(quotaSlots) || quotaSlots < 0 || quotaSlots > 1000000) throw new Error('额度必须是 0 到 1000000 的整数。')
    this.db.setQuotaSlots(ownerUuid, quotaSlots)
    this.db.addTransaction('web_admin_quota_save', 'ok', ownerUuid, this.db.ownerLabel(ownerUuid), [], `admin=${user.username}; quota_slots=${quotaSlots}`)
    return { ok: true, message: `已把 ${this.db.ownerLabel(ownerUuid)} 的额度设置为 ${quotaSlots} 格。` }
  }

  adminOwnerUsedSlots (ownerUuid) {
    const rows = this.db.db.prepare(`
      SELECT b.amount, i.item_id AS itemId
      FROM balances b JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ? AND b.amount > 0
    `).all(ownerUuid)
    return rows.reduce((sum, row) => {
      const stackSize = Math.max(1, Number(this.db.catalog?.getStackSize(row.itemId) || 64))
      return sum + Math.ceil(Number(row.amount || 0) / stackSize)
    }, 0)
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
    return [item.displayName, item.itemId, item.itemKey, item.shortCode, item.nbtJson, item.metaJson, ...(item.globalAliases || [])].some(value => this.textMatches(value, query))
  }

  adminTransactionItemMatches (item, query) {
    if (this.adminItemMatches(item, query)) return true
    if (!item.itemKey || !String(item.itemId || '').endsWith('shulker_box')) return false
    const contents = Array.isArray(item.shulkerContents)
      ? item.shulkerContents
      : (this.db.getShulkerContentsByBox([item.itemKey]).get(item.itemKey) || [])
    return contents.some(content => this.adminItemMatches(content, query))
  }

  prepareTransactionItems (rows) {
    const itemsById = new Map()
    const shulkerKeys = new Set()
    for (const row of rows || []) {
      const items = this.parseItemsJson(row.itemsJson)
      itemsById.set(row.id, items)
      for (const item of items) {
        const itemKey = item.itemKey || item.item_key || ''
        const itemId = item.itemId || item.item_id || ''
        if (itemKey && String(itemId).endsWith('shulker_box')) shulkerKeys.add(itemKey)
      }
    }
    return {
      itemsById,
      contentsByBox: this.db.getShulkerContentsByBox([...shulkerKeys])
    }
  }

  decorateTransactionItems (items, prefetchedContents = null) {
    const decorated = (items || []).map(item => ({
      ...this.adminItem(item),
      amount: Number(item.amount || 0)
    }))
    const shulkerKeys = [...new Set(decorated
      .filter(item => item.itemKey && String(item.itemId || '').endsWith('shulker_box'))
      .map(item => item.itemKey))]
    const contentsByBox = prefetchedContents || this.db.getShulkerContentsByBox(shulkerKeys)
    return decorated.map(item => ({
      ...item,
      shulkerContents: (contentsByBox.get(item.itemKey) || []).map(content => ({
        ...this.adminItem(content),
        amount: Number(content.amount || 0),
        slotCount: Number(content.slotCount || 0)
      }))
    }))
  }

  transactionDetails (message) {
    const details = {}
    for (const part of String(message || '').split(/[;,]\s*/)) {
      const match = part.match(/^([^=]+)=(.*)$/)
      if (match) details[match[1].trim()] = match[2].trim()
    }
    const transfer = String(message || '').match(/admin transfer (?:to|from) (.+)$/)
    if (transfer) details.counterparty = this.db.ownerLabel(transfer[1].trim())
    return details
  }

  transactionOperator (row, details = {}) {
    return String(details.admin || details.actor || details.operator || details.player || row.username || '').trim()
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
      deposit_residual_recovery: '存货残留恢复',
      withdraw_residual_recovery: '取货残留恢复',
      admin_adjust_add: '指令增加库存',
      admin_adjust_remove: '指令减少库存',
      web_admin_add: '管理员增加库存',
      web_admin_subtract: '管理员减少库存',
      web_admin_set: '管理员设置库存',
      web_admin_transfer_out: '管理员转出',
      web_admin_transfer_in: '管理员转入',
      web_admin_mismatch_deduct: '异常扣除',
      web_admin_mismatch_transfer: '多余物品转入库存',
      warehouse_delete_transfer_out: '删除仓库转出',
      warehouse_delete_transfer_in: '删除仓库转入 momo',
      web_admin_organization_member_add: '管理员添加组织成员',
      web_admin_organization_member_remove: '管理员删除组织成员',
      web_admin_organization_member_role: '管理员设置组织身份',
      web_admin_alias_save: '保存物品别名',
      web_admin_alias_delete: '删除物品别名',
      web_admin_quota_save: '设置仓库额度'
    }
    return labels[type] || String(type || '')
  }

  transactionStatusLabel (status) {
    const labels = {
      ok: '成功',
      partial: '部分完成',
      empty: '空操作',
      no_space: '空间不足',
      failed: '失败',
      cancelled: '已取消',
      error: '失败',
      teleport_timeout: '传送超时',
      ok_after_teleport_timeout: '传送超时后成功入库',
      partial_after_teleport_timeout: '传送超时后部分入库',
      no_space_after_teleport_timeout: '传送超时后空间不足',
      empty_after_teleport_timeout: '传送超时后未收到物品',
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
      stopReason: '结束原因',
      playerDistance: '玩家距离',
      vault: '仓库',
      radius: '半径',
      chests: '木桶数',
      leftOver_items: '剩余种类',
      leftover_items: '剩余种类',
      leftover_amount: '剩余数量',
      timeoutMs: '超时',
      recovery: '恢复方式',
      error: '错误',
      admin: '操作管理员',
      player: '玩家',
      requested: '请求数量',
      to: '转入目标',
      from: '来源仓库',
      action: '操作',
      item: '物品',
      amount: '数量',
      mismatch: '异常类型',
      id: '记录编号',
      deduct: '扣除数量',
      source: '来源',
      global_alias: '全局别名',
      'delete global_alias': '删除全局别名',
      quota_slots: '额度格数',
      deletedOwner: '被删除仓库',
      warehouseType: '仓库类型',
      member: '成员',
      role: '身份',
      batch: '批次',
      reason: '原因',
      usedSlots: '已用格数',
      quotaSlots: '额度格数'
    }
    const valueLabels = {
      personal: '个人仓库',
      custom: '组织仓库',
      true: '是',
      false: '否',
      player_left: '玩家离开超过距离',
      timeout: '等待时间结束',
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
      quota_check: '检查额度',
      death: '机器人死亡',
      cancelled: '操作取消',
      physical_extra: '仓库实物多余'
    }
    const pairs = text.split(/\s*[;,]\s*/).map(part => {
      const index = part.indexOf('=')
      if (index <= 0) {
        const mismatch = part.match(/^mismatch\s+#(\d+)$/i)
        if (mismatch) return `异常记录 #${mismatch[1]}`
        const transfer = part.match(/^admin transfer (to|from) (.+)$/i)
        if (transfer) return `${transfer[1].toLowerCase() === 'to' ? '管理员转入目标' : '管理员转出来源'}：${transfer[2]}`
        return part
      }
      const key = part.slice(0, index).trim()
      const value = part.slice(index + 1).trim()
      let displayValue = value.startsWith('vault:') ? `仓库:${value.slice(6)}` : (valueLabels[value] || value)
      if (key === 'role') displayValue = value === 'admin' ? '仓库管理员' : (value === 'member' ? '普通成员' : displayValue)
      if (key === 'action') displayValue = ({ add: '增加库存', subtract: '减少库存', set: '设置库存' })[value] || displayValue
      if (key === 'mismatch') displayValue = ({ extra: '多余物品', missing: '缺失物品' })[value] || displayValue
      if (key === 'warehouseType') displayValue = ({ personal: '个人仓库', custom: '组织仓库' })[value] || displayValue
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
    const value = String(this.serviceProvider()?.bot?.username || this.config.server?.botName || this.config.server?.username || '').trim()
    return value && !value.includes('@') ? value : 'NanKinz1'
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
      height: 100vh;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font: 15px/1.5 "Microsoft YaHei", system-ui, sans-serif;
      letter-spacing: 0;
    }
    .app { height: 100vh; min-height: 0; display: grid; grid-template-columns: 250px minmax(0, 1fr); overflow: hidden; }
    aside {
      background: var(--side);
      border-right: 1px solid var(--line);
      padding: 28px 15px;
      display: flex;
      flex-direction: column;
      gap: 24px;
      height: 100vh;
      min-height: 0;
      overflow: hidden;
    }
    .brand { font-size: 30px; font-weight: 800; color: var(--text); }
    .brand span { color: var(--orange); }
    nav { flex: 1 1 auto; border-top: 1px solid var(--line); padding-top: 14px; display: grid; gap: 8px; overflow-y: auto; min-height: 0; align-content: start; }
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
    .userbox { margin-top: auto; flex: 0 0 auto; border-top: 1px solid var(--line); padding-top: 20px; color: var(--gold); background: var(--side); }
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
    button.danger { color: #ffb1b1; border-color: #763f3f; background: #2a1717; }
    main { min-width: 0; height: 100vh; overflow-y: auto; padding: 40px; }
    .hero {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 9px;
      padding: 24px 30px;
      font-size: 23px;
      margin-bottom: 26px;
    }
    .hero strong { color: #fff; font-weight: 800; }
    .quota-inline { margin-left: 14px; color: var(--gold); font-size: 15px; white-space: nowrap; }
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
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      align-items: center;
      margin: -8px 0 14px;
    }
    .admin-transferbar input { width: min(360px, 38vw); }
    .admin-transferbar .muted {
      max-width: 160px;
      color: var(--gold);
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
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
      max-width: min(560px, calc(100vw - 18px));
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
    .tip-text-list { display: grid; gap: 4px; margin-top: 8px; min-width: 230px; max-height: 360px; overflow: auto; }
    .tip-text-row { display: flex; justify-content: space-between; gap: 18px; border-bottom: 1px solid #2c2c31; padding: 5px 2px; color: #eeeae1; font-size: 13px; }
    .tip-text-row:last-child { border-bottom: 0; }
    .tip-text-row span:last-child { color: var(--gold); white-space: nowrap; }
    .tip-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-top: 8px; max-height: 360px; overflow: auto; }
    .tip-slot {
      min-width: 0;
      height: 54px;
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr) auto;
      align-items: center;
      gap: 7px;
      background: #242428;
      border: 1px solid #33343a;
      border-radius: 6px;
      padding: 5px 7px 5px 5px;
      overflow: hidden;
    }
    .tip-slot img { width: 40px; height: 40px; object-fit: contain; image-rendering: pixelated; }
    .tip-slot-name { min-width: 0; color: #f1efe8; font-size: 12px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tip-slot span { color: #fff; font-size: 12px; font-weight: 700; text-shadow: 1px 1px #000; }
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
    .admin-grid-panel { padding: 14px; min-height: 150px; }
    .compact-admin-grid { display: grid; grid-template-columns: repeat(auto-fill, 78px); gap: 10px; align-items: start; }
    .compact-admin-grid .item { box-sizing: border-box; }
    .compact-admin-grid .item .owner-dot { position: absolute; left: 4px; top: 4px; width: 7px; height: 7px; border-radius: 50%; background: var(--gold); box-shadow: 0 0 0 2px #151518; }
    .admin-transfer-top { display: grid; grid-template-columns: minmax(0, 1fr) minmax(190px, 280px) auto; gap: 9px; align-items: start; margin-bottom: 10px; }
    .admin-quick-alias { display: flex; gap: 9px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
    .alias-detail-panel { margin-top: 12px; padding: 14px; min-height: 90px; }
    .alias-detail-head { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 10px; align-items: center; margin-bottom: 10px; }
    .global-alias-toggle-list { display: grid; gap: 6px; }
    .global-alias-toggle-row { display: grid; grid-template-columns: minmax(120px, 1fr) auto 48px; gap: 10px; align-items: center; border-top: 1px solid var(--line); padding: 8px 0; }
    .admin-item-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
    .admin-item-card { min-width: 0; border: 1px solid #2d2d32; background: #151518; border-radius: 9px; padding: 10px; cursor: pointer; }
    .admin-item-card:hover { border-color: #5d492a; }
    .admin-item-card.selected { border-color: var(--gold); background: #211b12; }
    .admin-item-main { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 9px; align-items: center; }
    .admin-item-icon { width: 52px; height: 52px; background: #252529; border-radius: 7px; display: grid; place-items: center; position: relative; }
    .admin-item-icon img { width: 44px; height: 44px; object-fit: contain; image-rendering: pixelated; }
    .admin-item-icon .count { font-size: 12px; }
    .admin-item-name { color: #f1efe8; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .admin-item-meta { color: var(--muted); font-size: 12px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .admin-actionbar { position: sticky; bottom: 10px; z-index: 12; display: grid; grid-template-columns: minmax(180px, 1fr) minmax(180px, 260px) 130px auto; gap: 8px; align-items: center; margin-top: 12px; padding: 10px; border: 1px solid #4a3921; border-radius: 9px; background: rgba(20,18,15,.96); box-shadow: 0 8px 30px rgba(0,0,0,.35); }
    .mismatch-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .mismatch-columns h3 { color: var(--gold); margin: 5px 0 9px; }
    .mismatch-card { cursor: default; }
    .mismatch-actions { display: flex; gap: 6px; margin-top: 9px; }
    .mismatch-actions select { min-width: 0; width: 100%; padding: 6px; }
    .mismatch-actions button { padding: 6px 8px; white-space: nowrap; }
    .alias-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
    .alias-tag { display: inline-flex; gap: 5px; align-items: center; border: 1px solid #493a25; background: #201a12; color: #f4d48a; border-radius: 99px; padding: 3px 7px; font-size: 12px; }
    .transaction-shulker { cursor: help; text-decoration: underline dotted rgba(244, 212, 138, .7); text-underline-offset: 3px; }
    .alias-tag button { border: 0; padding: 0; color: #c9b47e; background: transparent; }
    .admin-alias-list { padding: 14px; display: grid; gap: 9px; }
    .alias-row { display: grid; grid-template-columns: 58px minmax(160px, 1fr) minmax(220px, 2fr); gap: 10px; align-items: center; border-bottom: 1px solid var(--line); padding: 8px 0; }
    .alias-add { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .alias-add input { min-width: 150px; flex: 1; }
    .usage-track { width: 150px; height: 7px; overflow: hidden; border-radius: 99px; background: #29292d; margin-top: 5px; }
    .usage-fill { height: 100%; background: var(--gold); }
    .pager { display: flex; justify-content: center; align-items: center; gap: 10px; margin-top: 12px; }
    .empty-state { padding: 70px 20px; text-align: center; color: var(--muted); }
    .empty-state h3 { color: var(--gold); margin: 8px 0; }
    .empty-icon { font-size: 48px; color: #6e5933; }
    .organization-list { display: grid; gap: 14px; }
    .organization-card { border: 1px solid var(--line); background: var(--panel); border-radius: 10px; padding: 16px; }
    .organization-head { display: flex; gap: 12px; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
    .organization-name { color: var(--gold); font-size: 20px; font-weight: 800; }
    .organization-summary { display: flex; gap: 12px; flex-wrap: wrap; color: var(--muted); font-size: 13px; }
    .member-list { display: grid; gap: 7px; margin-top: 12px; }
    .member-row { display: grid; grid-template-columns: minmax(120px, 1fr) 130px auto; gap: 8px; align-items: center; border-top: 1px solid rgba(255,255,255,.05); padding-top: 7px; }
    .organization-actions { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 12px; }
    .organization-actions input { min-width: 180px; }
    .section-title { color: var(--gold); margin: 18px 0 8px; }
    .warehouse-create-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .warehouse-create-card { padding: 16px; }
    .warehouse-create-card h3 { color: var(--gold); margin: 0 0 6px; }
    .switch { width: 44px; height: 24px; border-radius: 99px; padding: 2px; background: #33343a; border: 0; }
    .switch::after { content: ''; display: block; width: 20px; height: 20px; border-radius: 50%; background: #aaa; transition: transform .15s; }
    .switch.on { background: #71582e; }
    .switch.on::after { transform: translateX(20px); background: var(--gold); }
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
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }
    .alias-note { grid-column: 1 / -1; color: var(--muted); font-size: 13px; }
    .alias-form > .alias-tags { grid-column: 1 / -1; }
    .check-label { grid-column: 1 / -1; display: flex; gap: 7px; align-items: center; color: var(--muted); font-size: 13px; }
    .check-label input { width: auto; margin: 0; }
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
      body { height: auto; min-height: 100vh; overflow: auto; }
      .app { height: auto; min-height: 100vh; overflow: visible; }
      aside { height: auto; min-height: auto; overflow: visible; }
      nav { overflow: visible; }
      main { height: auto; overflow: visible; padding: 20px; }
      .withdrawbar { grid-template-columns: 1fr; }
      .admin-transferbar { justify-content: stretch; }
      .admin-transferbar input { width: 100%; flex: 1 1 220px; }
      .admin-transferbar .muted { white-space: normal; }
      .admin-actionbar { grid-template-columns: 1fr; }
      .admin-transfer-top { grid-template-columns: 1fr; }
      .mismatch-columns { grid-template-columns: 1fr; }
      .alias-row { grid-template-columns: 48px minmax(0, 1fr); }
      .alias-row .alias-add { grid-column: 1 / -1; }
      .member-row { grid-template-columns: 1fr; }
      .warehouse-create-grid { grid-template-columns: 1fr; }
      .tip-grid { grid-template-columns: 1fr; }
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
        <button class="navbtn" data-view="my">☺　我的</button>
        <button id="warehouseAdminLink" class="navbtn hidden" data-view="warehouseAdmin">♜　组织管理</button>
        <button class="navbtn" data-view="help">？　帮助</button>
        <button id="adminLink" class="navbtn hidden" data-view="admin">▣　管理</button>
      </nav>
      <div class="userbox">
        <div><span class="dot"></span><span id="username">-</span></div>
        <button id="logout" class="ghost" style="width:100%;margin-top:18px">登出</button>
      </div>
    </aside>
    <main>
      <div id="inventoryHero" class="hero">欢迎回来，<strong id="heroName">-</strong>。 共 <strong id="heroTypes">0</strong> 种物品，<strong id="heroAmount">0</strong> 件。 <span id="inventoryQuota" class="quota-inline">仓库额度 0/0格</span></div>
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
          <select id="txOwner"></select>
          <input id="txType" placeholder="类型">
          <input id="txOperator" placeholder="操作者">
          <input id="txItem" placeholder="物品（含潜影盒内容）">
          <select id="txStatus"><option value="">全部状态</option><option value="ok">成功</option><option value="failed">失败</option></select>
          <input id="txFrom" type="date" title="开始日期">
          <input id="txTo" type="date" title="结束日期">
          <input id="txQ" placeholder="备注/其他字段">
          <button id="txLoad" class="primary">查询</button>
          <button id="txRefresh" class="primary">刷新</button>
        </div>
        <div id="transactions" class="panel tablewrap"></div>
        <div class="pager"><button id="txPrev">上一页</button><span id="txPage">第 1 / 1 页</span><button id="txNext">下一页</button></div>
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
                  <div class="command-desc">仅云仓库系统管理员可用；普通玩家需要由管理员分配仓库。</div>
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
      <section id="myView" class="hidden">
        <div class="toolbar"><div class="title">我的</div><button id="myRefresh" class="primary">刷新</button></div>
        <div class="subnav">
          <button class="primary active" data-my-tab="organizations">组织</button>
          <button class="primary" data-my-tab="aliases">别名</button>
        </div>
        <section id="myOrganizations"><div id="myOrganizationList" class="organization-list"></div></section>
        <section id="myAliases" class="hidden">
          <div class="toolbar"><input id="myAliasQ" placeholder="筛选物品、短码或别名"><button id="myAliasLoad" class="primary">查询</button></div>
          <h3 class="section-title">我的个人别名</h3><div id="myPersonalAliases" class="panel admin-grid-panel"></div><div id="myPersonalAliasDetail" class="panel alias-detail-panel"><p class="muted">点击物品图标管理个人别名。</p></div>
          <h3 class="section-title">管理员全局别名</h3><p class="muted">默认全部启用。禁用后，该别名不会再用于你的搜索和取货指令。</p><div id="myGlobalAliases" class="panel admin-grid-panel"></div><div id="myGlobalAliasDetail" class="panel alias-detail-panel"><p class="muted">点击物品图标管理全局别名开关。</p></div>
        </section>
      </section>
      <section id="warehouseAdminView" class="hidden">
        <div class="toolbar"><div class="title">组织管理</div><button id="warehouseAdminRefresh" class="primary">刷新</button></div>
        <p class="muted">这里只显示你担任仓库管理员的组织仓库。系统管理员身份不会自动获得这里的权限。</p>
        <div id="warehouseAdminOrganizationList" class="organization-list"></div>
      </section>
      <section id="adminView" class="hidden">
        <div class="toolbar">
          <div class="title">管理面板</div>
          <button id="adminRefresh" class="primary">刷新</button>
        </div>
        <div class="subnav">
          <button class="primary active" data-admin-tab="inventory">库存</button>
          <button class="primary" data-admin-tab="warehouses">组织管理</button>
          <button class="primary" data-admin-tab="mismatches">库存异常</button>
          <button class="primary" data-admin-tab="chests">木桶视图</button>
          <button class="primary" data-admin-tab="transactions">交易记录</button>
          <button class="primary" data-admin-tab="aliases">全局别名</button>
          <button class="primary" data-admin-tab="quotas">额度管理</button>
        </div>
        <section id="adminInventory">
          <div class="toolbar">
            <span id="adminInvStatus" class="muted">等待加载</span>
            <select id="adminInvOwner"><option value="">全部仓库</option></select>
            <input id="adminInvItem" placeholder="按物品/ID/短码筛选">
            <button id="adminInvLoad" class="primary">查询</button>
          </div>
          <div class="admin-transfer-top">
            <div id="adminSelectedList" class="selected-list"><span class="selected-empty">点击物品加入待转账列表</span></div>
            <input id="adminTransferTarget" placeholder="目标玩家 ID 或仓库名">
            <button id="adminTransferRun" class="solid">转账</button>
          </div>
          <div class="admin-quick-alias">
            <button id="adminAliasMode" class="primary">全局别名</button>
            <span id="adminAliasModeHint" class="muted">开启后点击物品图标查看 NBT 并设置全局别名</span>
          </div>
          <div id="adminInvStats" class="stats"></div>
          <div id="adminInvGrid" class="panel admin-grid-panel"></div>
        </section>
        <section id="adminWarehouses" class="hidden">
          <div class="warehouse-create-grid">
            <div class="panel warehouse-create-card"><h3>创建个人仓库</h3><p class="muted">填写玩家 ID。创建后该玩家可以立即使用个人仓库。</p><div class="alias-add"><input id="adminPersonalWarehousePlayer" placeholder="玩家 ID"><button id="adminPersonalWarehouseCreate" class="solid">创建个人仓库</button></div></div>
            <div class="panel warehouse-create-card"><h3>创建组织仓库</h3><p class="muted">指定仓库名和首位仓库管理员。</p><div class="alias-add"><input id="adminOrganizationWarehouseName" placeholder="组织仓库名"><input id="adminOrganizationWarehouseCreator" placeholder="仓库管理员玩家 ID"><button id="adminOrganizationWarehouseCreate" class="solid">创建组织仓库</button></div></div>
          </div>
          <h3 class="section-title">已创建的个人仓库</h3><div id="adminPersonalWarehouseList" class="panel tablewrap"></div>
          <h3 class="section-title">已有组织仓库</h3><div id="adminOrganizationWarehouseList" class="panel tablewrap"></div>
          <div id="adminOrganizationWarehouseDetail" class="panel alias-detail-panel"><p class="muted">点击组织仓库右侧的“查看”管理详情、成员与管理员。</p></div>
        </section>
        <section id="adminMismatches" class="hidden">
          <div class="toolbar">
            <select id="adminMmStatus"><option value="open">未处理</option><option value="resolved">已处理</option></select>
            <select id="adminMmKind"><option value="">全部类型</option><option value="extra">多余</option><option value="missing">缺失</option></select>
            <input id="adminMmItem" placeholder="按物品筛选">
            <button id="adminMmLoad" class="primary">查询</button>
          </div>
          <div id="adminMmStats" class="stats"></div>
          <div class="mismatch-columns">
            <div><h3>多余物品</h3><div id="adminMmExtra" class="panel admin-grid-panel"></div></div>
            <div><h3>缺失物品</h3><div id="adminMmMissing" class="panel admin-grid-panel"></div></div>
          </div>
        </section>
        <section id="adminChests" class="hidden">
          <div class="empty-state panel"><div class="empty-icon">▦</div><h3>木桶视图</h3><p>此模块将在下一次专项重构中实现。本次先保留入口与布局位置。</p></div>
        </section>
        <section id="adminTransactions" class="hidden">
          <div class="toolbar">
            <input id="adminTxOwner" placeholder="目标仓库/玩家">
            <input id="adminTxType" placeholder="类型">
            <input id="adminTxOperator" placeholder="操作者">
            <input id="adminTxItem" placeholder="物品（含潜影盒内容）">
            <select id="adminTxStatus"><option value="">全部状态</option><option value="ok">成功</option><option value="failed">失败</option></select>
            <input id="adminTxFrom" type="date" title="开始日期">
            <input id="adminTxTo" type="date" title="结束日期">
            <input id="adminTxQ" placeholder="备注/操作者/其他字段">
            <button id="adminTxLoad" class="primary">查询</button>
          </div>
          <div id="adminTxTable" class="panel tablewrap"></div>
          <div class="pager"><button id="adminTxPrev">上一页</button><span id="adminTxPage">第 1 / 1 页</span><button id="adminTxNext">下一页</button></div>
        </section>
        <section id="adminAliases" class="hidden">
          <div class="toolbar">
            <input id="adminAliasQ" placeholder="按别名/短码/ID/NBT筛选">
            <button id="adminAliasLoad" class="primary">查询</button>
          </div>
          <div id="adminAliasGrid" class="panel admin-grid-panel"></div>
          <div id="adminAliasDetail" class="panel alias-detail-panel"><p class="muted">点击上方物品图标管理全局别名。</p></div>
        </section>
        <section id="adminQuotas" class="hidden">
          <div class="toolbar"><input id="adminQuotaQ" placeholder="筛选仓库"><button id="adminQuotaLoad" class="primary">查询</button></div>
          <div id="adminQuotaOverall" class="stats"></div>
          <div id="adminQuotaTable" class="panel tablewrap"></div>
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
          <input id="aliasInput" placeholder="新增一个个人别名">
          <button id="aliasSave" class="solid">添加别名</button>
          <div id="aliasExisting" class="alias-tags"></div>
          <label class="check-label"><input id="aliasUseDisplayName" type="checkbox"> 同时修改我的库存显示名称</label>
          <div id="aliasNote" class="alias-note"></div>
        </div>
        <div id="globalAliasEditor" class="alias-form hidden">
          <input id="globalAliasInput" placeholder="新增一个全局别名">
          <button id="globalAliasSave" class="solid">添加全局别名</button>
          <div id="globalAliasExisting" class="alias-tags"></div>
          <label class="check-label"><input id="globalAliasUseDisplayName" type="checkbox"> 同时修改所有库存中的显示名称</label>
          <div id="globalAliasNote" class="alias-note"></div>
        </div>
        <pre id="nbtModalText"></pre>
      </div>
      <div class="nbt-foot"><span id="nbtModalHint" class="muted"></span></div>
    </div>
  </div>
  <div id="tooltip" class="tooltip"></div>

  <script>
    const state = { view: 'inventory', myTab: 'organizations', myPersonalAliasItemKey: '', myGlobalAliasItemKey: '', user: null, owners: [], owner: '', items: [], tx: [], txPage: 1, txTotalPages: 1, selected: new Map(), aliasMode: false, aliasItem: null, adminTab: 'inventory', adminAliasMode: false, adminGlobalAliasItem: null, adminOrganizationName: '', adminInventoryLoadId: 0, adminOwners: [], adminInventoryRows: new Map(), adminSelected: new Map(), adminAliasItem: null, adminTxPage: 1, adminTxTotalPages: 1, actionCooldownUntil: 0, actionCooldownTimer: null, iconRenderId: 0, activePoll: null, iconCache: new Map(), inventoryCache: new Map(), inventoryLoadId: 0, iconScrollTimer: null, onlinePlayersTimer: null, loginChallengeTimer: null, loginChallengeExpiresAt: 0, loginChallengeCommand: '' };
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
      state.defaultOwnerUuid = data.defaultOwnerUuid || '';
      updateBotNameLabels(data.botName || 'bot');
      $('username').textContent = state.user.username;
      $('heroName').textContent = state.user.username;
      $('adminLink').classList.toggle('hidden', !state.user.isAdmin);
      $('warehouseAdminLink').classList.toggle('hidden', !state.user.isWarehouseAdmin);
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
      if (!state.owners.length) {
        $('owner').innerHTML = '<option value="">没有可用仓库</option>';
        state.owner = '';
        $('setDefaultOwner').disabled = true;
        $('deposit').disabled = true;
        $('withdraw').disabled = true;
        $('txOwner').innerHTML = '<option value="">没有可用仓库</option>';
        return;
      }
      $('owner').innerHTML = state.owners.map(owner => {
        const label = owner.label + (owner.isDefault ? '（默认）' : '');
        return '<option value="' + esc(owner.ownerUuid) + '">' + esc(label) + '</option>';
      }).join('');
      const fallbackOwner = state.owners.find(owner => owner.ownerUuid === state.defaultOwnerUuid)?.ownerUuid || state.owners[0]?.ownerUuid || '';
      state.owner = state.owner && state.owners.some(owner => owner.ownerUuid === state.owner) ? state.owner : fallbackOwner;
      $('owner').value = state.owner;
      const txValue = $('txOwner').value || state.owner;
      $('txOwner').innerHTML = state.owners.map(owner => '<option value="' + esc(owner.ownerUuid) + '">' + esc(owner.label) + '</option>').join('');
      $('txOwner').value = state.owners.some(owner => owner.ownerUuid === txValue) ? txValue : state.owner;
      const selected = state.owners.find(owner => owner.ownerUuid === state.owner);
      if ($('setDefaultOwner')) {
        $('setDefaultOwner').textContent = selected?.isDefault ? '默认仓库' : '设为默认';
        $('setDefaultOwner').disabled = Boolean(selected?.isDefault);
      }
      $('deposit').disabled = false;
      $('withdraw').disabled = false;
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
      $('inventoryQuota').textContent = '仓库额度 ' + num(data.quota?.usedSlots || 0) + '/' + num(data.quota?.quotaSlots || 0) + '格';
      renderSelected();
      renderInventory();
    }

    async function loadInventory(options = {}) {
      state.owner = $('owner').value || state.owner;
      if (!state.owner) {
        state.items = [];
        state.selected.clear();
        $('heroTypes').textContent = '0';
        $('heroAmount').textContent = '0';
        $('inventoryQuota').textContent = '当前没有可用仓库';
        $('loaded').textContent = '0/0 种已加载';
        $('inventory').innerHTML = '<div class="empty-state"><div class="empty-icon">▦</div><h3>没有可用仓库</h3><p>请联系云仓库管理员创建个人仓库，或让组织仓库管理员把你加入组织仓库。</p></div>';
        renderSelected();
        return;
      }
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

    function transactionItemsHtml(items, tooltipItems) {
      if (!items?.length) return '<span class="muted">无</span>';
      return items.map(item => {
        const name = item.displayName || item.itemId;
        const isShulker = String(item.itemId || '').endsWith('shulker_box');
        let tooltipKey = '';
        if (isShulker && tooltipItems) {
          tooltipKey = String(tooltipItems.size);
          tooltipItems.set(tooltipKey, item);
        }
        return '<span class="alias-tag' + (isShulker ? ' transaction-shulker' : '') + '"' + (tooltipKey ? ' data-transaction-tip="' + esc(tooltipKey) + '"' : '') + '>' + esc(name) + ' x' + num(item.amount) + '</span>';
      }).join(' ');
    }

    function itemText(item) {
      return [item.displayName, item.adminDisplayName, ...(item.personalAliases || []), ...(item.globalAliases || []), item.itemId, item.itemKey, item.shortCode, item.nbtJson, item.metaJson, ...(item.shulkerContents || []).map(x => x.displayName + ' ' + x.adminDisplayName + ' ' + (x.personalAliases || []).join(' ') + ' ' + (x.globalAliases || []).join(' ') + ' ' + x.itemId + ' ' + x.shortCode)].join(' ').toLowerCase();
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
        item.personalAliases?.length ? '<div class="tip-line">个人别名：' + esc(item.personalAliases.join('、')) + '</div>' : '',
        item.globalAliases?.length ? '<div class="tip-line">全局别名：' + esc(item.globalAliases.join('、')) + '</div>' : '',
        item.adminDisplayName && item.adminDisplayName !== item.displayName ? '<div class="tip-line">默认名：' + esc(item.adminDisplayName) + '</div>' : '',
        item.ownerLabel ? '<div class="tip-line">归属：' + esc(item.ownerLabel) + '</div>' : '',
        '<div class="tip-line">数量：' + num(item.amount) + '</div>',
        '<div class="tip-line">ID：' + esc(item.itemId) + '</div>'
      ].filter(Boolean);
      if (shulker.length) {
        lines.push('<div class="tip-line">潜影盒内容：</div>');
        lines.push('<div class="tip-grid">' + shulker.slice(0, 21).map(x =>
          '<div class="tip-slot" title="' + esc(x.displayName || x.itemId) + '">' +
          '<img data-tip-icon="' + esc(x.itemId) + '" alt="">' +
          '<div class="tip-slot-name">' + esc(x.displayName || x.itemId) + '</div>' +
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

    function transactionTooltipHtml(item) {
      const contents = item.shulkerContents || [];
      const lines = [
        '<div class="tip-title">' + esc(item.displayName || item.itemId) + '</div>',
        '<div class="tip-line">交易数量：' + num(item.amount) + ' 盒</div>',
        '<div class="tip-line">盒内物品（每盒）</div>'
      ];
      if (contents.length) {
        lines.push('<div class="tip-text-list">' + contents.map(content =>
          '<div class="tip-text-row"><span>' + esc(content.displayName || content.itemId) + '</span><span>x' + num(content.amount) + '</span></div>'
        ).join('') + '</div>');
      } else {
        lines.push('<div class="tip-text-list"><div class="muted">潜影盒为空，或这条历史记录没有盒内物品索引。</div></div>');
      }
      return lines.join('');
    }

    function showTransactionTip(event, item) {
      if (!canHoverTooltip()) return;
      const tip = $('tooltip');
      tip.innerHTML = transactionTooltipHtml(item);
      tip.style.display = 'block';
      moveTip(event);
    }

    function bindTransactionTooltips(containerId, tooltipItems) {
      if (!canHoverTooltip()) return;
      for (const element of document.querySelectorAll('#' + containerId + ' [data-transaction-tip]')) {
        const item = tooltipItems.get(element.dataset.transactionTip);
        if (!item) continue;
        element.addEventListener('mouseenter', event => showTransactionTip(event, item));
        element.addEventListener('mousemove', moveTip);
        element.addEventListener('mouseleave', hideTip);
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
        ? '<span class="selected-empty">别名模式：点击物品图标查看详情，可添加多个个人别名</span>'
        : (state.selected.size ? $('selectedList').innerHTML : '<span class="selected-empty">点击物品加入待取列表</span>');
      if (!state.aliasMode) renderSelected();
    }

    function renderSelected() {
      if (state.aliasMode) {
        $('selectedList').innerHTML = '<span class="selected-empty">别名模式：点击物品图标查看详情，可添加多个个人别名</span>';
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
        const aliasTitle = item.personalAliases?.length ? '个人别名：' + item.personalAliases.join('、') : (item.adminDisplayName && item.adminDisplayName !== item.displayName ? '默认名：' + item.adminDisplayName : '');
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
      const data = await api('/api/transactions', { owner: $('txOwner').value, type: $('txType').value, operator: $('txOperator').value, item: $('txItem').value, status: $('txStatus').value, dateFrom: $('txFrom').value, dateTo: $('txTo').value, q: $('txQ').value, page: state.txPage, pageSize: 30 });
      state.tx = data.rows || [];
      state.txPage = data.page || 1;
      state.txTotalPages = data.totalPages || 1;
      $('txPage').textContent = '第 ' + state.txPage + ' / ' + state.txTotalPages + ' 页，共 ' + num(data.total || 0) + ' 条';
      $('txPrev').disabled = state.txPage <= 1;
      $('txNext').disabled = state.txPage >= state.txTotalPages;
      const tooltipItems = new Map();
      renderTable('transactions', ['时间', '类型', '操作者', '归属', '物品', '备注'], state.tx.map(row => {
        const items = transactionItemsHtml(row.items, tooltipItems);
        const details = row.messageLabel ? '<span class="alias-tag">' + esc(row.messageLabel) + '</span>' : '';
        return '<tr><td>' + esc(row.createdAtLabel || row.createdAt) + '</td><td>' + esc(row.typeLabel || row.type) + '<div class="muted">' + esc(row.statusLabel || row.status) + '</div></td><td>' + esc(row.operator || '') + '</td><td>' + esc(row.ownerLabel || '') + '</td><td class="wrap">' + items + '</td><td class="wrap muted">' + details + '</td></tr>';
      }), '没有交易记录。');
      bindTransactionTooltips('transactions', tooltipItems);
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
      if (!state.adminOwners.length) {
        const data = await api('/api/admin/owners');
        state.adminOwners = data.rows || [];
      }
      const inventoryValue = $('adminInvOwner')?.value || '';
      if ($('adminInvOwner')) {
        const occupied = state.adminOwners.filter(owner => Number(owner.totalAmount || 0) > 0);
        $('adminInvOwner').innerHTML = '<option value="">全部有库存仓库</option>' + occupied.map(owner =>
          '<option value="' + esc(owner.ownerUuid) + '"' + (owner.ownerUuid === inventoryValue ? ' selected' : '') + '>' + esc(owner.label) + '（' + num(owner.totalAmount) + '件）</option>'
        ).join('');
      }
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
        row.personalAliases?.length ? '个人别名: ' + row.personalAliases.join('、') : '',
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
      state.adminGlobalAliasItem = null;
      $('aliasEditor').classList.add('hidden');
      $('globalAliasEditor').classList.add('hidden');
      $('nbtModalTitle').textContent = (row.displayName || row.itemId || '物品详情') + (row.shortCode ? ' #' + row.shortCode : '');
      $('nbtModalText').textContent = adminItemDetailText(row);
      $('nbtModalHint').textContent = row.nbtJson || row.metaJson ? '可以按 NBT 或 meta 里的关键词筛选总库存。' : '这个物品没有额外 NBT/meta。';
      $('nbtModal').classList.remove('hidden');
    }

    function openAliasModal(item) {
      state.aliasItem = item;
      state.adminGlobalAliasItem = null;
      $('aliasEditor').classList.remove('hidden');
      $('globalAliasEditor').classList.add('hidden');
      $('aliasInput').value = '';
      $('aliasUseDisplayName').checked = false;
      $('aliasExisting').innerHTML = (item.personalAliases || []).length
        ? item.personalAliases.map(alias => '<span class="alias-tag">' + esc(alias) + '<button data-personal-alias-delete="' + esc(alias) + '">×</button></span>').join('')
        : '<span class="muted">还没有设置个人别名</span>';
      $('aliasNote').textContent = '默认名：' + (item.adminDisplayName || item.itemId || '') + '；短码：' + (item.shortCode || '无');
      $('nbtModalTitle').textContent = (item.displayName || item.itemId || '物品详情') + (item.shortCode ? ' #' + item.shortCode : '');
      $('nbtModalText').textContent = adminItemDetailText(item);
      $('nbtModalHint').textContent = '一件物品可以添加多个个人别名；这些别名只影响你自己的搜索、显示和取货。';
      $('nbtModal').classList.remove('hidden');
      $('aliasInput').focus();
    }

    function openGlobalAliasModal(item) {
      state.aliasItem = null;
      state.adminGlobalAliasItem = item;
      $('aliasEditor').classList.add('hidden');
      $('globalAliasEditor').classList.remove('hidden');
      $('globalAliasInput').value = '';
      $('globalAliasUseDisplayName').checked = false;
      $('globalAliasExisting').innerHTML = (item.globalAliases || []).length
        ? item.globalAliases.map(alias => '<span class="alias-tag">' + esc(alias) + '<button data-admin-alias-delete="' + esc(alias) + '">×</button></span>').join('')
        : '<span class="muted">还没有设置全局别名</span>';
      $('globalAliasNote').textContent = '物品：' + (item.displayName || item.itemId) + '；短码：' + (item.shortCode || '无');
      $('nbtModalTitle').textContent = (item.displayName || item.itemId || '物品详情') + (item.shortCode ? ' #' + item.shortCode : '');
      $('nbtModalText').textContent = adminItemDetailText(item);
      $('nbtModalHint').textContent = '全局别名供所有启用该别名的玩家搜索和取货；修改库存显示名称为可选操作。';
      $('nbtModal').classList.remove('hidden');
      $('globalAliasInput').focus();
    }

    function closeNbtModal() {
      $('nbtModal').classList.add('hidden');
      $('nbtModalText').textContent = '';
      $('aliasEditor').classList.add('hidden');
      $('globalAliasEditor').classList.add('hidden');
      state.aliasItem = null;
      state.adminGlobalAliasItem = null;
    }

    async function copyNbtModal() {
      const text = $('nbtModalText').textContent || '';
      if (!text) return;
      await navigator.clipboard.writeText(text);
      toast('已复制物品详情。');
    }

    function applyAliasToLocalItem(itemKey, personalAliases, personalDisplayName = '') {
      for (const item of state.items) {
        if (item.itemKey !== itemKey) continue;
        item.personalAliases = personalAliases || [];
        item.personalAlias = item.personalAliases[0] || '';
        item.personalDisplayName = personalDisplayName || '';
        item.displayName = item.personalDisplayName || item.adminDisplayName || item.itemId;
      }
      const picked = state.selected.get(itemKey);
      if (picked) picked.displayName = personalDisplayName || picked.displayName;
      state.inventoryCache.delete(state.owner);
      renderSelected();
      renderInventory();
    }

    async function savePersonalAlias() {
      if (!state.aliasItem) return;
      const nextName = $('aliasInput').value.trim();
      if (!nextName) throw new Error('请填写要新增的个人别名。');
      const data = await post('/api/item-alias/save', {
        itemKey: state.aliasItem.itemKey,
        displayName: nextName,
        updateDisplayName: $('aliasUseDisplayName').checked
      });
      applyAliasToLocalItem(data.itemKey, data.personalAliases || [], data.personalDisplayName || '');
      const updated = state.items.find(item => item.itemKey === data.itemKey) || {
        ...state.aliasItem,
        personalAliases: data.personalAliases || []
      };
      openAliasModal(updated);
      toast(data.message);
    }

    async function saveGlobalAliasFromModal() {
      if (!state.adminGlobalAliasItem) return;
      const alias = $('globalAliasInput').value.trim();
      if (!alias) throw new Error('请填写全局别名。');
      const data = await post('/api/admin/alias/save', { itemKey: state.adminGlobalAliasItem.itemKey, alias, updateDisplayName: $('globalAliasUseDisplayName').checked });
      const itemKey = state.adminGlobalAliasItem.itemKey;
      toast(data.message);
      await loadAdminInventory();
      const updated = [...state.adminInventoryRows.values()].find(row => row.itemKey === itemKey);
      if (updated) openGlobalAliasModal(updated);
    }

    async function loadMyOrganizations() {
      const data = await api('/api/my/organizations');
      const rows = data.rows || [];
      $('myOrganizationList').innerHTML = rows.length ? rows.map(warehouse => {
        const members = (warehouse.members || []).map(member =>
          '<div class="member-row" data-member="' + esc(member.playerUuid) + '"><div><strong>' + esc(member.username) + '</strong>' + (member.playerUuid === warehouse.creatorUuid ? '<div class="muted">创建者</div>' : '') + '</div>' +
          '<span class="muted">' + (member.role === 'admin' ? '管理员' : '成员') + '</span><span></span></div>'
        ).join('');
        return '<div class="organization-card" data-warehouse="' + esc(warehouse.name) + '"><div class="organization-head"><div><div class="organization-name">' + esc(warehouse.name) + '</div><div class="organization-summary"><span>' + (warehouse.role === 'admin' ? '仓库管理员' : '普通成员') + '</span><span>' + num((warehouse.members || []).length) + ' 名成员</span></div></div><div><strong>' + num(warehouse.usedSlots) + ' / ' + num(warehouse.quotaSlots) + ' 格</strong><div class="usage-track"><div class="usage-fill" style="width:' + Math.min(100, Number(warehouse.usagePercent || 0)) + '%"></div></div><div class="muted">使用率 ' + esc(warehouse.usagePercent) + '%</div></div></div><div class="member-list">' + members + '</div></div>';
      }).join('') : '<div class="empty-state panel"><div class="empty-icon">♙</div><h3>还没有组织仓库</h3><p>你尚未创建或加入任何组织仓库。</p></div>';
    }

    async function loadMyAliases() {
      const data = await api('/api/my/aliases', { q: $('myAliasQ').value });
      const personal = data.personal || [];
      state.myPersonalAliasRows = new Map(personal.map(row => [row.itemKey, row]));
      $('myPersonalAliases').innerHTML = personal.length ? '<div class="compact-admin-grid">' + personal.map(row => aliasGridItemHtml(row, 'my-personal-alias-card', state.myPersonalAliasItemKey === row.itemKey, row.aliases.length + ' 个别名')).join('') + '</div>' : '<p class="muted">你还没有设置个人别名。可在库存页进入“物品别名”模式添加。</p>';

      const globalMap = new Map();
      for (const row of data.global || []) {
        if (!globalMap.has(row.itemKey)) globalMap.set(row.itemKey, { ...row, aliases: [] });
        globalMap.get(row.itemKey).aliases.push({ alias: row.alias, enabled: row.enabled });
      }
      const globals = [...globalMap.values()];
      state.myGlobalAliasRows = globalMap;
      $('myGlobalAliases').innerHTML = globals.length ? '<div class="compact-admin-grid">' + globals.map(row => aliasGridItemHtml(row, 'my-global-alias-card', state.myGlobalAliasItemKey === row.itemKey, row.aliases.length + ' 个别名')).join('') + '</div>' : '<p class="muted">管理员还没有设置全局别名。</p>';

      if (state.myPersonalAliasItemKey && state.myPersonalAliasRows.has(state.myPersonalAliasItemKey)) renderMyPersonalAliasDetail(state.myPersonalAliasRows.get(state.myPersonalAliasItemKey));
      else { state.myPersonalAliasItemKey = ''; $('myPersonalAliasDetail').innerHTML = '<p class="muted">点击物品图标管理个人别名。</p>'; }
      if (state.myGlobalAliasItemKey && state.myGlobalAliasRows.has(state.myGlobalAliasItemKey)) renderMyGlobalAliasDetail(state.myGlobalAliasRows.get(state.myGlobalAliasItemKey));
      else { state.myGlobalAliasItemKey = ''; $('myGlobalAliasDetail').innerHTML = '<p class="muted">点击物品图标管理全局别名开关。</p>'; }
    }

    function aliasGridItemHtml(row, attribute, selected, note) {
      return '<div class="item' + (selected ? ' selected' : '') + '" data-' + attribute + '="' + esc(row.itemKey) + '" title="' + esc(row.displayName + ' · ' + note) + '"><div class="icon"><img src="' + esc(iconUrl(row.itemId, 'item')) + '" alt=""><span class="fallback">' + esc((row.displayName || row.itemId).slice(0, 4)) + '</span></div><div class="name">' + esc(row.displayName) + '</div></div>';
    }

    function renderMyPersonalAliasDetail(row) {
      state.myPersonalAliasItemKey = row.itemKey;
      document.querySelectorAll('[data-my-personal-alias-card]').forEach(card => card.classList.toggle('selected', card.dataset.myPersonalAliasCard === row.itemKey));
      $('myPersonalAliasDetail').innerHTML = '<div class="alias-detail-head"><div class="admin-item-icon"><img src="' + esc(iconUrl(row.itemId, 'item')) + '" alt=""></div><div><div class="admin-item-name">' + esc(row.displayName) + '</div><div class="admin-item-meta">#' + esc(row.shortCode) + ' · ' + esc(row.itemId) + '</div></div></div><div class="alias-tags">' + row.aliases.map(alias => '<span class="alias-tag">' + esc(alias) + '<button data-personal-alias-delete="' + esc(alias) + '">×</button></span>').join('') + '</div><div class="alias-add" data-item="' + esc(row.itemKey) + '" style="margin-top:10px"><input data-my-alias-input placeholder="新增个人别名"><button data-my-alias-add>添加</button></div>';
    }

    function renderMyGlobalAliasDetail(row) {
      state.myGlobalAliasItemKey = row.itemKey;
      document.querySelectorAll('[data-my-global-alias-card]').forEach(card => card.classList.toggle('selected', card.dataset.myGlobalAliasCard === row.itemKey));
      $('myGlobalAliasDetail').innerHTML = '<div class="alias-detail-head"><div class="admin-item-icon"><img src="' + esc(iconUrl(row.itemId, 'item')) + '" alt=""></div><div><div class="admin-item-name">' + esc(row.displayName) + '</div><div class="admin-item-meta">#' + esc(row.shortCode) + ' · ' + esc(row.itemId) + '</div></div></div><div class="global-alias-toggle-list">' + row.aliases.map(item => '<div class="global-alias-toggle-row"><span>' + esc(item.alias) + '</span><span class="muted">' + (item.enabled ? '已启用' : '已禁用') + '</span><button class="switch' + (item.enabled ? ' on' : '') + '" data-global-alias-toggle="' + esc(item.alias) + '" data-enabled="' + (item.enabled ? '1' : '0') + '"></button></div>').join('') + '</div>';
    }

    function loadMyCurrent() {
      return state.myTab === 'organizations' ? loadMyOrganizations() : loadMyAliases();
    }

    function setMyTab(tab) {
      state.myTab = tab;
      document.querySelectorAll('[data-my-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.myTab === tab));
      $('myOrganizations').classList.toggle('hidden', tab !== 'organizations');
      $('myAliases').classList.toggle('hidden', tab !== 'aliases');
      loadMyCurrent().catch(error => toast(error.message));
    }

    function adminCardHtml(row, index, options = {}) {
      const selected = state.adminSelected.has(index) ? ' selected' : '';
      const aliases = (row.globalAliases || row.aliases || []).join('、');
      return '<div class="admin-item-card' + selected + (options.className ? ' ' + options.className : '') + '" data-admin-card="' + esc(index) + '">' +
        '<div class="admin-item-main"><div class="admin-item-icon"><img src="' + esc(iconUrl(row.itemId, 'item')) + '" alt=""><span class="count">' + esc(shortCount(row.amount)) + '</span></div>' +
        '<div><div class="admin-item-name" title="' + esc(row.displayName) + '">' + esc(row.displayName || row.itemId) + '</div>' +
        '<div class="admin-item-meta">' + esc(row.ownerLabel || '') + '</div><div class="admin-item-meta">#' + esc(row.shortCode || '无短码') + (aliases ? ' · ' + esc(aliases) : '') + '</div></div></div>' +
        (options.actions || '') + '</div>';
    }

    function renderAdminTransferSelection() {
      if (state.adminAliasMode) {
        $('adminSelectedList').innerHTML = '<span class="selected-empty">别名模式：点击下方物品图标查看 NBT 和设置全局别名</span>';
        return;
      }
      const rows = [...state.adminSelected.values()];
      if (!rows.length) {
        $('adminSelectedList').innerHTML = '<span class="selected-empty">点击物品加入待转账列表</span>';
      } else {
        $('adminSelectedList').innerHTML = rows.map(row =>
          '<div class="pick" data-admin-pick="' + esc(row.selectionKey) + '"><span class="pick-name" title="' + esc(row.ownerLabel + ' · ' + row.displayName) + '">' + esc(row.displayName) + '</span><input type="number" min="1" max="' + esc(row.amount) + '" value="' + esc(row.selectedAmount) + '" data-admin-pick-amount><button class="ghost" data-admin-pick-remove>×</button></div>'
        ).join('') + '<button class="ghost selected-clear" data-admin-pick-clear>清空</button>';
      }
    }

    function compactAdminItemHtml(row, index, selected = false) {
      return '<div class="item' + (selected ? ' selected' : '') + '" data-admin-card="' + esc(index) + '"><div class="icon"><img src="' + esc(iconUrl(row.itemId, 'item')) + '" alt=""><span class="fallback">' + esc((row.displayName || row.itemId).slice(0, 4)) + '</span><span class="count">' + esc(shortCount(row.amount)) + '</span></div><div class="name">' + esc(row.displayName || row.itemId) + '</div></div>';
    }

    function loadAdminInventorySelectionState() {
      document.querySelectorAll('#adminInvGrid [data-admin-card]').forEach(card => card.classList.toggle('selected', state.adminSelected.has(card.dataset.adminCard)));
    }

    function bindAdminInventoryTooltips() {
      if (!canHoverTooltip()) return;
      for (const card of document.querySelectorAll('#adminInvGrid [data-admin-card]')) {
        const item = state.adminInventoryRows.get(card.dataset.adminCard);
        if (!item) continue;
        card.addEventListener('mouseenter', event => showTip(event, item));
        card.addEventListener('mousemove', moveTip);
        card.addEventListener('mouseleave', hideTip);
      }
    }

    async function loadAdminInventory(options = {}) {
      const loadId = ++state.adminInventoryLoadId;
      const startedAt = performance.now();
      const requestedOwner = options.owner !== undefined ? String(options.owner || '') : String($('adminInvOwner').value || '');
      $('adminInvStatus').textContent = '加载中…';
      $('adminInvOwner').disabled = true;
      $('adminInvLoad').disabled = true;
      $('adminInvGrid').style.opacity = '.55';
      try {
        state.adminOwners = [];
        await loadAdminOwners();
        const ownerExists = [...$('adminInvOwner').options].some(option => option.value === requestedOwner);
        const owner = ownerExists ? requestedOwner : '';
        $('adminInvOwner').value = owner;
        const data = await api('/api/admin/inventory', { owner, item: $('adminInvItem').value });
        if (loadId !== state.adminInventoryLoadId) return;
        renderStats('adminInvStats', { '仓库数': data.stats?.owners || 0, '物品种类': data.stats?.itemTypes || 0, '物品总数': data.stats?.totalAmount || 0 });
        state.adminInventoryRows = new Map();
        state.adminSelected.clear();
        const rows = data.rows || [];
        rows.forEach((row, index) => state.adminInventoryRows.set(String(index), row));
        $('adminInvGrid').innerHTML = rows.length ? '<div class="compact-admin-grid">' + rows.map((row, index) => compactAdminItemHtml(row, String(index))).join('') + '</div>' : '<p class="muted" style="text-align:center">没有库存。</p>';
        $('adminInvStatus').textContent = '已加载 ' + rows.length + ' 种 · ' + Math.round(performance.now() - startedAt) + 'ms';
        renderAdminTransferSelection();
        bindAdminInventoryTooltips();
      } catch (error) {
        if (loadId === state.adminInventoryLoadId) $('adminInvStatus').textContent = '加载失败：' + error.message;
        throw error;
      } finally {
        if (loadId === state.adminInventoryLoadId) {
          $('adminInvOwner').disabled = false;
          $('adminInvLoad').disabled = false;
          $('adminInvGrid').style.opacity = '';
        }
      }
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
      await loadAdminOwners();
      const rows = data.rows || [];
      const mismatchHtml = row => adminCardHtml(row, 'mm-' + row.id, {
        className: 'mismatch-card',
        actions: row.status !== 'open' ? '<div class="admin-item-meta">已处理 ' + esc(row.resolvedAt || '') + '</div>' : row.kind === 'extra'
          ? '<div class="mismatch-actions"><select data-mm-target><option value="">目标仓库</option>' + ownerOptions() + '</select><button data-admin-mm-resolve="' + esc(row.id) + '">转入</button></div>'
          : '<div class="mismatch-actions"><button data-admin-mm-deduct="' + esc(row.id) + '">清除库存</button></div>'
      });
      const extra = rows.filter(row => row.kind === 'extra');
      const missing = rows.filter(row => row.kind === 'missing');
      $('adminMmExtra').innerHTML = extra.length ? '<div class="admin-item-grid">' + extra.map(mismatchHtml).join('') + '</div>' : '<p class="muted">没有多余物品。</p>';
      $('adminMmMissing').innerHTML = missing.length ? '<div class="admin-item-grid">' + missing.map(mismatchHtml).join('') + '</div>' : '<p class="muted">没有缺失物品。</p>';
    }

    async function loadAdminWarehouseProvisioning() {
      const data = await api('/api/admin/warehouse-provisioning');
      renderTable('adminPersonalWarehouseList', ['玩家', '库存', '已用格数', '创建时间', '操作'], (data.personal || []).map(row =>
        '<tr><td>' + esc(row.username) + '<div class="muted">' + esc(row.ownerUuid) + '</div></td><td>' + num(row.totalAmount) + ' 件</td><td>' + num(row.usedSlots) + ' 格</td><td>' + esc(row.createdAt || '') + '</td><td><button class="danger" data-admin-personal-delete="' + esc(row.ownerUuid) + '" data-owner-name="' + esc(row.username) + '">删除</button></td></tr>'
      ), '还没有创建个人仓库。');
      renderTable('adminOrganizationWarehouseList', ['仓库', '首位管理员', '成员', '库存', '已用格数', '创建时间', '操作'], (data.organizations || []).map(row =>
        '<tr><td>' + esc(row.name) + '</td><td>' + esc(row.creatorUsername) + '</td><td>' + num(row.memberCount) + ' 人</td><td>' + num(row.totalAmount) + ' 件</td><td>' + num(row.usedSlots) + ' 格</td><td>' + esc(row.createdAt || '') + '</td><td><button data-admin-org-view="' + esc(row.name) + '">查看</button></td></tr>'
      ), '还没有组织仓库。');
      const names = new Set((data.organizations || []).map(row => row.name));
      if (state.adminOrganizationName && names.has(state.adminOrganizationName)) await loadAdminOrganizationDetail(state.adminOrganizationName);
      else if (state.adminOrganizationName) {
        state.adminOrganizationName = '';
        $('adminOrganizationWarehouseDetail').innerHTML = '<p class="muted">点击组织仓库右侧的“查看”管理详情、成员与管理员。</p>';
      }
    }

    async function loadAdminOrganizationDetail(name) {
      const data = await api('/api/admin/organization-warehouse/detail', { name });
      const warehouse = data.warehouse;
      state.adminOrganizationName = warehouse.name;
      const members = (warehouse.members || []).map(member =>
        '<div class="member-row" data-admin-org-member="' + esc(member.playerUuid) + '"><div><strong>' + esc(member.username) + '</strong>' + (member.playerUuid === warehouse.creatorUuid ? '<div class="muted">首位管理员</div>' : '') + '</div><select data-admin-org-role><option value="member"' + (member.role === 'member' ? ' selected' : '') + '>普通成员</option><option value="admin"' + (member.role === 'admin' ? ' selected' : '') + '>仓库管理员</option></select><button class="danger" data-admin-org-member-remove>删除成员</button></div>'
      ).join('');
      $('adminOrganizationWarehouseDetail').innerHTML =
        '<div class="organization-card" data-admin-org-detail="' + esc(warehouse.name) + '">' +
          '<div class="organization-head"><div><div class="organization-name">' + esc(warehouse.name) + '</div><div class="organization-summary"><span>首位管理员：' + esc(warehouse.creatorUsername) + '</span><span>' + num((warehouse.members || []).length) + ' 名成员</span><span>' + num(warehouse.totalAmount) + ' 件物品</span></div></div><div><strong>' + num(warehouse.usedSlots) + ' / ' + num(warehouse.quotaSlots) + ' 格</strong><div class="usage-track"><div class="usage-fill" style="width:' + Math.min(100, Number(warehouse.usagePercent || 0)) + '%"></div></div><div class="muted">使用率 ' + esc(warehouse.usagePercent) + '%</div></div></div>' +
          '<div class="organization-actions"><input data-admin-org-add-name placeholder="玩家 ID"><select data-admin-org-add-role><option value="member">普通成员</option><option value="admin">仓库管理员</option></select><button data-admin-org-member-add>添加成员</button><button class="danger" data-admin-org-delete>删除组织仓库</button></div>' +
          '<div class="member-list">' + (members || '<p class="muted">没有成员。</p>') + '</div>' +
        '</div>';
    }

    async function createAdminPersonalWarehouse() {
      const data = await post('/api/admin/personal-warehouse/create', { username: $('adminPersonalWarehousePlayer').value });
      toast(data.message); $('adminPersonalWarehousePlayer').value = ''; state.adminOwners = []; await loadAdminWarehouseProvisioning();
    }

    async function createAdminOrganizationWarehouse() {
      const data = await post('/api/admin/organization-warehouse/create', { name: $('adminOrganizationWarehouseName').value, creatorUsername: $('adminOrganizationWarehouseCreator').value });
      toast(data.message); $('adminOrganizationWarehouseName').value = ''; $('adminOrganizationWarehouseCreator').value = ''; state.adminOwners = []; await loadAdminWarehouseProvisioning();
    }

    async function loadWarehouseAdminOrganizations() {
      const data = await api('/api/warehouse-admin/organizations');
      const rows = data.rows || [];
      $('warehouseAdminOrganizationList').innerHTML = rows.length ? rows.map(warehouse => {
        const actions = '<div class="organization-actions"><input data-org-new-name value="' + esc(warehouse.name) + '" placeholder="新仓库名"><button data-org-rename>修改仓库名</button><input data-org-add-name placeholder="玩家 ID"><button data-org-member-add>添加成员</button></div>';
        const members = (warehouse.members || []).map(member =>
          '<div class="member-row" data-member="' + esc(member.playerUuid) + '"><div><strong>' + esc(member.username) + '</strong>' + (member.playerUuid === warehouse.creatorUuid ? '<div class="muted">创建者</div>' : '') + '</div><select data-member-role' + (member.playerUuid === warehouse.creatorUuid ? ' disabled' : '') + '><option value="member"' + (member.role === 'member' ? ' selected' : '') + '>普通成员</option><option value="admin"' + (member.role === 'admin' ? ' selected' : '') + '>仓库管理员</option></select>' + (member.playerUuid !== warehouse.creatorUuid ? '<button data-org-member-remove>删除成员</button>' : '<span></span>') + '</div>'
        ).join('');
        return '<div class="organization-card" data-warehouse="' + esc(warehouse.name) + '"><div class="organization-head"><div><div class="organization-name">' + esc(warehouse.name) + '</div><div class="organization-summary"><span>创建者：' + esc(warehouse.creatorUsername) + '</span><span>' + num((warehouse.members || []).length) + ' 名成员</span></div></div><div><strong>' + num(warehouse.usedSlots) + ' / ' + num(warehouse.quotaSlots) + ' 格</strong><div class="usage-track"><div class="usage-fill" style="width:' + Math.min(100, Number(warehouse.usagePercent || 0)) + '%"></div></div></div></div>' + actions + '<div class="member-list">' + members + '</div></div>';
      }).join('') : '<div class="empty-state panel"><div class="empty-icon">♙</div><h3>没有组织仓库</h3></div>';
    }

    async function runAdminTransfer() {
      const target = $('adminTransferTarget').value.trim();
      const rows = [...state.adminSelected.values()];
      if (!target) throw new Error('请输入目标玩家 ID 或仓库名。');
      if (!rows.length) throw new Error('请先选择要转账的物品。');
      const total = rows.reduce((sum, row) => sum + Number(row.selectedAmount || 0), 0);
      if (!confirm('确认把已选的 ' + rows.length + ' 种、共 ' + total + ' 个物品转账给 ' + target + ' 吗？')) return;
      const data = await post('/api/admin/transfer', { toOwnerText: target, items: rows.map(row => ({ fromOwnerUuid: row.ownerUuid, itemKey: row.itemKey, amount: row.selectedAmount })) });
      toast(data.message);
      state.adminOwners = [];
      await loadAdminInventory();
    }

    function setAdminAliasMode(enabled) {
      state.adminAliasMode = Boolean(enabled);
      state.adminSelected.clear();
      $('adminAliasMode').classList.toggle('solid', state.adminAliasMode);
      $('adminAliasMode').textContent = state.adminAliasMode ? '退出别名' : '全局别名';
      $('adminAliasModeHint').textContent = state.adminAliasMode ? '别名模式：点击物品图标查看 NBT 并设置全局别名' : '开启后点击物品图标查看 NBT 并设置全局别名';
      $('adminTransferTarget').disabled = state.adminAliasMode;
      $('adminTransferRun').disabled = state.adminAliasMode;
      renderAdminTransferSelection();
      loadAdminInventorySelectionState();
    }

    async function loadAdminTransactions() {
      const data = await api('/api/admin/transactions', { q: $('adminTxQ').value, owner: $('adminTxOwner').value, type: $('adminTxType').value, operator: $('adminTxOperator').value, item: $('adminTxItem').value, status: $('adminTxStatus').value, dateFrom: $('adminTxFrom').value, dateTo: $('adminTxTo').value, page: state.adminTxPage, pageSize: 30 });
      state.adminTxPage = data.page || 1;
      state.adminTxTotalPages = data.totalPages || 1;
      $('adminTxPage').textContent = '第 ' + state.adminTxPage + ' / ' + state.adminTxTotalPages + ' 页，共 ' + num(data.total || 0) + ' 条';
      $('adminTxPrev').disabled = state.adminTxPage <= 1;
      $('adminTxNext').disabled = state.adminTxPage >= state.adminTxTotalPages;
      const tooltipItems = new Map();
      renderTable('adminTxTable', ['时间', '类型', '操作者', '归属', '物品', '备注'], (data.rows || []).map(row => {
        const items = transactionItemsHtml(row.items, tooltipItems);
        const details = row.messageLabel ? '<span class="alias-tag">' + esc(row.messageLabel) + '</span>' : '';
        return '<tr><td>' + esc(row.createdAtLabel || row.createdAt) + '</td><td>' + esc(row.typeLabel || row.type) + '<div class="muted">' + esc(row.statusLabel || row.status) + '</div></td><td>' + esc(row.operator || '') + '</td><td>' + esc(row.ownerLabel || row.username || '') + '</td><td class="wrap">' + items + '</td><td class="wrap muted">' + details + '</td></tr>';
      }), '没有交易记录。');
      bindTransactionTooltips('adminTxTable', tooltipItems);
    }

    async function loadAdminAliases() {
      const data = await api('/api/admin/aliases', { q: $('adminAliasQ').value });
      const rows = data.rows || [];
      state.adminAliasRows = new Map(rows.map(row => [row.itemKey, row]));
      $('adminAliasGrid').innerHTML = rows.length ? '<div class="compact-admin-grid">' + rows.map(row =>
        '<div class="item' + (state.adminAliasItem?.itemKey === row.itemKey ? ' selected' : '') + '" data-admin-alias-card="' + esc(row.itemKey) + '" title="' + esc(row.displayName + ' · ' + row.aliases.join('、')) + '"><div class="icon"><img src="' + esc(iconUrl(row.itemId, 'item')) + '" alt=""><span class="fallback">' + esc((row.displayName || row.itemId).slice(0, 4)) + '</span></div><div class="name">' + esc(row.displayName) + '</div></div>'
      ).join('') + '</div>' : '<p class="muted">没有已设置的全局别名。</p>';
      if (state.adminAliasItem && state.adminAliasRows.has(state.adminAliasItem.itemKey)) {
        renderAdminAliasDetail(state.adminAliasRows.get(state.adminAliasItem.itemKey));
      } else {
        state.adminAliasItem = null;
        $('adminAliasDetail').innerHTML = '<p class="muted">点击上方物品图标管理全局别名。</p>';
      }
    }

    function renderAdminAliasDetail(row) {
      state.adminAliasItem = row;
      document.querySelectorAll('[data-admin-alias-card]').forEach(card => card.classList.toggle('selected', card.dataset.adminAliasCard === row.itemKey));
      $('adminAliasDetail').innerHTML = '<div class="alias-detail-head"><div class="admin-item-icon"><img src="' + esc(iconUrl(row.itemId, 'item')) + '" alt=""></div><div><div class="admin-item-name">' + esc(row.displayName) + '</div><div class="admin-item-meta">#' + esc(row.shortCode) + ' · ' + esc(row.itemId) + '</div></div></div><div class="alias-tags">' + row.aliases.map(alias => '<span class="alias-tag">' + esc(alias) + '<button data-admin-alias-delete="' + esc(alias) + '">×</button></span>').join('') + '</div><div class="alias-add" style="margin-top:10px"><input id="adminAliasDetailInput" placeholder="新增全局别名"><button data-admin-alias-detail-save>添加别名</button></div><label class="check-label" style="margin-top:8px"><input id="adminAliasDetailUseDisplayName" type="checkbox"> 同时修改所有库存中的显示名称</label>';
    }

    async function loadAdminQuotas() {
      const data = await api('/api/admin/quotas', { q: $('adminQuotaQ').value });
      renderStats('adminQuotaOverall', { '木桶数量': data.overall?.chestCount || 0, '已用物理格数': data.overall?.usedSlots || 0, '总物理格数': data.overall?.totalSlots || 0, '整体使用率 %': data.overall?.usagePercent || 0 });
      renderTable('adminQuotaTable', ['仓库', '使用情况', '额度', '操作'], (data.rows || []).map(row =>
        '<tr data-owner="' + esc(row.ownerUuid) + '"><td>' + esc(row.label) + '<div class="muted">' + esc(row.ownerUuid) + '</div></td><td>' + num(row.usedSlots) + ' / ' + num(row.quotaSlots) + ' 格<div class="usage-track"><div class="usage-fill" style="width:' + Math.min(100, Number(row.usagePercent || 0)) + '%"></div></div><div class="muted">' + esc(row.usagePercent) + '%</div></td><td><input class="compact-input" type="number" min="0" value="' + esc(row.quotaSlots) + '" data-quota-value></td><td><button data-quota-save>保存</button></td></tr>'
      ), '没有仓库额度。');
    }

    async function loadAdminCurrent() {
      if (!state.user?.isAdmin) return;
      if (state.adminTab === 'inventory') return loadAdminInventory();
      if (state.adminTab === 'warehouses') return loadAdminWarehouseProvisioning();
      if (state.adminTab === 'mismatches') return loadAdminMismatches();
      if (state.adminTab === 'chests') return Promise.resolve();
      if (state.adminTab === 'transactions') return loadAdminTransactions();
      if (state.adminTab === 'aliases') return loadAdminAliases();
      if (state.adminTab === 'quotas') return loadAdminQuotas();
    }

    function setAdminTab(tab) {
      if (tab !== 'inventory' && state.adminAliasMode) setAdminAliasMode(false);
      state.adminTab = tab;
      document.querySelectorAll('[data-admin-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.adminTab === tab));
      $('adminInventory').classList.toggle('hidden', tab !== 'inventory');
      $('adminWarehouses').classList.toggle('hidden', tab !== 'warehouses');
      $('adminMismatches').classList.toggle('hidden', tab !== 'mismatches');
      $('adminChests').classList.toggle('hidden', tab !== 'chests');
      $('adminTransactions').classList.toggle('hidden', tab !== 'transactions');
      $('adminAliases').classList.toggle('hidden', tab !== 'aliases');
      $('adminQuotas').classList.toggle('hidden', tab !== 'quotas');
      loadAdminCurrent().catch(error => toast(error.message));
    }

    function setView(view) {
      if (view === 'admin' && !state.user?.isAdmin) return toast('只有管理员可以打开管理界面。');
      if (view === 'warehouseAdmin' && !state.user?.isWarehouseAdmin) return toast('你不是任何组织仓库的仓库管理员。');
      state.view = view;
      document.querySelectorAll('.navbtn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
      $('inventoryView').classList.toggle('hidden', view !== 'inventory');
      $('inventoryHero').classList.toggle('hidden', view !== 'inventory');
      $('transactionsView').classList.toggle('hidden', view !== 'transactions');
      $('myView').classList.toggle('hidden', view !== 'my');
      $('warehouseAdminView').classList.toggle('hidden', view !== 'warehouseAdmin');
      $('helpView').classList.toggle('hidden', view !== 'help');
      $('adminView').classList.toggle('hidden', view !== 'admin');
      if (view === 'transactions') loadTransactions().catch(error => toast(error.message));
      if (view === 'my') loadMyCurrent().catch(error => toast(error.message));
      if (view === 'warehouseAdmin') loadWarehouseAdminOrganizations().catch(error => toast(error.message));
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
    $('txLoad').addEventListener('click', () => { state.txPage = 1; loadTransactions().catch(error => toast(error.message)); });
    $('txRefresh').addEventListener('click', event => {
      runButtonTask(event.currentTarget, '刷新中...', '交易记录已刷新', () => loadTransactions()).catch(error => toast(error.message));
    });
    $('txOwner').addEventListener('change', () => { state.txPage = 1; loadTransactions().catch(error => toast(error.message)); });
    $('txPrev').addEventListener('click', () => { if (state.txPage > 1) state.txPage--; loadTransactions().catch(error => toast(error.message)); });
    $('txNext').addEventListener('click', () => { if (state.txPage < state.txTotalPages) state.txPage++; loadTransactions().catch(error => toast(error.message)); });
    $('adminRefresh').addEventListener('click', event => {
      runButtonTask(event.currentTarget, '刷新中...', '管理数据已刷新', () => loadAdminCurrent()).catch(error => toast(error.message));
    });
    $('adminInvLoad').addEventListener('click', () => loadAdminInventory({ owner: $('adminInvOwner').value }).catch(error => toast(error.message)));
    $('adminInvOwner').addEventListener('change', event => loadAdminInventory({ owner: event.currentTarget.value }).catch(error => toast(error.message)));
    $('adminMmLoad').addEventListener('click', () => loadAdminMismatches().catch(error => toast(error.message)));
    $('adminTransferRun').addEventListener('click', () => runAdminTransfer().catch(error => toast(error.message)));
    $('adminAliasMode').addEventListener('click', () => setAdminAliasMode(!state.adminAliasMode));
    $('globalAliasSave').addEventListener('click', () => saveGlobalAliasFromModal().catch(error => toast(error.message)));
    $('globalAliasInput').addEventListener('keydown', event => { if (event.key === 'Enter') saveGlobalAliasFromModal().catch(error => toast(error.message)); });
    $('adminPersonalWarehouseCreate').addEventListener('click', () => createAdminPersonalWarehouse().catch(error => toast(error.message)));
    $('adminOrganizationWarehouseCreate').addEventListener('click', () => createAdminOrganizationWarehouse().catch(error => toast(error.message)));
    $('adminTxLoad').addEventListener('click', () => { state.adminTxPage = 1; loadAdminTransactions().catch(error => toast(error.message)); });
    $('adminTxPrev').addEventListener('click', () => { if (state.adminTxPage > 1) state.adminTxPage--; loadAdminTransactions().catch(error => toast(error.message)); });
    $('adminTxNext').addEventListener('click', () => { if (state.adminTxPage < state.adminTxTotalPages) state.adminTxPage++; loadAdminTransactions().catch(error => toast(error.message)); });
    $('adminAliasLoad').addEventListener('click', () => loadAdminAliases().catch(error => toast(error.message)));
    $('adminQuotaLoad').addEventListener('click', () => loadAdminQuotas().catch(error => toast(error.message)));
    $('myRefresh').addEventListener('click', () => loadMyCurrent().catch(error => toast(error.message)));
    $('warehouseAdminRefresh').addEventListener('click', () => loadWarehouseAdminOrganizations().catch(error => toast(error.message)));
    $('myAliasLoad').addEventListener('click', () => loadMyAliases().catch(error => toast(error.message)));
    $('nbtClose').addEventListener('click', closeNbtModal);
    $('nbtCopy').addEventListener('click', () => copyNbtModal().catch(error => toast(error.message)));
    $('aliasSave').addEventListener('click', () => savePersonalAlias().catch(error => toast(error.message)));
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
    document.querySelectorAll('[data-my-tab]').forEach(btn => btn.addEventListener('click', () => setMyTab(btn.dataset.myTab)));
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
      const adminCard = event.target.closest('#adminInvGrid [data-admin-card]');
      const adminPickRemove = event.target.closest('[data-admin-pick-remove]');
      const adminPickClear = event.target.closest('[data-admin-pick-clear]');
      const mmDeduct = event.target.closest('[data-admin-mm-deduct]');
      const mmResolve = event.target.closest('[data-admin-mm-resolve]');
      const aliasSave = event.target.closest('[data-admin-alias-save]');
      const aliasDetailSave = event.target.closest('[data-admin-alias-detail-save]');
      const aliasDelete = event.target.closest('[data-admin-alias-delete]');
      const adminAliasCard = event.target.closest('[data-admin-alias-card]');
      const quotaSave = event.target.closest('[data-quota-save]');
      const personalAliasDelete = event.target.closest('[data-personal-alias-delete]');
      const myAliasAdd = event.target.closest('[data-my-alias-add]');
      const myPersonalAliasCard = event.target.closest('[data-my-personal-alias-card]');
      const myGlobalAliasCard = event.target.closest('[data-my-global-alias-card]');
      const globalAliasToggle = event.target.closest('[data-global-alias-toggle]');
      const orgRename = event.target.closest('[data-org-rename]');
      const orgMemberAdd = event.target.closest('[data-org-member-add]');
      const orgMemberRemove = event.target.closest('[data-org-member-remove]');
      const adminOrgView = event.target.closest('[data-admin-org-view]');
      const adminOrgMemberAdd = event.target.closest('[data-admin-org-member-add]');
      const adminOrgMemberRemove = event.target.closest('[data-admin-org-member-remove]');
      const adminPersonalDelete = event.target.closest('[data-admin-personal-delete]');
      const adminOrgDelete = event.target.closest('[data-admin-org-delete]');
      try {
        if (adminPickRemove) {
          state.adminSelected.delete(adminPickRemove.closest('[data-admin-pick]').dataset.adminPick);
          renderAdminTransferSelection();
          loadAdminInventorySelectionState();
        } else if (adminPickClear) {
          state.adminSelected.clear();
          renderAdminTransferSelection();
          loadAdminInventorySelectionState();
        } else if (personalAliasDelete) {
          const alias = personalAliasDelete.dataset.personalAliasDelete;
          const data = await post('/api/item-alias/delete', { alias });
          toast(data.message);
          if (state.aliasItem) {
            state.aliasItem.personalAliases = (state.aliasItem.personalAliases || []).filter(name => name.toLowerCase() !== alias.toLowerCase());
            applyAliasToLocalItem(state.aliasItem.itemKey, state.aliasItem.personalAliases);
            openAliasModal(state.items.find(item => item.itemKey === state.aliasItem.itemKey) || state.aliasItem);
          }
          state.inventoryCache.clear();
          if (state.owner) await loadInventory({ force: true });
          if (state.view === 'my' && state.myTab === 'aliases') await loadMyAliases();
        } else if (myAliasAdd) {
          const row = myAliasAdd.closest('[data-item]');
          const alias = row.querySelector('[data-my-alias-input]').value;
          const data = await post('/api/item-alias/save', { itemKey: row.dataset.item, displayName: alias });
          toast(data.message);
          state.inventoryCache.clear();
          if (state.owner) await loadInventory({ force: true });
          await loadMyAliases();
        } else if (myPersonalAliasCard) {
          const row = state.myPersonalAliasRows?.get(myPersonalAliasCard.dataset.myPersonalAliasCard);
          if (row) renderMyPersonalAliasDetail(row);
        } else if (myGlobalAliasCard) {
          const row = state.myGlobalAliasRows?.get(myGlobalAliasCard.dataset.myGlobalAliasCard);
          if (row) renderMyGlobalAliasDetail(row);
        } else if (globalAliasToggle) {
          const enabled = globalAliasToggle.dataset.enabled !== '1';
          const data = await post('/api/my/global-alias/toggle', { alias: globalAliasToggle.dataset.globalAliasToggle, enabled });
          toast(data.message);
          state.inventoryCache.clear();
          if (state.owner) await loadInventory({ force: true });
          await loadMyAliases();
        } else if (adminOrgView) {
          await loadAdminOrganizationDetail(adminOrgView.dataset.adminOrgView);
        } else if (adminOrgMemberAdd) {
          const card = adminOrgMemberAdd.closest('[data-admin-org-detail]');
          const data = await post('/api/admin/organization-warehouse/member/add', {
            warehouse: card.dataset.adminOrgDetail,
            username: card.querySelector('[data-admin-org-add-name]').value,
            role: card.querySelector('[data-admin-org-add-role]').value
          });
          toast(data.message); await loadAdminWarehouseProvisioning();
        } else if (adminOrgMemberRemove) {
          const card = adminOrgMemberRemove.closest('[data-admin-org-detail]');
          const member = adminOrgMemberRemove.closest('[data-admin-org-member]');
          if (!confirm('确认从这个组织仓库删除该成员吗？系统管理员可以删除包括首位管理员在内的任意成员。')) return;
          const data = await post('/api/admin/organization-warehouse/member/remove', { warehouse: card.dataset.adminOrgDetail, playerUuid: member.dataset.adminOrgMember });
          toast(data.message); await loadAdminWarehouseProvisioning();
        } else if (adminPersonalDelete) {
          const ownerUuid = adminPersonalDelete.dataset.adminPersonalDelete;
          const ownerName = adminPersonalDelete.dataset.ownerName;
          if (!confirm('确认删除 ' + ownerName + ' 的个人仓库吗？该仓库全部库存会转入 momo，此操作不可撤销。')) return;
          const data = await post('/api/admin/personal-warehouse/delete', { ownerUuid, confirmOwnerUuid: ownerUuid });
          toast(data.message); state.adminOwners = []; state.owners = []; state.inventoryCache.clear();
          const me = await api('/api/me'); state.owners = me.owners || []; state.defaultOwnerUuid = me.defaultOwnerUuid; renderOwners();
          await loadAdminWarehouseProvisioning();
        } else if (adminOrgDelete) {
          const card = adminOrgDelete.closest('[data-admin-org-detail]');
          const warehouse = card.dataset.adminOrgDetail;
          const confirmation = prompt('删除组织仓库会把全部库存转入 momo。请输入仓库名 “' + warehouse + '” 确认删除：');
          if (confirmation === null) return;
          const data = await post('/api/admin/organization-warehouse/delete', { warehouse, confirmName: confirmation });
          toast(data.message); state.adminOrganizationName = ''; state.adminOwners = []; state.owners = []; state.inventoryCache.clear();
          const me = await api('/api/me'); state.owners = me.owners || []; state.defaultOwnerUuid = me.defaultOwnerUuid; renderOwners();
          await loadAdminWarehouseProvisioning();
        } else if (orgRename) {
          const card = orgRename.closest('[data-warehouse]');
          const data = await post('/api/warehouse-admin/rename', { warehouse: card.dataset.warehouse, newName: card.querySelector('[data-org-new-name]').value });
          toast(data.message);
          state.owners = [];
          state.inventoryCache.clear();
          const me = await api('/api/me'); state.owners = me.owners || []; state.defaultOwnerUuid = me.defaultOwnerUuid; renderOwners();
          await loadWarehouseAdminOrganizations();
        } else if (orgMemberAdd) {
          const card = orgMemberAdd.closest('[data-warehouse]');
          const data = await post('/api/warehouse-admin/member/add', { warehouse: card.dataset.warehouse, username: card.querySelector('[data-org-add-name]').value });
          toast(data.message); await loadWarehouseAdminOrganizations();
        } else if (orgMemberRemove) {
          const card = orgMemberRemove.closest('[data-warehouse]');
          const member = orgMemberRemove.closest('[data-member]');
          if (!confirm('确认删除这个仓库成员吗？')) return;
          const data = await post('/api/warehouse-admin/member/remove', { warehouse: card.dataset.warehouse, playerUuid: member.dataset.member });
          toast(data.message); await loadWarehouseAdminOrganizations();
        } else if (mmDeduct) {
          const ok = confirm('确认清除这条缺失物品对应的账本库存吗？');
          if (!ok) return;
          const data = await post('/api/admin/mismatch/deduct', { id: mmDeduct.dataset.adminMmDeduct });
          toast(data.message);
          await loadAdminMismatches();
        } else if (mmResolve) {
          const card = mmResolve.closest('[data-admin-card]');
          const targetOwnerUuid = card.querySelector('[data-mm-target]').value;
          if (!targetOwnerUuid) throw new Error('请选择多余物品要转入的目标仓库。');
          const data = await post('/api/admin/mismatch/resolve', { id: mmResolve.dataset.adminMmResolve, targetOwnerUuid });
          toast(data.message);
          await loadAdminMismatches();
        } else if (aliasDetailSave) {
          if (!state.adminAliasItem) throw new Error('请先选择物品。');
          const input = $('adminAliasDetailInput');
          const data = await post('/api/admin/alias/save', { itemKey: state.adminAliasItem.itemKey, alias: input.value, updateDisplayName: $('adminAliasDetailUseDisplayName').checked });
          toast(data.message);
          await loadAdminAliases();
        } else if (aliasSave) {
          const row = aliasSave.closest('.alias-row');
          const input = row.querySelector('[data-admin-alias-input]');
          const data = await post('/api/admin/alias/save', { itemKey: row.dataset.item, alias: input.value });
          toast(data.message);
          await loadAdminAliases();
        } else if (aliasDelete) {
          const deletedAlias = aliasDelete.dataset.adminAliasDelete;
          const data = await post('/api/admin/alias/delete', { alias: deletedAlias });
          toast(data.message);
          if (state.adminGlobalAliasItem) {
            state.adminGlobalAliasItem.globalAliases = (state.adminGlobalAliasItem.globalAliases || []).filter(alias => alias.toLowerCase() !== deletedAlias.toLowerCase());
            openGlobalAliasModal(state.adminGlobalAliasItem);
            await loadAdminInventory();
          } else {
            await loadAdminAliases();
          }
        } else if (adminAliasCard) {
          const row = state.adminAliasRows?.get(adminAliasCard.dataset.adminAliasCard);
          if (row) renderAdminAliasDetail(row);
        } else if (quotaSave) {
          const row = quotaSave.closest('tr');
          const data = await post('/api/admin/quota/save', { ownerUuid: row.dataset.owner, quotaSlots: row.querySelector('[data-quota-value]').value });
          toast(data.message);
          await loadAdminQuotas();
        } else if (adminCard) {
          const key = adminCard.dataset.adminCard;
          const row = state.adminInventoryRows.get(key);
          if (!row) return;
          if (state.adminAliasMode) {
            openGlobalAliasModal(row);
            return;
          }
          if (state.adminSelected.has(key)) {
            state.adminSelected.delete(key);
          } else {
            state.adminSelected.set(key, { ...row, selectionKey: key, selectedAmount: Math.max(1, Math.min(Number(row.amount || 1), 64)) });
          }
          adminCard.classList.toggle('selected', state.adminSelected.has(key));
          renderAdminTransferSelection();
        }
      } catch (error) {
        toast(error.message);
      }
    });

    document.addEventListener('change', async event => {
      const adminAmount = event.target.closest('[data-admin-pick-amount]');
      if (adminAmount) {
        const key = adminAmount.closest('[data-admin-pick]').dataset.adminPick;
        const row = state.adminSelected.get(key);
        if (row) {
          row.selectedAmount = Math.max(1, Math.min(Number(row.amount || 1), Number.parseInt(adminAmount.value, 10) || 1));
          adminAmount.value = row.selectedAmount;
        }
        return;
      }
      const adminRoleSelect = event.target.closest('[data-admin-org-role]');
      if (adminRoleSelect) {
        try {
          const card = adminRoleSelect.closest('[data-admin-org-detail]');
          const member = adminRoleSelect.closest('[data-admin-org-member]');
          const data = await post('/api/admin/organization-warehouse/member/role', { warehouse: card.dataset.adminOrgDetail, playerUuid: member.dataset.adminOrgMember, role: adminRoleSelect.value });
          toast(data.message);
          await loadAdminOrganizationDetail(card.dataset.adminOrgDetail);
        } catch (error) {
          toast(error.message);
          if (state.adminOrganizationName) await loadAdminOrganizationDetail(state.adminOrganizationName).catch(() => {});
        }
        return;
      }
      const roleSelect = event.target.closest('[data-member-role]');
      if (!roleSelect) return;
      try {
        const card = roleSelect.closest('[data-warehouse]');
        const member = roleSelect.closest('[data-member]');
        const data = await post('/api/warehouse-admin/member/role', { warehouse: card.dataset.warehouse, playerUuid: member.dataset.member, role: roleSelect.value });
        toast(data.message);
        await loadWarehouseAdminOrganizations();
      } catch (error) {
        toast(error.message);
        await loadWarehouseAdminOrganizations().catch(() => {});
      }
    });

    loadMe().catch(error => toast(error.message));
  </script>
</body>
</html>`

module.exports = CloudStoreWebServer

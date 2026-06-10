const { clampInt, sleep, sumBy } = require('./utils')

class CloudStoreService {
  constructor (bot, db, catalog, warehouse, config) {
    this.bot = bot
    this.db = db
    this.catalog = catalog
    this.warehouse = warehouse
    this.config = config
    this.active = null
    this.deathContext = null
    this.recoveringFromDeath = false
    this.seenMessages = new Map()
    this.webAuth = null
    this.accountedResidual = new Map()
  }

  setWebAuth (webAuth) {
    this.webAuth = webAuth
  }

  start () {
    this.bot.on('chat', (username, message) => {
      if (username === this.bot.username) return
      this.handleIncoming(username, message, 'chat')
    })

    this.bot.on('whisper', (username, message) => {
      if (username === this.bot.username) return
      this.handleIncoming(username, message, 'whisper')
    })

    this.bot.on('messagestr', (message, position, originalMessage, sender) => {
      this.handleMessageString(message, position, sender)
    })

    this.bot._client.on('player_chat', packet => {
      this.handlePlayerChatPacket(packet)
    })

    this.bot._client.on('system_chat', packet => {
      this.handleSystemChatPacket(packet)
    })

    this.bot.on('death', () => {
      this.handleDeath()
    })

    this.bot.on('respawn', () => {
      this.handleRespawn().catch(error => {
        console.error('[death-recovery] failed:', error)
      })
    })
  }

  handleDeath () {
    console.warn(`[death] bot died. active=${this.active ? `${this.active.type}:${this.active.username}:${this.active.phase || ''}` : 'none'}`)
    if (this.active) {
      this.active.dead = true
      this.active.cancelled = true
      this.deathContext = { ...this.active }
    } else {
      this.deathContext = { type: 'idle', username: '', player: null, phase: 'idle' }
    }
    this.bot.pathfinder?.stop()
    this.bot.clearControlStates()
  }

  async handleRespawn () {
    if (!this.deathContext || this.recoveringFromDeath) return
    this.recoveringFromDeath = true
    const context = this.deathContext
    this.deathContext = null

    try {
      await sleep(1500)
      console.log(`[death-recovery] respawned, going home. context=${context.type}:${context.username || ''}:${context.phase || ''}`)
      await this.warehouse.goHome()

      if (context.type === 'deposit' && (context.owner || context.player)) {
        const owner = context.owner || context.player
        const result = await this.warehouse.depositInventoryForOwner(owner.uuid, owner.username)
        if (result.deposited.length) {
          this.msg(context.username, `机器人死亡后已回仓库，已继续存入${this.ownerScopeName(owner)}：${this.formatItemList(result.deposited)}`)
        } else {
          this.msg(context.username, '机器人死亡后已回仓库，但背包里没有可继续入库的物品。')
        }
        if (result.leftover.length) {
          this.accountResidualAsMomo(result.leftover, `death deposit leftover, actor=${context.username}, owner=${owner.uuid}`)
          this.msg(context.username, `仓库空间不足，剩余物品已转记为 momo，避免影响下一个玩家：${this.formatItemList(result.leftover)}`)
        }
      } else if (context.type === 'withdraw') {
        const result = await this.warehouse.depositInventoryWithoutBalance('withdraw_death_recovery', `player=${context.username}, phase=${context.phase || ''}`)
        if (context.username) {
          this.msg(context.username, '机器人取物品过程中死亡，本次取物品已终止；身上剩余物品已回收入库，不会扣除未交付数量。')
        }
        if (result.leftover.length && context.username) {
          this.msg(context.username, `仓库空间不足，仍有物品留在机器人身上：${this.formatItemList(result.leftover)}`)
        }
      }

      if (this.active?.dead) this.active = null
    } finally {
      this.recoveringFromDeath = false
    }
  }

  handlePlayerChatPacket (packet) {
    const username = this.usernameFromUuid(packet.senderUuid)
    const message = packet.plainMessage || this.componentToText(packet.unsignedChatContent)
    if (this.config.debugRawChat) {
      console.log(`[packet:player_chat] uuid=${packet.senderUuid} username=${username || '?'} plain=${message}`)
    }
    if (!username || !message || this.isSelfUsername(username)) return
    this.handleIncoming(username, message, 'packet:player_chat')
  }

  handleSystemChatPacket (packet) {
    const message = this.componentToText(packet.content)
    if (this.config.debugRawChat && message) {
      console.log(`[packet:system_chat] actionBar=${packet.isActionBar} text=${message}`)
    }
    if (!message) return
    const parsed = this.parseCustomCommandMessage(message, null)
    if (!parsed) return
    this.handleIncoming(parsed.username, parsed.command, 'packet:system_chat')
  }

  handleIncoming (username, message, source, context = {}) {
    if (this.isSelfUsername(username)) {
      if (this.config.debugRawChat) console.log(`[chat:${source}] ignored self message: ${username}: ${message}`)
      return
    }
    if (this.config.debugRawChat) console.log(`[chat:${source}] ${username}: ${message}`)

    const commandMessage = this.normalizePrivateCommandText(message, source)
    if (this.isDuplicateCommand(username, commandMessage, source)) return
    this.handleChat(username, commandMessage, { ...context, source }).catch(error => this.handleCommandError(username, error))
  }

  isDuplicateCommand (username, message, source) {
    const text = this.normalizeCommandText(message)
    if (!text.startsWith('!')) return false

    const key = `${username.toLowerCase()}|${text}`
    const now = Date.now()
    const last = this.seenMessages.get(key) || 0
    const dedupeMs = this.config.timing.commandDedupeMs || 1500
    if (now - last < dedupeMs) {
      if (this.config.debugChat) console.log(`[command:dedupe] ignored duplicate from ${source}: ${username} -> ${this.redactSensitiveText(text)}`)
      return true
    }

    this.seenMessages.set(key, now)
    return false
  }

  handleMessageString (message, position, sender) {
    if (this.config.debugRawChat) {
      const senderInfo = sender ? ` sender=${sender}` : ''
      console.log(`[messagestr:${position}]${senderInfo} ${message}`)
    }

    if (this.handleTeleportRequestMessage(message)) return

    const whisper = this.parsePrivateMessage(message)
    if (whisper) {
      this.handleIncoming(whisper.username, whisper.message, 'messagestr:private')
      return
    }

    const parsed = this.parseCustomCommandMessage(message, sender)
    if (!parsed) return
    this.handleIncoming(parsed.username, parsed.command, 'messagestr')
  }

  parsePrivateMessage (message) {
    const text = String(message || '').trim()
    const patterns = [
      /^\[([A-Za-z0-9_]{3,16})\s*[➥➦➤➜→>\-]+\s*([A-Za-z0-9_]{3,16})\]\s*(.+)$/,
      /^\[([A-Za-z0-9_]{3,16})\s*->\s*([A-Za-z0-9_]{3,16})\]\s*(.+)$/,
      /^([A-Za-z0-9_]{3,16})\s+悄悄地对你说[:：]\s*(.+)$/,
      /^([A-Za-z0-9_]{3,16})\s+whispers(?: to you)?[:：]?\s*(.+)$/i
    ]

    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (!match) continue
      if (match.length === 4) {
        const [, from, to, body] = match
        if (this.isSelfUsername(from)) return null
        if (to !== this.bot.username) return null
        return { username: from, message: this.normalizeCommandText(body) }
      }
      const [, from, body] = match
      if (this.isSelfUsername(from)) return null
      return { username: from, message: this.normalizeCommandText(body) }
    }

    return null
  }

  parseCustomCommandMessage (message, sender) {
    if (this.isOutgoingPrivateMessage(message)) return null

    const commandMatch = this.findCommandAtChatBodyStart(message)
    if (!commandMatch) return null

    const command = this.normalizeCommandText(commandMatch.command)
    const beforeCommand = message.slice(0, commandMatch.index)
    const username = this.extractUsername(beforeCommand, sender)
    if (!username || this.isSelfUsername(username)) return null

    const key = `${username}|${command}|${message}`
    const now = Date.now()
    const last = this.seenMessages.get(key) || 0
    if (now - last < 1000) return null
    this.seenMessages.set(key, now)

    return { username, command }
  }

  handleTeleportRequestMessage (message) {
    const text = String(message || '').trim()
    const match = text.match(/^([A-Za-z0-9_]{3,16})\s+请求传送到你的位置$/)
    if (!match) return false

    const username = match[1]
    if (!this.isAdmin(username)) {
      if (this.config.debugChat) console.log(`[tpa] ignored non-admin teleport request from ${username}`)
      return true
    }

    const command = (this.config.commands.tpaccept || '/tpaccept {player}').replace('{player}', username)
    if (this.config.debugChat) console.log(`[tpa] accepting admin teleport request: ${command}`)
    this.bot.chat(command)
    return true
  }

  findCommandAtChatBodyStart (message) {
    const text = String(message || '')
    const commandPattern = /^\s*([!！][^\r\n]*)/

    const direct = text.match(commandPattern)
    if (direct) {
      return {
        command: direct[1],
        index: direct.index + direct[0].indexOf(direct[1])
      }
    }

    const arrowIndex = Math.max(text.lastIndexOf('>'), text.lastIndexOf('»'))
    if (arrowIndex >= 0) {
      const afterArrow = text.slice(arrowIndex + 1)
      const match = afterArrow.match(commandPattern)
      if (!match) return null
      return {
        command: match[1],
        index: arrowIndex + 1 + match.index + match[0].indexOf(match[1])
      }
    }

    const colonIndexes = [text.indexOf(':'), text.indexOf('：')].filter(index => index >= 0)
    if (!colonIndexes.length) return null
    const colonIndex = Math.min(...colonIndexes)
    const afterColon = text.slice(colonIndex + 1)
    const match = afterColon.match(commandPattern)
    if (!match) return null
    return {
      command: match[1],
      index: colonIndex + 1 + match.index + match[0].indexOf(match[1])
    }
  }

  isOutgoingPrivateMessage (message) {
    const text = String(message || '').trim()
    const match = text.match(/^\[([A-Za-z0-9_]{3,16})\s*[➥➦➤➜→>\-]+\s*([A-Za-z0-9_]{3,16})\]/)
    if (!match) return false
    const [, from, to] = match
    return this.isSelfUsername(from) || !this.isSelfUsername(to)
  }

  extractUsername (text, sender) {
    if (sender) {
      const player = Object.values(this.bot.players).find(entry => entry.uuid === sender)
      if (player?.username) return player.username
    }

    const names = Object.keys(this.bot.players)
      .filter(name => name !== this.bot.username)
      .sort((a, b) => b.length - a.length)

    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(text)) {
        return name
      }
    }

    const fallback = text.match(/([A-Za-z0-9_]{3,16})\s*[:：>»]?\s*$/)
    return fallback?.[1] || null
  }

  usernameFromUuid (uuid) {
    if (!uuid) return null
    const normalized = String(uuid).toLowerCase()
    for (const [username, player] of Object.entries(this.bot.players)) {
      if (String(player.uuid || '').toLowerCase() === normalized) return username
    }
    return null
  }

  componentToText (component) {
    if (!component) return ''
    if (typeof component === 'string') {
      try {
        return this.componentToText(JSON.parse(component))
      } catch {
        return component
      }
    }
    if (Array.isArray(component)) return component.map(part => this.componentToText(part)).join('')
    if (component.type && Object.prototype.hasOwnProperty.call(component, 'value')) {
      return this.componentToText(component.value)
    }
    if (typeof component !== 'object') return String(component)

    let text = ''
    if (typeof component.text === 'string') text += component.text
    if (component.text?.value) text += component.text.value
    if (typeof component.translate === 'string') text += component.translate
    if (component.translate?.value) text += component.translate.value

    const extra = component.extra || component.with
    if (Array.isArray(extra)) text += extra.map(part => this.componentToText(part)).join('')
    if (extra?.value && Array.isArray(extra.value)) text += extra.value.map(part => this.componentToText(part)).join('')

    return text
  }

  handleCommandError (username, error) {
    if (error?.silent) {
      if (this.config.debug) console.warn(`[command:silent-cancel] ${username}: ${error.message}`)
      this.active = null
      return
    }
    console.error(error)
    if (this.active?.type === 'withdraw' && this.active.targetUsername && this.active.targetUsername !== username) {
      this.msg(this.active.targetUsername, `${username} 给你的取货失败：${error.message}`)
    } else {
      this.msg(username, `操作失败：${error.message}`)
    }
    this.active = null
  }

  async handleChat (username, message, context = {}) {
    const text = this.normalizeCommandText(message)
    if (!text.startsWith('!')) return
    if (this.config.debugChat) console.log(`[command] ${username} -> ${this.redactSensitiveText(text)}`)
    this.touchPlayer(username)

    if (this.isWebLoginTokenCommand(text)) {
      await this.handleWebLoginToken(username, text, context)
      return
    }

    if (text === '!完成' || text === '!结束') {
      if (this.active?.type === 'deposit' && this.active.username === username) {
        this.active.finished = true
        this.msg(username, '已收到结束指令，正在回仓库入库。')
      }
      return
    }

    if (text.startsWith('!创建仓库')) {
      await this.handleCreateCustomWarehouse(username, text)
      return
    }

    if (text === '!我的仓库') {
      await this.handleMyCustomWarehouses(username)
      return
    }

    const customCommand = this.parseCustomWarehouseCommand(text)
    if (customCommand) {
      await this.handleCustomWarehouseCommand(username, customCommand)
      return
    }

    if (text.startsWith('!查询') || text.startsWith('!查')) {
      await this.handleQuery(username, text)
      return
    }

    if (text.startsWith('!额度')) {
      await this.handleQuota(username, text)
      return
    }

    if (text.startsWith('!加管理员') || text.startsWith('!加管理')) {
      await this.handleAddAdmin(username, text)
      return
    }

    if (text.startsWith('!设置额度')) {
      await this.handleSetQuota(username, text)
      return
    }

    if (text.startsWith('!增加') || text.startsWith('!减少')) {
      await this.handleAdjustBalance(username, text)
      return
    }

    if (text.startsWith('!清空库存') || text.startsWith('!清理库存')) {
      await this.handleClearInventory(username, text)
      return
    }

    if (text.startsWith('!同步仓库') || text.startsWith('!同步')) {
      await this.handleSync(username, text)
      return
    }

    if (this.active) {
      this.msg(username, `机器人忙，玩家${this.active.username}使用中，请稍后再试。`)
      return
    }

    if (text === '!存物品' || text === '!存') {
      await this.runExclusive(username, 'deposit', () => this.handleDeposit(username))
      return
    }

    if (text.startsWith('!取物品') || text.startsWith('!取')) {
      await this.runExclusive(username, 'withdraw', () => this.handleWithdraw(username, text))
    }
  }

  async runExclusive (username, type, fn) {
    this.active = { type, username, finished: false, cancelled: false, dead: false, phase: 'start', player: null }
    try {
      await fn()
    } finally {
      this.active = null
    }
  }

  startWebDeposit (user, ownerUuid) {
    const owner = this.resolveWebStorageOwner(user, ownerUuid)
    if (this.active) {
      throw new Error(`机器人忙，玩家${this.active.username}使用中，请稍后再试。`)
    }
    this.runExclusive(user.username, 'deposit', () => this.handleDeposit(user.username, owner))
      .catch(error => this.handleCommandError(user.username, error))
    return `已开始准备存入${this.ownerScopeName(owner)}，请在游戏内接受传送请求。`
  }

  startWebWithdraw (user, ownerUuid, itemText, amount, targetUsername = '') {
    return this.startWebWithdrawMany(user, ownerUuid, [{ item: itemText, amount }], targetUsername)
  }

  startWebWithdrawMany (user, ownerUuid, webRequests, targetUsername = '') {
    const owner = this.resolveWebStorageOwner(user, ownerUuid)
    if (!Array.isArray(webRequests) || !webRequests.length) throw new Error('请先选择要取出的物品。')
    if (this.active) {
      throw new Error(`机器人忙，玩家${this.active.username}使用中，请稍后再试。`)
    }
    const target = String(targetUsername || user.username || '').trim()
    if (!/^[A-Za-z0-9_]{3,16}$/.test(target)) throw new Error('目标玩家 ID 格式不正确。')

    const requests = webRequests.map(entry => {
      const count = Number.parseInt(entry.amount, 10)
      if (!Number.isFinite(count) || count <= 0) throw new Error('取出数量必须是大于 0 的整数。')
      let resolved = null
      if (entry.itemKey) {
        const item = this.db.getItemByKey(entry.itemKey)
        if (!item) throw new Error(`找不到物品：${entry.itemKey}`)
        resolved = item
      } else {
        const item = String(entry.item || '').trim()
        if (!item) throw new Error('请填写要取出的物品。')
        resolved = this.resolveStoredItem(item)
      }
      return { ...resolved, amount: count }
    })

    this.runExclusive(user.username, 'withdraw', () => this.handleWithdraw(user.username, '', owner, requests, target))
      .catch(error => this.handleCommandError(user.username, error))
    return target === user.username
      ? `已开始准备从${this.ownerScopeName(owner)}取出 ${requests.length} 种物品，请在游戏内接受传送请求。`
      : `已开始准备从${this.ownerScopeName(owner)}取出 ${requests.length} 种物品，并交给 ${target}。`
  }

  resolveWebStorageOwner (user, ownerUuid) {
    const owner = String(ownerUuid || user.uuid || '').trim()
    if (!owner) throw new Error('缺少仓库归属。')
    if (!this.db.canWebUserAccessOwner(user, owner)) {
      throw new Error('你没有权限操作这个仓库。')
    }
    if (owner.startsWith('vault:')) {
      const warehouse = this.db.getCustomWarehouse(owner.slice(6))
      if (!warehouse) throw new Error(`找不到自定义仓库：${owner}`)
      return this.resolveCustomWarehouseOwner(warehouse)
    }
    if (owner === user.uuid) {
      return { uuid: user.uuid, username: user.username, scope: 'personal' }
    }
    const player = [...Object.keys(this.bot.players)]
      .find(name => this.bot.players[name]?.uuid === owner)
    const known = player ? this.resolvePlayer(player) : null
    const username = known?.username || this.db.ownerLabel(owner)
    return { uuid: owner, username, scope: 'personal' }
  }

  async handleDeposit (username, owner = null) {
    const player = this.getPlayer(username)
    const storageOwner = owner || { ...player, scope: 'personal' }
    let sessionLogged = false
    const logSession = (status, items = [], extra = {}) => {
      if (sessionLogged) return
      sessionLogged = true
      this.logDepositSession(username, storageOwner, status, items, extra)
    }
    const logCancelledSession = () => {
      const held = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
      logSession('cancelled', held, {
        phase: this.active?.phase || 'unknown',
        reason: this.active?.dead ? 'death' : 'cancelled'
      })
    }

    if (this.active) {
      this.active.player = player
      this.active.owner = storageOwner
      this.active.phase = 'prepare_deposit'
    }
    try {
      this.msg(username, `准备存入${this.ownerScopeName(storageOwner)}，请稍等。`)
      await this.warehouse.goHome()
      if (this.isActiveCancelled()) {
        logCancelledSession()
        return
      }
      await this.flushResidual()
      if (this.isActiveCancelled()) {
        logCancelledSession()
        return
      }

      const quota = this.getStorageQuota(storageOwner.uuid, storageOwner.scope)
      if (quota.usedSlots >= quota.quotaSlots) {
        logSession('quota_full', [], {
          phase: this.active?.phase || 'quota_check',
          usedSlots: quota.usedSlots,
          quotaSlots: quota.quotaSlots
        })
        this.msg(username, `${this.ownerSubjectName(storageOwner)}额度已满：${quota.usedSlots}/${quota.quotaSlots} 格。请先取出一些物品。`)
        return
      }

      if (this.active) this.active.phase = 'deposit_teleport_to_player'
      const teleported = await this.teleportToPlayer(username)
      if (!teleported) {
        logSession('teleport_timeout', [], {
          phase: this.active?.phase || 'deposit_teleport_to_player',
          timeoutMs: this.config.timing.teleportRequestTimeoutMs || 15000
        })
        return
      }
      if (this.isActiveCancelled()) {
        logCancelledSession()
        return
      }
      if (this.active) this.active.phase = 'deposit_collecting'
      this.msg(username, '开始收集物品，请在10秒内丢给我；输入!完成或!结束可提前结束。')

      const deadline = Date.now() + this.config.timing.pickupWindowMs
      if (this.config.debug) console.log(`[deposit] collecting for ${username}, window=${this.config.timing.pickupWindowMs}ms`)
      await this.warehouse.collectNearbyDropsUntil(deadline, () => this.active?.finished || this.active?.cancelled)
      if (this.config.debug) console.log(`[deposit] collect window ended for ${username}, cancelled=${this.active?.cancelled}, finished=${this.active?.finished}`)
      if (this.isActiveCancelled()) {
        logCancelledSession()
        return
      }

      if (this.active) this.active.phase = 'deposit_return_home'
      await this.warehouse.goHome()
      if (this.isActiveCancelled()) {
        logCancelledSession()
        return
      }
      if (this.active) this.active.phase = 'deposit_storing'
      const result = await this.warehouse.depositInventoryForOwner(storageOwner.uuid, storageOwner.username)
      const status = result.deposited.length
        ? (result.leftover.length ? 'partial' : 'ok')
        : (result.leftover.length ? 'no_space' : 'empty')
      logSession(status, result.deposited.length ? result.deposited : result.leftover, {
        phase: this.active?.phase || 'deposit_storing',
        depositedAmount: this.totalAmount(result.deposited),
        leftoverAmount: this.totalAmount(result.leftover),
        finishedByUser: Boolean(this.active?.finished)
      })
      if (result.deposited.length) {
        const prefix = result.leftover.length ? '部分存入' : '存入完成'
        this.msg(username, `${this.ownerActionPrefix(storageOwner)}${prefix}：${this.formatItemList(result.deposited)}`)
      } else {
        this.msg(username, result.leftover.length ? `收到物品但暂时无法入库：${this.formatItemList(result.leftover)}` : '没有收到可入库的物品。')
      }

      if (result.leftover.length) {
        this.accountResidualAsMomo(result.leftover, `deposit leftover, actor=${username}, owner=${storageOwner.uuid}`)
        const reason = result.stopReason ? `${result.stopReason} ` : '仓库空间不足，'
        this.msg(username, `${reason}剩余物品已转记为 momo，避免影响下一个玩家：${this.formatItemList(result.leftover)}`)
      }
    } catch (error) {
      const held = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
      logSession('error', held, {
        phase: this.active?.phase || 'unknown',
        error: error.message
      })
      throw error
    }
  }

  logDepositSession (actorUsername, owner, status, items = [], extra = {}) {
    const details = {
      actor: actorUsername,
      owner: owner.uuid,
      scope: owner.scope || 'personal',
      ...extra
    }
    if (owner.vaultName) details.vault = owner.vaultName
    const message = Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, ' ')}`)
      .join(', ')
    this.db.addTransaction('deposit_session', status, owner.uuid, owner.username, items, message)
  }

  async handleWithdraw (username, text, owner = null, prebuiltRequests = null, targetUsername = username) {
    const player = this.getPlayer(username)
    const deliveryTarget = String(targetUsername || username).trim()
    const deliveryToOther = deliveryTarget !== username
    const msgActor = message => {
      if (!deliveryToOther) this.msg(username, message)
    }
    const msgTarget = message => this.msg(deliveryTarget, message)
    const storageOwner = owner || { ...player, scope: 'personal' }
    if (this.active) {
      this.active.player = player
      this.active.owner = storageOwner
      this.active.targetUsername = deliveryTarget
      this.active.phase = 'prepare_withdraw'
    }
    const requests = prebuiltRequests || this.parseWithdraw(this.extractWithdrawText(text, storageOwner))
    if (!requests.length) {
      msgActor(`格式示例：${storageOwner.scope === 'custom' ? `!${storageOwner.vaultName} 取 石英块64` : '!取 石英块64 石头128 红石块3'}`)
      return
    }

    const targetText = deliveryTarget === username ? '' : `，目标玩家 ${deliveryTarget}`
    msgActor(`正在准备从${this.ownerScopeName(storageOwner)}取物品${targetText}，请稍等。`)
    await this.warehouse.goHome()
    if (this.isActiveCancelled()) return
    await this.flushResidual()
    if (this.isActiveCancelled()) return

    const plan = this.buildWithdrawPlan(storageOwner.uuid, requests, storageOwner.scope === 'custom' ? `${storageOwner.vaultName} 当前` : '你当前')
    if (!deliveryToOther) {
      for (const notice of plan.notices) this.msg(username, notice)
    }

    if (!plan.allocations.length) {
      if (deliveryToOther) msgTarget(`${username} 想给你取物品，但仓库没有可取出的物品。`)
      else this.msg(username, '没有可取出的物品。')
      return
    }

    if (this.active) this.active.phase = 'withdraw_from_chests'
    const physical = await this.warehouse.withdrawAllocations(plan.allocations)
    if (this.isActiveCancelled()) return
    const actualByKey = sumBy(physical.withdrawn, item => item.itemKey)
    const delivered = plan.allocations
      .map(item => ({ ...item, amount: Math.min(item.amount, actualByKey.get(item.itemKey) || 0) }))
      .filter(item => item.amount > 0)

    if (!delivered.length) {
      const physicalMissing = this.formatItemList(physical.missing)
      await this.warehouse.goHome()
      const returned = await this.warehouse.depositInventoryWithoutBalance('withdraw_failed_return', `owner=${storageOwner.uuid}, actor=${username}`)
      if (returned.leftover.length) {
        msgActor(`机器人身上仍有未能放回仓库的物品：${this.formatItemList(returned.leftover)}`)
      }
      if (deliveryToOther) msgTarget(`${username} 给你的取货失败：仓库实物取出失败，请稍后再试。`)
      else this.msg(username, `账本有库存，但按本地木桶记录没有成功取出：${physicalMissing || this.formatItemList(plan.allocations)}。请管理员执行 !同步 后再试。`)
      return
    }

    const missingByItem = this.groupMissingByDisplay(plan.allocations, delivered)
    if (!deliveryToOther) {
      for (const notice of missingByItem) this.msg(username, notice)
    }

    if (this.active) this.active.phase = 'withdraw_teleport_to_player'
    if (deliveryToOther) {
      msgTarget(`${username} 正在从${this.ownerScopeName(storageOwner)}给你取物品，请接受机器人的传送请求。`)
    }
    const teleported = await this.teleportToPlayer(deliveryTarget)
    if (!teleported) {
      if (this.active) this.active.phase = 'withdraw_tpa_timeout_return_home'
      await this.warehouse.goHome()
      const result = await this.warehouse.depositInventoryWithoutBalance('withdraw_tpa_timeout', `actor=${username}, target=${deliveryTarget}`)
      if (result.leftover.length) {
        msgActor(`仓库空间不足，机器人身上仍有未放回的物品：${this.formatItemList(result.leftover)}`)
      }
      return
    }
    if (this.isActiveCancelled()) return
    if (this.active) this.active.phase = 'withdraw_dropping'
    await this.warehouse.dropInventoryToPlayer(deliveryTarget)
    if (this.isActiveCancelled()) return
    const leftoverAfterDrop = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    const deduct = leftoverAfterDrop.length
      ? this.subtractLeftoverFromDelivered(delivered, leftoverAfterDrop)
      : delivered

    this.db.removeBalanceItems(storageOwner.uuid, deduct)
    this.db.addTransaction('withdraw', 'ok', storageOwner.uuid, storageOwner.username, deduct, `actor=${username}, target=${deliveryTarget}`)
    if (deliveryToOther) {
      msgTarget(`${username} 给你的物品已送达：${this.formatItemList(deduct)}`)
    } else {
      this.msg(username, `${this.ownerActionPrefix(storageOwner)}已取出：${this.formatItemList(deduct)}`)
    }

    if (this.active) this.active.phase = 'withdraw_return_home'
    await this.warehouse.goHome()
    if (this.isActiveCancelled()) return
    const residual = await this.warehouse.depositInventoryWithoutBalance('withdraw_residual_return', `owner=${storageOwner.uuid}, actor=${username}, target=${deliveryTarget}`)
    if (residual.deposited.length) {
      msgActor(`有未成功丢出的物品已回收入库；这部分没有从${this.ownerSubjectName(storageOwner)}扣除。`)
    }
  }

  async handleQuery (username, text) {
    const parts = text.split(/\s+/).filter(Boolean)
    let owner = this.getPlayer(username)
    let itemName = parts[1]

    if (parts.length === 3 && parts[1].toLowerCase() === 'momo') {
      if (!this.isAdmin(username)) {
        this.msg(username, '你没有权限查询 momo。')
        return
      }
      owner = { uuid: this.config.momoOwner, username: 'momo' }
      itemName = parts[2]
    }

    if (!itemName || parts.length > 3) {
      this.msg(username, '查询只支持单一物品，格式：!查 石头')
      return
    }

    const items = this.resolveStoredItemsForOwnerQuery(owner.uuid, itemName)
    const shulkers = this.resolveShulkerContentsForOwnerQuery(owner.uuid, itemName)
    if (!items.length && !shulkers.length) {
      this.msg(username, `${owner.uuid === this.config.momoOwner ? 'momo 当前' : '你当前'}没有匹配当前库存的物品：${itemName}`)
      return
    }
    const who = owner.uuid === this.config.momoOwner ? 'momo 当前' : '你当前'
    this.sendQueryResult(username, who, items, shulkers)
  }

  async handleCreateCustomWarehouse (username, text) {
    const player = this.getPlayer(username)
    const parts = text.split(/\s+/).filter(Boolean)
    if (parts.length !== 2) {
      this.msg(username, '格式：!创建仓库 仓库名')
      return
    }

    const name = parts[1]
    const error = this.validateCustomWarehouseName(name)
    if (error) {
      this.msg(username, error)
      return
    }

    if (this.db.getCustomWarehouse(name)) {
      this.msg(username, `仓库名 ${name} 已存在，请换一个名字。`)
      return
    }

    const limit = this.config.storage?.maxCustomWarehousesPerPlayer || 3
    const current = this.db.countWarehousesCreatedBy(player.uuid)
    if (current >= limit) {
      this.msg(username, `你最多只能创建 ${limit} 个自定义仓库。`)
      return
    }

    this.db.createCustomWarehouse(name, player.uuid, username)
    this.msg(username, `已创建自定义仓库：${name}。你是这个仓库的管理员。`)
  }

  async handleMyCustomWarehouses (username) {
    const player = this.getPlayer(username)
    const rows = this.db.listCustomWarehousesForPlayer(player.uuid)
    if (!rows.length) {
      this.msg(username, '你还没有关联任何自定义仓库。')
      return
    }
    const text = rows.map(row => `${row.name}${row.role === 'admin' ? '(管理员)' : '(成员)'}`).join('，')
    this.msg(username, `你的仓库：${text}`)
  }

  parseCustomWarehouseCommand (text) {
    const match = text.match(/^!(\S{1,15})\s+(添加成员|加成员|删除成员|删成员|添加管理|添加管理员|加管理|加管理员|删除管理|删除管理员|删管理|删管理员|查|存|取|仓库成员|成员|查看成员|成员列表)(?:\s+(.+))?$/)
    if (!match) return null
    const [, warehouseName, action, rest = ''] = match
    return { warehouseName, action, rest: rest.trim() }
  }

  isCustomAction (action, type) {
    const aliases = {
      addMember: ['添加成员', '加成员'],
      removeMember: ['删除成员', '删成员'],
      addAdmin: ['添加管理', '添加管理员', '加管理', '加管理员'],
      removeAdmin: ['删除管理', '删除管理员', '删管理', '删管理员'],
      listMembers: ['仓库成员', '成员', '查看成员', '成员列表']
    }
    return aliases[type]?.includes(action) || false
  }

  async handleCustomWarehouseCommand (username, command) {
    const actor = this.getPlayer(username)
    const warehouse = this.db.getCustomWarehouse(command.warehouseName)
    if (!warehouse) {
      this.msg(username, `找不到自定义仓库：${command.warehouseName}`)
      return
    }

    const owner = this.resolveCustomWarehouseOwner(warehouse)
    const isMember = this.db.isCustomWarehouseMember(warehouse.name, actor.uuid)
    const isAdmin = this.db.isCustomWarehouseAdmin(warehouse.name, actor.uuid)

    if (this.isCustomAction(command.action, 'addMember')) {
      if (!isAdmin) {
        this.msg(username, '只有仓库管理员可以添加成员。')
        return
      }
      const target = this.resolveMemberArgument(command.rest)
      this.db.addCustomWarehouseMember(warehouse.name, target.uuid, target.username)
      this.msg(username, `已把 ${target.username} 添加到仓库 ${warehouse.name}。`)
      return
    }

    if (this.isCustomAction(command.action, 'removeMember')) {
      if (!isAdmin) {
        this.msg(username, '只有仓库管理员可以删除成员。')
        return
      }
      const target = this.resolveMemberArgument(command.rest)
      if (target.uuid === warehouse.creatorUuid) {
        this.msg(username, '不能删除仓库创建者。')
        return
      }
      const removed = this.db.removeCustomWarehouseMember(warehouse.name, target.uuid)
      this.msg(username, removed ? `已从仓库 ${warehouse.name} 删除成员 ${target.username}。` : `${target.username} 不是仓库 ${warehouse.name} 的成员。`)
      return
    }

    if (this.isCustomAction(command.action, 'addAdmin')) {
      if (!isAdmin) {
        this.msg(username, '只有仓库管理员可以添加仓库管理员。')
        return
      }
      const target = this.resolveMemberArgument(command.rest)
      this.db.setCustomWarehouseMemberRole(warehouse.name, target.uuid, target.username, 'admin')
      this.msg(username, `已把 ${target.username} 设为仓库 ${warehouse.name} 的管理员。`)
      return
    }

    if (this.isCustomAction(command.action, 'removeAdmin')) {
      if (!isAdmin) {
        this.msg(username, '只有仓库管理员可以删除仓库管理员。')
        return
      }
      const target = this.resolveMemberArgument(command.rest)
      if (target.uuid === warehouse.creatorUuid) {
        this.msg(username, '不能取消仓库创建者的管理员权限。')
        return
      }
      const changed = this.db.setCustomWarehouseMemberRoleIfExists(warehouse.name, target.uuid, 'member')
      this.msg(username, changed ? `已取消 ${target.username} 在仓库 ${warehouse.name} 的管理员权限。` : `${target.username} 不是仓库 ${warehouse.name} 的成员。`)
      return
    }

    if (!isMember) {
      this.msg(username, `你不是仓库 ${warehouse.name} 的成员。`)
      return
    }

    if (this.isCustomAction(command.action, 'listMembers')) {
      if (!isAdmin) {
        this.msg(username, '只有仓库管理员可以查看成员列表。')
        return
      }
      const members = this.db.listCustomWarehouseMembers(warehouse.name)
      const text = members.map(member => `${member.username}${member.role === 'admin' ? '(管理员)' : ''}`).join('，') || '无'
      this.msg(username, `${warehouse.name} 成员：${text}`)
      return
    }

    if (command.action === '查') {
      if (!command.rest || /\s/.test(command.rest)) {
        this.msg(username, `查询只支持单一物品，格式：!${warehouse.name} 查 石头`)
        return
      }
      const items = this.resolveStoredItemsForOwnerQuery(owner.uuid, command.rest)
      const shulkers = this.resolveShulkerContentsForOwnerQuery(owner.uuid, command.rest)
      if (!items.length && !shulkers.length) {
        this.msg(username, `${warehouse.name} 当前没有匹配当前库存的物品：${command.rest}`)
        return
      }
      this.sendQueryResult(username, `${warehouse.name} 当前`, items, shulkers)
      return
    }

    if (this.active) {
      this.msg(username, `机器人忙，玩家${this.active.username}使用中，请稍后再试。`)
      return
    }

    if (command.action === '存') {
      if (command.rest) {
        this.msg(username, `格式：!${warehouse.name} 存`)
        return
      }
      await this.runExclusive(username, 'deposit', () => this.handleDeposit(username, owner))
      return
    }

    if (command.action === '取') {
      if (!command.rest) {
        this.msg(username, `格式：!${warehouse.name} 取 石头64`)
        return
      }
      await this.runExclusive(username, 'withdraw', () => this.handleWithdraw(username, `!${warehouse.name} 取 ${command.rest}`, owner))
    }
  }

  resolveMemberArgument (text) {
    const username = String(text || '').trim()
    if (!username || /\s/.test(username)) {
      throw new Error('成员参数必须是单个玩家ID。')
    }
    return this.resolvePlayer(username)
  }

  async handleQuota (username, text) {
    const parts = text.split(/\s+/).filter(Boolean)
    let target = { ...this.getPlayer(username), scope: 'personal' }

    if (parts.length === 2) {
      target = this.resolveQuotaOwnerArgument(parts[1])
      if (target.scope === 'custom') {
        const actor = this.getPlayer(username)
        const isMember = this.db.isCustomWarehouseMember(target.vaultName, actor.uuid)
        if (!isMember && !this.isAdmin(username)) {
          this.msg(username, `你不是仓库 ${target.vaultName} 的成员。`)
          return
        }
      } else if (!this.isAdmin(username)) {
        this.msg(username, '你没有权限查询其他玩家额度。')
        return
      }
    } else if (parts.length > 2) {
      this.msg(username, '格式：!额度、!额度 玩家ID 或 !额度 仓库:仓库名')
      return
    }

    const quota = this.getStorageQuota(target.uuid, target.scope)
    const percent = quota.quotaSlots > 0 ? Math.floor((quota.usedSlots / quota.quotaSlots) * 100) : 0
    const prefix = target.scope === 'custom'
      ? `仓库 ${target.vaultName} 当前`
      : (target.username === username ? '你当前' : `${target.username} 当前`)
    this.msg(username, `${prefix}已使用 ${quota.usedSlots}/${quota.quotaSlots} 格，约 ${quota.usedItems} 个物品，${percent}%。`)
  }

  async handleAddAdmin (username, text) {
    if (!this.isAdmin(username)) {
      this.msg(username, '你没有权限添加管理员。')
      return
    }

    const parts = text.split(/\s+/).filter(Boolean)
    if (parts.length !== 2) {
      this.msg(username, '格式：!加管理员 玩家ID')
      return
    }

    const target = this.resolvePlayer(parts[1])
    this.db.addAdmin(target.username, target.uuid.startsWith('name:') ? null : target.uuid)
    this.msg(username, `已添加管理员：${target.username}`)
  }

  isWebLoginTokenCommand (text) {
    return /^!设置密钥(?:\s+.*)?$/.test(text)
  }

  async handleWebLoginToken (username, text, context = {}) {
    if (!this.isPrivateSource(context.source)) {
      this.msg(username, '为了避免泄露，请私聊我发送：设置密钥 你自己的密钥。')
      return
    }

    const player = this.getPlayer(username)
    const { customToken } = this.parseWebLoginTokenCommand(text)
    if (!customToken) {
      this.msg(username, '格式：设置密钥 你自己的密钥。每次设置都会覆盖旧密钥。')
      return
    }
    const result = this.db.setWebLoginToken(player.uuid, player.username, customToken)
    const dashboardUrl = this.config.web?.dashboardUrl || this.config.dashboardUrl || ''
    const loginHint = dashboardUrl
      ? `网页登录地址：${dashboardUrl}  已设置密钥：${result.token}`
      : `已设置密钥：${result.token}`
    this.msg(username, `${loginHint}。每次设置都会覆盖旧密钥。注意：密钥不检查复杂度，太简单可能被别人猜到；被破解造成库存信息泄露，后果自负。`)
  }

  parseWebLoginTokenCommand (text) {
    const match = String(text || '').match(/^!设置密钥(?:\s+([\s\S]+))?$/)
    return { customToken: String(match?.[1] || '').trim() }
  }

  async handleSetQuota (username, text) {
    if (!this.isAdmin(username)) {
      this.msg(username, '你没有权限设置额度。')
      return
    }

    const parts = text.split(/\s+/).filter(Boolean)
    if (parts.length !== 3) {
      this.msg(username, '格式：!设置额度 玩家ID 格数 或 !设置额度 仓库:仓库名 格数')
      return
    }

    const target = this.resolveQuotaOwnerArgument(parts[1])
    const slots = Number.parseInt(parts[2], 10)
    if (!Number.isFinite(slots) || slots < 0) {
      this.msg(username, '额度必须是大于等于 0 的整数格数。')
      return
    }

    this.db.setQuotaSlots(target.uuid, slots)
    const quota = this.getStorageQuota(target.uuid, target.scope)
    const label = target.scope === 'custom' ? `仓库 ${target.vaultName}` : target.username
    this.msg(username, `已设置 ${label} 的额度为 ${slots} 格；当前已用 ${quota.usedSlots}/${quota.quotaSlots} 格。`)
  }

  async handleAdjustBalance (username, text) {
    if (!this.isAdmin(username)) {
      this.msg(username, '你没有权限修改玩家库存。')
      return
    }

    const match = text.match(/^!(增加|减少)\s+(\S+)\s+(.+?)\s+(\d+)$/)
    if (!match) {
      this.msg(username, '格式：!增加 玩家ID 物品名 数量 或 !减少 玩家ID 物品名 数量')
      return
    }

    const [, action, targetName, itemName, amountText] = match
    const amount = Number.parseInt(amountText, 10)
    if (!Number.isFinite(amount) || amount <= 0) {
      this.msg(username, '数量必须是大于 0 的整数。')
      return
    }

    const target = this.resolvePlayer(targetName)
    const resolved = this.catalog.resolveName(itemName)
    const item = this.catalog.fromItemIdAmount(resolved.itemId, amount)

    if (action === '增加') {
      this.db.addBalanceItems(target.uuid, [item])
      this.db.addTransaction('admin_adjust_add', 'ok', target.uuid, target.username, [item], `admin=${username}`)
      const total = this.db.getOwnerTotalByItemId(target.uuid, item.itemId)
      this.msg(username, `已给 ${target.username} 增加 ${this.catalog.getDisplayName(item.itemId)} x${amount}，当前共 x${total}。`)
      return
    }

    const current = this.db.getOwnerTotalByItemId(target.uuid, item.itemId)
    const removeAmount = Math.min(amount, current)
    if (removeAmount <= 0) {
      this.msg(username, `${target.username} 当前没有 ${this.catalog.getDisplayName(item.itemId)}。`)
      return
    }

    const removals = this.buildAdminRemovalItems(target.uuid, item.itemId, removeAmount)
    this.db.removeBalanceItems(target.uuid, removals)
    this.db.addTransaction('admin_adjust_remove', 'ok', target.uuid, target.username, removals, `admin=${username}, requested=${amount}`)
    const total = this.db.getOwnerTotalByItemId(target.uuid, item.itemId)
    this.msg(username, `已从 ${target.username} 减少 ${this.catalog.getDisplayName(item.itemId)} x${removeAmount}，当前剩余 x${total}。`)
  }

  buildAdminRemovalItems (ownerUuid, itemId, amount) {
    const rows = this.db.getOwnerItemsByItemId(ownerUuid, itemId)
    const removals = []
    let remaining = amount

    for (const row of rows) {
      if (remaining <= 0) break
      const removeAmount = Math.min(row.amount, remaining)
      removals.push({
        itemKey: row.itemKey,
        itemId: row.itemId,
        displayName: row.displayName,
        nbtJson: row.nbtJson || '',
        metaJson: row.metaJson || '',
        amount: removeAmount
      })
      remaining -= removeAmount
    }

    return removals
  }

  async handleSync (username, text) {
    if (!this.isAdmin(username)) {
      this.msg(username, '你没有权限同步仓库。')
      return
    }

    if (this.active) {
      this.msg(username, `机器人忙，玩家${this.active.username}使用中，请稍后再试。`)
      return
    }

    await this.runExclusive(username, 'sync', async () => {
      const parts = text.split(/\s+/).filter(Boolean)
      const radius = clampInt(
        parts[1],
        this.config.warehouse.defaultSyncRadius,
        1,
        this.config.warehouse.maxSyncRadius
      )
      this.msg(username, `开始同步仓库，半径 ${radius}。`)
      const result = await this.warehouse.syncWarehouse(radius)
      const addedAmount = this.totalAmount(result.addedToMomo)
      const unresolvedAmount = this.totalAmount(result.unresolved)
      const failureText = result.failures.length ? `，失败${result.failures.length}` : ''
      this.msg(username, `同步完成：木桶${result.chestCount}，打开${result.openedChestCount}${failureText}，多余${addedAmount}/${this.itemTypeCount(result.addedToMomo)}种，缺失${unresolvedAmount}/${this.itemTypeCount(result.unresolved)}种。详情见Web管理页。`)
    })
  }

  async handleClearInventory (username, text) {
    if (!this.isAdmin(username)) {
      this.msg(username, '你没有权限清空库存记录。')
      return
    }

    if (this.active) {
      this.msg(username, `机器人忙，玩家${this.active.username}使用中，请稍后再试。`)
      return
    }

    const parts = text.split(/\s+/).filter(Boolean)
    if (parts[1] !== '确认') {
      this.msg(username, '此操作会清空库存、木桶位置、同步异常、存取记录和历史物品档案；保留管理员、组织仓库、成员、玩家、额度和配置别名。确认执行请输入：!清空库存 确认')
      return
    }

    const counts = this.db.clearInventoryData()
    this.msg(username, `已清空库存记录：库存${counts.balances}条，木桶${counts.chests}个，槽位${counts.chestSlots}条，潜影盒索引${counts.shulkerContents}条，异常${counts.inventoryMismatches || 0}条，记录${counts.transactions}条，物品档案${counts.items}条。`)
  }

  buildWithdrawPlan (ownerUuid, requests, ownerLabel = '你当前') {
    const notices = []
    const allocations = []
    const reservedShulkerBoxes = new Map()

    for (const request of requests) {
      const rows = request.itemKey
        ? this.db.getOwnerItemsByItemKey(ownerUuid, request.itemKey)
        : this.db.getOwnerItemsByItemId(ownerUuid, request.itemId)
      const looseAvailable = rows.reduce((sum, row) => sum + row.amount, 0)
      const displayName = request.displayName || this.catalog.getDisplayName(request.itemId)
      const shulkerRows = this.resolveShulkerRowsForWithdraw(ownerUuid, request)
      const shulkerAvailable = shulkerRows.reduce((sum, row) => sum + Number(row.totalContainedAmount || 0), 0)
      const available = looseAvailable + shulkerAvailable
      const loosePlanned = Math.min(request.amount, looseAvailable)

      if (available <= 0) {
        notices.push(`${ownerLabel}只有 0 个${displayName}，无法取出 ${request.amount} 个。`)
        continue
      }

      if (available < request.amount) {
        notices.push(`${ownerLabel}散装和潜影盒内合计只有 ${available} 个${displayName}，将尽量取出。`)
      }

      let remaining = loosePlanned
      for (const row of rows) {
        if (remaining <= 0) break
        const amount = Math.min(row.amount, remaining)
        allocations.push({ ...row, amount })
        remaining -= amount
      }

      let remainingInside = request.amount - loosePlanned
      const alreadySelectedInside = shulkerRows.reduce((sum, row) => {
        const selected = Math.min(reservedShulkerBoxes.get(row.shulkerItemKey) || 0, row.shulkerAmount || 0)
        return sum + selected * Number(row.containedAmount || 0)
      }, 0)
      remainingInside = Math.max(0, remainingInside - alreadySelectedInside)

      const shulkerAllocations = []
      for (const row of shulkerRows) {
        if (remainingInside <= 0) break
        const perBox = Number(row.containedAmount || 0)
        const ownedBoxes = Number(row.shulkerAmount || 0)
        const reserved = reservedShulkerBoxes.get(row.shulkerItemKey) || 0
        const availableBoxes = Math.max(0, ownedBoxes - reserved)
        if (perBox <= 0 || availableBoxes <= 0) continue

        const boxes = Math.min(availableBoxes, Math.ceil(remainingInside / perBox))
        if (boxes <= 0) continue

        const allocation = this.shulkerRowToAllocation(row, boxes, displayName)
        allocations.push(allocation)
        shulkerAllocations.push(allocation)
        reservedShulkerBoxes.set(row.shulkerItemKey, reserved + boxes)
        remainingInside -= boxes * perBox
      }

      if (looseAvailable < request.amount && shulkerAllocations.length) {
        notices.push(`${ownerLabel}散装只有 ${looseAvailable} 个${displayName}，会额外取出潜影盒：${this.formatShulkerAllocationList(shulkerAllocations)}。`)
      }
    }

    return { notices, allocations: this.mergeAllocations(allocations) }
  }

  mergeAllocations (allocations) {
    const byKey = new Map()
    for (const item of allocations) {
      const existing = byKey.get(item.itemKey)
      if (existing) {
        existing.amount += item.amount
      } else {
        byKey.set(item.itemKey, { ...item })
      }
    }
    return [...byKey.values()]
  }

  groupMissingByDisplay (planned, delivered) {
    const plannedByKey = sumBy(planned, item => item.itemKey)
    const deliveredByKey = sumBy(delivered, item => item.itemKey)
    const notices = []
    for (const item of planned) {
      const missing = (plannedByKey.get(item.itemKey) || 0) - (deliveredByKey.get(item.itemKey) || 0)
      if (missing > 0) {
        notices.push(`${item.displayName || this.catalog.getDisplayName(item.itemId)} 仓库实际库存不足，少取 ${missing} 个；只扣除实际交付数量。`)
      }
    }
    return [...new Set(notices)]
  }

  subtractLeftoverFromDelivered (delivered, leftover) {
    const leftoverByKey = sumBy(leftover, item => item.itemKey)
    return delivered
      .map(item => ({
        ...item,
        amount: Math.max(0, item.amount - (leftoverByKey.get(item.itemKey) || 0))
      }))
      .filter(item => item.amount > 0)
  }

  resolveStoredItem (name) {
    const shortCodeItem = this.resolveStoredItemByShortCode(name)
    if (shortCodeItem) return shortCodeItem

    try {
      return this.catalog.resolveName(name)
    } catch (error) {
      const matches = this.db.findItemsByDisplayQuery(name)
      if (!matches.length) throw error
      const exact = matches.filter(item => item.displayName.toLowerCase() === String(name).trim().toLowerCase())
      const candidates = exact.length ? exact : matches
      if (candidates.length > 1) {
        const names = candidates.map(item => this.formatCandidateForWithdraw(item)).slice(0, 5).join('，')
        throw new Error(`物品名不够精确：${name}，匹配到 ${names}`)
      }
      const item = candidates[0]
      return {
        itemKey: item.itemKey,
        itemId: item.itemId,
        displayName: item.displayName
      }
    }
  }

  resolveStoredItemForOwnerQuery (ownerUuid, name) {
    const items = this.resolveStoredItemsForOwnerQuery(ownerUuid, name)
    if (!items.length) return null
    if (items.length > 1) {
      const names = items
        .map(item => `${this.formatCandidateForWithdraw(item)} x${item.amount}`)
        .slice(0, 5)
        .join('，')
      throw new Error(`物品名不够精确：${name}，匹配到 ${names}`)
    }
    return items[0]
  }

  resolveStoredItemsForOwnerQuery (ownerUuid, name) {
    const shortCodeItem = this.resolveStoredItemByShortCode(name)
    if (shortCodeItem) {
      const amount = this.db.getOwnerTotalByItemKey(ownerUuid, shortCodeItem.itemKey)
      return amount > 0 ? [{ ...shortCodeItem, amount }] : []
    }

    const raw = String(name || '').trim()
    try {
      const resolved = this.catalog.resolveName(raw)
      const rows = this.db.getOwnerItemsByItemId(ownerUuid, resolved.itemId)
      if (rows.length) return rows
      return []
    } catch (error) {
      const matches = this.db.findOwnerItemsByDisplayQuery(ownerUuid, raw)
      if (!matches.length) return []
      const exact = matches.filter(item => item.displayName.toLowerCase() === raw.toLowerCase())
      return exact.length ? exact : matches
    }
  }

  resolveShulkerRowsForWithdraw (ownerUuid, request) {
    if (request.itemKey) {
      return this.db.getOwnerShulkersContainingItemKey(ownerUuid, request.itemKey)
    }
    return this.db.getOwnerShulkersContainingItemId(ownerUuid, request.itemId)
  }

  resolveShulkerContentsForOwnerQuery (ownerUuid, name) {
    const shortCodeItem = this.resolveStoredItemByShortCode(name)
    if (shortCodeItem) {
      return this.db.getOwnerShulkersContainingItemKey(ownerUuid, shortCodeItem.itemKey)
    }

    const raw = String(name || '').trim()
    try {
      const resolved = this.catalog.resolveName(raw)
      return this.db.getOwnerShulkersContainingItemId(ownerUuid, resolved.itemId)
    } catch {
      return this.db.findOwnerShulkersByContainedDisplayQuery(ownerUuid, raw)
    }
  }

  shulkerRowToAllocation (row, amount, requestedDisplayName = '') {
    return {
      itemKey: row.shulkerItemKey,
      itemId: row.shulkerItemId,
      displayName: row.shulkerDisplayName,
      nbtJson: row.shulkerNbtJson || '',
      metaJson: row.shulkerMetaJson || '',
      amount,
      shulkerForItem: requestedDisplayName,
      containedAmountPerBox: Number(row.containedAmount || 0)
    }
  }

  resolveStoredItemByShortCode (name) {
    const code = String(name || '').trim().replace(/^#/, '')
    if (!/^[0-9a-fA-F]{6}$/.test(code)) return null
    const item = this.db.findItemByShortCode(code)
    if (!item) return null
    return {
      itemKey: item.itemKey,
      itemId: item.itemId,
      displayName: item.displayName,
      nbtJson: item.nbtJson || '',
      metaJson: item.metaJson || ''
    }
  }

  itemShortCode (item) {
    const match = String(item?.itemKey || '').match(/\|([0-9a-f]{6})/i)
    return match ? match[1].toLowerCase() : ''
  }

  formatItemNameWithCode (item) {
    const name = item.displayName || this.catalog.getDisplayName(item.itemId) || item.itemId
    const code = this.itemShortCode(item)
    return code ? `${name}(${code})` : name
  }

  formatQueryItemNameWithCode (item) {
    const code = this.itemShortCode(item)
    const baseName = this.catalog.getDisplayName(item.itemId) || item.itemId
    const customName = this.extractStoredCustomName(item)
    if (customName && customName !== baseName) {
      return code ? `${customName}/${baseName}(${code})` : `${customName}/${baseName}`
    }
    return this.formatItemNameWithCode(item)
  }

  extractStoredCustomName (item) {
    const meta = this.catalog.parseStoredJson(item?.metaJson, {})
    return this.catalog.extractCustomName(meta.components) || ''
  }

  formatWithdrawToken (item) {
    return this.itemShortCode(item) || item.displayName || this.catalog.getDisplayName(item.itemId) || item.itemId
  }

  formatCandidateForWithdraw (item) {
    return this.formatQueryItemNameWithCode(item)
  }

  sendQueryResult (username, prefix, items, shulkers = []) {
    if (!items.length) {
      this.msg(username, `${prefix}没有散装匹配库存。`)
    } else if (items.length === 1) {
      const item = items[0]
      this.msg(username, `${prefix}有 ${this.formatQueryItemNameWithCode(item)} x${item.amount}`)
    } else {
      const total = items.reduce((sum, item) => sum + item.amount, 0)
      const lines = items.slice(0, 6).map(item => `${this.formatQueryItemNameWithCode(item)} x${item.amount}`)
      this.msg(username, `${prefix}共有 ${total} 个，分为 ${items.length} 种：${lines.join('；')}`)
      if (items.length > 6) {
        this.msg(username, `还有 ${items.length - 6} 种未显示，请输入更精确的名字。`)
      }
    }

    if (shulkers.length) {
      this.msg(username, `潜影盒内有：${this.formatShulkerContentRows(shulkers)}`)
    }
  }

  formatShulkerContentRows (rows) {
    const lines = rows.slice(0, 5).map(row => {
      const box = this.formatItemNameWithCode({
        itemKey: row.shulkerItemKey,
        itemId: row.shulkerItemId,
        displayName: row.shulkerDisplayName,
        nbtJson: row.shulkerNbtJson || '',
        metaJson: row.shulkerMetaJson || ''
      })
      const containedNames = String(row.containedDisplayNames || this.catalog.getDisplayName(row.containedItemId) || row.containedItemId)
        .split(',')
        .filter(Boolean)
        .slice(0, 3)
        .join('/')
      const total = Number(row.totalContainedAmount || 0)
      const boxes = Number(row.shulkerAmount || 0)
      return `${box} x${boxes}盒，内含 ${containedNames} x${total}`
    })
    const suffix = rows.length > 5 ? `；还有 ${rows.length - 5} 种未显示` : ''
    return `${lines.join('；')}${suffix}`
  }

  formatShulkerAllocationList (items) {
    return items.map(item => `${this.formatItemNameWithCode(item)} x${item.amount}盒`).join('，')
  }

  parseWithdraw (text) {
    const tokens = text.split(/\s+/).filter(Boolean)
    const requests = []
    let nameParts = []

    const addRequest = (name, amountText, source) => {
      const item = this.resolveStoredItem(name)
      const amount = Number.parseInt(amountText, 10)
      if (amount <= 0) throw new Error(`数量必须大于 0：${source}`)
      requests.push({ ...item, amount })
    }

    for (const token of tokens) {
      if (/^[0-9a-fA-F]{6}$/.test(token) && this.resolveStoredItemByShortCode(token)) {
        nameParts.push(token)
        continue
      }

      const shortCodeCombined = token.match(/^([0-9a-fA-F]{6})(\d+)$/)
      if (shortCodeCombined && this.resolveStoredItemByShortCode(shortCodeCombined[1])) {
        addRequest(shortCodeCombined[1], shortCodeCombined[2], token)
        nameParts = []
        continue
      }

      if (/^\d+$/.test(token)) {
        if (!nameParts.length) {
          if (this.resolveStoredItemByShortCode(token)) {
            nameParts.push(token)
            continue
          }
          throw new Error(`无法解析：${token}，格式示例 石头64 或 石头 64`)
        }
        addRequest(nameParts.join(' '), token, `${nameParts.join(' ')} ${token}`)
        nameParts = []
        continue
      }

      const combined = token.match(/^(.+?)(\d+)$/)
      if (combined) {
        const name = [...nameParts, combined[1]].join(' ')
        addRequest(name, combined[2], `${name}${combined[2]}`)
        nameParts = []
        continue
      }

      nameParts.push(token)
    }

    if (nameParts.length) {
      throw new Error(`缺少数量：${nameParts.join(' ')}，格式示例 石头64 或 石头 64`)
    }
    return requests
  }

  async flushResidual () {
    const held = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    if (!held.length) return

    const unaccounted = this.unaccountedResidualItems(held)
    if (unaccounted.length) {
      this.accountResidualAsMomo(unaccounted, 'flush residual before task')
    }

    const result = await this.warehouse.depositInventoryWithoutBalance('momo_residual_physical_store', 'already_accounted_as_momo')
    if (result.deposited.length) {
      this.markAccountedResidualStored(result.deposited)
      console.warn(`Residual inventory physically stored for momo: ${this.formatItemList(result.deposited)}`)
    }
    if (result.leftover?.length) {
      throw new Error(`机器人背包仍有已记为 momo 的残留物品无法入库，为避免影响下一个玩家，已停止本次服务：${this.formatItemList(result.leftover)}`)
    }
  }

  accountResidualAsMomo (items, message = '') {
    const normalized = this.mergeItems(items || []).filter(item => item.amount > 0)
    if (!normalized.length) return
    this.db.addBalanceItems(this.config.momoOwner, normalized)
    this.db.addTransaction('residual_to_momo', 'ok', this.config.momoOwner, 'momo', normalized, message)
    for (const item of normalized) {
      this.accountedResidual.set(item.itemKey, (this.accountedResidual.get(item.itemKey) || 0) + item.amount)
    }
    console.warn(`Residual inventory accounted as momo: ${this.formatItemList(normalized)} ${message}`)
  }

  unaccountedResidualItems (held) {
    const result = []
    for (const item of held) {
      const accounted = this.accountedResidual.get(item.itemKey) || 0
      const amount = item.amount - accounted
      if (amount > 0) result.push({ ...item, amount })
    }
    return result
  }

  markAccountedResidualStored (items) {
    for (const item of items || []) {
      const current = this.accountedResidual.get(item.itemKey) || 0
      const next = Math.max(0, current - item.amount)
      if (next > 0) this.accountedResidual.set(item.itemKey, next)
      else this.accountedResidual.delete(item.itemKey)
    }
  }

  isActiveCancelled () {
    return Boolean(this.active?.cancelled || this.active?.dead)
  }

  getPlayer (username) {
    const uuid = this.bot.players[username]?.uuid || `name:${username}`
    this.db.upsertPlayer(uuid, username)
    return { uuid, username }
  }

  resolvePlayer (username) {
    const onlineName = Object.keys(this.bot.players).find(name => name.toLowerCase() === username.toLowerCase())
    const online = onlineName ? this.bot.players[onlineName] : null
    if (online?.uuid) {
      this.db.upsertPlayer(online.uuid, onlineName)
      return { uuid: online.uuid, username: onlineName }
    }

    const known = this.db.getPlayerByUsername(username)
    if (known) return known

    const fallback = { uuid: `name:${username}`, username }
    this.db.upsertPlayer(fallback.uuid, username)
    return fallback
  }

  touchPlayer (username) {
    this.getPlayer(username)
  }

  resolveCustomWarehouseOwner (warehouse) {
    return {
      uuid: `vault:${warehouse.nameLower}`,
      username: `仓库:${warehouse.name}`,
      vaultName: warehouse.name,
      scope: 'custom'
    }
  }

  resolveQuotaOwnerArgument (text) {
    const raw = String(text || '').trim()
    if (!raw) throw new Error('目标不能为空。')
    if (raw.startsWith('仓库:') || raw.toLowerCase().startsWith('vault:')) {
      const name = raw.startsWith('仓库:') ? raw.slice(3).trim() : raw.slice(6).trim()
      if (!name) throw new Error('仓库名不能为空。')
      const warehouse = this.db.getCustomWarehouse(name)
      if (!warehouse) throw new Error(`找不到自定义仓库：${name}`)
      return this.resolveCustomWarehouseOwner(warehouse)
    }
    const onlineName = Object.keys(this.bot.players).find(name => name.toLowerCase() === raw.toLowerCase())
    const online = onlineName ? this.bot.players[onlineName] : null
    if (online?.uuid) {
      this.db.upsertPlayer(online.uuid, onlineName)
      return { uuid: online.uuid, username: onlineName, scope: 'personal' }
    }
    const known = this.db.getPlayerByUsername(raw)
    if (!known) {
      throw new Error(`找不到玩家：${raw}。设置额度需要玩家至少使用过机器人或在线。`)
    }
    return { ...known, scope: 'personal' }
  }

  validateCustomWarehouseName (name) {
    const text = String(name || '').trim()
    if (!text) return '仓库名不能为空。'
    if (/\s/.test(text)) return '仓库名不能包含空格。'
    if ([...text].length > 15) return '仓库名最多 15 个字。'
    return null
  }

  ownerScopeName (owner) {
    if (owner?.scope === 'custom') return `自定义仓库 ${owner.vaultName}`
    return '仓库'
  }

  ownerSubjectName (owner) {
    if (owner?.scope === 'custom') return `仓库 ${owner.vaultName}`
    return '你的仓库'
  }

  ownerActionPrefix (owner) {
    if (owner?.scope === 'custom') return `${owner.vaultName} `
    return ''
  }

  extractWithdrawText (text, owner) {
    if (owner?.scope === 'custom') {
      const escaped = owner.vaultName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return text.replace(new RegExp(`^!${escaped}\\s+取\\s*`), '')
    }
    return text.replace(/^!(取物品|取)\s*/, '')
  }

  isAdmin (username) {
    const uuid = this.bot.players[username]?.uuid || null
    return this.db.isAdmin(username, uuid)
  }

  isSelfUsername (username) {
    if (!username) return false
    return String(username).toLowerCase() === String(this.bot.username || '').toLowerCase()
  }

  async teleportToPlayer (username) {
    const commandTemplate = this.config.commands.tpa || '/tpa {player}'
    const timeoutMs = this.config.timing.teleportRequestTimeoutMs || 15000
    const radius = this.config.timing.teleportDetectRadius || 8

    this.msg(username, '已向你发送传送请求，请在15秒内接受。')
    this.bot.chat(commandTemplate.replace('{player}', username))

    const ok = await this.waitForPlayerNearby(username, timeoutMs, radius)
    if (ok) {
      if (this.config.debug) console.log(`[teleport] arrived near ${username}`)
      await sleep(this.config.timing.postTeleportWaitMs || 500)
      return true
    }

    console.warn(`[teleport] /tpa ${username} timed out after ${timeoutMs}ms`)
    this.msg(username, '15秒内没有检测到你在附近，本次操作已取消；如果稍后看到这条传送请求，请不要再接受。')
    return false
  }

  async waitForPlayerNearby (username, timeoutMs, radius) {
    const startedAt = Date.now()
    const startPos = this.bot.entity?.position?.clone()
    let movedLogged = false

    while (Date.now() - startedAt < timeoutMs) {
      if (this.isActiveCancelled()) return false

      const entity = this.bot.players[username]?.entity
      const botPos = this.bot.entity?.position
      if (entity && botPos) {
        const distance = entity.position.distanceTo(botPos)
        if (distance <= radius) return true
      }

      if (!movedLogged && startPos && botPos && botPos.distanceTo(startPos) > 3) {
        movedLogged = true
        if (this.config.debug) {
          console.log(`[teleport] bot position changed while waiting for ${username}: ${this.describePosition(startPos)} -> ${this.describePosition(botPos)}`)
        }
      }

      await sleep(250)
    }

    return false
  }

  describePosition (pos) {
    if (!pos) return '?'
    return `${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}`
  }

  msg (username, message) {
    const template = this.config.commands.msg
    const chunks = this.splitMessage(String(message), 80)
    for (const chunk of chunks) {
      const privateCommand = template.replace('{player}', username).replace('{message}', chunk)
      if (this.config.debugChat) console.log(`[reply] ${this.redactSensitiveText(privateCommand)}`)
      this.bot.chat(privateCommand)
      if (this.config.commands.publicFallback) {
        const publicMessage = `@${username} ${chunk}`
        if (this.config.debugChat) console.log(`[reply:publicFallback] ${this.redactSensitiveText(publicMessage)}`)
        this.bot.chat(publicMessage)
      }
    }
  }

  redactSensitiveText (text) {
    const value = String(text || '')
    if (!/设置密钥/.test(value)) return value
    return value
      .replace(/(!设置密钥)\s+.+$/u, '$1 [已隐藏]')
      .replace(/(已设置密钥：)[^。 ]+/gu, '$1[已隐藏]')
  }

  normalizeCommandText (message) {
    const text = this.stripChatCommandSuffix(String(message || '').trim())
    return text.startsWith('！') ? `!${text.slice(1)}` : text
  }

  stripChatCommandSuffix (text) {
    return text
      .replace(/\s*喵[~～!！。.]?\s*$/u, '')
      .trim()
  }

  normalizePrivateCommandText (message, source) {
    const text = this.normalizeCommandText(message)
    if (!this.isPrivateSource(source) || text.startsWith('!')) return text

    const commandNames = [
      '创建仓库',
      '我的仓库',
      '查询',
      '查',
      '额度',
      '加管理员',
      '加管理',
      '设置密钥',
      '设置额度',
      '增加',
      '减少',
      '清空库存',
      '清理库存',
      '同步仓库',
      '同步',
      '存物品',
      '存',
      '取物品',
      '取',
      '完成',
      '结束'
    ]

    for (const name of commandNames) {
      if (text === name || text.startsWith(`${name} `)) {
        return `!${text}`
      }
    }

    if (/^\S{1,15}\s+(添加成员|加成员|删除成员|删成员|添加管理|添加管理员|加管理|加管理员|删除管理|删除管理员|删管理|删管理员|查|存|取|仓库成员|成员|查看成员|成员列表)(?:\s+.*)?$/.test(text)) {
      return `!${text}`
    }

    return text
  }

  isPrivateSource (source) {
    return String(source || '').includes('private') || String(source || '').includes('whisper')
  }

  splitMessage (message, maxLength) {
    const chunks = []
    let text = message
    while (text.length > maxLength) {
      chunks.push(text.slice(0, maxLength))
      text = text.slice(maxLength)
    }
    chunks.push(text)
    return chunks
  }

  totalAmount (items) {
    return items.reduce((sum, item) => sum + item.amount, 0)
  }

  itemTypeCount (items) {
    return new Set((items || []).map(item => item.itemKey || item.itemId).filter(Boolean)).size
  }

  mergeItems (items) {
    const byKey = new Map()
    for (const item of items || []) {
      if (!item?.itemKey || !item.amount) continue
      const existing = byKey.get(item.itemKey)
      if (existing) {
        existing.amount += item.amount
      } else {
        byKey.set(item.itemKey, { ...item })
      }
    }
    return [...byKey.values()]
  }

  formatItemList (items) {
    if (!items.length) return '无'
    return items.map(item => `${this.formatItemNameWithCode(item)} x${item.amount}`).join('，')
  }

  getStorageQuota (ownerUuid, scope = 'personal') {
    const defaultSlots = scope === 'custom'
      ? (this.config.storage?.defaultCustomWarehouseQuotaSlots || this.config.storage?.defaultQuotaSlots || 270)
      : (this.config.storage?.defaultQuotaSlots || 270)
    const quotaSlots = this.db.getQuotaSlots(ownerUuid, defaultSlots)
    const rows = this.db.getOwnerBalances(ownerUuid)
    let usedSlots = 0
    let usedItems = 0

    for (const row of rows) {
      const stackSize = Math.max(1, this.catalog.getStackSize(row.itemId))
      usedSlots += Math.ceil(row.amount / stackSize)
      usedItems += row.amount
    }

    return { usedSlots, quotaSlots, usedItems }
  }
}

module.exports = CloudStoreService

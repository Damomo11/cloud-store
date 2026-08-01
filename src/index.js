const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const mineflayer = require('mineflayer')
const nbt = require('prismarine-nbt')
const { pathfinder } = require('mineflayer-pathfinder')
const { loadConfig } = require('./config')
const StoreDb = require('./db')
const ItemCatalog = require('./itemCatalog')
const Warehouse = require('./warehouse')
const CloudStoreService = require('./service')
const CloudStoreWebServer = require('./webServer')
const SubscriptionManager = require('./subscriptions')
const { BotTaskPool } = require('./taskPool')
const {
  invalidateMinecraftAccessTokenCache,
  isMinecraftProfileAuthError,
  isMicrosoftAuthRateLimitError,
  microsoftAuthRetryDelayMs
} = require('./authCache')
const { installFatalProtocolPacketCapture, isFatalProtocolReadError, releaseBotConnection, terminateBotTransport } = require('./botConnection')

function createBot (config, onMsaCode) {
  const options = {
    host: config.server.host,
    port: config.server.port,
    username: config.server.username,
    auth: 'microsoft',
    version: config.server.version,
    locale: config.server.locale || 'zh_CN',
    logErrors: false,
    onMsaCode
  }

  if (config.server.profilesFolder) {
    options.profilesFolder = path.resolve(process.cwd(), config.server.profilesFolder)
  }

  const bot = mineflayer.createBot(options)

  bot.loadPlugin(pathfinder)
  return bot
}

function createCatalogForVersion (version) {
  return new ItemCatalog(version, config.aliases, config.language)
}

function attachCatalog (nextCatalog) {
  db.setCatalog(nextCatalog)
  const refreshedDisplayNames = db.refreshItemDisplayNames(nextCatalog)
  if (refreshedDisplayNames > 0) {
    console.log(`Refreshed ${refreshedDisplayNames} stored item display names`)
  }
}

function formatKickReason (reason) {
  if (typeof reason === 'string') return reason
  try {
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}

function formatDisconnectReason (reason) {
  if (!reason) return ''
  if (typeof reason === 'string') return reason
  if (reason instanceof Error) return `${reason.code || reason.name}: ${reason.message}`
  try {
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}

function isSocketDisconnectError (error) {
  return ['EPIPE', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(error?.code)
}

const config = loadConfig(path.resolve(process.cwd(), 'config.json'), { autoUpdate: true })
const db = new StoreDb(path.resolve(process.cwd(), 'data', 'cloud-store.sqlite'), config)
const subscriptions = new SubscriptionManager(db, config)
const catalog = createCatalogForVersion(config.server.version)
attachCatalog(catalog)

const configuredAccounts = (Array.isArray(config.bots) && config.bots.length ? config.bots : [config.server])
  .map((account, index) => ({
    username: String(account.username || '').trim(),
    botName: String(account.botName || account.username || `bot-${index + 1}`).trim(),
    profilesFolder: String(account.profilesFolder || `auth-cache/bot-${index + 1}`).trim()
  }))
  .filter(account => account.username)

const existingAccounts = db.listBotAccounts()
if (!existingAccounts.length) {
  for (const account of configuredAccounts) {
    db.createBotAccount({ id: crypto.randomUUID(), ...account, enabled: true })
  }
} else if (configuredAccounts.length) {
  console.log('Bot accounts are loaded from the database; config.json server/bots are only used for first initialization.')
}

const accounts = db.listBotAccounts()
if (!accounts.length) throw new Error('没有配置微软机器人账号，请在 config.json 的 server.username 或 bots[] 中填写账号。')
console.log(`Configured ${accounts.length} Microsoft OAuth2 bot account(s)`)
console.log(`Minecraft version: ${config.server.version}, auth: microsoft`)

let shuttingDown = false
const taskPool = new BotTaskPool(config)
const states = new Map(accounts.map(account => [account.id, createBotState(account)]))
const currentService = () => [...states.values()].find(state => state.service)?.service || null
const botManager = {
  list: listManagedAccounts,
  add: addManagedAccount,
  setEnabled: setManagedAccountEnabled,
  remove: removeManagedAccount
}
const webServer = new CloudStoreWebServer(db, config, currentService, () => botManager, subscriptions)
webServer.start()

for (const state of states.values()) {
  if (state.account.enabled) launchBot(state)
}

function createBotState (account) {
  return {
    account,
    bot: null,
    service: null,
    reconnectTimer: null,
    drainTimer: null,
    reconnectAttempt: 0,
    lastProfileAuthRecoveryAt: 0,
    desiredEnabled: Boolean(account.enabled),
    status: account.enabled ? 'starting' : 'disabled',
    lastError: '',
    deviceCode: null
  }
}

function listManagedAccounts () {
  return db.listBotAccounts().map(account => {
    const state = states.get(account.id)
    return {
      ...account,
      status: state?.status || (account.enabled ? 'offline' : 'disabled'),
      minecraftName: state?.bot?.username || '',
      activeTask: state?.service?.active
        ? { type: state.service.active.type, username: state.service.active.username, phase: state.service.active.phase }
        : null,
      lastError: state?.lastError || '',
      deviceCode: state?.deviceCode && state.deviceCode.expiresAt > Date.now() ? state.deviceCode : null
    }
  })
}

function addManagedAccount (input) {
  const username = String(input.username || '').trim()
  const botName = String(input.botName || '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) throw new Error('请输入有效的微软账号邮箱。')
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(botName)) throw new Error('Bot 标识只能包含字母、数字、下划线和连字符，长度 2-32。')
  const id = crypto.randomUUID()
  const account = db.createBotAccount({
    id,
    username,
    botName,
    profilesFolder: path.join('auth-cache', 'bots', id),
    enabled: true
  })
  const state = createBotState(account)
  states.set(id, state)
  launchBot(state)
  return account
}

function setManagedAccountEnabled (id, enabled) {
  const account = db.setBotAccountEnabled(id, enabled)
  let state = states.get(account.id)
  if (!state) {
    state = createBotState(account)
    states.set(account.id, state)
  }
  state.account = account
  state.desiredEnabled = Boolean(enabled)
  if (enabled) {
    state.status = 'starting'
    state.lastError = ''
    if (!state.bot) launchBot(state)
  } else {
    drainBot(state)
  }
  return account
}

function removeManagedAccount (id) {
  const account = db.deleteBotAccount(id)
  const state = states.get(account.id)
  if (state) {
    state.desiredEnabled = false
    state.removeAfterStop = true
    drainBot(state)
  }
  return account
}

function drainBot (state) {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
  state.reconnectTimer = null
  if (state.service) taskPool.unregister(state.service)
  if (state.service?.active) {
    state.status = 'draining'
    if (!state.drainTimer) {
      state.drainTimer = setTimeout(() => {
        state.drainTimer = null
        drainBot(state)
      }, 500)
    }
    return
  }
  state.status = state.removeAfterStop ? 'removing' : 'disabled'
  if (state.bot) {
    const bot = state.bot
    const service = state.service
    releaseBotConnection(state, bot, service, taskPool, 'disabled from web admin')
    if (state.removeAfterStop) states.delete(state.account.id)
  }
  else if (state.removeAfterStop) states.delete(state.account.id)
}

function launchBot (state) {
  if (shuttingDown || !state.desiredEnabled || state.bot) return
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = null
  }

  state.reconnectAttempt += 1
  state.status = 'connecting'
  state.deviceCode = null
  if (state.reconnectAttempt > 1) {
    console.log(`[reconnect:${state.account.botName}] attempt ${state.reconnectAttempt}`)
  }

  const activeVersion = config.server.version

  const launchConfig = {
    ...config,
    server: {
      ...config.server,
      ...state.account,
      version: activeVersion
    }
  }

  let bot
  bot = createBot(launchConfig, code => {
    if (bot && state.bot !== bot) return
    const expiresIn = Number(code?.expires_in || code?.expiresIn || 900)
    state.deviceCode = {
      userCode: String(code?.user_code || code?.userCode || ''),
      verificationUri: String(code?.verification_uri || code?.verificationUri || 'https://microsoft.com/link'),
      directUri: String(code?.verification_uri_complete || code?.verificationUriComplete || ''),
      expiresAt: Date.now() + (expiresIn * 1000)
    }
    state.status = 'auth_required'
    console.log(`[oauth:${state.account.botName}] open ${state.deviceCode.verificationUri} and enter ${state.deviceCode.userCode}`)
  })
  state.bot = bot
  const protocolPacketCapture = installFatalProtocolPacketCapture(bot, {
    directory: path.resolve(process.cwd(), 'logs')
  })
  let loggedIn = false
  let spawned = false
  let lastDisconnectReason = ''
  const acceptedResourcePacks = new Set()

  const warehouse = new Warehouse(bot, db, catalog, launchConfig, taskPool.warehouseMutex)
  const service = new CloudStoreService(bot, db, catalog, warehouse, launchConfig, taskPool, subscriptions)
  service.setWebAuth(webServer)
  setupRegistryExport(bot, catalog, db)

  const loginWatchdog = setInterval(() => {
    if (state.bot !== bot) {
      clearInterval(loginWatchdog)
      return
    }
    if (!loggedIn) {
      if (state.deviceCode && state.deviceCode.expiresAt > Date.now()) {
        console.log(`[login:${state.account.botName}] 仍在等待 Microsoft OAuth 验证。打开 ${state.deviceCode.verificationUri} 输入 ${state.deviceCode.userCode}`)
      } else {
        console.log(`[login:${state.account.botName}] 仍在等待登录完成。如果首次登录，请查看是否出现 microsoft.com/link 验证码。`)
      }
    } else if (!spawned) {
      console.log(`[login:${state.account.botName}] 已登录，仍在等待 spawn。可能正在等待服务器资源包确认、服务器队列或插件验证。`)
    }
  }, 15000)

  bot.once('login', () => {
    if (state.bot !== bot) {
      terminateBotTransport(bot, 'stale bot instance')
      return
    }
    loggedIn = true
    state.status = 'logging_in'
    state.deviceCode = null
    bot.setSettings?.({ locale: config.server.locale || 'zh_CN' })
    console.log(`[login:${state.account.botName}] Bot logged in as ${bot.username}, waiting for spawn...`)
  })

  bot.once('spawn', () => {
    if (state.bot !== bot) {
      terminateBotTransport(bot, 'stale bot instance')
      return
    }
    spawned = true
    state.reconnectAttempt = 0
    state.status = 'online'
    state.lastError = ''
    clearInterval(loginWatchdog)
    console.log(`[login:${state.account.botName}] Cloud store bot spawned as ${bot.username}`)
    state.service = service
    taskPool.register(service)
    service.start()
  })

  bot.on('resourcePack', (url, hashOrUuid) => {
    console.log(`[resourcePack] server requested pack: ${url} ${hashOrUuid || ''}`)
    if (config.resourcePack?.autoAccept !== false) {
      const packKey = String(hashOrUuid || url || '')
      if (packKey && acceptedResourcePacks.has(packKey)) {
        console.log(`[resourcePack] already accepted ${packKey}, skip mineflayer helper`)
        return
      }
      console.log('[resourcePack] accepting resource pack via mineflayer helper')
      try {
        bot.acceptResourcePack()
        if (packKey) acceptedResourcePacks.add(packKey)
      } catch (error) {
        console.error('[resourcePack] mineflayer accept failed:', error)
      }
    } else {
      console.log('[resourcePack] autoAccept=false, resource pack not accepted')
    }
  })

  bot._client?.on('add_resource_pack', data => {
    console.log('[resourcePack] add_resource_pack packet:', JSON.stringify(data))
    if (config.resourcePack?.autoAccept !== false) {
      acceptResourcePackOnce(bot, acceptedResourcePacks, data.uuid)
    }
  })

  bot._client?.on('resource_pack_send', data => {
    console.log('[resourcePack] resource_pack_send packet:', JSON.stringify(data))
    if (config.resourcePack?.autoAccept !== false && data.uuid) {
      acceptResourcePackOnce(bot, acceptedResourcePacks, data.uuid)
    }
  })

  bot._client?.on('end', reason => {
    lastDisconnectReason = formatDisconnectReason(reason)
    if (lastDisconnectReason) console.warn(`[client] connection ended: ${lastDisconnectReason}`)
  })

  bot._client?.on('close', reason => {
    lastDisconnectReason = formatDisconnectReason(reason)
    if (lastDisconnectReason) console.warn(`[client] connection closed: ${lastDisconnectReason}`)
  })

  bot.on('kicked', reason => {
    clearInterval(loginWatchdog)
    if (state.bot !== bot) return
    console.error(`[login:${state.account.botName}] Bot kicked:`, reason)
    const kickReason = formatKickReason(reason)
    lastDisconnectReason = kickReason
    state.lastError = kickReason
  })

  bot.on('error', error => {
    if (state.bot !== bot) return
    state.lastError = String(error?.message || error)
    if (isFatalProtocolReadError(error)) {
      const packetPath = protocolPacketCapture.dump(error, {
        botName: state.account.botName,
        version: activeVersion,
        openingChest: warehouse.openingChest || null
      })
      if (packetPath) console.error(`[protocol:${state.account.botName}] saved failing packet to ${packetPath}`)
      const contextualError = warehouse.abortForProtocolReadError(error)
      state.lastError = contextualError.message
      console.error(`[protocol:${state.account.botName}] ${contextualError.message} 连接已终止，将继续用 ${activeVersion} 重连。`)
      clearInterval(loginWatchdog)
      if (releaseBotConnection(state, bot, service, taskPool, 'fatal Slot/NBT protocol read error')) {
        state.status = state.desiredEnabled ? 'offline' : 'disabled'
        if (state.desiredEnabled) scheduleReconnect(state, 1000)
      }
      return
    }
    if (!spawned && isMicrosoftAuthRateLimitError(error)) {
      const retryDelay = microsoftAuthRetryDelayMs(state.reconnectAttempt, config.timing?.reconnectDelayMs)
      console.warn(`[auth:${state.account.botName}] Microsoft/Xbox login was rate limited; released the failed bot instance and will retry in ${retryDelay}ms`)
      clearInterval(loginWatchdog)
      if (releaseBotConnection(state, bot, service, taskPool, 'retry rate-limited microsoft authentication')) {
        state.status = state.desiredEnabled ? 'offline' : 'disabled'
        if (state.desiredEnabled) scheduleReconnect(state, retryDelay)
      }
      return
    }
    if (!spawned && isMinecraftProfileAuthError(error)) {
      let cleared = 0
      let cacheReset = false
      if (Date.now() - state.lastProfileAuthRecoveryAt >= 5 * 60 * 1000) {
        state.lastProfileAuthRecoveryAt = Date.now()
        cacheReset = true
        const profilesFolder = path.resolve(process.cwd(), String(state.account.profilesFolder || config.server.profilesFolder || ''))
        cleared = invalidateMinecraftAccessTokenCache(profilesFolder)
      }
      console.warn(`[auth:${state.account.botName}] profile token rejected; cleared ${cleared} Minecraft access-token cache file(s), released the failed bot instance and will retry`)
      clearInterval(loginWatchdog)
      if (releaseBotConnection(state, bot, service, taskPool, 'refresh minecraft access token')) {
        state.status = state.desiredEnabled ? 'offline' : 'disabled'
        if (state.desiredEnabled) scheduleReconnect(state, cacheReset ? 1000 : null)
      }
      return
    }
    if (isSocketDisconnectError(error)) {
      console.warn(`[network] ${error.code}: socket 已断开，等待重连。${lastDisconnectReason ? `lastReason=${lastDisconnectReason}` : '通常是服务器/代理主动断开或网络抖动。'}`)
      return
    }
    console.error(`[login:${state.account.botName}] Bot error:`, error)
  })

  bot.on('end', () => {
    clearInterval(loginWatchdog)
    console.log(`[login:${state.account.botName}] Bot disconnected${lastDisconnectReason ? `: ${lastDisconnectReason}` : ''}`)
    if (!releaseBotConnection(state, bot, service, taskPool, 'connection ended', { terminate: false })) return
    state.status = state.desiredEnabled ? 'offline' : (state.removeAfterStop ? 'removed' : 'disabled')
    if (state.removeAfterStop) {
      states.delete(state.account.id)
      return
    }
    if (state.desiredEnabled) scheduleReconnect(state)
  })
}

function setupRegistryExport (bot, catalog, db) {
  bot._client?.on('registry_data', packet => {
    const exported = exportEnchantmentRegistry(packet, catalog)
    if (!exported) return

    const filePath = path.resolve(process.cwd(), 'data', 'server-enchantments.json')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(exported, null, 2), 'utf8')
    console.log(`[registry] exported ${exported.count} server enchantments to ${filePath}`)
    logEnchantmentRegistry(exported.enchantments)

    const loaded = catalog.reloadServerEnchantments(filePath)
    console.log(`[registry] reloaded ${loaded} server enchantment mappings`)
    const refreshed = db.refreshItemDisplayNames(catalog)
    if (refreshed > 0) {
      console.log(`[registry] refreshed ${refreshed} stored item display names`)
    }
  })
}

function logEnchantmentRegistry (enchantments, batchSize = 12) {
  const entries = Array.isArray(enchantments) ? enchantments : []
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const batch = entries.slice(offset, offset + batchSize)
    const details = batch
      .map(entry => `${entry.id}:${entry.key}=${String(entry.displayName || '').replace(/\s+/g, ' ').trim()}`)
      .join(' | ')
    console.log(`[registry] enchantments ${offset + 1}-${offset + batch.length}/${entries.length}: ${details}`)
  }
}

function exportEnchantmentRegistry (packet, catalog) {
  const registryId = String(packet?.id || packet?.registryId || '')
  if (registryId !== 'minecraft:enchantment' && registryId !== 'enchantment') return null
  const entries = Array.isArray(packet.entries) ? packet.entries : []
  const enchantments = entries
    .map((entry, index) => {
      const key = String(entry?.key || entry?.name || '')
      if (!key) return null
      const name = key.replace(/^minecraft:/, '')
      const data = simplifyNbtValue(entry?.value)
      return {
        id: index,
        key,
        name,
        displayName: registryEnchantmentDisplayName(data, name, catalog),
        data
      }
    })
    .filter(Boolean)

  return {
    source: 'server_registry_data',
    registryId,
    exportedAt: new Date().toISOString(),
    count: enchantments.length,
    enchantments
  }
}

function simplifyNbtValue (value) {
  if (!value) return null
  try {
    return nbt.simplify(value)
  } catch {
    return value
  }
}

function registryEnchantmentDisplayName (data, name, catalog) {
  const description = data?.description
  if (description) {
    if (typeof description.text === 'string' && description.text.trim()) {
      return description.text.trim()
    }
    if (typeof description.translate === 'string') {
      const translated = catalog.language?.[description.translate]
      if (translated) return translated
      if (typeof description.fallback === 'string' && description.fallback.trim()) {
        return description.fallback.trim()
      }
    }
    if (typeof description.fallback === 'string' && description.fallback.trim()) {
      return description.fallback.trim()
    }
  }
  return catalog.getEnchantmentDisplayName(name)
}

function scheduleReconnect (state, delayOverrideMs = null) {
  if (shuttingDown || !state.desiredEnabled || state.reconnectTimer) return
  const delay = Math.max(1000, Number(delayOverrideMs || config.timing?.reconnectDelayMs || 10000))
  console.log(`[reconnect:${state.account.botName}] will reconnect in ${delay}ms`)
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null
    try {
      launchBot(state)
    } catch (error) {
      console.error(`[reconnect:${state.account.botName}] failed to launch bot:`, error)
      scheduleReconnect(state)
    }
  }, delay)
}

function acceptResourcePackOnce (bot, acceptedResourcePacks, uuid) {
  const key = String(uuid || '')
  if (key && acceptedResourcePacks.has(key)) {
    console.log(`[resourcePack] already accepted ${key}, skip duplicate status packets`)
    return
  }
  const accepted = acceptResourcePackDirect(bot, uuid)
  if (accepted && key) acceptedResourcePacks.add(key)
}

function acceptResourcePackDirect (bot, uuid) {
  const statuses = [
    ['ACCEPTED', 3],
    ['DOWNLOADED', 4],
    ['SUCCESSFULLY_LOADED', 0]
  ]

  let ok = true
  for (const [label, result] of statuses) {
    try {
      bot._client.write('resource_pack_receive', { uuid, result })
      console.log(`[resourcePack] sent ${label} for ${uuid}`)
    } catch (error) {
      ok = false
      console.error(`[resourcePack] failed to send ${label}:`, error)
    }
  }
  return ok
}

process.on('SIGINT', () => {
  shuttingDown = true
  for (const state of states.values()) {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    state.bot?.quit('shutdown')
  }
  subscriptions.close()
  db.close()
  process.exit(0)
})

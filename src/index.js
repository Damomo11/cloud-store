const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
// via 模块：26.3 伪版本注入（mod 式自动生效，不需要 config 开关）。
// 必须先于 mineflayer 的 require——mineflayer/lib/loader.js 加载时解构版本表，晚了放行不进去。
// 注入后 minecraft-protocol 的 autoVersion ping 到 777 会自动选 26.3；连 1.21.x 服时
// 协商结果不变，注入的字典闲置无害。data/via/26.3 缺失时降级走 1.21.11 老路。
try {
  require('./via').activate()
  console.log('[via] 26.3 伪版本已注入，连接版本将自动协商')
} catch (error) {
  console.log('[via] 注入失败，回退 1.21.11 直连：', error.message)
}
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
const { deliverHotReloadNotify } = require('./hotReload')
const { hookEarlyChannelRegister } = require('./servux')
const {
  invalidateMinecraftAccessTokenCache,
  isMinecraftProfileAuthError,
  isMicrosoftAuthRateLimitError,
  microsoftAuthRetryDelayMs
} = require('./authCache')
const { installFatalProtocolPacketCapture, isFatalProtocolReadError, releaseBotConnection, terminateBotTransport } = require('./botConnection')
const { installClientTickEndPatch } = require('./tickEndPatch')
const { installPlayerLoadedReport } = require('./playerLoaded')
const { logLocalError } = require('./localErrorLog')
const { configureTraceLog } = require('./traceLog')
const { installConsoleLogBuffer } = require('./consoleLogBuffer')
const { watchPackLanguage } = require('./packLang')

function createBot (config, onMsaCode) {
  const options = {
    host: config.server.host,
    port: config.server.port,
    username: config.server.username,
    auth: 'microsoft',
    // 强制声明 26.3：via 注入字典后直接以 26.3（协议号 777）握手，不走 ping 协商。
    // config.server.version 仅作 catalog 初始字典，不再锁定连接版本。
    version: '26.3',
    locale: config.server.locale || 'zh_CN',
    disableChatSigning: true,
    logErrors: false,
    onMsaCode
  }

  if (config.server.profilesFolder) {
    options.profilesFolder = path.resolve(process.cwd(), config.server.profilesFolder)
  }

  const bot = mineflayer.createBot(options)

  // 26.3 的 sync_entity_position 没有 26.1 的速度字段，mineflayer 处理器会 NaN；
  // 在 mineflayer 处理器之后注册修复监听（详见 via/sync-compat.js）
  require('./via/sync-compat').installRepairSync(bot)

  // 1.21.6+ 需在 configuration 阶段声明 servux 通道（详见 servux.js 注释）
  hookEarlyChannelRegister(bot)

  // 登录后按协商出的真实版本切换 catalog（26.3 字典含 26.2/26.3 新物品）
  bot.once('login', () => {
    const negotiated = bot.registry?.version?.minecraftVersion
    if (!negotiated || negotiated === currentCatalogVersion) return
    console.log(`[via] 服务器实际版本 ${negotiated}，切换物品字典（原 ${currentCatalogVersion}）`)
    currentCatalogVersion = negotiated
    attachCatalog(createCatalogForVersion(negotiated))
  })

  // 26.x（1.21.2+）机制：客户端要发 player_loaded 告诉服务器"加载完成"，
  // 服务器收到后才开始推区块/坐标/keepalive。以前 1.21.11 直连靠服务器端
  // Via 代发，现在直连 26.3 必须自己发，不然 30 秒 keepalive 超时被踢。
  bot.once('login', () => {
    try {
      bot._client.write('player_loaded', {})
    } catch {
      // 版本没有这个包（< 1.21.2）就跳过
    }
  })

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
installConsoleLogBuffer({ limit: config.web?.consoleLogLimit })
configureTraceLog(config.traceLog)
// 每个进程只在第一只 bot 上线时检查，旧进程重连时不能认领新进程的完成提醒。
let hotReloadNotifyChecked = false
const db = new StoreDb(path.resolve(process.cwd(), 'data', 'cloud-store.sqlite'), config)
const subscriptions = new SubscriptionManager(db, config)
const catalog = createCatalogForVersion(config.server.version)
attachCatalog(catalog)
// 当前生效的物品字典版本；bot 登录按协商版本自适应（见 createBot 里的 login 钩子）
let currentCatalogVersion = config.server.version

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
  taskPool.cancelQueuedCraftRecovery(String(state.account.botName || state.account.username || '').toLowerCase())
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
  const uninstallTickEndPatch = installClientTickEndPatch(bot)
  installPlayerLoadedReport(bot)
  let loggedIn = false
  let spawned = false
  let lastDisconnectReason = ''
  const acceptedResourcePacks = new Set()

  const warehouse = new Warehouse(bot, db, catalog, launchConfig, taskPool.warehouseMutex, taskPool.warehouseState)
  const service = new CloudStoreService(bot, db, catalog, warehouse, launchConfig, taskPool, subscriptions)
  // 26.x 会话按协商版本切换物品字典时，同步替换 warehouse/service 的 catalog 实例。
  // createBot 内的 login 处理器只更新 db——不替换的话 servux 的数字 id 转换、指纹
  // 归一化仍按启动时的 1.21.11 目录计算（2026-11 部署实测：26.3 会话里 hay_block
  // 被转成 1.21.11 的 504 → 同一只潜影盒两条路径指纹不同 → 幽灵条目/取出失败）。
  let warehouseCatalogVersion = config.server.version
  bot.once('login', () => {
    const negotiated = bot.registry?.version?.minecraftVersion
    if (!negotiated || negotiated === warehouseCatalogVersion) return
    if (!db.catalog) return
    warehouse.setCatalog(db.catalog)
    service.setCatalog(db.catalog)
    // executor 的 catalog/registry/Item 一起切到协商版本，否则数字 id 跨字典
    // 错位（合成会拿旧字典的 id 查新 registry 的配方）。
    bot._craftingExecutor?.setCatalog?.(db.catalog)
    warehouseCatalogVersion = negotiated
    console.log(`[via] warehouse/service 物品字典已切换到 ${negotiated}`)
  })

  // Synthesis (ported from olela bot): attach the crafting executor to this bot.
  // It registers itself as bot._craftingExecutor; the service enqueues craft tasks.
  if (launchConfig.craft?.enabled !== false) {
    try {
      const { attachCraftingExecutor } = require('./craft')
      attachCraftingExecutor(bot, {
        config: launchConfig,
        catalog,
        warehouse,
        debugCraft: (event, details) => service.debugCraft(event, details)
      })
    } catch (error) {
      console.warn(`[craft] executor attach failed: ${error.message}`)
    }
  }
  service.setWebAuth(webServer)
  // 热重载收尾钩子：断开全部 bot 并关资源后显式退出（exit 0），
  // 由外层守护（screen 循环/systemd）或 spawnSuccessor 拉起的新进程接替。
  service.setHotReloadHooks(shutdownForHotReload, () => {
    process.exit(0)
    return true
  })
  setupRegistryExport(bot, catalog, db)

  // 服务器资源包语言提取：mineflayer 只回状态不真下载，自定义内容（dnt 系附魔等）
  // 的中文翻译客户端是从资源包 lang 文件里拿的。真下载解析出来补进当前字典，
  // 再用缓存的注册表包重导附魔翻译并刷新显示名。
  watchPackLanguage(bot, {
    onLang: (merged) => {
      const active = db.catalog || catalog
      const added = active.mergeLanguage(merged)
      console.log(`[packLang] merged ${added} new translations into item catalog`)
      const packet = bot._lastEnchantmentRegistryPacket
      if (packet) {
        const exported = exportEnchantmentRegistry(packet, active)
        if (exported) applyEnchantmentRegistry(exported, active, db)
      } else {
        db.refreshItemDisplayNames(active)
      }
    }
  })

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
    if (!hotReloadNotifyChecked) {
      hotReloadNotifyChecked = true
      deliverHotReloadNotify(service)
    }
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

  // 调试：协议解析炸（PartialReadError）时把 wire 原始 hex 打到终端实时日志
  // 背景：FullPacketParser._transform 对 partialReadError 只 console.log + cb() 吞包，
  // client 层 'error' 事件收不到（#149 钩子因此失效）。
  // 改法：monkey-patch deserializer.parsePacketBuffer，catch 时打印 wire hex 再原样抛回。
  // 坑：重连会重建 bot._client 与 deserializer，一次性 patch 会丢（d89bc56 在重连后哑火）；
  // 故挂 spawn 每次安装，幂等标记 __viaDumpPatched 在实例上，新实例会被重新 patch。
  const installViaDumpHook = () => {
    const deserializer = bot._client?.deserializer
    if (!deserializer || typeof deserializer.parsePacketBuffer !== 'function' || deserializer.__viaDumpPatched) return
    const origParse = deserializer.parsePacketBuffer.bind(deserializer)
    deserializer.__viaDumpPatched = true
    deserializer.parsePacketBuffer = (buffer) => {
      try {
        return origParse(buffer)
      } catch (e) {
        if (e?.partialReadError && buffer?.length) {
          console.log(`[via] 解析炸 wire hex（len=${buffer.length}）: ${buffer.toString('hex').replace(/(..)/g, '$1 ').trim()}`)
        }
        throw e
      }
    }
    console.log('[via] dump 钩子已安装（deserializer 已 patch）')
  }
  installViaDumpHook()
  bot.on('spawn', installViaDumpHook)

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
    uninstallTickEndPatch?.()
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
    // 必须用"当前生效"字典而不是闭包捕获的 catalog：后者是启动初始版
    // （config.server.version，如 1.21.11），第二只 bot / 掉线重连触发
    // registry_data 时若用它刷全表，26.3 新物品（sulfur 等）display_name
    // 会被写成小写英文；而重连的 login 已因版本相同跳过切换，没人再刷回
    // 中文，Web 库存表就卡在英文直到 !同步（2026-11-19 热重载后 sulfur 案）。
    const active = db.catalog || catalog
    const exported = exportEnchantmentRegistry(packet, active)
    if (!exported) return
    // 缓存注册表包：资源包语言提取完成后用它重导（dnt 系附魔翻译在包里）。
    bot._lastEnchantmentRegistryPacket = packet
    applyEnchantmentRegistry(exported, active, db)
  })
  bot._client?.on('registry_data', packet => {
    // minecraft:potion registry：26.x 本地字典无 potion registry，开窗协议
    // 解码 potion_contents 用数字 id，Servux NBT 用字符串名——药水指纹归一
    // 靠这份导出的 id↔名映射（data/server-potions.json）。2026-11-20 长抗火
    // 药水案：两形状分裂 → 取货 7 桶全扑空。
    const active = db.catalog || catalog
    const exportedPotions = exportPotionRegistry(packet)
    if (exportedPotions) {
      applyPotionRegistry(exportedPotions, active, db)
      return
    }
    // minecraft:mob_effect registry：custom_effects 条目两路形状（开窗数字 id
    // vs Servux 字符串名）归一同理靠这份映射。2026-11-20 漂浮药水案：
    // a1da56（隔空）vs 9669a5f（开窗）两 key 分裂 → 取货开桶全扑空、修账留悬空。
    const exportedEffects = exportEffectRegistry(packet)
    if (exportedEffects) {
      applyEffectRegistry(exportedEffects, active, db)
    }
  })
}

function applyPotionRegistry (exported, catalog, db) {
  const filePath = path.resolve(process.cwd(), 'data', 'server-potions.json')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(exported, null, 2), 'utf8')
  console.log(`[registry] exported ${exported.count} server potions to ${filePath}`)
  const loaded = catalog.reloadServerPotions(filePath)
  console.log(`[registry] reloaded ${loaded} server potion mappings`)
  // 登录晚于启动迁移：字符串形状的药水档在启动那轮转不了数字 id，这里
  // 补跑一次指纹迁移（幂等，stable 档零开销），让 1a7d/c1ce82 类两代档
  // 当场并 key，不必等下次热重载。
  if (typeof db?.canonicalizeItemKeys === 'function') {
    try {
      const merged = db.canonicalizeItemKeys(catalog)
      if (merged > 0) console.log(`[registry] potion migration merged ${merged} item keys`)
    } catch (err) {
      console.log(`[registry] potion migration retry failed: ${err.message}`)
    }
  }
}

function exportPotionRegistry (packet) {
  const registryId = String(packet?.id || packet?.registryId || '')
  if (registryId !== 'minecraft:potion' && registryId !== 'potion') return null
  const entries = Array.isArray(packet.entries) ? packet.entries : []
  const potions = entries
    .map((entry, index) => {
      const key = String(entry?.key || entry?.name || '')
      if (!key) return null
      return { id: index, key, name: key.replace(/^minecraft:/, '') }
    })
    .filter(Boolean)
  return {
    source: 'server_registry_data',
    registryId,
    exportedAt: new Date().toISOString(),
    count: potions.length,
    potions
  }
}

// mob_effect registry 导出/应用：custom_effects 归一需要的效果名→数字 id 映射，
// 同 potion 一套（写盘 → 重载映射 → 补跑指纹迁移让两代 custom_effects 档当场并 key）。
function applyEffectRegistry (exported, catalog, db) {
  const filePath = path.resolve(process.cwd(), 'data', 'server-effects.json')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(exported, null, 2), 'utf8')
  console.log(`[registry] exported ${exported.count} server effects to ${filePath}`)
  const loaded = catalog.reloadServerEffects(filePath)
  console.log(`[registry] reloaded ${loaded} server effect mappings`)
  // 登录晚于启动迁移：字符串形状的 custom_effects 档在启动那轮转不了数字 id，
  // 这里补跑一次指纹迁移（幂等），让 a1da56/9669a5f 类两代档当场并 key。
  if (typeof db?.canonicalizeItemKeys === 'function') {
    try {
      const merged = db.canonicalizeItemKeys(catalog)
      if (merged > 0) console.log(`[registry] effect migration merged ${merged} item keys`)
    } catch (err) {
      console.log(`[registry] effect migration retry failed: ${err.message}`)
    }
  }
}

function exportEffectRegistry (packet) {
  const registryId = String(packet?.id || packet?.registryId || '')
  if (registryId !== 'minecraft:mob_effect' && registryId !== 'mob_effect') return null
  const entries = Array.isArray(packet.entries) ? packet.entries : []
  const effects = entries
    .map((entry, index) => {
      const key = String(entry?.key || entry?.name || '')
      if (!key) return null
      return { id: index, key, name: key.replace(/^minecraft:/, '') }
    })
    .filter(Boolean)
  return {
    source: 'server_registry_data',
    registryId,
    exportedAt: new Date().toISOString(),
    count: effects.length,
    effects
  }
}

function applyEnchantmentRegistry (exported, active, db) {
  const filePath = path.resolve(process.cwd(), 'data', 'server-enchantments.json')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(exported, null, 2), 'utf8')
  console.log(`[registry] exported ${exported.count} server enchantments to ${filePath}`)
  logEnchantmentRegistry(exported.enchantments)

  const loaded = active.reloadServerEnchantments(filePath)
  console.log(`[registry] reloaded ${loaded} server enchantment mappings`)
  const refreshed = db.refreshItemDisplayNames(active)
  if (refreshed > 0) {
    console.log(`[registry] refreshed ${refreshed} stored item display names`)
  }
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
    // 数据包附魔的 description 常是纯字符串中文描述（supersteve2333:shell_breaker
    // 的 registry data 里 description="碎壳"）——之前只认 text/translate/fallback
    // 对象形状，纯字符串漏接，displayName 回退裸名，附魔书就显示成
    // "supersteve2333:shell_breaker一"（8 月 34e301e7 档）。接住后走
    // refreshItemDisplayNames 链，存量书名自动刷成"碎壳一"。
    if (typeof description === 'string' && description.trim()) {
      return description.trim()
    }
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

process.on('uncaughtException', (error) => {
  console.error('[process] uncaught exception:', error)
  logLocalError('uncaught-exception', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection:', reason)
  logLocalError('unhandled-rejection', reason)
})

// !热重载 / SIGINT / SIGTERM 共用的全局收尾：断开全部 bot（不再重连）、关闭 Web 端口、
// 订阅和 DB。退出后由外层守护（screen 循环/systemd）或 spawnSuccessor 拉起的新进程接替。
function shutdownForHotReload () {
  if (shuttingDown) return
  shuttingDown = true
  for (const state of states.values()) {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    state.reconnectTimer = null
    state.desiredEnabled = false
    try { state.bot?.quit('shutdown') } catch {}
  }
  try { webServer.server?.close?.() } catch {}
  subscriptions.close()
  db.close()
}

process.on('SIGINT', () => {
  shutdownForHotReload()
  process.exit(0)
})

process.on('SIGTERM', () => {
  // 外层守护（screen 循环/systemd 重启、运维手动 stop）统一走这条收尾：
  // 断开全部 bot、关订阅和 DB，再退出；未收尾直接 kill 会留下 WAL 未合并、bot 未 quit。
  shutdownForHotReload()
  process.exit(0)
})

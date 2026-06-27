const fs = require('node:fs')
const path = require('node:path')
const mineflayer = require('mineflayer')
const nbt = require('prismarine-nbt')
const { pathfinder } = require('mineflayer-pathfinder')
const { loadConfig } = require('./config')
const StoreDb = require('./db')
const ItemCatalog = require('./itemCatalog')
const Warehouse = require('./warehouse')
const CloudStoreService = require('./service')
const CloudStoreWebServer = require('./webServer')

function createBot (config) {
  const options = {
    host: config.server.host,
    port: config.server.port,
    username: config.server.username,
    auth: config.server.auth,
    version: config.server.version,
    locale: config.server.locale || 'zh_CN',
    logErrors: false
  }

  if (config.server.password) options.password = config.server.password
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

function buildProtocolVersionList (config) {
  const configured = config.server.version
  const fallbacks = Array.isArray(config.server.protocolFallbackVersions)
    ? config.server.protocolFallbackVersions
    : (configured === '1.21.11' ? ['1.21.9', '1.21.8'] : [])
  const versions = [configured, ...fallbacks]
    .map(version => String(version || '').trim())
    .filter(Boolean)
  return [...new Set(versions)]
}

function shouldFallbackProtocol (error) {
  const message = String(error?.message || error || '')
  return /SlotComponent|array size is abnormally large|Read error.*intArray|play\.toClient/i.test(message)
}

function advanceProtocolFallback (reason) {
  if (protocolVersionIndex >= protocolVersions.length - 1) return false
  const previous = protocolVersions[protocolVersionIndex]
  protocolVersionIndex += 1
  console.error(`[protocol] ${previous} 启动失败，切换到 ${protocolVersions[protocolVersionIndex]}。原因：${reason}`)
  return true
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
const protocolVersions = buildProtocolVersionList(config)
let protocolVersionIndex = 0
let catalog = createCatalogForVersion(protocolVersions[protocolVersionIndex] || config.server.version)
attachCatalog(catalog)

console.log(`Starting cloud store bot: ${config.server.username}@${config.server.host}:${config.server.port}`)
console.log(`Minecraft version: ${config.server.version}, auth: ${config.server.auth}`)
if (protocolVersions.length > 1) {
  console.log(`Protocol fallback versions: ${protocolVersions.join(' -> ')}`)
}

let currentBot = null
let currentService = null
let shuttingDown = false
let reconnectTimer = null
let reconnectAttempt = 0
const webServer = new CloudStoreWebServer(db, config, () => currentService)
webServer.start()

launchBot()

function launchBot () {
  if (shuttingDown) return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  reconnectAttempt += 1
  if (reconnectAttempt > 1) {
    console.log(`[reconnect] attempt ${reconnectAttempt}`)
  }

  const activeVersion = protocolVersions[protocolVersionIndex] || config.server.version
  if (activeVersion !== config.server.version) {
    console.log(`[protocol] launching with fallback Minecraft version ${activeVersion}`)
  }
  if (catalog.version !== activeVersion) {
    catalog = createCatalogForVersion(activeVersion)
    attachCatalog(catalog)
  }

  const launchConfig = {
    ...config,
    server: {
      ...config.server,
      version: activeVersion
    }
  }

  const bot = createBot(launchConfig)
  currentBot = bot
  let loggedIn = false
  let spawned = false
  let lastDisconnectReason = ''
  const acceptedResourcePacks = new Set()

  const warehouse = new Warehouse(bot, db, catalog, launchConfig)
  const service = new CloudStoreService(bot, db, catalog, warehouse, launchConfig)
  service.setWebAuth(webServer)
  setupRegistryExport(bot, catalog, db)

  const loginWatchdog = setInterval(() => {
    if (!loggedIn) {
      console.log('[login] 仍在等待登录完成。如果使用 microsoft 且首次登录，请查看是否出现 microsoft.com/link 验证码。')
    } else if (!spawned) {
      console.log('[login] 已登录，仍在等待 spawn。可能正在等待服务器资源包确认、服务器队列或插件验证。')
    }
  }, 15000)

  bot.once('login', () => {
    loggedIn = true
    bot.setSettings?.({ locale: config.server.locale || 'zh_CN' })
    console.log('Bot logged in, waiting for spawn...')
  })

  bot.once('spawn', () => {
    spawned = true
    reconnectAttempt = 0
    clearInterval(loginWatchdog)
    console.log(`Cloud store bot spawned as ${bot.username}`)
    currentService = service
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
    console.error('Bot kicked:', reason)
    const kickReason = formatKickReason(reason)
    lastDisconnectReason = kickReason
    if (!spawned && /outdated|version|protocol|版本|协议/i.test(kickReason)) {
      advanceProtocolFallback(`kick before spawn: ${kickReason}`)
    }
  })

  bot.on('error', error => {
    if (isSocketDisconnectError(error)) {
      console.warn(`[network] ${error.code}: socket 已断开，等待重连。${lastDisconnectReason ? `lastReason=${lastDisconnectReason}` : '通常是服务器/代理主动断开或网络抖动。'}`)
      return
    }
    if (!spawned && shouldFallbackProtocol(error)) {
      const advanced = advanceProtocolFallback(error.message)
      if (advanced) {
        console.error(`[protocol] Slot/NBT 解析失败，准备用 ${protocolVersions[protocolVersionIndex]} 重连：${error.message}`)
        try {
          bot._client?.end('protocol fallback')
        } catch {}
        scheduleReconnect(1000)
        return
      }
    }
    console.error('Bot error:', error)
  })

  bot.on('end', () => {
    clearInterval(loginWatchdog)
    console.log(`Bot disconnected${lastDisconnectReason ? `: ${lastDisconnectReason}` : ''}`)
    if (currentBot === bot) currentBot = null
    if (currentService === service) currentService = null
    scheduleReconnect()
  })
}

function setupRegistryExport (bot, catalog, db) {
  bot._client?.on('registry_data', packet => {
    const exported = exportEnchantmentRegistry(packet, catalog)
    if (!exported) return

    const filePath = path.resolve(process.cwd(), 'data', 'server-enchantments.json')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(exported, null, 2), 'utf8')
    const sample = exported.enchantments
      .slice(0, 12)
      .map(entry => `${entry.id}:${entry.key}=${entry.displayName}`)
      .join(' | ')
    console.log(`[registry] exported ${exported.count} server enchantments to ${filePath}`)
    console.log(`[registry] enchantment sample: ${sample}`)

    const loaded = catalog.reloadServerEnchantments(filePath)
    console.log(`[registry] reloaded ${loaded} server enchantment mappings`)
    const refreshed = db.refreshItemDisplayNames(catalog)
    if (refreshed > 0) {
      console.log(`[registry] refreshed ${refreshed} stored item display names`)
    }
  })
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

function scheduleReconnect (delayOverrideMs = null) {
  if (shuttingDown || reconnectTimer) return
  const delay = Math.max(1000, Number(delayOverrideMs || config.timing?.reconnectDelayMs || 10000))
  console.log(`[reconnect] will reconnect in ${delay}ms`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    try {
      launchBot()
    } catch (error) {
      console.error('[reconnect] failed to launch bot:', error)
      scheduleReconnect()
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
  if (reconnectTimer) clearTimeout(reconnectTimer)
  db.close()
  currentBot?.quit('shutdown')
  process.exit(0)
})

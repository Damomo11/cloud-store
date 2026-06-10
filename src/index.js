const fs = require('node:fs')
const path = require('node:path')
const mineflayer = require('mineflayer')
const nbt = require('prismarine-nbt')
const { pathfinder } = require('mineflayer-pathfinder')
const StoreDb = require('./db')
const ItemCatalog = require('./itemCatalog')
const Warehouse = require('./warehouse')
const CloudStoreService = require('./service')
const CloudStoreWebServer = require('./webServer')

function loadConfig () {
  const configPath = path.resolve(process.cwd(), 'config.json')
  if (!fs.existsSync(configPath)) {
    throw new Error('找不到 config.json，请复制 config.example.json 后填写服务器配置。')
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'))
}

function createBot (config) {
  const options = {
    host: config.server.host,
    port: config.server.port,
    username: config.server.username,
    auth: config.server.auth,
    version: config.server.version,
    locale: config.server.locale || 'zh_CN'
  }

  if (config.server.password) options.password = config.server.password
  if (config.server.profilesFolder) {
    options.profilesFolder = path.resolve(process.cwd(), config.server.profilesFolder)
  }

  const bot = mineflayer.createBot(options)

  bot.loadPlugin(pathfinder)
  return bot
}

const config = loadConfig()
const db = new StoreDb(path.resolve(process.cwd(), 'data', 'cloud-store.sqlite'), config)
const catalog = new ItemCatalog(config.server.version, config.aliases, config.language)
db.setCatalog(catalog)
const refreshedDisplayNames = db.refreshItemDisplayNames(catalog)
if (refreshedDisplayNames > 0) {
  console.log(`Refreshed ${refreshedDisplayNames} stored item display names`)
}

console.log(`Starting cloud store bot: ${config.server.username}@${config.server.host}:${config.server.port}`)
console.log(`Minecraft version: ${config.server.version}, auth: ${config.server.auth}`)

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

  const bot = createBot(config)
  currentBot = bot
  let loggedIn = false
  let spawned = false

  const warehouse = new Warehouse(bot, db, catalog, config)
  const service = new CloudStoreService(bot, db, catalog, warehouse, config)
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
      console.log('[resourcePack] accepting resource pack via mineflayer helper')
      try {
        bot.acceptResourcePack()
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
      acceptResourcePackDirect(bot, data.uuid)
    }
  })

  bot._client?.on('resource_pack_send', data => {
    console.log('[resourcePack] resource_pack_send packet:', JSON.stringify(data))
    if (config.resourcePack?.autoAccept !== false && data.uuid) {
      acceptResourcePackDirect(bot, data.uuid)
    }
  })

  bot.on('kicked', reason => {
    clearInterval(loginWatchdog)
    console.error('Bot kicked:', reason)
  })

  bot.on('error', error => {
    console.error('Bot error:', error)
  })

  bot.on('end', () => {
    clearInterval(loginWatchdog)
    console.log('Bot disconnected')
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

function scheduleReconnect () {
  if (shuttingDown || reconnectTimer) return
  const delay = Math.max(1000, Number(config.timing?.reconnectDelayMs || 10000))
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

function acceptResourcePackDirect (bot, uuid) {
  const statuses = [
    ['ACCEPTED', 3],
    ['DOWNLOADED', 4],
    ['SUCCESSFULLY_LOADED', 0]
  ]

  for (const [label, result] of statuses) {
    try {
      bot._client.write('resource_pack_receive', { uuid, result })
      console.log(`[resourcePack] sent ${label} for ${uuid}`)
    } catch (error) {
      console.error(`[resourcePack] failed to send ${label}:`, error)
    }
  }
}

process.on('SIGINT', () => {
  shuttingDown = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  db.close()
  currentBot?.quit('shutdown')
  process.exit(0)
})

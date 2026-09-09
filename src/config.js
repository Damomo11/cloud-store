const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_CONFIG = {
  bots: [],
  server: {
    host: '127.0.0.1',
    port: 25565,
    username: '',
    botName: 'NanKinz1',
    auth: 'microsoft',
    password: '',
    profilesFolder: 'auth-cache',
    version: '1.21.11',
    locale: 'zh_CN'
  },
  admins: [],
  momoOwner: '__momo__',
  web: {
    enabled: true,
    host: '127.0.0.1',
    port: 8787,
    trustProxy: false,
    maxLoginFailures: 5,
    loginFailWindowMs: 600000,
    loginBlockMs: 600000,
    loginCodeTtlMs: 120000,
    sessionTtlMs: 2592000000,
    botPlatformUrl: 'http://127.0.0.1:8788',
    botPlatformSsoSecretFile: 'data/bot-platform-sso.key'
  },
  storage: {
    defaultQuotaSlots: 270,
    defaultCustomWarehouseQuotaSlots: 270,
    maxCustomWarehousesPerPlayer: 3
  },
  commands: {
    home: '/home ck',
    tpa: '/tpa {player}',
    tpaccept: '/tpaccept {player}',
    msg: '/msg {player} {message}',
    publicFallback: false
  },
  timing: {
    homeWaitMs: 3500,
    homeTimeoutMs: 30000,
    pickupWindowMs: 10000,
    depositLeaveDistance: 4,
    postTeleportWaitMs: 1500,
    dropIntervalMs: 250,
    dropConfirmTimeoutMs: 5000,
    dropConfirmRounds: 3,
    withdrawConfirmPasses: 2,
    quickShulkerOpenAttempts: 3,
    pickupSettleMs: 3500,
    pickupStableMs: 700,
    containerSettleMs: 250,
    containerClickIntervalMs: 50,
    openContainerTimeoutMs: 8000,
    openContainerAttempts: 3,
    openContainerTimeoutsMs: [2000, 4000, 8000],
    inventoryUpdateTimeoutMs: 2000,
    pathTimeoutMs: 15000,
    pathNoProgressMs: 4000,
    commandDedupeMs: 1500,
    teleportRequestTimeoutMs: 15000,
    teleportDetectRadius: 8,
    reconnectDelayMs: 10000
  },
  debug: true,
  debugChat: true,
  debugRawChat: false,
  resourcePack: {
    autoAccept: true
  },
  warehouse: {
    // Whether withdrawals may extract loose items from quick/openable shulker boxes.
    // Individual warehouses can override this setting in the admin panel.
    quickShulkerExtractionEnabled: true,
    layoutMode: 'normal',
    defaultSyncRadius: 16,
    pickupRadius: 2,
    homeSkipRadius: 8,
    maxSyncRadius: 64,
    maxEmptyDepositAttempts: 3,
    cylinder: {
      axis: 'x',
      tunnelCenter: {
        x: null,
        y: null,
        z: null
      },
      yOffsets: [0, -1, 1]
    },
    chestBlockNames: ['barrel']
  },
  language: {
    file: 'data/zh_cn.json'
  },
  aliases: {}
}

function stripJsonComments (text) {
  let result = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]

    if (inString) {
      result += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      result += ch
      continue
    }

    if (ch === '/' && next === '/') {
      i += 2
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++
      if (i < text.length) result += text[i]
      continue
    }

    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n' || text[i] === '\r') result += text[i]
        i++
      }
      i++
      continue
    }

    result += ch
  }

  return result
}

function normalizeConfig (config) {
  if (config?.server && config.server.auth !== 'microsoft') {
    console.warn('[config] only Microsoft OAuth2 is supported; auth has been set to microsoft in memory')
    config.server.auth = 'microsoft'
  }
  if (config?.web && typeof config.web.dashboardUrl === 'string' && !config.web.dashboardUrl.trim()) {
    delete config.web.dashboardUrl
  }
  return config
}

function isPlainObject (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cloneConfigValue (value) {
  if (Array.isArray(value)) return value.map(cloneConfigValue)
  if (isPlainObject(value)) {
    const result = {}
    for (const [key, child] of Object.entries(value)) result[key] = cloneConfigValue(child)
    return result
  }
  return value
}

function applyMissingDefaults (target, defaults, prefix = '') {
  const added = []
  if (!isPlainObject(target)) return added

  for (const [key, value] of Object.entries(defaults)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = cloneConfigValue(value)
      added.push(fullKey)
      continue
    }
    if (isPlainObject(target[key]) && isPlainObject(value)) {
      added.push(...applyMissingDefaults(target[key], value, fullKey))
    }
  }

  return added
}

function backupPathForConfig (configPath) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  return `${configPath}.bak-${stamp}`
}

function formatConfigFile (config) {
  return [
    '// Runtime config. Auto-updated by cloud-store; existing values are preserved.',
    '// Add web.dashboardUrl only when you need to show a public tunnel/proxy URL.',
    `${JSON.stringify(config, null, 2)}\n`
  ].join('\n')
}

function autoUpdateConfigFile (configPath, config, originalText) {
  const added = applyMissingDefaults(config, DEFAULT_CONFIG)
  if (!added.length) return { changed: false, added }

  const backupPath = backupPathForConfig(configPath)
  fs.writeFileSync(backupPath, originalText, 'utf8')
  fs.writeFileSync(configPath, formatConfigFile(config), 'utf8')
  console.log(`[config] added missing config fields: ${added.join(', ')}`)
  console.log(`[config] backup written to ${backupPath}`)
  return { changed: true, added, backupPath }
}

function parseConfigText (text, filePath = 'config.json') {
  try {
    return normalizeConfig(JSON.parse(stripJsonComments(text)))
  } catch (error) {
    throw new Error(`${filePath} 配置解析失败：${error.message}`)
  }
}

function loadConfig (configPath = path.resolve(process.cwd(), 'config.json'), options = {}) {
  if (!fs.existsSync(configPath)) {
    throw new Error('找不到 config.json，请复制 config.example.json 后填写服务器配置。')
  }
  const text = fs.readFileSync(configPath, 'utf8')
  const config = parseConfigText(text, configPath)
  if (options.autoUpdate) autoUpdateConfigFile(configPath, config, text)
  return config
}

function loadOptionalConfig (configPath = path.resolve(process.cwd(), 'config.json'), fallback = {}) {
  if (!fs.existsSync(configPath)) return fallback
  return loadConfig(configPath, { autoUpdate: false })
}

module.exports = {
  DEFAULT_CONFIG,
  applyMissingDefaults,
  autoUpdateConfigFile,
  loadConfig,
  loadOptionalConfig,
  parseConfigText,
  stripJsonComments
}

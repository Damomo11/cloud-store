const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const url = require('node:url')
const Database = require('better-sqlite3')
const { loadOptionalConfig } = require('../src/config')
const ItemCatalog = require('../src/itemCatalog')

const DEFAULT_PORT = Number.parseInt(process.env.ITEM_RENDER_PORT || '8791', 10)
const DB_PATH = path.resolve(process.cwd(), 'data', 'cloud-store.sqlite')

function loadConfig () {
  return loadOptionalConfig(path.resolve(process.cwd(), 'config.json'), {})
}

const config = loadConfig()
const catalog = new ItemCatalog(config.server?.version || '1.21.1', config.aliases || {}, config.language || { file: 'data/zh_cn.json' })
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })

const COLOR_MAP = {
  black: '#000000',
  dark_blue: '#0000aa',
  dark_green: '#00aa00',
  dark_aqua: '#00aaaa',
  dark_red: '#aa0000',
  dark_purple: '#aa00aa',
  gold: '#ffaa00',
  gray: '#aaaaaa',
  dark_gray: '#555555',
  blue: '#5555ff',
  green: '#55ff55',
  aqua: '#55ffff',
  red: '#ff5555',
  light_purple: '#ff55ff',
  yellow: '#ffff55',
  white: '#ffffff'
}

const POTION_ID_MAP = new Map([
  [0, { key: 'water', effects: [] }],
  [1, { key: 'mundane', effects: [] }],
  [2, { key: 'thick', effects: [] }],
  [3, { key: 'awkward', effects: [] }],
  [4, { key: 'night_vision', effects: [{ effect: 'night_vision', duration: 180 }] }],
  [5, { key: 'long_night_vision', displayKey: 'night_vision', effects: [{ effect: 'night_vision', duration: 480 }] }],
  [6, { key: 'invisibility', effects: [{ effect: 'invisibility', duration: 180 }] }],
  [7, { key: 'long_invisibility', displayKey: 'invisibility', effects: [{ effect: 'invisibility', duration: 480 }] }],
  [8, { key: 'leaping', effects: [{ effect: 'jump_boost', duration: 180 }] }],
  [9, { key: 'long_leaping', displayKey: 'leaping', effects: [{ effect: 'jump_boost', duration: 480 }] }],
  [10, { key: 'strong_leaping', displayKey: 'leaping', effects: [{ effect: 'jump_boost', amplifier: 1, duration: 90 }] }],
  [11, { key: 'fire_resistance', effects: [{ effect: 'fire_resistance', duration: 180 }] }],
  [12, { key: 'long_fire_resistance', displayKey: 'fire_resistance', effects: [{ effect: 'fire_resistance', duration: 480 }] }],
  [13, { key: 'swiftness', effects: [{ effect: 'speed', duration: 180 }] }],
  [14, { key: 'long_swiftness', displayKey: 'swiftness', effects: [{ effect: 'speed', duration: 480 }] }],
  [15, { key: 'strong_swiftness', displayKey: 'swiftness', effects: [{ effect: 'speed', amplifier: 1, duration: 90 }] }],
  [16, { key: 'slowness', effects: [{ effect: 'slowness', duration: 90 }] }],
  [17, { key: 'long_slowness', displayKey: 'slowness', effects: [{ effect: 'slowness', duration: 240 }] }],
  [18, { key: 'strong_slowness', displayKey: 'slowness', effects: [{ effect: 'slowness', amplifier: 3, duration: 20 }] }],
  [19, { key: 'water_breathing', effects: [{ effect: 'water_breathing', duration: 180 }] }],
  [20, { key: 'long_water_breathing', displayKey: 'water_breathing', effects: [{ effect: 'water_breathing', duration: 480 }] }],
  [21, { key: 'healing', effects: [{ effect: 'instant_health' }] }],
  [22, { key: 'strong_healing', displayKey: 'healing', effects: [{ effect: 'instant_health', amplifier: 1 }] }],
  [23, { key: 'harming', effects: [{ effect: 'instant_damage' }] }],
  [24, { key: 'strong_harming', displayKey: 'harming', effects: [{ effect: 'instant_damage', amplifier: 1 }] }],
  [25, { key: 'poison', effects: [{ effect: 'poison', duration: 45 }] }],
  [26, { key: 'long_poison', displayKey: 'poison', effects: [{ effect: 'poison', duration: 90 }] }],
  [27, { key: 'strong_poison', displayKey: 'poison', effects: [{ effect: 'poison', amplifier: 1, duration: 21 }] }],
  [28, { key: 'regeneration', effects: [{ effect: 'regeneration', duration: 45 }] }],
  [29, { key: 'long_regeneration', displayKey: 'regeneration', effects: [{ effect: 'regeneration', duration: 90 }] }],
  [30, { key: 'strong_regeneration', displayKey: 'regeneration', effects: [{ effect: 'regeneration', amplifier: 1, duration: 22 }] }],
  [31, { key: 'strength', effects: [{ effect: 'strength', duration: 180 }] }],
  [32, { key: 'long_strength', displayKey: 'strength', effects: [{ effect: 'strength', duration: 480 }] }],
  [33, { key: 'strong_strength', displayKey: 'strength', effects: [{ effect: 'strength', amplifier: 1, duration: 90 }] }],
  [34, { key: 'weakness', effects: [{ effect: 'weakness', duration: 90 }] }],
  [35, { key: 'long_weakness', displayKey: 'weakness', effects: [{ effect: 'weakness', duration: 240 }] }],
  [36, { key: 'luck', effects: [{ effect: 'luck', duration: 300 }] }],
  [37, { key: 'turtle_master', effects: [{ effect: 'slowness', amplifier: 3, duration: 20 }, { effect: 'resistance', amplifier: 2, duration: 20 }] }],
  [38, { key: 'long_turtle_master', displayKey: 'turtle_master', effects: [{ effect: 'slowness', amplifier: 3, duration: 40 }, { effect: 'resistance', amplifier: 2, duration: 40 }] }],
  [39, { key: 'strong_turtle_master', displayKey: 'turtle_master', effects: [{ effect: 'slowness', amplifier: 5, duration: 20 }, { effect: 'resistance', amplifier: 3, duration: 20 }] }],
  [40, { key: 'slow_falling', effects: [{ effect: 'slow_falling', duration: 90 }] }],
  [41, { key: 'long_slow_falling', displayKey: 'slow_falling', effects: [{ effect: 'slow_falling', duration: 240 }] }],
  [42, { key: 'wind_charged', effects: [{ effect: 'wind_charged', duration: 180 }] }],
  [43, { key: 'weaving', effects: [{ effect: 'weaving', duration: 180 }] }],
  [44, { key: 'oozing', effects: [{ effect: 'oozing', duration: 180 }] }],
  [45, { key: 'infested', effects: [{ effect: 'infested', duration: 180 }] }]
])

function parseJson (text, fallback = null) {
  if (!text) return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function getComponent (components, type) {
  if (!Array.isArray(components)) return null
  return components.find(component => component?.type === type) || null
}

function unwrap (value) {
  if (!value || typeof value !== 'object') return value
  if (Object.prototype.hasOwnProperty.call(value, 'value') && typeof value.type === 'string') return unwrap(value.value)
  return value
}

function getTextColor (value, fallback = 'white') {
  const raw = unwrap(value)
  if (raw && typeof raw === 'object') {
    const color = unwrap(raw.color)
    if (typeof color === 'string') return COLOR_MAP[color] || color
  }
  return COLOR_MAP[fallback] || fallback
}

function componentText (value) {
  return catalog.componentText(value).trim()
}

function line (text, color = 'gray', options = {}) {
  return {
    text: String(text || ''),
    color: COLOR_MAP[color] || color,
    italic: Boolean(options.italic),
    dim: Boolean(options.dim)
  }
}

function getLoreLines (components) {
  const lore = getComponent(components, 'lore')
  if (!Array.isArray(lore?.data)) return []
  return lore.data.map(entry => {
    const text = componentText(entry)
    if (!text) return null
    return line(text, getTextColor(entry, 'dark_purple'), { italic: true })
  }).filter(Boolean)
}

function getDamage (components) {
  const component = getComponent(components, 'damage')
  const damage = Number.parseInt(component?.data, 10)
  return Number.isFinite(damage) ? damage : null
}

function translate (key, fallback = key) {
  return catalog.language?.[key] || fallback
}

function formatDuration (seconds) {
  if (!Number.isFinite(seconds)) return ''
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = String(total % 60).padStart(2, '0')
  return `${minutes}:${rest}`
}

function formatEffectName (effect) {
  const translated = translate(`effect.minecraft.${effect.effect}`, effect.effect.replace(/_/g, ' '))
  const amplifier = Number.parseInt(effect.amplifier || 0, 10)
  const withAmplifier = amplifier > 0 ? `${translated} ${translate(`potion.potency.${amplifier}`, amplifier + 1)}` : translated
  if (!Number.isFinite(effect.duration)) return withAmplifier
  return translate('potion.withDuration', '%s（%s）')
    .replace('%s', withAmplifier)
    .replace('%s', formatDuration(effect.duration))
}

function normalizePotionEffectName (name) {
  return String(name || '')
    .replace(/^minecraft:/, '')
    .replace(/^long_/, '')
    .replace(/^strong_/, '')
}

function potionNameForItem (itemId, potion) {
  const simple = String(itemId || '').replace(/^minecraft:/, '')
  const base = ['potion', 'splash_potion', 'lingering_potion', 'tipped_arrow'].includes(simple) ? simple : 'potion'
  const displayKey = potion?.displayKey || normalizePotionEffectName(potion?.key || 'water')
  const key = `item.minecraft.${base}.effect.${displayKey}`
  return translate(key, catalog.getDisplayName(itemId))
}

function getPotionInfo (itemId, components) {
  const component = getComponent(components, 'potion_contents')
  if (!component?.data) return null
  const id = Number.parseInt(component.data.potionId, 10)
  const mapped = Number.isFinite(id) ? POTION_ID_MAP.get(id) : null
  const customEffects = Array.isArray(component.data.customEffects) ? component.data.customEffects : []
  const effects = mapped?.effects ? [...mapped.effects] : []

  for (const effect of customEffects) {
    const rawId = effect.id ?? effect.effect ?? effect.type
    const mcEffect = typeof rawId === 'number' ? catalog.mcData.effects?.[rawId] : null
    const effectName = String(mcEffect?.name || rawId || '').replace(/^minecraft:/, '')
    if (!effectName) continue
    effects.push({
      effect: effectName,
      amplifier: Number.parseInt(effect.amplifier || 0, 10),
      duration: Number.isFinite(Number(effect.duration)) ? Math.floor(Number(effect.duration) / 20) : undefined
    })
  }

  return {
    id: Number.isFinite(id) ? id : null,
    key: mapped?.key || '',
    displayName: mapped ? potionNameForItem(itemId, mapped) : catalog.getDisplayName(itemId),
    effects,
    customColor: component.data.customColor ?? null,
    guessed: Boolean(mapped)
  }
}

function getTitle (row, components, potion) {
  const customName = getComponent(components, 'custom_name')
  if (customName?.data) {
    const text = componentText(customName.data)
    if (text) return { text, color: getTextColor(customName.data, 'white'), custom: true }
  }
  if (potion?.displayName) return { text: potion.displayName, color: COLOR_MAP.white, custom: false }
  return { text: row.displayName || catalog.describeStoredItem(row.itemId, row.metaJson, row.nbtJson), color: COLOR_MAP.white, custom: false }
}

function getContainerLines (components) {
  const container = getComponent(components, 'container')
  const contents = Array.isArray(container?.data?.contents) ? container.data.contents : []
  const nonEmpty = contents.filter(entry => Number.parseInt(entry?.itemCount || 0, 10) > 0)
  if (!nonEmpty.length) return []
  const shown = nonEmpty.slice(0, 5).map(entry => {
    const item = catalog.mcData.items?.[entry.itemId]
    const name = item ? catalog.getDisplayName(`minecraft:${item.name}`) : `itemId ${entry.itemId}`
    return line(`${name} x${entry.itemCount}`, 'gray')
  })
  if (nonEmpty.length > shown.length) shown.push(line(`以及另外 ${nonEmpty.length - shown.length} 格...`, 'dark_gray'))
  return [line(`盒内物品：${nonEmpty.length} 格`, 'gray'), ...shown]
}

function renderTooltip (row) {
  const meta = catalog.parseStoredJson(row.metaJson, {})
  const nbt = catalog.parseStoredJson(row.nbtJson, null)
  const components = Array.isArray(meta.components) ? meta.components : []
  const potion = getPotionInfo(row.itemId, components)
  const title = getTitle(row, components, potion)
  const lines = []

  const enchantments = catalog.extractEnchantments(components)
  for (const enchantment of enchantments) {
    lines.push(line(catalog.formatEnchantment(enchantment), 'gray'))
  }

  const lore = getLoreLines(components)
  if (lore.length && lines.length) lines.push(line('', 'gray'))
  lines.push(...lore)

  if (potion) {
    if (lines.length) lines.push(line('', 'gray'))
    if (potion.effects.length) {
      lines.push(line(translate('potion.whenDrank', '当生效后：'), 'dark_purple'))
      for (const effect of potion.effects) lines.push(line(formatEffectName(effect), effect.effect?.includes('damage') || effect.effect?.includes('poison') ? 'red' : 'blue'))
    } else {
      lines.push(line(`potionId=${potion.id ?? 'null'}，无直接效果`, 'dark_gray'))
    }
    if (potion.id !== null) lines.push(line(`potionId=${potion.id}${potion.guessed ? ` -> ${potion.key}` : '，未知映射'}`, 'dark_gray'))
  }

  const containerLines = getContainerLines(components)
  if (containerLines.length) {
    if (lines.length) lines.push(line('', 'gray'))
    lines.push(...containerLines)
  }

  const damage = getDamage(components)
  const simple = String(row.itemId || '').replace(/^minecraft:/, '')
  const maxDurability = catalog.mcData.itemsByName[simple]?.maxDurability
  if (damage !== null || nbt?.value?.Damage) {
    const actualDamage = damage ?? nbt.value.Damage.value
    const durability = maxDurability ? `${Math.max(0, maxDurability - actualDamage)} / ${maxDurability}` : `damage=${actualDamage}`
    if (lines.length) lines.push(line('', 'gray'))
    lines.push(line(`耐久度：${durability}`, 'gray'))
  }

  if (!lines.length) {
    lines.push(line(catalog.getDisplayName(row.itemId), 'dark_gray'))
  }

  const componentTypes = components.map(component => component?.type).filter(Boolean)
  return {
    title,
    lines,
    itemId: row.itemId,
    amount: Number(row.amount || 0),
    stackSize: catalog.getStackSize(row.itemId),
    shortCode: row.shortCode || '',
    componentTypes,
    hasNbt: Boolean(row.nbtJson && row.nbtJson !== 'null'),
    hasMeta: Boolean(row.metaJson && row.metaJson !== 'null' && row.metaJson !== ''),
    meta,
    nbt,
    potion
  }
}

function rowToItem (row) {
  const tooltip = renderTooltip(row)
  return {
    itemKey: row.itemKey,
    shortKey: String(row.itemKey || '').split('|')[1]?.slice(0, 6) || '',
    itemId: row.itemId,
    displayName: row.displayName,
    amount: Number(row.amount || 0),
    tooltip
  }
}

function listItems (q = '') {
  const query = `%${q.trim()}%`
  const rows = db.prepare(`
    SELECT i.item_key AS itemKey,
           i.item_id AS itemId,
           i.display_name AS displayName,
           i.nbt_json AS nbtJson,
           i.meta_json AS metaJson,
           COALESCE(SUM(b.amount), 0) AS amount,
           MIN(a.short_code) AS shortCode
    FROM items i
    LEFT JOIN balances b ON b.item_key = i.item_key
    LEFT JOIN item_key_aliases a ON a.item_key = i.item_key
    WHERE @q = ''
       OR i.item_id LIKE @query
       OR i.display_name LIKE @query
       OR i.meta_json LIKE @query
       OR i.nbt_json LIKE @query
       OR a.short_code LIKE @query
    GROUP BY i.item_key
    ORDER BY (i.meta_json NOT IN ('', 'null')) DESC,
             (i.nbt_json NOT IN ('', 'null')) DESC,
             amount DESC,
             i.display_name COLLATE NOCASE ASC
    LIMIT 240
  `).all({ q: q.trim(), query })
  return rows.map(rowToItem)
}

function sendJson (res, data, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(data))
}

function serveHtml (res) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(HTML)
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true)
  if (parsed.pathname === '/') return serveHtml(res)
  if (parsed.pathname === '/api/items') return sendJson(res, { ok: true, items: listItems(String(parsed.query.q || '')) })
  sendJson(res, { ok: false, error: 'not_found' }, 404)
})

function listen (port) {
  server.once('error', error => {
    if (error.code === 'EADDRINUSE') return listen(port + 1)
    throw error
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`[item-render-preview] listening on http://127.0.0.1:${port}/`)
    console.log('[item-render-preview] this test server reads SQLite only and does not start the bot.')
  })
}

listen(Number.isFinite(DEFAULT_PORT) ? DEFAULT_PORT : 8791)

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>物品 Meta 渲染预览</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #111215;
      --panel: #1a1b20;
      --line: #30323a;
      --text: #ececf2;
      --muted: #969aa6;
      --accent: #55ffff;
      --slot: #24262d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif;
    }
    .app {
      display: grid;
      grid-template-columns: minmax(320px, 460px) minmax(0, 1fr);
      min-height: 100vh;
    }
    aside {
      border-right: 1px solid var(--line);
      background: #15161a;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
    }
    header {
      padding: 18px 18px 12px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .note {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }
    .search {
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
    }
    input {
      width: 100%;
      height: 38px;
      border: 1px solid #3a3c46;
      border-radius: 6px;
      background: #202228;
      color: var(--text);
      padding: 0 12px;
      font-size: 14px;
      outline: none;
    }
    input:focus {
      border-color: #55ffff;
      box-shadow: 0 0 0 2px rgba(85, 255, 255, .12);
    }
    .items {
      overflow: auto;
      padding: 10px;
      display: grid;
      align-content: start;
      gap: 8px;
    }
    .item-row {
      border: 1px solid transparent;
      border-radius: 6px;
      background: #1b1c21;
      color: inherit;
      display: grid;
      grid-template-columns: 48px minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 8px;
      text-align: left;
      cursor: pointer;
    }
    .item-row:hover, .item-row.active {
      border-color: #4a4d5a;
      background: #22242b;
    }
    .item-icon, .big-icon {
      position: relative;
      display: grid;
      place-items: center;
      background: var(--slot);
      border: 1px solid #383b45;
      image-rendering: pixelated;
      overflow: hidden;
    }
    .item-icon { width: 48px; height: 48px; border-radius: 4px; }
    .big-icon { width: 96px; height: 96px; border-radius: 6px; }
    .item-icon img, .big-icon img { width: 82%; height: 82%; object-fit: contain; image-rendering: pixelated; }
    .count {
      position: absolute;
      right: 3px;
      bottom: 1px;
      font-family: Consolas, monospace;
      font-weight: 700;
      color: #fff;
      text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;
      font-size: 14px;
    }
    .name { min-width: 0; }
    .name strong {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
    }
    .name span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 4px;
    }
    .badge {
      border: 1px solid #3a3d46;
      color: #b8bbc7;
      border-radius: 999px;
      padding: 3px 7px;
      font-size: 12px;
      white-space: nowrap;
    }
    main {
      padding: 28px;
      overflow: auto;
    }
    .preview-head {
      display: flex;
      align-items: center;
      gap: 18px;
      margin-bottom: 22px;
    }
    .preview-head h2 {
      margin: 0 0 8px;
      font-size: 22px;
    }
    .meta-line {
      color: var(--muted);
      font-family: Consolas, monospace;
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .stage {
      display: grid;
      grid-template-columns: minmax(300px, max-content) minmax(280px, 1fr);
      gap: 22px;
      align-items: start;
    }
    .tooltip-wrap {
      min-height: 220px;
      display: grid;
      place-items: start;
    }
    .mc-tooltip {
      min-width: 260px;
      max-width: min(560px, calc(100vw - 40px));
      padding: 8px 9px 9px;
      background: rgba(16, 0, 16, .94);
      border: 2px solid #26005b;
      box-shadow:
        inset 2px 0 #5000ff,
        inset -2px 0 #28007f,
        inset 0 2px #5000ff,
        inset 0 -2px #28007f,
        0 12px 30px rgba(0,0,0,.35);
      font-family: "Minecraft", "Consolas", "Microsoft YaHei UI", monospace;
      font-size: 16px;
      line-height: 1.25;
      text-shadow: 2px 2px 0 rgba(0,0,0,.9);
      image-rendering: pixelated;
    }
    .mc-title {
      color: #fff;
      margin-bottom: 4px;
      min-height: 20px;
      overflow-wrap: anywhere;
    }
    .mc-line {
      min-height: 20px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .italic { font-style: italic; }
    .dim { opacity: .7; }
    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      overflow: hidden;
    }
    .panel h3 {
      margin: 0;
      padding: 12px 14px;
      font-size: 14px;
      border-bottom: 1px solid var(--line);
      color: #d8dae2;
    }
    .kv {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }
    .tag {
      font-size: 12px;
      color: #c9ccd6;
      background: #262832;
      border: 1px solid #3a3d49;
      border-radius: 999px;
      padding: 4px 8px;
    }
    pre {
      margin: 0;
      padding: 14px;
      max-height: 58vh;
      overflow: auto;
      color: #d7d9e2;
      font: 12px/1.55 Consolas, monospace;
      background: #14151a;
    }
    .empty {
      color: var(--muted);
      padding: 28px;
      border: 1px dashed var(--line);
      border-radius: 8px;
    }
    @media (max-width: 860px) {
      .app { grid-template-columns: 1fr; }
      aside { min-height: 52vh; border-right: 0; border-bottom: 1px solid var(--line); }
      .stage { grid-template-columns: 1fr; }
      main { padding: 18px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <header>
        <h1>物品 Meta 渲染预览</h1>
        <div class="note">独立测试页，只读仓库数据库。点击物品后会用 meta/NBT 尽量还原 Minecraft tooltip。</div>
      </header>
      <div class="search">
        <input id="q" placeholder="搜索物品、短码、NBT/meta..." autocomplete="off">
      </div>
      <div id="items" class="items"></div>
    </aside>
    <main>
      <div id="detail" class="empty">正在读取库存样本...</div>
    </main>
  </div>
  <script>
    const state = { items: [], selected: null }
    const $ = id => document.getElementById(id)
    const esc = text => String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
    const iconUrl = itemId => 'https://blocksitems.com/api/v1/items/' + encodeURIComponent(itemId || 'minecraft:stone') + '/icon?size=64'
    const jsonText = value => JSON.stringify(value, null, 2)

    function renderRows () {
      const selectedKey = state.selected?.itemKey
      $('items').innerHTML = state.items.map(item => {
        const title = item.tooltip?.title?.text || item.displayName || item.itemId
        const tags = item.tooltip?.componentTypes?.slice(0, 2).join(', ') || item.shortKey
        return '<button class="item-row ' + (selectedKey === item.itemKey ? 'active' : '') + '" data-key="' + esc(item.itemKey) + '">' +
          '<div class="item-icon"><img src="' + esc(iconUrl(item.itemId)) + '" alt=""><span class="count">' + esc(item.amount || '') + '</span></div>' +
          '<div class="name"><strong>' + esc(title) + '</strong><span>' + esc(item.itemId) + '</span></div>' +
          '<span class="badge">' + esc(tags || '普通') + '</span>' +
          '</button>'
      }).join('')
      for (const btn of document.querySelectorAll('.item-row')) {
        btn.addEventListener('click', () => selectItem(btn.dataset.key))
      }
    }

    function renderTooltip (tooltip) {
      const title = tooltip.title || {}
      const lines = tooltip.lines || []
      return '<div class="mc-tooltip">' +
        '<div class="mc-title" style="color:' + esc(title.color || '#fff') + '">' + esc(title.text || tooltip.itemId) + '</div>' +
        lines.map(row => {
          const cls = 'mc-line' + (row.italic ? ' italic' : '') + (row.dim ? ' dim' : '')
          return '<div class="' + cls + '" style="color:' + esc(row.color || '#aaa') + '">' + esc(row.text) + '</div>'
        }).join('') +
      '</div>'
    }

    function renderDetail () {
      const item = state.selected
      if (!item) {
        $('detail').className = 'empty'
        $('detail').textContent = state.items.length ? '请选择一个物品。' : '没有找到物品。'
        return
      }
      const tooltip = item.tooltip || {}
      $('detail').className = ''
      $('detail').innerHTML =
        '<div class="preview-head">' +
          '<div class="big-icon"><img src="' + esc(iconUrl(item.itemId)) + '" alt=""><span class="count">' + esc(item.amount || '') + '</span></div>' +
          '<div><h2>' + esc(tooltip.title?.text || item.displayName || item.itemId) + '</h2>' +
          '<div class="meta-line">' + esc(item.itemId) + '</div>' +
          '<div class="meta-line">key: ' + esc(item.shortKey || '') + ' / stack: ' + esc(tooltip.stackSize || '') + '</div></div>' +
        '</div>' +
        '<div class="stage">' +
          '<div class="tooltip-wrap">' + renderTooltip(tooltip) + '</div>' +
          '<div class="panel">' +
            '<h3>解析数据</h3>' +
            '<div class="kv">' +
              (tooltip.componentTypes || []).map(type => '<span class="tag">' + esc(type) + '</span>').join('') +
              (tooltip.hasNbt ? '<span class="tag">NBT</span>' : '') +
              (tooltip.potion ? '<span class="tag">potionId=' + esc(tooltip.potion.id) + '</span>' : '') +
            '</div>' +
            '<pre>' + esc(jsonText({ tooltip, meta: tooltip.meta, nbt: tooltip.nbt })) + '</pre>' +
          '</div>' +
        '</div>'
    }

    function selectItem (key) {
      state.selected = state.items.find(item => item.itemKey === key) || state.items[0] || null
      renderRows()
      renderDetail()
    }

    let timer = null
    async function loadItems () {
      const q = $('q').value.trim()
      const res = await fetch('/api/items?q=' + encodeURIComponent(q))
      const data = await res.json()
      state.items = data.items || []
      if (!state.selected || !state.items.some(item => item.itemKey === state.selected.itemKey)) {
        state.selected = state.items[0] || null
      }
      renderRows()
      renderDetail()
    }

    $('q').addEventListener('input', () => {
      clearTimeout(timer)
      timer = setTimeout(loadItems, 160)
    })
    loadItems().catch(error => {
      $('detail').className = 'empty'
      $('detail').textContent = '加载失败：' + error.message
    })
  </script>
</body>
</html>`

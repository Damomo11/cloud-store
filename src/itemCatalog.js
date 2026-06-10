const mcDataLoader = require('minecraft-data')
const fs = require('node:fs')
const path = require('node:path')
const { sha1, stableStringify } = require('./utils')

class ItemCatalog {
  constructor (version, aliases = {}, languageConfig = {}) {
    this.mcData = mcDataLoader(version)
    this.aliases = new Map()
    this.itemsByName = new Map()
    this.itemsByDisplay = new Map()
    this.localizedNames = new Map()
    this.language = {}
    this.serverEnchantmentsById = new Map()
    this.serverEnchantmentsByName = new Map()

    for (const item of Object.values(this.mcData.itemsByName)) {
      const itemId = `minecraft:${item.name}`
      this.itemsByName.set(item.name, itemId)
      this.itemsByDisplay.set(item.displayName.toLowerCase(), itemId)
      this.aliases.set(item.name, itemId)
      this.aliases.set(itemId, itemId)
      this.aliases.set(item.displayName.toLowerCase(), itemId)
    }

    for (const [alias, value] of Object.entries(aliases)) {
      this.aliases.set(alias.toLowerCase(), this.normalizeItemId(value))
    }

    const loaded = this.loadLanguageAliases(languageConfig)
    if (loaded > 0) {
      console.log(`Loaded ${loaded} localized item aliases from ${languageConfig.file}`)
    } else if (languageConfig.file) {
      console.log(`Localized item alias file not found or empty: ${languageConfig.file}`)
    }

    const loadedServerEnchantments = this.reloadServerEnchantments(languageConfig.serverEnchantmentsFile || 'data/server-enchantments.json')
    if (loadedServerEnchantments > 0) {
      console.log(`Loaded ${loadedServerEnchantments} server enchantment mappings`)
    }
  }

  normalizeItemId (value) {
    if (!value) return null
    const text = String(value).trim()
    if (text.startsWith('minecraft:')) return text
    if (this.itemsByName.has(text)) return this.itemsByName.get(text)
    return `minecraft:${text}`
  }

  resolveName (name) {
    const raw = String(name || '').trim()
    const lower = raw.toLowerCase()
    const itemId = this.aliases.get(lower) || this.aliases.get(raw) || this.normalizeItemId(raw)
    const simple = itemId?.replace(/^minecraft:/, '')
    if (!simple || !this.mcData.itemsByName[simple]) {
      throw new Error(`未知物品：${name}`)
    }
    const data = this.mcData.itemsByName[simple]
    return {
      itemId,
      type: data.id,
      name: data.name,
      displayName: this.getDisplayName(itemId)
    }
  }

  fromPrismarineItem (item) {
    const itemId = `minecraft:${item.name}`
    const nbtJson = stableStringify(item.nbt || null)
    const rawMeta = {
      metadata: item.metadata ?? null,
      components: item.components || null
    }
    const metaJson = stableStringify(rawMeta)
    const fingerprintMeta = this.isShulkerBox(itemId) ? this.normalizeShulkerMetaForFingerprint(rawMeta) : rawMeta
    const fingerprintNbt = this.isShulkerBox(itemId) ? null : (item.nbt || null)
    const fingerprint = sha1(stableStringify({ itemId, nbtJson: stableStringify(fingerprintNbt), metaJson: stableStringify(fingerprintMeta) }))
    return {
      itemKey: `${itemId}|${fingerprint}`,
      itemId,
      displayName: this.describePrismarineItem(item, itemId),
      nbtJson,
      metaJson,
      amount: item.count,
      type: item.type,
      metadata: item.metadata,
      nbt: item.nbt
    }
  }

  fromItemIdAmount (itemId, amount) {
    const normalized = this.normalizeItemId(itemId)
    const nbtJson = stableStringify(null)
    const metaJson = stableStringify({ metadata: null, components: null })
    const fingerprint = sha1(stableStringify({ itemId: normalized, nbtJson, metaJson }))
    return {
      itemKey: `${normalized}|${fingerprint}`,
      itemId: normalized,
      displayName: this.getDisplayName(normalized),
      nbtJson,
      metaJson,
      amount
    }
  }

  canonicalizeStoredItem (row) {
    if (!row?.itemId || !this.isShulkerBox(row.itemId)) return row
    const meta = this.parseStoredJson(row.metaJson, {})
    const canonicalMeta = this.normalizeShulkerMetaForFingerprint(meta)
    const fingerprint = sha1(stableStringify({
      itemId: row.itemId,
      nbtJson: stableStringify(null),
      metaJson: stableStringify(canonicalMeta)
    }))
    return {
      itemKey: `${row.itemId}|${fingerprint}`,
      itemId: row.itemId,
      displayName: row.displayName || this.describeStoredItem(row.itemId, row.metaJson, row.nbtJson),
      nbtJson: row.nbtJson || 'null',
      metaJson: row.metaJson || '',
      amount: row.amount || 0
    }
  }

  fromContainerEntry (entry) {
    if (!entry || !Number.isInteger(entry.itemId)) return null
    const item = this.mcData.items[entry.itemId]
    if (!item) return null

    const itemId = `minecraft:${item.name}`
    const components = Array.isArray(entry.components) && entry.components.length ? entry.components : null
    const meta = { metadata: null, components }
    if (Array.isArray(entry.removeComponents) && entry.removeComponents.length) {
      meta.removeComponents = entry.removeComponents
    }

    const nbtJson = stableStringify(null)
    const metaJson = stableStringify(meta)
    const fingerprintMeta = this.isShulkerBox(itemId) ? this.normalizeShulkerMetaForFingerprint(meta) : meta
    const fingerprint = sha1(stableStringify({ itemId, nbtJson, metaJson: stableStringify(fingerprintMeta) }))
    const amount = Number.parseInt(entry.itemCount ?? entry.count ?? 0, 10)
    if (!Number.isFinite(amount) || amount <= 0) return null

    return {
      itemKey: `${itemId}|${fingerprint}`,
      itemId,
      displayName: this.describeStoredItem(itemId, metaJson, nbtJson),
      nbtJson,
      metaJson,
      amount,
      type: item.id,
      metadata: null,
      nbt: null
    }
  }

  extractShulkerContents (item) {
    if (!this.isShulkerBox(item?.itemId)) return []

    const meta = this.parseStoredJson(item?.metaJson, {})

    const container = this.extractContainerComponent(meta.components)
    const entries = Array.isArray(container?.contents) ? container.contents : []
    const byKey = new Map()

    for (const entry of entries) {
      const contained = this.fromContainerEntry(entry)
      if (!contained) continue
      const existing = byKey.get(contained.itemKey)
      if (existing) {
        existing.amount += contained.amount
        existing.slotCount += 1
      } else {
        byKey.set(contained.itemKey, {
          item: contained,
          amount: contained.amount,
          slotCount: 1
        })
      }
    }

    return [...byKey.values()]
  }

  extractContainerComponent (components) {
    if (!Array.isArray(components)) return null
    const component = components.find(entry => entry?.type === 'container')
    return component?.data || null
  }

  normalizeShulkerMetaForFingerprint (meta) {
    const components = Array.isArray(meta?.components) ? meta.components : []
    const normalizedComponents = []

    const customName = components.find(component => component?.type === 'custom_name')
    if (customName) {
      normalizedComponents.push({
        type: 'custom_name',
        data: customName.data ?? null
      })
    }

    const container = this.extractContainerComponent(components)
    const contents = Array.isArray(container?.contents) ? container.contents : []
    const normalizedContents = []
    for (const entry of contents) {
      const normalized = this.normalizeContainerEntryForFingerprint(entry)
      if (normalized) normalizedContents.push(normalized)
    }
    normalizedContents.sort((a, b) => {
      const ak = stableStringify(a)
      const bk = stableStringify(b)
      return ak.localeCompare(bk)
    })

    normalizedComponents.push({
      type: 'container',
      data: { contents: normalizedContents }
    })

    return {
      metadata: meta?.metadata ?? null,
      components: normalizedComponents
    }
  }

  normalizeContainerEntryForFingerprint (entry) {
    if (!entry || !Number.isInteger(entry.itemId)) return null
    const count = Number.parseInt(entry.itemCount ?? entry.count ?? 0, 10)
    if (!Number.isFinite(count) || count <= 0) return null

    const components = Array.isArray(entry.components)
      ? entry.components
        .filter(component => this.shouldKeepComponentForFingerprint(component))
        .map(component => this.normalizeComponentForFingerprint(component))
      : []
    const removeComponents = Array.isArray(entry.removeComponents) && entry.removeComponents.length
      ? [...entry.removeComponents].sort()
      : []

    return {
      itemId: entry.itemId,
      itemCount: count,
      components,
      removeComponents
    }
  }

  shouldKeepComponentForFingerprint (component) {
    if (!component || typeof component !== 'object') return false
    const type = component.type
    return !['custom_data'].includes(type)
  }

  normalizeComponentForFingerprint (component) {
    return {
      type: component.type,
      data: component.data ?? null
    }
  }

  isShulkerBox (itemId) {
    const normalized = this.normalizeItemId(itemId)
    return /(^|:)shulker_box$/.test(normalized) || /_shulker_box$/.test(normalized)
  }

  aggregatePrismarineItems (items) {
    const map = new Map()
    for (const item of items) {
      if (!item || item.count <= 0) continue
      const normalized = this.fromPrismarineItem(item)
      const existing = map.get(normalized.itemKey)
      if (existing) {
        existing.amount += normalized.amount
      } else {
        map.set(normalized.itemKey, normalized)
      }
    }
    return [...map.values()]
  }

  loadLanguageAliases (languageConfig) {
    if (!languageConfig?.file) return 0
    const filePath = path.resolve(process.cwd(), languageConfig.file)
    if (!fs.existsSync(filePath)) return 0

    const lang = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    this.language = lang
    let loaded = 0
    for (const item of Object.values(this.mcData.itemsByName)) {
      const itemId = `minecraft:${item.name}`
      const blockKey = `block.minecraft.${item.name}`
      const itemKey = `item.minecraft.${item.name}`
      const localized = lang[blockKey] || lang[itemKey]
      if (!localized) continue
      this.localizedNames.set(itemId, localized)
      this.aliases.set(localized.toLowerCase(), itemId)
      this.aliases.set(localized, itemId)
      loaded++
    }
    return loaded
  }

  loadServerEnchantments (file) {
    if (!file) return 0
    const filePath = path.resolve(process.cwd(), file)
    if (!fs.existsSync(filePath)) return 0

    let data
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
      return 0
    }

    const entries = Array.isArray(data?.enchantments) ? data.enchantments : []
    let loaded = 0
    for (const entry of entries) {
      const numericId = Number.parseInt(entry.id, 10)
      const name = String(entry.name || entry.key || '').replace(/^minecraft:/, '')
      if (!Number.isFinite(numericId) || !name) continue
      const normalized = {
        id: numericId,
        name,
        displayName: entry.displayName || this.getEnchantmentDisplayName(name)
      }
      this.serverEnchantmentsById.set(numericId, normalized)
      this.serverEnchantmentsByName.set(name, normalized)
      loaded++
    }
    return loaded
  }

  reloadServerEnchantments (file = 'data/server-enchantments.json') {
    this.serverEnchantmentsById.clear()
    this.serverEnchantmentsByName.clear()
    return this.loadServerEnchantments(file)
  }

  getDisplayName (itemId) {
    if (!itemId) return ''
    const normalized = this.normalizeItemId(itemId)
    const localized = this.localizedNames.get(normalized)
    if (localized) return localized
    const simple = normalized.replace(/^minecraft:/, '')
    return this.mcData.itemsByName[simple]?.displayName || simple
  }

  describePrismarineItem (item, itemId) {
    const baseName = this.getDisplayName(itemId) || item.displayName || item.name
    const fireworkName = this.describeFireworkRocket(itemId, item.components)
    if (fireworkName) return fireworkName

    const customName = this.extractCustomName(item.components)
    if (customName) return customName

    if (this.normalizeItemId(itemId) === 'minecraft:enchanted_book') {
      const enchantments = this.extractEnchantments(item.components)
      if (enchantments.length) {
        return enchantments.map(enchantment => this.formatEnchantment(enchantment)).join('，')
      }
    }

    return baseName
  }

  describeStoredItem (itemId, metaJson = '', nbtJson = '') {
    const baseName = this.getDisplayName(itemId)
    const meta = this.parseStoredJson(metaJson, {})

    const fireworkName = this.describeFireworkRocket(itemId, meta.components)
    if (fireworkName) return fireworkName

    const customName = this.extractCustomName(meta.components)
    if (customName) return customName

    if (this.normalizeItemId(itemId) === 'minecraft:enchanted_book') {
      const enchantments = this.extractEnchantments(meta.components)
      if (enchantments.length) {
        return enchantments.map(enchantment => this.formatEnchantment(enchantment)).join('，')
      }
    }

    return baseName
  }

  parseStoredJson (text, fallback = {}) {
    if (!text) return fallback
    try {
      return JSON.parse(text)
    } catch {
      try {
        return JSON.parse(this.repairUndefinedJsonValues(text))
      } catch {
        return fallback
      }
    }
  }

  repairUndefinedJsonValues (text) {
    return String(text).replace(/:([,}\]])/g, ':null$1')
  }

  describeFireworkRocket (itemId, components) {
    if (this.normalizeItemId(itemId) !== 'minecraft:firework_rocket') return ''
    const flightDuration = this.extractFireworkFlightDuration(components)
    return `${this.getDisplayName(itemId)}${this.levelName(flightDuration || 1)}`
  }

  extractFireworkFlightDuration (components) {
    let duration = 0
    this.walkValue(components, value => {
      if (duration > 0 || !value || typeof value !== 'object') return
      const raw = value.flightDuration ?? value.flight_duration ?? value.flight
      const parsed = Number.parseInt(raw, 10)
      if (Number.isFinite(parsed) && parsed > 0) duration = parsed
    })
    return Math.max(1, Math.min(3, duration || 1))
  }

  extractCustomName (components) {
    if (!Array.isArray(components)) return ''
    const customName = components.find(component => component?.type === 'custom_name')
    if (!customName?.data) return ''
    return this.componentText(customName.data).trim()
  }

  componentText (value) {
    if (!value) return ''
    if (typeof value === 'string') {
      try {
        return this.componentText(JSON.parse(value))
      } catch {
        return value
      }
    }
    if (Array.isArray(value)) return value.map(part => this.componentText(part)).join('')
    if (typeof value !== 'object') return String(value)
    if (typeof value.type === 'string' && Object.prototype.hasOwnProperty.call(value, 'value')) {
      return this.componentText(value.value)
    }
    let text = ''
    if (typeof value.text === 'string') text += value.text
    if (value.text?.value) text += value.text.value
    if (value.extra && !Array.isArray(value.extra)) text += this.componentText(value.extra)
    if (Array.isArray(value.extra)) text += value.extra.map(part => this.componentText(part)).join('')
    if (value.with && !Array.isArray(value.with)) text += this.componentText(value.with)
    if (Array.isArray(value.with)) text += value.with.map(part => this.componentText(part)).join('')
    return text
  }

  extractEnchantments (components) {
    const result = []
    const seen = new Set()
    this.walkValue(components, value => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value.enchantments)) {
        for (const entry of value.enchantments) {
          const parsed = this.parseEnchantmentEntry(entry)
          if (!parsed) continue
          const key = `${parsed.name}:${parsed.level}`
          if (seen.has(key)) continue
          seen.add(key)
          result.push(parsed)
        }
      }
      if (value.levels && typeof value.levels === 'object') {
        for (const [name, level] of Object.entries(value.levels)) {
          const parsed = this.parseEnchantmentEntry({ id: name, level })
          if (!parsed) continue
          const key = `${parsed.name}:${parsed.level}`
          if (seen.has(key)) continue
          seen.add(key)
          result.push(parsed)
        }
      }
    })
    return result
  }

  walkValue (value, visit) {
    visit(value)
    if (Array.isArray(value)) {
      for (const item of value) this.walkValue(item, visit)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const child of Object.values(value)) this.walkValue(child, visit)
  }

  parseEnchantmentEntry (entry) {
    if (!entry || typeof entry !== 'object') return null
    const id = entry.id ?? entry.name ?? entry.key
    const level = Number.parseInt(entry.level ?? entry.lvl ?? entry.value ?? 1, 10)
    const enchantment = this.resolveEnchantment(id)
    if (!enchantment) {
      return {
        name: `unknown_${id}`,
        displayName: `附魔${id}`,
        level: Number.isFinite(level) && level > 0 ? level : 1
      }
    }
    return {
      name: enchantment.name,
      displayName: this.getEnchantmentDisplayName(enchantment.name),
      level: Number.isFinite(level) && level > 0 ? level : 1
    }
  }

  resolveEnchantment (id) {
    if (id === undefined || id === null) return null
    if (typeof id === 'number') {
      return this.serverEnchantmentsById.get(id) || this.mcData.enchantments?.[id] || this.mcData.enchantments?.[id - 25] || null
    }
    if (/^\d+$/.test(String(id))) {
      const numeric = Number.parseInt(id, 10)
      return this.serverEnchantmentsById.get(numeric) || this.mcData.enchantments?.[numeric] || this.mcData.enchantments?.[numeric - 25] || null
    }
    const text = String(id).replace(/^minecraft:/, '')
    return this.serverEnchantmentsByName.get(text) || this.mcData.enchantmentsByName?.[text] || null
  }

  getEnchantmentDisplayName (name) {
    const text = String(name || '').replace(/^minecraft:/, '')
    const server = this.serverEnchantmentsByName.get(text) || this.serverEnchantmentsByName.get(name)
    if (server?.displayName) return server.displayName
    return this.language[`enchantment.minecraft.${text}`] || this.mcData.enchantmentsByName?.[text]?.displayName || text
  }

  formatEnchantment (enchantment) {
    return `${enchantment.displayName}${this.levelName(enchantment.level)}`
  }

  levelName (level) {
    const names = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
    if (level >= 1 && level < names.length) return names[level]
    return String(level)
  }

  getStackSize (itemId) {
    const normalized = this.normalizeItemId(itemId)
    const simple = normalized.replace(/^minecraft:/, '')
    return this.mcData.itemsByName[simple]?.stackSize || 64
  }
}

module.exports = ItemCatalog

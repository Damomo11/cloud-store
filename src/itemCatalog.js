const mcDataLoader = require('minecraft-data')
const fs = require('node:fs')
const path = require('node:path')
const { sha1, stableStringify } = require('./utils')

class ItemCatalog {
  constructor (version, aliases = {}, languageConfig = {}) {
    this.version = version
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
    const rawMeta = {
      metadata: item.metadata ?? null,
      components: item.components || null,
      removeComponents: item.removedComponents || null
    }
    const safeNbt = this.sanitizeNbtForStorage(itemId, item.nbt || null)
    const safeMeta = this.sanitizeMetaForStorage(itemId, rawMeta)
    const nbtJson = stableStringify(safeNbt)
    const metaJson = stableStringify(safeMeta)
    const fingerprintMeta = this.normalizeMetaForFingerprint(itemId, safeMeta)
    const fingerprintNbt = this.normalizeNbtForFingerprint(itemId, safeNbt)
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
      nbt: safeNbt
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
    if (!row?.itemId) return row
    const meta = this.sanitizeMetaForStorage(row.itemId, this.parseStoredJson(row.metaJson, {}))
    const nbt = this.sanitizeNbtForStorage(row.itemId, this.parseStoredJson(row.nbtJson, null))
    const canonicalMeta = this.normalizeMetaForFingerprint(row.itemId, meta)
    const canonicalNbt = this.normalizeNbtForFingerprint(row.itemId, nbt)
    const fingerprint = sha1(stableStringify({
      itemId: row.itemId,
      nbtJson: stableStringify(canonicalNbt),
      metaJson: stableStringify(canonicalMeta)
    }))
    return {
      itemKey: `${row.itemId}|${fingerprint}`,
      itemId: row.itemId,
      displayName: row.displayName || this.describeStoredItem(row.itemId, stableStringify(meta), stableStringify(nbt)),
      nbtJson: stableStringify(nbt),
      metaJson: stableStringify(meta),
      amount: row.amount || 0
    }
  }

  fromContainerEntry (entry) {
    if (!entry || !Number.isInteger(entry.itemId)) return null
    const entryItemId = this.isBeeContainerEntry(entry) ? this.canonicalBeeContainerItemId(entry) : entry.itemId
    const item = this.mcData.items[entryItemId]
    if (!item) return null

    const itemId = `minecraft:${item.name}`
    const components = Array.isArray(entry.components) && entry.components.length ? entry.components : null
    const meta = this.sanitizeMetaForStorage(itemId, {
      metadata: null,
      components,
      removeComponents: entry.removeComponents || null
    })

    const nbtJson = stableStringify(null)
    const metaJson = stableStringify(meta)
    const fingerprintMeta = this.normalizeMetaForFingerprint(itemId, meta)
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

  normalizeMetaForFingerprint (itemId, meta) {
    if (this.isBeeContainer(itemId)) return this.fixedBeeContainerMeta()
    const canonicalMeta = meta && typeof meta === 'object'
      ? { ...meta, metadata: this.normalizeItemMetadata(meta.metadata) }
      : meta
    const base = this.isShulkerBox(itemId) ? this.normalizeShulkerMetaForFingerprint(canonicalMeta) : canonicalMeta
    const stripped = this.stripVolatileMetaForFingerprint(itemId, base)
    if (this.isNoteBlock(itemId)) return this.canonicalNoteBlockMetaForFingerprint(stripped)
    return this.sortMetaComponentsForFingerprint(stripped)
  }

  normalizeItemMetadata (metadata) {
    return this.mcData.supportFeature?.('itemsWithComponents') ? null : (metadata ?? null)
  }

  normalizeNbtForFingerprint (itemId, nbt) {
    return (this.isShulkerBox(itemId) || this.isBeeContainer(itemId)) ? null : nbt
  }

  stripVolatileMetaForFingerprint (itemId, meta) {
    const isShitHat = this.isShitHatMeta(meta)
    const isBreweryX = this.isBreweryXMeta(meta)
    if (!this.shouldIgnoreCraftEngineNetworkData(itemId) && !isShitHat && !isBreweryX) return meta

    let stripped = meta
    if (this.shouldIgnoreCraftEngineNetworkData(itemId) || isShitHat) {
      stripped = this.omitObjectKeyDeep(stripped, 'craftengine:network_data')
      stripped = this.omitObjectKeyDeep(stripped, 'craftengine:network_modifiers')
      stripped = this.sortBlockStatePropertiesDeep(stripped)
      if (Array.isArray(stripped?.components)) {
        stripped = {
          ...stripped,
          components: stripped.components.filter(component => !this.isEmptyCustomDataComponent(component))
        }
      }
    }
    if (isBreweryX) {
      stripped = this.omitObjectKeyDeep(stripped, 'breweryx:brewdata')
      if (Array.isArray(stripped?.components)) {
        stripped = {
          ...stripped,
          components: stripped.components
            .map(component => {
              if (component?.type !== 'tooltip_display') return component
              return {
                ...component,
                data: this.omitObjectKeyDeep(component.data, 'hiddenComponents')
              }
            })
            .filter(component => !this.isEmptyCustomDataComponent(component))
        }
      }
    }
    return stripped
  }

  shouldIgnoreCraftEngineNetworkData (itemId) {
    const normalized = this.normalizeItemId(itemId)
    return normalized === 'minecraft:string' ||
      normalized === 'minecraft:tripwire_hook' ||
      normalized === 'minecraft:note_block'
  }

  isNoteBlock (itemId) {
    return this.normalizeItemId(itemId) === 'minecraft:note_block'
  }

  // 音符盒：CraftEngine mod 会附加波动的 craftengine:network_data /
  // craftengine:network_modifiers 自定义数据，且 block_state 属性列表顺序
  // 不稳定。库存中的音符盒 block_state 恒为默认值（note=0 harp false），
  // 故指纹固定用该默认 block_state，与历史键 f17058…完全一致。
  canonicalNoteBlockMetaForFingerprint (meta) {
    const components = Array.isArray(meta?.components) ? meta.components : []
    const nonBlockState = components.filter(component => component?.type !== 'block_state')
    const blockState = components.find(component => component?.type === 'block_state')
    const properties = Array.isArray(blockState?.data?.properties) ? blockState.data.properties : []
    const props = Object.create(null)
    for (const prop of properties) {
      if (prop && typeof prop === 'object' && prop.name !== undefined) props[prop.name] = prop.value
    }
    // 属性顺序必须是历史 f17058 的原始顺序（powered,instrument,note），不能排序。
    const canonicalProperties = [
      { name: 'powered', value: this.noteBlockPropValue(props, 'powered', 'false') },
      { name: 'instrument', value: this.noteBlockPropValue(props, 'instrument', 'harp') },
      { name: 'note', value: this.noteBlockPropValue(props, 'note', '0') }
    ]
    const canonicalComponents = [...nonBlockState, {
      data: { properties: canonicalProperties },
      type: 'block_state'
    }]
    return {
      ...meta,
      components: canonicalComponents
    }
  }

  noteBlockPropValue (props, name, fallback) {
    const value = props[name]
    const text = value === undefined || value === null ? fallback : String(value)
    return text
  }

  // CraftEngine 服务器发来的 block_state 属性列表顺序不稳定（同一物品不同来源
  // 顺序不同，见音符盒 e478987/f17058 两种排列）。craftengine 忽略路径内的物品
  // 属性顺序无业务含义，统一排序使指纹稳定；注意历史指纹依赖保持原顺序的
  // 排列（f17058…为 powered,instrument,note），因此这里排序必须产生与历史
  // f17058 相同的序列化结果——见 note-block-canonicalization 测试。
  sortBlockStatePropertiesDeep (value) {
    if (Array.isArray(value)) return value.map(item => this.sortBlockStatePropertiesDeep(item))
    if (!value || typeof value !== 'object') return value
    const result = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === 'properties' && Array.isArray(child) && child.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
        result[key] = [...child].sort((a, b) => this.compareFingerprintValues(a, b))
      } else {
        result[key] = this.sortBlockStatePropertiesDeep(child)
      }
    }
    return result
  }

  isShitHatMeta (meta) {
    return this.hasObjectKeyWithValueDeep(meta, 'craftengine:id', 'tsl:shit_hat')
  }

  isBreweryXMeta (meta) {
    return this.hasObjectKeyDeep(meta, 'breweryx:brewdata')
  }

  hasObjectKeyDeep (value, targetKey) {
    if (Array.isArray(value)) return value.some(item => this.hasObjectKeyDeep(item, targetKey))
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, child]) => key === targetKey || this.hasObjectKeyDeep(child, targetKey))
  }

  hasObjectKeyWithValueDeep (value, targetKey, expected) {
    if (Array.isArray(value)) return value.some(item => this.hasObjectKeyWithValueDeep(item, targetKey, expected))
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, child]) => {
      if (key === targetKey) return this.unwrapTypedValue(child) === expected
      return this.hasObjectKeyWithValueDeep(child, targetKey, expected)
    })
  }

  unwrapTypedValue (value) {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'value')) {
      return this.unwrapTypedValue(value.value)
    }
    return value
  }

  omitObjectKeyDeep (value, keyToOmit) {
    if (Array.isArray(value)) return value.map(item => this.omitObjectKeyDeep(item, keyToOmit))
    if (!value || typeof value !== 'object') return value
    const result = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === keyToOmit) continue
      result[key] = this.omitObjectKeyDeep(child, keyToOmit)
    }
    return result
  }

  isEmptyCustomDataComponent (component) {
    if (component?.type !== 'custom_data') return false
    return this.isEmptyValue(component.data)
  }

  isEmptyValue (value) {
    if (value === undefined || value === null) return true
    if (Array.isArray(value)) return value.length === 0 || value.every(item => this.isEmptyValue(item))
    if (typeof value !== 'object') return false
    if (Object.prototype.hasOwnProperty.call(value, 'type') && Object.prototype.hasOwnProperty.call(value, 'value')) {
      return this.isEmptyValue(value.value)
    }
    return Object.keys(value).length === 0 || Object.values(value).every(child => this.isEmptyValue(child))
  }

  normalizeContainerEntryForFingerprint (entry) {
    if (!entry || !Number.isInteger(entry.itemId)) return null
    const count = Number.parseInt(entry.itemCount ?? entry.count ?? 0, 10)
    if (!Number.isFinite(count) || count <= 0) return null

    const fixedBeeContainer = this.isBeeContainerEntry(entry)
    const isBreweryX = this.isBreweryXMeta({ components: entry.components })
    const components = !fixedBeeContainer && Array.isArray(entry.components)
      ? entry.components
        .filter(component => this.shouldKeepComponentForFingerprint(component))
        .map(component => this.normalizeContainerComponentForFingerprint(component, isBreweryX))
      : []
    components.sort((a, b) => this.compareFingerprintValues(a, b))
    const removeComponents = !fixedBeeContainer && Array.isArray(entry.removeComponents) && entry.removeComponents.length
      ? [...entry.removeComponents].sort()
      : []

    return {
      itemId: fixedBeeContainer ? this.canonicalBeeContainerItemId(entry) : entry.itemId,
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
      data: this.sortNestedItemComponentsForFingerprint(component.data ?? null)
    }
  }

  normalizeContainerComponentForFingerprint (component, isBreweryX) {
    const normalized = this.normalizeComponentForFingerprint(component)
    if (!isBreweryX || component?.type !== 'tooltip_display') return normalized
    return {
      ...normalized,
      data: this.omitObjectKeyDeep(normalized.data, 'hiddenComponents')
    }
  }

  sortMetaComponentsForFingerprint (meta) {
    if (!meta || typeof meta !== 'object') return meta
    return this.sortNestedItemComponentsForFingerprint(meta)
  }

  sortNestedItemComponentsForFingerprint (value) {
    if (Array.isArray(value)) return value.map(item => this.sortNestedItemComponentsForFingerprint(item))
    if (!value || typeof value !== 'object') return value

    const result = {}
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'components' || key === 'removeComponents') && Array.isArray(child)) {
        result[key] = this.sortComponentListForFingerprint(child)
      } else {
        result[key] = this.sortNestedItemComponentsForFingerprint(child)
      }
    }
    return result
  }

  sortComponentListForFingerprint (components) {
    return components
      .map(component => this.sortNestedItemComponentsForFingerprint(component))
      .sort((a, b) => this.compareFingerprintValues(a, b))
  }

  compareFingerprintValues (a, b) {
    const ak = stableStringify(a)
    const bk = stableStringify(b)
    return ak.localeCompare(bk)
  }

  isShulkerBox (itemId) {
    const normalized = this.normalizeItemId(itemId)
    return /(^|:)shulker_box$/.test(normalized) || /_shulker_box$/.test(normalized)
  }

  isBeeContainer (itemId) {
    const normalized = this.normalizeItemId(itemId)
    return normalized === 'minecraft:beehive' || normalized === 'minecraft:bee_nest'
  }

  sanitizeNbtForStorage (itemId, nbtValue) {
    if (!nbtValue) return null
    if (this.isBeeContainer(itemId)) return null
    return this.compactLargeValue(nbtValue, 'nbt')
  }

  sanitizeMetaForStorage (itemId, meta = {}) {
    if (this.isBeeContainer(itemId)) return this.fixedBeeContainerMeta()
    const components = Array.isArray(meta?.components)
      ? meta.components.map(component => this.sanitizeComponentForStorage(itemId, component)).filter(Boolean)
      : meta?.components
    const result = {
      metadata: this.normalizeItemMetadata(meta?.metadata),
      components: Array.isArray(components) && components.length === 0 ? null : (components || null)
    }
    if (Array.isArray(meta?.removeComponents) && meta.removeComponents.length) {
      result.removeComponents = [...meta.removeComponents]
    }
    return result
  }

  fixedBeeContainerMeta () {
    return {
      metadata: null,
      components: null
    }
  }

  sanitizeComponentForStorage (itemId, component) {
    if (!component || typeof component !== 'object') return component

    const type = component.type
    if (this.isShulkerBox(itemId) && type === 'container') {
      const contents = Array.isArray(component.data?.contents)
        ? component.data.contents.map(entry => this.sanitizeShulkerContainerEntry(entry))
        : []
      return {
        ...component,
        data: {
          ...component.data,
          contents
        }
      }
    }

    if (this.isShulkerBox(itemId) && type === 'custom_data') {
      const data = this.omitObjectKeyDeep(component.data, 'AxShulkers-UUID')
      if (this.isEmptyValue(data)) return null
      return {
        ...component,
        data: this.compactLargeValue(data, `component:${type}`)
      }
    }

    if (this.isBeeContainer(itemId) && ['bees', 'block_entity_data', 'custom_data'].includes(type)) {
      return {
        ...component,
        data: this.summarizeBeeComponent(type, component.data)
      }
    }

    return {
      ...component,
      data: this.compactLargeValue(component.data, `component:${type}`)
    }
  }

  sanitizeShulkerContainerEntry (entry) {
    if (!entry || !Number.isInteger(entry.itemId)) return entry
    if (!this.isBeeContainerEntry(entry)) return entry
    return {
      ...entry,
      itemId: this.canonicalBeeContainerItemId(entry),
      addedComponentCount: 0,
      components: [],
      removeComponents: [],
      removedComponentCount: 0
    }
  }

  isBeeContainerEntry (entry) {
    if (!entry || !Number.isInteger(entry.itemId)) return false
    const nestedItem = this.mcData.items[entry.itemId]
    const nestedItemId = nestedItem ? `minecraft:${nestedItem.name}` : null
    if (this.isBeeContainer(nestedItemId)) return true

    if (Array.isArray(entry.removeComponents) && entry.removeComponents.some(component => {
      return component === 'bees' || component === 'minecraft:bees'
    })) return true

    let found = false
    this.walkValue(entry.components, value => {
      if (found) return
      if (typeof value === 'string' && /^(?:minecraft:)?(?:bees|bee_nest|beehive)$/.test(value)) found = true
      if (!value || typeof value !== 'object') return
      if (Object.prototype.hasOwnProperty.call(value, 'Bees') || Object.prototype.hasOwnProperty.call(value, 'bees')) found = true
      if (value.type === 'bees') found = true
    })
    return found
  }

  canonicalBeeContainerItemId (entry) {
    const nestedItem = this.mcData.items[entry?.itemId]
    const nestedItemId = nestedItem ? `minecraft:${nestedItem.name}` : null
    if (this.isBeeContainer(nestedItemId)) return entry.itemId
    return this.mcData.itemsByName.bee_nest?.id ?? entry.itemId
  }

  summarizeBeeComponent (type, data) {
    if (type === 'bees') {
      const bees = Array.isArray(data?.bees) ? data.bees : []
      return {
        beeCount: bees.length,
        bees: bees.map(bee => ({
          ticksInHive: this.safeInteger(bee?.ticksInHive),
          minTicksInHive: this.safeInteger(bee?.minTicksInHive)
        }))
      }
    }

    const summary = this.summarizeBeeNbt(data?.data || data)
    if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'type')) {
      summary.type = data.type
    }
    return summary
  }

  summarizeBeeNbt (value) {
    const text = this.safeStableStringify(value)
    return {
      omittedBeeNbt: true,
      beeCount: this.extractBeeCountFromValue(value),
      hash: text ? sha1(text).slice(0, 12) : '',
      originalLength: text.length
    }
  }

  compactLargeValue (value, kind) {
    if (value === undefined || value === null) return value ?? null
    const maxLength = 20000
    const text = this.safeStableStringify(value)
    if (text.length <= maxLength) return value
    return {
      omittedLargeValue: true,
      kind,
      hash: sha1(text).slice(0, 12),
      originalLength: text.length,
      preview: this.previewLargeValue(value)
    }
  }

  safeStableStringify (value) {
    try {
      return stableStringify(value)
    } catch {
      try {
        return JSON.stringify(value, (_key, child) => typeof child === 'bigint' ? child.toString() : child)
      } catch {
        return String(value)
      }
    }
  }

  previewLargeValue (value) {
    const text = this.componentText(value).trim()
    if (text) return text.slice(0, 120)
    if (Array.isArray(value)) return `array(${value.length})`
    if (value && typeof value === 'object') return Object.keys(value).slice(0, 12).join(',')
    return String(value).slice(0, 120)
  }

  safeInteger (value) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : 0
  }

  extractBeeCountFromValue (value) {
    let count = 0
    this.walkValue(value, child => {
      if (count > 0 || !child || typeof child !== 'object') return
      const bees = child.Bees ?? child.bees
      if (Array.isArray(bees)) count = bees.length
      if (Array.isArray(bees?.value?.value)) count = bees.value.value.length
      if (Array.isArray(bees?.value)) count = bees.value.length
    })
    return count
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

    let lang
    try {
      lang = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (error) {
      console.warn(`Failed to load localized item alias file: ${filePath} (${error.message})`)
      return 0
    }
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

    const customName = this.extractCustomName(item.components)
    if (customName) return customName

    const beeContainerName = this.describeBeeContainer(itemId, item.components)
    if (beeContainerName) return beeContainerName

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

    const customName = this.extractCustomName(meta.components)
    if (customName) return customName

    const beeContainerName = this.describeBeeContainer(itemId, meta.components)
    if (beeContainerName) return beeContainerName

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

  describeBeeContainer (itemId, components) {
    if (!this.isBeeContainer(itemId)) return ''
    const count = this.extractBeeCountFromComponents(components)
    if (!count) return ''
    return `${this.getDisplayName(itemId)}（含蜂${count}）`
  }

  extractBeeCountFromComponents (components) {
    if (!Array.isArray(components)) return 0
    const bees = components.find(component => component?.type === 'bees')
    const count = Number.parseInt(bees?.data?.beeCount, 10)
    if (Number.isFinite(count) && count > 0) return count
    if (Array.isArray(bees?.data?.bees)) return bees.data.bees.length

    let nestedCount = 0
    for (const component of components) {
      if (!['block_entity_data', 'custom_data'].includes(component?.type)) continue
      nestedCount = Math.max(nestedCount, this.extractBeeCountFromValue(component.data))
    }
    return nestedCount
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

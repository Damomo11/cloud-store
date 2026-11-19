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
    // 服务器 potion registry（登录 registry_data 导出）：药水 potion_contents 的
    // 协议数字 id ↔ 字符串名互转用。26.x 本地字典无 potion registry，只能靠导出。
    this.serverPotionIdByName = new Map()
    // 服务器 mob_effect registry（登录 registry_data 导出）：potion_contents
    // custom_effects 条目的效果协议数字 id ↔ 字符串名互转用（同 potion 一套）。
    this.serverEffectIdByName = new Map()

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
    const loadedServerPotions = this.loadServerPotions('data/server-potions.json')
    if (loadedServerPotions > 0) {
      console.log(`Loaded ${loadedServerPotions} server potion mappings`)
    }
    const loadedServerEffects = this.loadServerEffects('data/server-effects.json')
    if (loadedServerEffects > 0) {
      console.log(`Loaded ${loadedServerEffects} server effect mappings`)
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

  // Servux 方块实体 NBT 的 Items 条目 → 物品记录。components（map 形状）转成
  // [{ type, data }] 数组以对齐开箱路径里 node-minecraft-protocol 的解析形状，
  // 再复用 fromPrismarineItem，保证同一件物品两条路径算出同一个指纹。
  fromServuxItem (entry) {
    const name = String(entry?.id || '').replace(/^minecraft:/, '')
    // 服务器自定义物品（数据包注册的 minecraft: 命名空间物品）不在本地 mcData 词典里，
    // 以前直接抛“未知物品”导致整个桶漏读；现在对齐开箱路径（fromPrismarineItem 不查词典），
    // 用原始物品 id 建档案，这些桶照常入账。
    return this.fromPrismarineItem({
      name,
      count: Number(entry.count ?? 1),
      type: this.mcData.itemsByName[name]?.id ?? null,
      components: this.componentsMapToArray(entry.components),
      removedComponents: null,
      metadata: null,
      nbt: null
    })
  }

  // NBT 复合组件（Servux 回包的 map 形状）→ 协议组件数组 [{ type, data }]，
  // 与开箱路径里 node-minecraft-protocol 的解析形状对齐。
  componentsMapToArray (rawComponents) {
    if (!rawComponents || typeof rawComponents !== 'object' || Array.isArray(rawComponents)) return null
    return Object.entries(rawComponents).map(([key, value]) => {
      const type = key.replace(/^minecraft:/, '')
      // 容器组件（潜影盒内容）转成协议形状，保证盒内物品索引两条路径一个指纹
      if (type === 'container') return { type, data: this.nbtContainerDataToProtocol(value) }
      // 其它组件的形状对齐（NBT typed 解码 / block_state properties 转平 map）
      // 统一在 sanitizeMetaForStorage 收口（全路径必经、幂等），这里只转数组形状。
      return { type, data: value }
    })
  }

  // 存量 metaJson（协议数组形状）的组件树形状对齐：顶层组件 + 盒内条目组件
  // 递归走 alignServuxComponentShape，与运行时（sanitizeMetaForStorage 收口）
  // 共用同一转换，保证迁移重算的指纹与新入账恒等。协议形状输入幂等 no-op。
  // （2026-11-18 minecraft:string 三指纹分裂案：Servux 路 typed/properties 形状
  // vs 协议路 flat/map 形状，同一物品两条路字面不同 → key 分裂。）
  alignStoredComponentShapesDeep (meta) {
    const alignComponents = components => {
      if (!Array.isArray(components)) return components
      return components.map(component => {
        if (!component || typeof component !== 'object') return component
        const type = component.type
        let data = this.alignServuxComponentShape(type, component.data)
        if (type === 'container' && data && typeof data === 'object' && Array.isArray(data.contents)) {
          data = {
            ...data,
            contents: data.contents.map(entry => {
              if (!entry || typeof entry !== 'object') return entry
              // 协议空槽 padding（{itemCount:0} 无 components 键）原样保留：
              // packing 层的空槽判定依赖这个键形，不能擅自补键。
              if (!Array.isArray(entry.components)) return entry
              return { ...entry, components: alignComponents(entry.components) }
            })
          }
        }
        return { ...component, data }
      })
    }
    if (!meta || typeof meta !== 'object') return meta
    return { ...meta, components: alignComponents(meta.components) }
  }

  // Servux NBT 组件值 → 协议路形状。custom_data 解码 NBT typed 树；block_state
  // 先解码 typed 包装（properties 在 .value 里）再转协议平 map；附魔组件
  // （enchantments/stored_enchantments）map 形状翻成协议数字 id 数组。协议
  // 形状输入（无 typed 特征）原样返回，幂等。
  alignServuxComponentShape (type, value) {
    if (type === 'enchantments' || type === 'stored_enchantments') return this.enchantmentsDataToProtocol(value)
    if (type === 'block_state') return this.blockStateDataToProtocol(this.decodeNbtValue(value))
    // tooltip_display 的 hidden_components 在服务器侧是无序集合：同一件物品
    // 两次读的顺序都不同（2026-11 绿牛药水案：同款药水每次 sync 算出新 key，
    // 一天建出 10+ 个档），双路（协议/Servux）与每次重读的字面都对不上。
    // 收口统一排序，形状稳定、幂等。
    if (type === 'tooltip_display') return this.tooltipDisplayDataToProtocol(value)
    return this.decodeNbtValue(value)
  }

  tooltipDisplayDataToProtocol (value) {
    const decoded = this.decodeNbtValue(value)
    if (!Array.isArray(decoded?.hidden_components)) return decoded
    return { ...decoded, hidden_components: [...decoded.hidden_components].sort() }
  }

  // 附魔组件双路形状对齐（2026-11-18 shell_breaker 附魔书 924806/34e301e7
  // 分裂案）：Servux NBT 是 {附魔名:等级} map，协议开窗是
  // {enchantments:[{id:数字,level}]} 数组（协议 varint id）。同一件物品两条
  // 路字面不同 → key 分裂：sync 按 Servux 指纹建账，取货开窗读协议指纹 →
  // actual=0 → 修账扣账 → 越修越少。map 翻成协议形状（附魔名查
  // server-enchantments 映射表得数字 id），两种形状统一按 id 升序（双路
  // 序列化顺序无保证，排序后字面恒等；单附魔排序无影响，历史协议形状 key
  // 不变，Servux 存量迁移重算即与协议档案合并）。查不到的附魔名原样返回，
  // 交给 !同步 重扫重录兜底，绝不错译 id。
  enchantmentsDataToProtocol (value) {
    const decoded = this.decodeNbtValue(value)
    if (Array.isArray(decoded?.enchantments)) {
      const list = decoded.enchantments.map(entry =>
        (entry && typeof entry === 'object') ? { id: entry.id, level: entry.level } : entry)
      list.sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0))
      return { ...decoded, enchantments: list }
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return decoded
    const entries = Object.entries(decoded)
    if (!entries.length) return decoded
    const list = []
    for (const [name, level] of entries) {
      const mapping = this.serverEnchantmentsByName.get(String(name).replace(/^minecraft:/, ''))
      if (!mapping) return decoded
      list.push({ id: mapping.id, level: Number(level) })
    }
    list.sort((a, b) => a.id - b.id)
    return { enchantments: list }
  }

  // Servux NBT typed 树 → 裸 JSON（协议路的解码结果形状）。NBT 类型名白名单
  // 判定：craftengine 在 custom_data 里存的 JSON（{"type":0,...} 数字 type）
  // 不是 typed 包装，不误伤；byteArray 解成纯数组（协议路 wire 即纯数组）。
  decodeNbtValue (node) {
    const NBT_TYPES = new Set(['compound', 'list', 'byteArray', 'intArray', 'longArray',
      'string', 'byte', 'short', 'int', 'long', 'float', 'double'])
    if (!node || typeof node !== 'object') return node
    // 数组元素也要递归剥壳：协议路（1.21.5+ item components 部分字段走 NBT，
    // 如 lore）给的 data 可能直接是 typed 元素数组，此前数组原样返回导致
    // typed 形状进了存档、与 Servux 路（剥平）分裂——2026-11 指南针
    // 1d0a96(协议 typed lore)/5a12a7(Servux 平 lore) 同一只物品两个 key。
    // 平形状元素递归是无损 no-op，幂等。
    if (Array.isArray(node)) return node.map(item => this.decodeNbtValue(item))
    if (typeof node.type === 'string' && NBT_TYPES.has(node.type)) {
      switch (node.type) {
        case 'compound': {
          const out = {}
          for (const [k, v] of Object.entries(node.value || {})) out[k] = this.decodeNbtValue(v)
          return out
        }
        case 'list':
          return (Array.isArray(node.value?.value) ? node.value.value : []).map(v => this.decodeNbtValue(v))
        case 'byteArray': case 'intArray': case 'longArray':
          return Array.isArray(node.value) ? node.value.map(Number) : (node.value ?? [])
        case 'string':
          return node.value ?? ''
        default:
          return node.value ?? null
      }
    }
    // 无 type 特征的普通对象（如 NBT list<compound> 的裸条目 {name:typed, value:typed}）：
    // 递归剥每个字段的 typed 包装。craftengine 的 JSON（{"type":0,...} 数字 type）走到
    // 这里递归无损（裸值原样返回），与协议路同一函数处理 → 双路字面恒等。
    const out = {}
    for (const [k, v] of Object.entries(node)) out[k] = this.decodeNbtValue(v)
    return out
  }

  // block_state 组件：Servux NBT 形状 {properties:[{name,value}]} → 协议平 map
  // {name: value}。协议形状（无 properties 数组）原样返回。
  blockStateDataToProtocol (value) {
    const props = Array.isArray(value?.properties) ? value.properties : null
    if (!props) return value
    const out = {}
    for (const prop of props) {
      if (prop && typeof prop.name === 'string') out[prop.name] = prop.value
    }
    return out
  }

  // 容器组件数据 → 协议形状 { contents: [{ itemId, itemCount, components }] }。
  // Servux 实测（1.21.11，AxShulkers 插件）条目是 { slot, item: { id, count } }——
  // 物品包在 item 字段里；也兼容直接的 { id, count } 列表形状。
  nbtContainerDataToProtocol (value) {
    const list = Array.isArray(value) ? value : (Array.isArray(value?.contents) ? value.contents : null)
    if (!list) return value
    return {
      contents: list.map(entry => {
        const item = (entry && typeof entry.item === 'object' && entry.item) ? entry.item : entry
        const name = String(item?.id || '').replace(/^minecraft:/, '')
        const data = name ? this.mcData.itemsByName[name] : null
        return {
          itemId: data ? data.id : null,
          itemCount: Number(item?.count ?? 1),
          components: this.componentsMapToArray(item?.components),
          removeComponents: null
        }
      })
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
    // 1.21.11 时代入账的行（容器内容是旧目录的数字 id）无法可靠迁移：跳过迁移保留
    // 旧 key，交给下一次 !同步 的实物重录 + 库存异常对账修正，绝不错误合并余额。
    if (this.metaHasVersionAmbiguousContainerEntries(row.itemId, meta)) return null
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
    if (!entry) return null
    // 字符串全名（迁移后/落库即全名的新账形状）：按名建档，不再查数字目录。
    // 数字（存量旧形状）：按当前目录解，蜂箱条目归一到 bee_nest。
    let item = null
    if (typeof entry.itemId === 'string') {
      const name = entry.itemId.replace(/^minecraft:/, '')
      item = this.mcData.itemsByName[name] || null
    } else if (Number.isInteger(entry.itemId)) {
      const entryItemId = this.isBeeContainerEntry(entry) ? this.canonicalBeeContainerItemId(entry) : entry.itemId
      item = this.mcData.items[entryItemId] || null
    }
    if (!item) return null
    const entryItemId = item.id

    const itemId = `minecraft:${item.name}`
    const components = Array.isArray(entry.components) && entry.components.length ? entry.components : null
    const meta = this.sanitizeMetaForStorage(itemId, {
      metadata: null,
      components,
      removeComponents: entry.removeComponents || null
    })

    // Component-era inventory decoding synthesizes legacy damage NBT for
    // durable items. Use that same decoder for the content index so a sword's
    // identity stays the same when it is taken out of a shulker box.
    let nbt = null
    if (item.maxDurability && this.mcData.supportFeature('itemsWithComponents')) {
      this.containerItem ??= require('prismarine-item')(this.mcData)
      nbt = this.sanitizeNbtForStorage(itemId, this.containerItem.fromNotch({
        ...entry, itemId: entryItemId, itemCount: entry.itemCount ?? entry.count,
        components: meta.components, removeComponents: meta.removeComponents || null
      })?.nbt || null)
    }
    const nbtJson = stableStringify(nbt)
    const metaJson = stableStringify(meta)
    const fingerprintMeta = this.normalizeMetaForFingerprint(itemId, meta)
    // 与 fromPrismarineItem 同公式：nbt 走 normalizeNbtForFingerprint 再进哈希。
    // 此前盒内读直接用 sanitize 后的 nbtJson——耐久物品的合成 Damage NBT
    // 进了字面，与散货路（走 normalize）恒分裂（2026-11 打火石 03:51 三档）。
    const fingerprintNbt = this.normalizeNbtForFingerprint(itemId, nbt)
    const fingerprint = sha1(stableStringify({ itemId, nbtJson: stableStringify(fingerprintNbt), metaJson: stableStringify(fingerprintMeta) }))
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
      nbt
    }
  }

  // 目录版本无关的物品 id → 全名映射（带缓存），供跨目录签名解析用。
  itemsByIdMap (reg) {
    if (!reg) return null
    if (!reg.__itemsByIdMap) {
      const map = new Map()
      for (const entry of reg.itemsArray) map.set(entry.id, `minecraft:${entry.name}`)
      try {
        Object.defineProperty(reg, '__itemsByIdMap', { value: map })
      } catch {
        return map
      }
    }
    return reg.__itemsByIdMap
  }

  // 存量 metaJson 的容器条目数字 → 全名字符串，按“入账时代”的目录翻译：
  // reg 传该行时代的字典（26.3 部署前的老行传 1.21.11 目录，之后传当前目录）。
  // 翻译后 normalizeContainerEntryForFingerprint 走字符串原样分支，参与哈希的
  // 输入与当年“数字→当年目录→全名”完全一致：历史 itemKey 不变，只把存储形状
  // 换成跨版本稳定形式。字符串条目原样跳过（幂等）。目录解不出的数字保留
  // 原样（返回计数，交给 !同步 重扫重录兜底，绝不错译名字）。
  translateStoredContainerEntriesToFullNames (itemId, meta, reg) {
    const counts = { translated: 0, unresolved: 0 }
    const components = Array.isArray(meta?.components) ? meta.components : []
    const dictionary = reg || this.mcData
    // 嵌套物品容器不止潜影盒 container 一种：收纳袋 bundle_contents、
    // 弩 charged_projectiles 的条目同形状（{itemId, itemCount, ...}）。存量
    // 翻译覆盖全部三种，metaJson 里从此不携带任何目录数字。item_key 不受
    // 影响：这些条目不参与指纹归一（normalize 只认 container），行内 key
    // 无人重算，重扫重录时全删全插自然换新。
    for (const component of components) {
      const type = component?.type
      if (type !== 'container' && type !== 'bundle_contents' && type !== 'charged_projectiles') continue
      // 潜影盒 container 保持原有 gate：非盒物品的 container 组件
      // （理论上不存在，防御性跳过）。
      if (type === 'container' && !this.isShulkerBox(itemId)) continue
      const entries = this.nestedItemEntryList(component)
      if (!entries) continue
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || typeof entry.itemId === 'string') continue
        if (!Number.isInteger(entry.itemId)) continue
        const name = this.itemNameByNumericId(dictionary, entry.itemId)
        if (!name) { counts.unresolved++; continue }
        entry.itemId = `minecraft:${name}`
        counts.translated++
      }
    }
    return counts
  }

  // 嵌套物品条目列表：协议 data 可为裸数组（开箱路径），Servux NBT 转形状后
  // 带 contents（container/bundle_contents）或 projectiles（charged_projectiles）键。
  nestedItemEntryList (component) {
    const data = component?.data
    if (Array.isArray(data)) return data
    if (Array.isArray(data?.contents)) return data.contents
    if (Array.isArray(data?.projectiles)) return data.projectiles
    return null
  }

  // 迁移期跨目录内容签名（2026-11-18 椰汁橙 16417 多余/15329 缺失案例）：
  // 存量 metaJson 的容器内容数字 itemId 是"入账当时目录"的编码——迁移前入账的行
  // 用 1.21.11 编码、26.3 扫描行用 26.3 编码，任何单一目录解析都必然错一边
  // （1.21.11 的 1353=堆肥桶在 26.3 目录下解成 vex_spawn_egg），导致配对器
  // "同内容漂移盒子"判不出来。这里对同一份档案按两个目录各解出一个候选签名，
  // 配对时任意组合相等即判定同内容（旧行用旧目录、新行用新目录时两侧都是真名）。
  shulkerLooseSignatures (item) {
    const meta = this.parseStoredJson(item?.metaJson ?? item?.meta_json ?? null, {})
    const components = Array.isArray(meta?.components) ? meta.components : []
    const container = components.find(component => component?.type === 'container')
    const entries = Array.isArray(container?.data?.contents) ? container.data.contents : []
    const build = reg => {
      const byId = this.itemsByIdMap(reg)
      const tokens = []
      for (const entry of entries) {
        const count = Number.parseInt(entry?.itemCount ?? entry?.count ?? 0, 10)
        if (!Number.isFinite(count) || count <= 0) continue
        let name = null
        if (typeof entry?.itemId === 'string' && entry.itemId) {
          name = entry.itemId.startsWith('minecraft:') ? entry.itemId : `minecraft:${entry.itemId}`
        } else if (Number.isInteger(entry?.itemId)) {
          name = byId.get(entry.itemId) ?? null
        }
        if (!name) continue
        tokens.push(`${name}x${count}`)
      }
      return tokens.sort().join('|')
    }
    const legacyCatalog = this.legacy12111Catalog()
    return {
      current: build(this.mcData),
      legacy: legacyCatalog ? build(legacyCatalog) : ''
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
    // 耐久物品先剥 damage：耐久随使用漂移，同种物品一堆耐久 key
    //（2026-11 打火石案：24 个档，取货开窗与账对不上 → actual=0 → 修账扣账）。
    const undamaged = this.isDurableItem(itemId) ? this.stripDamageComponentsForFingerprint(base) : base
    // 散货级再剥 block_state（盒内条目 3541e23 已剥）：放置状态不进库存身份，
    // 且 26.x 桶 NBT 快照丢物品组件（Servux 读桶）而协议开窗带组件——同一根
    // 线 sync 写 3099d1fa、开窗实测 a6530f2f，取货按账本开 7 桶全扑空 5/5 卡死
    //（2026-11 线案）。剥后两路都归一成无 block_state 形状，桶档重算即合并。
    const noBlockState = this.stripBlockStateComponentsForFingerprint(itemId, undamaged)
    const stripped = this.stripVolatileMetaForFingerprint(itemId, noBlockState)
    // 药水 potion_contents 两代形状归一：8月开窗解码（potionId 数字 + 驼峰空字段）
    // vs Servux/26.x（potion 字符串）。不归一则同一瓶药水 sync 记 c1ce82、开窗
    // 算 2138bb，取货按账本开 7 桶全扑空（2026-11-20 长抗火药水案）。空字段一律
    // 剥，非空字段键名对齐驼峰（协议解码风格，8月存档大头）。
    const potionUnified = this.unifyPotionContentsForFingerprint(stripped)
    // tobyscamera 相机物品指纹锚定稳定组件，文本组件剥离（见 stripTobysTextComponentsForFingerprint）。
    if (this.hasTobysCameraMediaId(potionUnified)) {
      return this.sortMetaComponentsForFingerprint(this.stripTobysTextComponentsForFingerprint(potionUnified))
    }
    if (this.isNoteBlock(itemId)) return this.canonicalNoteBlockMetaForFingerprint(potionUnified)
    return this.sortMetaComponentsForFingerprint(potionUnified)
  }

  // potion_contents 组件指纹归一：顶层组件里 type === 'potion_contents' 的
  // data 逐条过 unifyPotionContentsDataForFingerprint。只动指纹，存档形状原样。
  unifyPotionContentsForFingerprint (meta) {
    if (!meta || typeof meta !== 'object' || !Array.isArray(meta.components)) return meta
    let changed = false
    const components = meta.components.map(component => {
      if (component?.type !== 'potion_contents') return component
      const unified = this.unifyPotionContentsDataForFingerprint(component.data)
      if (unified === component.data) return component
      changed = true
      return { ...component, data: unified }
    })
    return changed ? { ...meta, components } : meta
  }

  // 一条 potion_contents data 的形状归一。输入可能形状：
  //  - 协议开窗解码（8月起稳定）：{potionId: 12, customEffects: [], customColor: null, customName: null}
  //  - Servux NBT：{potion: 'minecraft:long_fire_resistance'}（空字段 NBT 不写）
  // 输出统一：{potionId?: <数字>} + 非空字段驼峰。字符串名靠服务器 potion registry
  // （loadServerPotions）转数字；无映射时保字符串原样（同形状恒等，不误并）。
  unifyPotionContentsDataForFingerprint (data) {
    const list = Array.isArray(data) ? data : [data]
    if (!list.length) return data
    const unified = list.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
      const out = {}
      if (entry.potion != null) {
        const name = String(entry.potion).replace(/^minecraft:/, '')
        const numericId = this.serverPotionIdByName.get(name)
        if (Number.isFinite(numericId)) out.potionId = numericId
        else out.potion = entry.potion
      } else if (entry.potionId != null) {
        out.potionId = entry.potionId
      }
      const customColor = entry.custom_color ?? entry.customColor
      if (customColor != null) out.customColor = customColor
      const customName = entry.custom_name ?? entry.customName
      if (customName != null && customName !== '') out.customName = customName
      const customEffects = entry.custom_effects ?? entry.customEffects
      if (Array.isArray(customEffects) && customEffects.length) {
        // custom_effects 条目两路形状不同，必须逐条归一（unifyCustomEffectEntryForFingerprint），
        // 不能原样透传——透传则 Servux 字符串名形状与开窗数字形状各算各的 key
        //（2026-11-20 漂浮药水案：a1da56 隔空形状 vs 9669a5f 开窗形状分裂）。
        // 多效果列表还要排序：sortNestedItemComponentsForFingerprint 只排 components/
        // removeComponents，customEffects 保原序，两路顺序不一致会分裂（对抗审查实证），
        // 按稳定字符串排序让指纹与列表顺序无关（单效果排序不变，key 不会漂）。
        const unifiedEffects = customEffects.map(effect => this.unifyCustomEffectEntryForFingerprint(effect))
        unifiedEffects.sort((a, b) => {
          const sa = stableStringify(a)
          const sb = stableStringify(b)
          return sa < sb ? -1 : sa > sb ? 1 : 0
        })
        out.customEffects = unifiedEffects
      }
      // 无相关字段（如别的 mod 组件）时保原引用；有相关字段一律输出统一形状
      //（幂等：统一形状再跑一遍键值不变）。注：键名对齐后必须输出 out，
      // 否则 custom_color 会被 same 短路成"无变化"（绿牛案首测 FAIL 教训）。
      return Object.keys(out).length ? out : entry
    })
    const allSame = unified.every((u, i) => u === list[i])
    if (allSame) return data
    return Array.isArray(data) ? unified : unified[0]
  }

  // custom_effects 单条形状归一。同一效果两条读取路径形状不同：
  //  - 协议开窗（prismarine 1.21.5+ EffectInstance）：{id: 24, details: {ambient,
  //    amplifier, duration, hiddenEffect, showIcon, showParticles}}，字段全带默认值
  //  - Servux NBT：{id: 'minecraft:levitation', duration, show_icon}，默认值不写
  //  输出统一：{id: <数字>} + 非默认字段；默认值（amplifier 0 / ambient false /
  //  showIcon true / showParticles true / duration 0 / hiddenEffect null）一律剥。
  //  字符串名靠服务器 mob_effect registry（loadServerEffects）转数字；无映射时
  //  保字符串原样（同形状恒等，不误并，等登录导出后补跑迁移再并）。
  unifyCustomEffectEntryForFingerprint (effect) {
    if (!effect || typeof effect !== 'object' || Array.isArray(effect)) return effect
    // 开窗把实例字段包在 details 里，Servux 平铺；两个形状的 id 都在顶层。
    const nested = effect.details && typeof effect.details === 'object' && !Array.isArray(effect.details)
      ? effect.details
      : effect
    const out = {}
    const id = effect.id != null ? effect.id : nested.id
    if (Number.isFinite(id)) {
      out.id = id
    } else if (typeof id === 'string' && id) {
      const name = id.replace(/^minecraft:/, '')
      const numericId = this.serverEffectIdByName.get(name)
      out.id = Number.isFinite(numericId) ? numericId : id
    }
    if (Number.isFinite(nested.duration) && nested.duration !== 0) out.duration = nested.duration
    if (Number.isFinite(nested.amplifier) && nested.amplifier !== 0) out.amplifier = nested.amplifier
    if (nested.ambient === true) out.ambient = true
    const showIcon = nested.showIcon ?? nested.show_icon
    if (showIcon === false || showIcon === 0) out.showIcon = false
    const showParticles = nested.showParticles ?? nested.show_particles
    if (showParticles === false || showParticles === 0) out.showParticles = false
    const hiddenEffect = nested.hiddenEffect ?? nested.hidden_effect
    if (hiddenEffect && typeof hiddenEffect === 'object' && !Array.isArray(hiddenEffect)) {
      const unifiedHidden = this.unifyCustomEffectEntryForFingerprint(hiddenEffect)
      if (unifiedHidden && typeof unifiedHidden === 'object') out.hiddenEffect = unifiedHidden
    }
    return Object.keys(out).length ? out : effect
  }

  // 耐久物品（maxDurability 的工具/武器/护甲/潜影盒壳等）。1.21.5+ 的
  // 身份字段全在 components（custom_name/lore/附魔/custom_data），nbt 只剩
  // 合成的 legacy Damage；damage 从指纹剥离后满耐久与磨损版并档。
  isDurableItem (itemId) {
    const simple = this.normalizeItemId(itemId).replace(/^minecraft:/, '')
    return Boolean(this.mcData.itemsByName[simple]?.maxDurability)
  }

  // damage 组件从指纹剥离（存档 metaJson 原样保留，展示不受影响）。
  stripDamageComponentsForFingerprint (meta) {
    if (!meta || typeof meta !== 'object' || !Array.isArray(meta.components)) return meta
    const kept = meta.components.filter(component => component?.type !== 'damage')
    if (kept.length === meta.components.length) return meta
    return { ...meta, components: kept.length ? kept : null }
  }

  // block_state 组件从指纹剥离（散货级；盒内条目在 shouldKeepComponentForFingerprint 剥）。
  // 音符盒跳过：block_state 由 canonicalNoteBlockMetaForFingerprint 统一固定默认值，
  // 提前剥掉会改变 canonical 分支的输入形状。
  stripBlockStateComponentsForFingerprint (itemId, meta) {
    if (this.isNoteBlock(itemId)) return meta
    if (!meta || typeof meta !== 'object' || !Array.isArray(meta.components)) return meta
    const kept = meta.components.filter(component => component?.type !== 'block_state')
    if (kept.length === meta.components.length) return meta
    return { ...meta, components: kept.length ? kept : null }
  }

  // tobyscamera 相机物品（相片袋/照片）：custom_data 组件含 tobyscamera:media_id。
  hasTobysCameraMediaId (meta) {
    if (!Array.isArray(meta?.components)) return false
    return meta.components.some(component =>
      component?.type === 'custom_data' &&
      component.data && typeof component.data === 'object' &&
      typeof component.data['tobyscamera:media_id'] === 'string')
  }

  // 相机物品的文本组件（lore/custom_name）会被插件原地清写——实测相片袋
  // 04ec8f867 的 lore 文本被清空后指纹漂移成 3be52c0ba，账本认旧指纹导致
  // 开桶读不到实物（actual=0）、取货失败并触发修账。指纹改为只锚定稳定
  // 组件（custom_data 的 media_id 身份 + map_id 预览图）；lore/custom_name
  // 从指纹中剥离。物品展示名与建档走原始 metaJson，不受剥离影响。
  stripTobysTextComponentsForFingerprint (meta) {
    if (!Array.isArray(meta?.components)) return meta
    const components = meta.components.filter(component =>
      component?.type !== 'lore' && component?.type !== 'custom_name')
    return { ...meta, components }
  }

  normalizeItemMetadata (metadata) {
    return this.mcData.supportFeature?.('itemsWithComponents') ? null : (metadata ?? null)
  }

  normalizeNbtForFingerprint (itemId, nbt) {
    // 耐久物品的 nbt 只剩合成 legacy Damage（0 或磨损值）：damage 已从指纹
    // 剥离，nbt 也不参与——否则同一件工具会因「有无 Damage NBT」再分裂
    //（2026-11 打火石档：同 damage 值的行 NBT=null vs {"Damage":typed 0} 两个 key）。
    if (this.isDurableItem(itemId)) return null
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

  // 容器内容里的数字 itemId → 稳定的 minecraft: 全名（指纹用）。
  // 数字 id 随目录版本变（1.21.11 → 26.3 全表移位 +152）——数字原样进指纹会让
  // 同一件实物在目录切换后算出不同 key（幽灵条目/取出失败，2026-11 部署实测）。
  itemNameByNumericId (catalog, numericId) {
    if (!catalog || !Number.isInteger(numericId)) return null
    if (!this._numericIdNameCache) this._numericIdNameCache = new WeakMap()
    let map = this._numericIdNameCache.get(catalog)
    if (!map) {
      map = new Map()
      for (const item of (catalog.itemsArray ?? [])) {
        if (Number.isInteger(item.id)) map.set(item.id, item.name)
      }
      this._numericIdNameCache.set(catalog, map)
    }
    return map.get(numericId) ?? null
  }

  // 1.21.11 目录（bot 切到 26.3 之前的解析基线），用于存量记录的指纹迁移
  legacy12111Catalog () {
    if (this._legacy12111Catalog === undefined) {
      try {
        this._legacy12111Catalog = require('minecraft-data')('1.21.11')
      } catch {
        this._legacy12111Catalog = null
      }
    }
    return this._legacy12111Catalog
  }

  // 存量记录的容器内容里，是否存在“两个目录解析出不同物品名”的数字 id——
  // 这类行无法可靠判断它是 1.21.11 时代还是 26.3 时代入的账，迁移会算错名字。
  // 返回 true 时 canonicalizeStoredItem 会跳过该行（保留旧 key，交给下一次
  // !同步 的实物重录 + 库存异常对账修正，绝不错误合并余额）。
  metaHasVersionAmbiguousContainerEntries (itemId, meta) {
    if (!this.isShulkerBox(itemId)) return false
    const legacy = this.legacy12111Catalog()
    if (!legacy) return false
    const components = Array.isArray(meta?.components) ? meta.components : []
    const container = components.find(component => component?.type === 'container')
    const contents = Array.isArray(container?.data?.contents) ? container.data.contents : []
    for (const entry of contents) {
      if (!Number.isInteger(entry?.itemId)) continue
      const currentName = this.itemNameByNumericId(this.mcData, entry.itemId)
      const legacyName = this.itemNameByNumericId(legacy, entry.itemId)
      if (currentName && legacyName && currentName !== legacyName) return true
    }
    return false
  }

  normalizeContainerEntryForFingerprint (entry) {
    if (!entry) return null
    // 数字 id（协议解析/servux 转换）→ 稳定全名；字符串 id（修复后入账的记录）原样保留
    let fingerprintItemId
    if (typeof entry.itemId === 'string' && entry.itemId) {
      fingerprintItemId = entry.itemId.startsWith('minecraft:') ? entry.itemId : `minecraft:${entry.itemId}`
    } else if (Number.isInteger(entry.itemId)) {
      const name = this.itemNameByNumericId(this.mcData, entry.itemId)
      if (!name) return null
      fingerprintItemId = `minecraft:${name}`
    } else {
      return null
    }
    const count = Number.parseInt(entry.itemCount ?? entry.count ?? 0, 10)
    if (!Number.isFinite(count) || count <= 0) return null

    const fixedBeeContainer = this.isBeeContainerEntry(entry)
    const isBreweryX = this.isBreweryXMeta({ components: entry.components })
    // 耐久条目的 damage 同顶层剥离（8f317b2 只做了散货/盒外，盒内条目漏了）：
    // 迁移重算与运行时读盒（fromContainerEntry→normalizeMetaForFingerprint 剥）
    // 必须同形，否则同一只盒 8 月旧档与重读各算各的 key（音符盒 05b1b67f 案：
    // 账上 22 个盒、桶里读出的是新 key，取货全部回退失败）。
    const entryIsDurable = !fixedBeeContainer && this.isDurableItem(fingerprintItemId)
    const components = !fixedBeeContainer && Array.isArray(entry.components)
      ? entry.components
        .filter(component => this.shouldKeepComponentForFingerprint(component))
        .filter(component => !(entryIsDurable && component?.type === 'damage'))
        .map(component => this.normalizeContainerComponentForFingerprint(component, isBreweryX))
      : []
    components.sort((a, b) => this.compareFingerprintValues(a, b))
    const removeComponents = !fixedBeeContainer && Array.isArray(entry.removeComponents) && entry.removeComponents.length
      ? [...entry.removeComponents].sort()
      : []

    return {
      itemId: fixedBeeContainer ? this.canonicalBeeContainerItemId(entry) : fingerprintItemId,
      itemCount: count,
      components,
      removeComponents
    }
  }

  shouldKeepComponentForFingerprint (component) {
    if (!component || typeof component !== 'object') return false
    const type = component.type
    // 盒内条目指纹剥两类波动组件：
    // - custom_data：craftengine network_data 等插件附加数据，附加时机不定，
    //   同一批物品隔天读就从无到有（2026-11 音符盒案：09:14 存入读 null 组件，
    //   次日实物全带 network_data）。
    // - block_state：放置状态（音符盒乐器/音高、雕纹书的纹样等），调音/放置
    //   即变；且 Servux 直形状 {instrument…} 与协议开窗 {name, properties} 包装
    //   形状两路字面不同（同盒 9230058e vs 1dd06b 分裂 → 取货 21 次回退全败）。
    return !['custom_data', 'block_state'].includes(type)
  }

  normalizeComponentForFingerprint (component) {
    return {
      type: component.type,
      data: this.sortNestedItemComponentsForFingerprint(component.data ?? null)
    }
  }

  normalizeContainerComponentForFingerprint (component, isBreweryX) {
    let normalized = this.normalizeComponentForFingerprint(component)
    // 盒内药水条目同顶层归一（potion_contents 数字↔字符串两代形状）：散货在
    // normalizeMetaForFingerprint→unifyPotionContentsForFingerprint 归一，盒内
    // 条目此前漏了——同一只装药水的盒子 8 月旧档（Servux 字符串形状）与开窗
    // 重读（数字形状）各算各的 key，账上盒子悬空、桶里实物对不上，拆盒取药
    // 必败（2026-11-20 虚弱药水拆盒案：账 9302fb7b、桶里实物 8f8932fd）。
    if (normalized?.type === 'potion_contents') {
      const unified = this.unifyPotionContentsDataForFingerprint(normalized.data)
      if (unified !== normalized.data) normalized = { ...normalized, data: unified }
    }
    if (!isBreweryX || component?.type !== 'tooltip_display') return normalized
    return {
      ...normalized,
      data: this.omitObjectKeyDeep(normalized.data, 'hiddenComponents')
    }
  }

  sortMetaComponentsForFingerprint (meta) {
    if (!meta || typeof meta !== 'object') return meta
    // 顶层空组件归一：波动组件剥完剩下的 [](如线案的 custom_data 空壳滤除后)
    // 与无组件的 null 是同一物品，必须同指纹。sanitize 对空数组转 null，
    // 但带组件再剥完的路径输出 [] —— 不归一的话同一根线 sync 记 3099d1fa
    // (null 形)、开窗算 6c29925a([] 形)，两个 key 互相找不到。
    let normalized = meta
    if (Array.isArray(normalized.components) && normalized.components.length === 0) {
      normalized = { ...normalized, components: null }
    }
    return this.sortNestedItemComponentsForFingerprint(normalized)
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
    // 形状对齐收口（全路径必经）：Servux NBT typed / block_state properties →
    // 协议路平形状，两条读取路径对同一物品产出字面恒等的 metaJson。
    meta = this.alignStoredComponentShapesDeep(meta)
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

    // 其它嵌套物品容器（收纳袋 bundle_contents / 弩 charged_projectiles）：
    // 条目同样落库即全名（containerEntryFullItemId），metaJson 不落数字。
    if (type === 'bundle_contents' || type === 'charged_projectiles') {
      const entries = this.nestedItemEntryList(component)
      if (entries) {
        const list = entries.map(entry => this.containerEntryFullItemId(entry))
        const data = Array.isArray(component.data)
          ? list
          : { ...component.data, [Array.isArray(component.data?.contents) ? 'contents' : 'projectiles']: list }
        return { ...component, data }
      }
    }

    return {
      ...component,
      data: this.compactLargeValue(component.data, `component:${type}`)
    }
  }

  sanitizeShulkerContainerEntry (entry) {
    if (!entry || typeof entry !== 'object') return entry
    if (this.isBeeContainerEntry(entry)) {
      return {
        ...entry,
        // 蜂箱内容（蜜蜂活动数据）不稳定：抹平成固定形状。itemId 用全名字符串
        // 统一形状——beehive/bee_nest 本名保留，仅带蜂数据的非蜂箱杂牌归一到
        // bee_nest（与 canonicalBeeContainerItemId 同语义，保证盒内盒外同 key；
        // 1.21.11 时代存的数字形状由对账 canonicalize 的 move 合并兜底）。
        itemId: this.canonicalBeeContainerFullItemId(entry),
        addedComponentCount: 0,
        components: [],
        removeComponents: [],
        removedComponentCount: 0
      }
    }
    return this.containerEntryFullItemId(entry)
  }

  // 蜂箱容器条目的全名版 canonical（与 canonicalBeeContainerItemId 同语义）：
  // 本尊蜂箱（beehive/bee_nest）保留原名，带蜂数据的杂牌物品归一到 bee_nest。
  canonicalBeeContainerFullItemId (entry) {
    const nestedItem = this.mcData.items[entry.itemId]
    const nestedItemId = nestedItem ? `minecraft:${nestedItem.name}` : null
    if (this.isBeeContainer(nestedItemId)) return nestedItemId
    return `minecraft:${this.mcData.itemsByName.bee_nest?.name || 'bee_nest'}`
  }

  // 容器条目 itemId 落库即全名：数字（当前会话协议解码的目录编码）→ 当前字典
  // → 全名字符串；字符串原样归一。metaJson 从此不携带任何目录的数字编码，
  // 跨版本指纹稳定：normalizeContainerEntryForFingerprint 本来就把数字翻成
  // 全名再参与哈希，同一件实物“数字直算”与“全名直算”输入恒等、key 不变。
  // 解不出的数字原样保留，交给 !同步 重扫重录兜底。
  containerEntryFullItemId (entry) {
    if (typeof entry?.itemId === 'string') {
      if (!entry.itemId) return entry
      return { ...entry, itemId: entry.itemId.startsWith('minecraft:') ? entry.itemId : `minecraft:${entry.itemId}` }
    }
    if (!Number.isInteger(entry?.itemId)) return entry
    const name = this.itemNameByNumericId(this.mcData, entry.itemId)
    if (!name) return entry
    return { ...entry, itemId: `minecraft:${name}` }
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

  // 服务器资源包语言合并：只补 language 字典里没有的键（客户端版 zh_cn.json
  // 已命中的翻译优先），返回补进来的条数。附魔注册表 describe 翻译靠这张表。
  mergeLanguage (extra) {
    let added = 0
    for (const [key, value] of Object.entries(extra || {})) {
      if (key in this.language) continue
      if (value == null) continue
      this.language[key] = value
      added++
    }
    return added
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

  // 服务器 potion registry 导出文件（登录 registry_data → data/server-potions.json）
  // → 名字 → 数字 id 映射。指纹归一用它把 Servux 字符串形状转成协议数字形状，
  // 或反向对齐（见 unifyPotionContentsDataForFingerprint）。
  loadServerPotions (file) {
    if (!file) return 0
    const filePath = path.resolve(process.cwd(), file)
    if (!fs.existsSync(filePath)) return 0
    let data
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
      return 0
    }
    const entries = Array.isArray(data?.potions) ? data.potions : []
    let loaded = 0
    for (const entry of entries) {
      const numericId = Number.parseInt(entry?.id, 10)
      const name = String(entry?.name || entry?.key || '').replace(/^minecraft:/, '')
      if (!Number.isFinite(numericId) || !name) continue
      this.serverPotionIdByName.set(name, numericId)
      loaded++
    }
    return loaded
  }

  reloadServerPotions (file = 'data/server-potions.json') {
    this.serverPotionIdByName.clear()
    return this.loadServerPotions(file)
  }

  // 服务器 mob_effect registry 导出文件（登录 registry_data → data/server-effects.json）
  // → 效果名字 → 数字 id 映射。custom_effects 条目的 Servux 字符串名转协议数字 id 用。
  loadServerEffects (file) {
    if (!file) return 0
    const filePath = path.resolve(process.cwd(), file)
    if (!fs.existsSync(filePath)) return 0
    let data
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
      return 0
    }
    const entries = Array.isArray(data?.effects) ? data.effects : []
    let loaded = 0
    for (const entry of entries) {
      const numericId = Number.parseInt(entry?.id, 10)
      const name = String(entry?.name || entry?.key || '').replace(/^minecraft:/, '')
      if (!Number.isFinite(numericId) || !name) continue
      this.serverEffectIdByName.set(name, numericId)
      loaded++
    }
    return loaded
  }

  reloadServerEffects (file = 'data/server-effects.json') {
    this.serverEffectIdByName.clear()
    return this.loadServerEffects(file)
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

    const potionVariantName = this.describePotionVariant(itemId, item.components)
    if (potionVariantName) return potionVariantName

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

    const potionVariantName = this.describePotionVariant(itemId, meta.components)
    if (potionVariantName) return potionVariantName

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

  // 药水细分展示：从 potion_contents 读种类，查语言表
  // item.minecraft.<物品>.effect.<名>（weakness→虚弱药水/water→水瓶）。
  // long_/strong_ 前缀剥掉拼"延长/强化"。数字 potionId 用服务器 potion
  // registry 反查名字（未配锚的数字反查不到，返回 '' 退回基础名）。
  describePotionVariant (itemId, components) {
    const simple = this.normalizeItemId(itemId).replace(/^minecraft:/, '')
    if (!['potion', 'splash_potion', 'lingering_potion'].includes(simple)) return ''
    const potionComponent = Array.isArray(components)
      ? components.find(component => component?.type === 'potion_contents')
      : null
    const data = potionComponent?.data
    if (!data || typeof data !== 'object') return ''
    let name = null
    if (data.potion != null) {
      name = String(data.potion).replace(/^minecraft:/, '')
    } else if (data.potionId != null) {
      for (const [potionName, numericId] of this.serverPotionIdByName) {
        if (numericId === data.potionId) { name = potionName; break }
      }
    }
    if (!name) return ''
    let suffix = ''
    if (name.startsWith('long_')) { suffix = '（延长）'; name = name.slice(5) }
    else if (name.startsWith('strong_')) { suffix = '（强化）'; name = name.slice(7) }
    const localized = this.language[`item.minecraft.${simple}.effect.${name}`]
    if (!localized) return ''
    return suffix ? `${localized}${suffix}` : localized
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
    const push = parsed => {
      if (!parsed) return
      const key = `${parsed.name}:${parsed.level}`
      if (seen.has(key)) return
      seen.add(key)
      result.push(parsed)
    }
    // components 时代（1.20.5+）：附魔组件 data 直接是 {全名: 级} 的 map——
    // 既没有 enchantments 键也没有 levels 键，walkValue 的老形状分支扫不到，
    // 附魔书的 displayName 从 1.21 全量 components 化起一直 fallback 成裸名
    // "附魔书"（2026-11 实测 nova_structures/swift_sneak 均丢明细）。
    if (Array.isArray(components)) {
      for (const component of components) {
        const type = component?.type
        if (type !== 'enchantments' && type !== 'stored_enchantments') continue
        const data = component?.data
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue
        for (const [name, level] of Object.entries(data)) {
          if (typeof level !== 'number' || !Number.isFinite(level) || level <= 0) continue
          push(this.parseEnchantmentEntry({ id: name, level }))
        }
      }
    }
    this.walkValue(components, value => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value.enchantments)) {
        for (const entry of value.enchantments) {
          push(this.parseEnchantmentEntry(entry))
        }
      }
      if (value.levels && typeof value.levels === 'object') {
        for (const [name, level] of Object.entries(value.levels)) {
          push(this.parseEnchantmentEntry({ id: name, level }))
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

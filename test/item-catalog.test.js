const test = require('node:test')
const assert = require('node:assert/strict')
const ItemCatalog = require('../src/itemCatalog')

function typedString (value) {
  return { type: 'string', value }
}

function typedByteArray (value) {
  return { type: 'byteArray', value }
}

function customData (value) {
  return {
    type: 'custom_data',
    data: {
      type: 'compound',
      value
    }
  }
}

function createCatalog () {
  return new ItemCatalog('1.21.11')
}

test('legacy malformed durable components retain tolerant contained-item decoding', () => {
  const catalog = createCatalog()
  const Item = require('prismarine-item')(catalog.mcData)
  const itemId = catalog.mcData.itemsByName.diamond_sword.id
  const expected = catalog.fromPrismarineItem(Item.fromNotch({ itemId, itemCount: 1, components: [], removeComponents: [] }))
  for (const components of [{}, [null], true, 7, 'legacy', null, undefined]) {
    const contained = catalog.fromContainerEntry({ itemId, count: 1, components, removeComponents: {} })
    assert.equal(contained.amount, 1)
    assert.equal(contained.itemKey, expected.itemKey)
    assert.equal(contained.metaJson, expected.metaJson)
    assert.equal(contained.nbtJson, expected.nbtJson)
  }
})

test('catalog startup rebuild indexes a persisted shulker with legacy malformed durable components', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const StoreDb = require('../src/db')
  const { DEFAULT_CONFIG } = require('../src/config')
  const catalog = createCatalog()
  const Item = require('prismarine-item')(catalog.mcData)
  const itemId = catalog.mcData.itemsByName.diamond_sword.id
  const expected = catalog.fromPrismarineItem(Item.fromNotch({ itemId, itemCount: 1, components: [], removeComponents: [] }))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-durable-rebuild-'))
  const dbPath = path.join(directory, 'db.sqlite')
  let db = new StoreDb(dbPath, structuredClone(DEFAULT_CONFIG))
  try {
    db.addBalanceItems('legacy-owner', [{ itemKey: 'legacy-sword-box', itemId: 'minecraft:blue_shulker_box',
      displayName: 'Persisted sword box', nbtJson: 'null', amount: 1,
      metaJson: JSON.stringify({ metadata: null, components: [{ type: 'container', data: {
        contents: [{ itemId, count: 1, components: {} }]
      } }] }) }])
    db.close()
    db = new StoreDb(dbPath, structuredClone(DEFAULT_CONFIG))
    const startup = db.setCatalog(catalog)
    assert.equal(startup.indexed, 1)
    assert.equal(db.catalogMigrationDeferred, false)
    const indexed = db.getOwnerShulkersContainingItemKey('legacy-owner', expected.itemKey)
    assert.equal(indexed.length, 1)
    assert.equal(indexed[0].containedAmount, 1)
    assert.equal(indexed[0].shulkerAmount, 1)
    assert.equal(indexed[0].containedItemId, 'minecraft:diamond_sword')
    assert.equal(db.getItemByKey(expected.itemKey).nbtJson, expected.nbtJson)
    assert.equal(db.rebuildShulkerContentIndex(), 1)
    assert.equal(db.getOwnerShulkersContainingItemKey('legacy-owner', expected.itemKey).length, 1)
  } finally {
    if (db.db.open) db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('modern durable container entries match inventory identities after real packet decoding', () => {
  const catalog = createCatalog()
  const Item = require('prismarine-item')(catalog.mcData)
  const protocol = require('minecraft-protocol')
  const serializer = protocol.createSerializer({ state: 'play', version: '1.21.11', isServer: true })
  const deserializer = protocol.createDeserializer({ state: 'play', version: '1.21.11', isServer: false })
  for (const name of ['diamond_sword', 'bow', 'shield', 'stone', 'ender_pearl', 'beehive']) {
    for (const components of [[], [{ type: 'damage', data: 12 }, { type: 'custom_name', data: typedString('Owned equipment') }]]) {
      const entry = { itemId: catalog.mcData.itemsByName[name].id, itemCount: 1,
        addedComponentCount: components.length, removedComponentCount: 0, components, removeComponents: [] }
      const buffer = serializer.createPacketBuffer({ name: 'window_items', params: { windowId: 0, stateId: 1, items: [entry], carriedItem: { itemCount: 0 } } })
      const decoded = deserializer.parsePacketBuffer(buffer).data.params.items[0]
      const loose = catalog.fromPrismarineItem(Item.fromNotch(decoded))
      const contained = catalog.fromContainerEntry(decoded)
      assert.equal(contained.itemKey, loose.itemKey, `${name} must stay withdrawable after packing`)
      assert.equal(contained.nbtJson, loose.nbtJson)
      const box = new Item(catalog.mcData.itemsByName.blue_shulker_box.id, 1)
      box.components = [{ type: 'container', data: { contents: [decoded, { itemCount: 0 }] } }]
      assert.equal(catalog.extractShulkerContents(catalog.fromPrismarineItem(box))[0].item.itemKey, loose.itemKey)
    }
  }
})

test('shit hat ignores CraftEngine network data without changing stored metadata', () => {
  const catalog = createCatalog()
  const saddle = catalog.mcData.itemsByName.saddle
  const createItem = networkData => ({
    name: saddle.name,
    type: saddle.id,
    count: 1,
    metadata: 0,
    components: [
      customData({
        'craftengine:id': typedString('tsl:shit_hat'),
        'craftengine:network_data': typedByteArray(networkData)
      }),
      { type: 'custom_name', data: '      ' },
      { type: 'item_model', data: 'tsl:shit_hat' }
    ]
  })

  const first = catalog.fromPrismarineItem(createItem([1, 2, 3]))
  const second = catalog.fromPrismarineItem(createItem([4, 5, 6]))

  assert.equal(first.itemKey, second.itemKey)
  assert.match(first.metaJson, /craftengine:network_data/)
  assert.match(second.metaJson, /craftengine:network_data/)

  const changedId = catalog.fromPrismarineItem({
    ...createItem([1, 2, 3]),
    components: [customData({ 'craftengine:id': typedString('tsl:other_hat') })]
  })
  assert.notEqual(first.itemKey, changedId.itemKey)
})

test('shit hat uses the same fingerprint inside a shulker and in an open window', () => {
  const catalog = createCatalog()
  const saddle = catalog.mcData.itemsByName.saddle
  const components = [customData({
    'craftengine:id': typedString('tsl:shit_hat'),
    'craftengine:network_data': typedByteArray([9, 8, 7])
  })]

  const nested = catalog.fromContainerEntry({
    itemId: saddle.id,
    itemCount: 1,
    components
  })
  const opened = catalog.fromPrismarineItem({
    name: saddle.name,
    type: saddle.id,
    count: 1,
    metadata: 0,
    components
  })

  assert.equal(nested.itemKey, opened.itemKey)
})

test('BreweryX potion ignores brew data and tooltip hidden components', () => {
  const catalog = createCatalog()
  const potion = catalog.mcData.itemsByName.potion
  const createItem = (brewData, hiddenComponents, customName = '绿牛典藏版') => ({
    name: potion.name,
    type: potion.id,
    count: 1,
    metadata: 0,
    components: [
      { type: 'potion_contents', data: { customColor: 32768, customEffects: [], customName: null, potionId: null } },
      customData({ 'breweryx:brewdata': typedByteArray(brewData) }),
      { type: 'custom_model_data', data: { colors: [], flags: [], floats: [10000], strings: [] } },
      { type: 'custom_name', data: customName },
      { type: 'tooltip_display', data: { hiddenComponents, hideTooltip: false } }
    ]
  })

  const first = catalog.fromPrismarineItem(createItem([1, 2, 3], [86, 77, 47]))
  const second = catalog.fromPrismarineItem(createItem([9, 8, 7, 6], [44, 70, 53, 16]))

  assert.equal(first.itemKey, second.itemKey)
  assert.match(first.metaJson, /breweryx:brewdata/)
  assert.match(first.metaJson, /hiddenComponents/)

  const nestedFirst = catalog.fromContainerEntry({
    itemId: potion.id,
    itemCount: 1,
    components: createItem([1, 2, 3], [86, 77, 47]).components
  })
  const nestedSecond = catalog.fromContainerEntry({
    itemId: potion.id,
    itemCount: 1,
    components: createItem([9, 8, 7, 6], [44, 70, 53, 16]).components
  })
  assert.equal(nestedFirst.itemKey, nestedSecond.itemKey)
  assert.equal(nestedFirst.itemKey, first.itemKey)

  const renamed = catalog.fromPrismarineItem(createItem([9, 8, 7, 6], [44, 70, 53, 16], '另一瓶药'))
  assert.notEqual(first.itemKey, renamed.itemKey)
})

// 2026-11-24 绿牛典藏版案：同一瓶 BreweryX 药水，Servux 隔空读到占位符 lore
//（extra:["§t"]，插件未解析的服务端存档形态）+ floats-only custom_model_data +
// hidden_components 形 tooltip_display；协议开窗读到解析后的富文本 lore +
// 全字段 custom_model_data + hideTooltip 形 tooltip_display。三条差异叠加，
// sync 记 e2b055、开窗算 0073c1a8，取货按账本位置开桶 actual=0 缺货换桶 5/5
// 全扑空，"取货失败自动销账"一晚烧掉 4 瓶账面，!同步 又把多出的划给 momo。
// 指纹改为剥离三个渲染组件（brewdata/hiddenComponents 已有剥离继续生效），
// 两路形状归一后同 key；盒内条目同剥。
test('BreweryX potionServux placeholder lore and protocol rich lore unify into one fingerprint', () => {
  const catalog = createCatalog()
  const potion = catalog.mcData.itemsByName.potion

  // Servux 路（sync 写入形状）：占位符 lore、floats-only custom_model_data、
  // hidden_components 列表形 tooltip_display——对应生产 e2b055。
  const servuxShape = {
    name: potion.name,
    type: potion.id,
    count: 1,
    metadata: 0,
    components: [
      customData({ 'breweryx:brewdata': typedByteArray([86, 1, 0, 0, 10, -71, 2, 0, 6, -25, -69, -65, -25, -119, -101, 0, 0, 0, 0, 0]) }),
      { type: 'lore', data: [
        { extra: ['§t'], text: '' },
        { extra: ['§t'], text: '' },
        { extra: ['§u'], text: '' },
        { extra: ['§s'], text: '' },
        { extra: ['§p'], text: '' },
        { extra: ['§y'], text: '' }
      ] },
      { type: 'potion_contents', data: { custom_color: 32768 } },
      { type: 'custom_name', data: { extra: [{ bold: 0, color: 'white', italic: 0, obfuscated: 0, strikethrough: 0, text: '绿牛典藏版', underlined: 0 }], text: '' } },
      { type: 'custom_model_data', data: { floats: [10000] } },
      { type: 'tooltip_display', data: { hidden_components: ['minecraft:attribute_modifiers', 'minecraft:banner_patterns', 'minecraft:container'] } }
    ]
  }

  // 协议开窗路（取货实测形状）：富文本 lore、全字段 custom_model_data、
  // hideTooltip 布尔形 tooltip_display——对应生产 0073c1a8。
  const windowShape = {
    name: potion.name,
    type: potion.id,
    count: 1,
    metadata: 0,
    components: [
      customData({ 'breweryx:brewdata': typedByteArray([86, 1, 29, -28, 83, 93, 54, -62, -11, 6, 16, -118, 118, -33, 46, 126]) }),
      { type: 'lore', data: [
        { extra: [{ '': '§t' }, { bold: 0, color: 'gray', italic: 0, obfuscated: 0, strikethrough: 0, text: '喝下它你会觉得十分有力', underlined: 0 }], text: '' },
        { extra: [{ '': '§t' }, { bold: 0, color: 'dark_green', italic: 0, obfuscated: 0, strikethrough: 0, text: '绿牛之力欲破罐而出', underlined: 0 }], text: '' }
      ] },
      { type: 'potion_contents', data: { customColor: 32768, customEffects: [], customName: null, potionId: null } },
      { type: 'custom_name', data: { extra: [{ bold: 0, color: 'white', italic: 0, obfuscated: 0, strikethrough: 0, text: '绿牛典藏版', underlined: 0 }], text: '' } },
      { type: 'custom_model_data', data: { colors: [], flags: [], floats: [10000], strings: [] } },
      { type: 'tooltip_display', data: { hideTooltip: false } }
    ]
  }

  const servux = catalog.fromPrismarineItem(servuxShape)
  const opened = catalog.fromPrismarineItem(windowShape)
  assert.equal(servux.itemKey, opened.itemKey, '两路形状必须归一到同一指纹')

  // 存档形状不受指纹剥离影响：lore 文案原样保留
  assert.match(opened.metaJson, /绿牛之力欲破罐而出/)

  // 盒内条目同剥：装这瓶酒的盒子两路也必须同 key
  const nested = catalog.fromContainerEntry({
    itemId: potion.id,
    itemCount: 1,
    components: servuxShape.components
  })
  assert.equal(nested.itemKey, opened.itemKey)

  // 非 BreweryX 的普通药水不受影响：lore 差异仍是指纹差异
  const plainServux = {
    ...servuxShape,
    components: servuxShape.components.filter(component => component?.type !== 'custom_data')
  }
  const plainOpened = {
    ...windowShape,
    components: windowShape.components.filter(component => component?.type !== 'custom_data')
  }
  const plainA = catalog.fromPrismarineItem(plainServux)
  const plainB = catalog.fromPrismarineItem(plainOpened)
  assert.notEqual(plainA.itemKey, plainB.itemKey, '非 BreweryX 物品的 lore 差异保持区分')
})

// 2026-11-24 小三月仓库案：潜影盒内 2 瓶 BreweryX 龙涎酒被 isBeeContainerEntry
// 的字符串值全域匹配误判成蜂箱，sanitizeShulkerContainerEntry 把它们的身份改写
// 成 bee_nest + 空组件——同一只盒子 sync 记新指纹，旧指纹 missing 销账、新指纹
// extra 划 momo，pair 配对器因签名差异漏配。修复后判定只认组件名/legacy 键名，
// 不再对任意字符串值做全域匹配；真蜂箱（nestedItemId 命中）与杂牌带蜂数据
// （removeComponents 'bees'）的既有归一不受影响。
test('bee container detection does not misread nested BreweryX potions as bee nests', () => {
  const catalog = createCatalog()
  const shulker = catalog.mcData.itemsByName.shulker_box
  const potion = catalog.mcData.itemsByName.potion
  const nest = catalog.mcData.itemsByName.bee_nest

  // 盒内的 BreweryX 酒（带 brewdata/custom_data 等组件；lore 里的字符串值
  // 不再触发蜂箱判定）
  const breweryPotion = {
    itemId: potion.id,
    itemCount: 1,
    addedComponentCount: 2,
    components: [
      { type: 'custom_data', data: { type: 'compound', value: { 'PublicBukkitValues': { type: 'compound', value: { 'breweryx:brewdata': { type: 'byteArray', value: [86, 1, 0, 0] } } } } } },
      { type: 'custom_name', data: { extra: [{ text: '龙涎酒', color: 'white', italic: false }], text: '' } },
      { type: 'lore', data: [{ extra: [{ text: 'bees', color: 'gray' }], text: '' }] }
    ],
    removeComponents: [],
    removedComponentCount: 0
  }
  // 直接判定：蜂箱判定为 false
  assert.equal(catalog.isBeeContainerEntry(breweryPotion), false)

  // 落库归一：身份保持 potion，不变成 bee_nest
  const stored = catalog.sanitizeShulkerContainerEntry(breweryPotion)
  assert.equal(stored.itemId, `minecraft:${potion.name}`)

  // 真蜂巢格子仍归一（nestedItemId 命中）
  const trueNest = {
    itemId: nest.id,
    itemCount: 1,
    addedComponentCount: 1,
    components: [{ type: 'bees', data: { bees: [{ ticksInHive: 20 }] } }],
    removeComponents: [],
    removedComponentCount: 0
  }
  assert.equal(catalog.isBeeContainerEntry(trueNest), true)
  const storedNest = catalog.sanitizeShulkerContainerEntry(trueNest)
  assert.equal(storedNest.itemId, `minecraft:${nest.name}`)
  assert.deepEqual(storedNest.components, [])

  // 杂牌带蜂数据（removeComponents 显式移除 bees）仍归一到 bee_nest
  const corrupted = {
    itemId: catalog.mcData.itemsByName.copper_nugget.id,
    itemCount: 1,
    addedComponentCount: 0,
    components: [],
    removeComponents: ['minecraft:bees'],
    removedComponentCount: 1
  }
  assert.equal(catalog.isBeeContainerEntry(corrupted), true)

  // legacy NBT 键名 Bees 也仍触发
  const legacyBees = {
    itemId: catalog.mcData.itemsByName.oak_planks.id,
    itemCount: 1,
    addedComponentCount: 1,
    components: [{ type: 'custom_data', data: { type: 'compound', value: { Bees: { type: 'list', value: { type: 'compound', value: [] } } } } }],
    removeComponents: [],
    removedComponentCount: 0
  }
  assert.equal(catalog.isBeeContainerEntry(legacyBees), true)

  // end-to-end：装着 BreweryX 酒的潜影盒，两条读取路径（开窗协议/Servux NBT）
  // 落库后盒内条目都是 potion，指纹不再因蜂箱误判分裂
  const shulkerMeta = contents => ({
    name: shulker.name,
    type: shulker.id,
    count: 1,
    metadata: 0,
    components: [{ type: 'container', data: { contents } }]
  })
  const windowBox = catalog.fromPrismarineItem(shulkerMeta([
    breweryPotion,
    { itemId: catalog.mcData.itemsByName.oak_planks.id, itemCount: 3, addedComponentCount: 0, components: [], removeComponents: [], removedComponentCount: 0 }
  ]))
  const windowEntry = JSON.parse(windowBox.metaJson).components[0].data.contents[0]
  assert.equal(windowEntry.itemId, `minecraft:${potion.name}`)
  assert.equal(JSON.stringify(windowEntry.components).includes('brewdata'), true)
})

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

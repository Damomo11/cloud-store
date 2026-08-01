const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const minecraftData = require('minecraft-data')
const { createDeserializer, createSerializer } = require('minecraft-protocol')
const Warehouse = require('../src/warehouse')
const { isFatalProtocolReadError } = require('../src/botConnection')

test('fatal Slot/NBT protocol read errors are recognized without matching ordinary errors', () => {
  assert.equal(isFatalProtocolReadError(new Error('Read error for undefined : array size is abnormally large, not reading: 168296465')), true)
  assert.equal(isFatalProtocolReadError(new Error('failure in SlotComponent while reading play.toClient')), true)
  assert.equal(isFatalProtocolReadError(new Error('打开箱子超时')), false)
})

test('warehouse abort identifies the barrel and immediately rejects an open wait', async () => {
  const bot = new EventEmitter()
  bot._client = { ended: false, socket: { destroyed: false } }
  const warehouse = new Warehouse(bot, {}, {}, {
    warehouse: { chestBlockNames: ['barrel'] },
    timing: {}
  })
  warehouse.openingChest = {
    chestId: '-23046,-52,-24771',
    x: -23046,
    y: -52,
    z: -24771,
    blockName: 'barrel'
  }

  const pending = warehouse.withTimeout(new Promise(() => {}), 10000, 'timeout')
  const fatal = warehouse.abortForProtocolReadError(new Error('SlotComponent: array size is abnormally large, not reading: 168296465'))

  await assert.rejects(pending, error => {
    assert.equal(error, fatal)
    assert.equal(error.code, 'FATAL_PROTOCOL_READ')
    assert.match(error.message, /barrel@-23046,-52,-24771/)
    return true
  })
})

test('1.21.11 protocol decodes a beehive with bees nested inside a shulker box', () => {
  const mcData = minecraftData('1.21.11')
  const beeNbt = {
    type: 'compound',
    name: '',
    value: {
      id: { type: 'string', value: 'minecraft:bee' },
      UUID: { type: 'intArray', value: [1, 2, 3, 4] }
    }
  }
  const beehive = {
    itemCount: 1,
    itemId: mcData.itemsByName.beehive.id,
    addedComponentCount: 1,
    removedComponentCount: 0,
    components: [{
      type: 'bees',
      data: { bees: [{ nbtData: beeNbt, ticksInHive: 20, minTicksInHive: 600 }] }
    }],
    removeComponents: []
  }
  const shulker = {
    itemCount: 1,
    itemId: mcData.itemsByName.shulker_box.id,
    addedComponentCount: 1,
    removedComponentCount: 0,
    components: [{ type: 'container', data: { contents: [beehive] } }],
    removeComponents: []
  }
  const serializer = createSerializer({ state: 'play', version: '1.21.11', isServer: true })
  const deserializer = createDeserializer({ state: 'play', version: '1.21.11', isServer: false, noErrorLogging: true })
  const encoded = serializer.createPacketBuffer({
    name: 'window_items',
    params: { windowId: 1, stateId: 1, items: [shulker], carriedItem: { itemCount: 0 } }
  })

  const decoded = deserializer.parsePacketBuffer(encoded).data.params.items[0]
  const nestedBees = decoded.components[0].data.contents[0].components[0].data.bees
  assert.equal(nestedBees.length, 1)
  assert.deepEqual(nestedBees[0].nbtData.value.UUID.value, [1, 2, 3, 4])
})

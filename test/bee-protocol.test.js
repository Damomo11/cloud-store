const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { deflateSync } = require('node:zlib')
const { Client, createSerializer, createDeserializer } = require('minecraft-protocol')
const { installFatalProtocolPacketCapture } = require('../src/botConnection')

const version = '1.21.11'
const serializer = createSerializer({ state: 'play', version, isServer: true })
const empty = { itemCount: 0 }
const bees = [128, 64, 134].map(ticksInHive => ({ nbtData: { type: 'compound', value: {} }, ticksInHive, minTicksInHive: 600 }))
const rawParser = () => createDeserializer({ state: 'play', version, isServer: false, noErrorLogging: true })

function slot (components) {
  return { itemCount: 1, itemId: 1379, addedComponentCount: components.length, removedComponentCount: 0, components, removeComponents: [] }
}

function beeSlot (entries = bees) {
  return slot([{ type: 'bees', data: { bees: entries } }])
}

function infected (packet, entries = bees, badIndexes = entries.map((_, index) => index)) {
  const original = serializer.proto.createPacketBuffer('SlotComponent', { type: 'bees', data: { bees: entries } })
  const offset = packet.indexOf(original)
  assert.ok(offset >= 0)
  const replacement = [Buffer.from([0x4b, entries.length])]
  entries.forEach((entry, index) => {
    if (badIndexes.includes(index)) replacement.push(Buffer.from([0x0b]))
    replacement.push(serializer.proto.createPacketBuffer('anonymousNbt', entry.nbtData))
    replacement.push(serializer.proto.createPacketBuffer('varint', entry.ticksInHive))
    replacement.push(serializer.proto.createPacketBuffer('varint', entry.minTicksInHive))
  })
  return Buffer.concat([packet.subarray(0, offset), ...replacement, packet.subarray(offset + original.length)])
}

function client () {
  const c = new EventEmitter()
  c.version = version
  c.state = 'play'
  c.deserializer = rawParser()
  installFatalProtocolPacketCapture({ username: 'ReplayBot', _client: c })
  return c
}

const cases = [
  ['window_items', item => ({ windowId: 0, stateId: 1, items: [...Array.from({ length: 39 }, () => empty), item, empty], carriedItem: empty })],
  ['set_slot', item => ({ windowId: 0, stateId: 1, slot: 39, item })],
  ['entity_metadata', item => ({ entityId: 265727176, metadata: [{ key: 8, type: 'item_stack', value: item }, { key: 9, type: 'byte', value: 1 }] })],
  ['entity_equipment', item => ({ entityId: 1234, equipments: [{ slot: 0, item }, { slot: 1, item: empty }] })],
  ['set_cursor_item', contents => ({ contents })]
]

for (const [name, params] of cases) {
  test('real 1.21.11 ' + name + ' repairs reported three-bee corruption and preserves following fields', () => {
    const c = client()
    const valid = serializer.createPacketBuffer({ name, params: params(beeSlot()) })
    const expected = rawParser().parsePacketBuffer(Buffer.from(valid)).data
    const malformed = infected(valid)
    assert.throws(() => rawParser().parsePacketBuffer(Buffer.from(malformed)), /array size is abnormally large/)
    const originalReader = c.deserializer.proto.readCtx.SlotComponent
    const result = c.deserializer.parsePacketBuffer(malformed)
    assert.deepEqual(result.data, expected)
    assert.equal(result.metadata.size, malformed.length)
    assert.deepEqual(result.fullBuffer, malformed)
    assert.equal(c.deserializer.proto.readCtx.SlotComponent, originalReader)
  })
}

test('repairs mixed valid, empty and legacy non-empty bee NBT inside a nested shulker', () => {
  const entries = [
    bees[0],
    { ...bees[1], nbtData: { type: 'compound', value: { 'Paper.SpawnReason': { type: 'string', value: 'CUSTOM' }, id: { type: 'string', value: 'minecraft:bee' } } } },
    { ...bees[2], minTicksInHive: 0 }
  ]
  const nested = slot([{ type: 'container', data: { contents: [beeSlot(entries), empty] } }])
  const valid = serializer.createPacketBuffer({ name: 'set_slot', params: { windowId: 0, stateId: 1, slot: 39, item: nested } })
  const c = client()
  const expected = rawParser().parsePacketBuffer(valid).data
  assert.deepEqual(c.deserializer.parsePacketBuffer(infected(valid, entries, [0, 1])).data, expected)
})

test('matching bytes inside custom_data and legitimate NBT arrays remain unchanged', () => {
  const bytes = Buffer.from('4b030b0a008002d8040b0a0040d8040b0a008601d8040b0a08001150617065722e537061776e526561736f6e', 'hex')
  const item = slot([
    { type: 'custom_data', data: { type: 'compound', value: { payload: { type: 'byteArray', value: Array.from(bytes, byte => byte > 127 ? byte - 256 : byte) }, ints: { type: 'intArray', value: [0x0b0a00, 3] } } } },
    { type: 'bees', data: { bees } }
  ])
  const valid = serializer.createPacketBuffer({ name: 'set_slot', params: { windowId: 0, stateId: 1, slot: 39, item } })
  assert.deepEqual(client().deserializer.parsePacketBuffer(valid), rawParser().parsePacketBuffer(valid))
})

test('failed repair restores the shared compiled protocol reader', () => {
  const c = client()
  const valid = serializer.createPacketBuffer({ name: 'set_slot', params: { windowId: 0, stateId: 1, slot: 39, item: beeSlot() } })
  const malformed = infected(valid).subarray(0, -1)
  const originalReader = c.deserializer.proto.readCtx.SlotComponent
  assert.throws(() => c.deserializer.parsePacketBuffer(malformed))
  assert.equal(c.deserializer.proto.readCtx.SlotComponent, originalReader)
  assert.throws(() => rawParser().parsePacketBuffer(infected(valid)), /array size is abnormally large/)
})

test('real Client decodes compressed bee packets after configuration-to-play parser replacement', async () => {
  const c = new Client(false, version, undefined, true)
  installFatalProtocolPacketCapture({ username: 'StreamBot', _client: c })
  c.state = 'configuration'
  c.setCompressionThreshold(0)
  c.state = 'play'
  const valid = serializer.createPacketBuffer({ name: 'set_slot', params: { windowId: 0, stateId: 1, slot: 39, item: beeSlot() } })
  const malformed = infected(valid)
  const compressed = Buffer.concat([serializer.proto.createPacketBuffer('varint', malformed.length), deflateSync(malformed)])
  const frame = Buffer.concat([serializer.proto.createPacketBuffer('varint', compressed.length), compressed])
  const packet = new Promise((resolve, reject) => {
    c.once('set_slot', resolve)
    c.once('error', reject)
  })
  c.splitter.write(frame)
  try {
    const decoded = await packet
    assert.deepEqual(decoded.item.components[0].data.bees, bees)
  } finally {
    c.splitter.destroy()
    c.decompressor.destroy()
    c.deserializer.destroy()
  }
})

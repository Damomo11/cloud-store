// via 26.3 协议补丁的回归测试（2026-11 审计修复后的护栏）。
// 用 node-minecraft-protocol 的真实编译器编译补丁后的协议，并对重写的关键包做字节级往返。
'use strict'

const test = require('node:test')
const assert = require('node:assert')

// activate 必须在 require('mineflayer')/minecraft-protocol 之前（与 src/index.js 同序）
require('../src/via').activate()
const { createSerializer, createDeserializer } = require('minecraft-protocol/src/transforms/serializer.js')

function makePair (state, clientDirection) {
  // nmp 的方向由 isServer 推导：bot 侧序列化 = toClient（isServer:true）
  return {
    ser: createSerializer({ version: '26.3', state, isServer: clientDirection === 'toClient' }),
    des: createDeserializer({ version: '26.3', state })
  }
}

function roundTrip (pair, name, params) {
  const buf = pair.ser.createPacketBuffer({ name, params })
  const { data } = pair.des.parsePacketBuffer(buf)
  assert.strictEqual(data.name, name, `${name} 往返包名不匹配`)
  return { buf, params: data.params }
}

test('补丁后的 26.3 协议可被 nmp 编译器编译', () => {
  for (const state of ['play', 'configuration', 'login']) {
    for (const dir of ['toClient', 'toServer']) {
      const isServer = dir === 'toClient'
      assert.doesNotThrow(() => createSerializer({ version: '26.3', state, isServer }), `${state}.${dir} 编译失败`)
    }
  }
})

test('rel_entity_move：properties 在 delta 之前，0/1 步两种形态', () => {
  const pair = makePair('play', 'toClient')
  // 线格式：varint id(54) + varint properties + delta；properties=1 → dX/dY/dZ i16
  const { buf, params } = roundTrip(pair, 'rel_entity_move', { entityId: 5, properties: 1, delta: { dX: 32, dY: 0, dZ: -16 } })
  assert.strictEqual(buf.length, 9, '典型包应恰好 9 字节 (1+1+6)')
  assert.strictEqual(params.delta.dX, 32)
  // 单步路径（properties=2 → 1×{tickOffset,dX,dY,dZ}）
  const r2 = roundTrip(pair, 'rel_entity_move', { entityId: 5, properties: 2, delta: { tickOffset: 3, dX: 10, dY: 0, dZ: 0 } })
  assert.strictEqual(r2.params.delta.tickOffset, 3)
  assert.strictEqual(r2.params.delta.dX, 10)
})

test('entity_move_look：delta 后跟 yaw/pitch i8', () => {
  const pair = makePair('play', 'toClient')
  const { buf, params } = roundTrip(pair, 'entity_move_look', { entityId: 5, properties: 1, delta: { dX: 0, dY: 0, dZ: 0 }, yaw: 100, pitch: -40 })
  assert.strictEqual(buf.length, 11)
  assert.strictEqual(params.yaw, 100)
  assert.strictEqual(params.pitch, -40)
})

test('sync_entity_position：LINEAR 直连坐标 + onGround', () => {
  const pair = makePair('play', 'toClient')
  const { buf, params } = roundTrip(pair, 'sync_entity_position', { entityId: 3, pathType: 0, path: { x: 1.5, y: 64, z: -2.5 }, yaw: 90, pitch: -10, onGround: true })
  assert.strictEqual(buf.length, 36) // 包 id varint(1) + 35 字节参数
  assert.strictEqual(params.onGround, true)
  assert.strictEqual(params.path.x, 1.5)
})

test('update_light：光照掩码为 BIT_SET（varint 字节数 + 字节），可被 ChunkColumn26 装载', () => {
  const pair = makePair('play', 'toClient')
  const { buf, params } = roundTrip(pair, 'update_light', {
    chunkX: 1, chunkZ: 2,
    skyLightMask: Buffer.from([3]), blockLightMask: Buffer.from([0]),
    emptySkyLightMask: Buffer.from([0]), emptyBlockLightMask: Buffer.from([0]),
    skyLight: [Buffer.alloc(2048, 7), Buffer.alloc(2048, 8)], blockLight: []
  })
  assert.ok(Buffer.isBuffer(params.skyLightMask), '光照掩码应为 Buffer（bitset wire）')
  assert.strictEqual(params.skyLight.length, 2)
  // ChunkColumn26 兼容层把 Buffer 掩码转成 protodef i64 [hi,lo] 对后装载
  const reg = require('prismarine-registry')('26.3')
  const Chunk = require('prismarine-chunk')(reg)
  const column = new Chunk(reg)
  column.loadParsedLight(params.skyLight, params.blockLight, params.skyLightMask, params.blockLightMask, params.emptySkyLightMask, params.emptyBlockLightMask)
  assert.strictEqual(column.skyLightMask.get(0), 1)
  assert.strictEqual(column.skyLightMask.get(1), 1)
})

test('world_particles：particle 前置 + per-axis 速度 + randomizationType', () => {
  const pair = makePair('play', 'toClient')
  const { params } = roundTrip(pair, 'world_particles', {
    particle: { particleId: 'cloud' }, longDistance: false, alwaysShow: true,
    x: 1, y: 2, z: 3, offsetX: 0.1, offsetY: 0.2, offsetZ: 0.3,
    maxSpeedX: 0.4, maxSpeedY: 0.5, maxSpeedZ: 0.6, amount: 7, randomizationType: 0
  })
  assert.strictEqual(params.amount, 7)
  assert.strictEqual(params.randomizationType, 0)
})

test('login：encrypted bool 在 enforcesSecureChat 之前，gamemode 为 varint mapper', () => {
  const pair = makePair('play', 'toClient')
  const { params } = roundTrip(pair, 'login', {
    entityId: 1, isHardcore: false, worldNames: ['a'], maxPlayers: 100, viewDistance: 10,
    simulationDistance: 10, reducedDebugInfo: false, enableRespawnScreen: true, doLimitedCrafting: false,
    worldState: { dimension: 0, name: 'w', hashedSeed: 0n, gamemode: 'survival', previousGamemode: 0, isDebug: false, isFlat: false, death: undefined, portalCooldown: 0, seaLevel: 0 },
    encrypted: false, enforcesSecureChat: true
  })
  assert.strictEqual(params.encrypted, false)
  assert.strictEqual(params.enforcesSecureChat, true)
  assert.strictEqual(params.worldState.gamemode, 'survival') // mapper 映射后仍是字符串
})

test('post_effects：varint 数量 + N 个 identifier', () => {
  const pair = makePair('play', 'toClient')
  const { params } = roundTrip(pair, 'post_effects', ['minecraft:test_effect'])
  assert.deepStrictEqual(params, ['minecraft:test_effect'])
})

test('serverbound 兼容层：teleport_confirm 补坐标 / block_dig status 移位 / arm_animation→punch', () => {
  const EventEmitter = require('node:events')
  const { installRepairSync } = require('../src/via/sync-compat.js')
  const client = new EventEmitter()
  const writes = []
  client.write = (name, params) => { writes.push([name, params]) }
  const fakeBot = { _client: client, entities: {} }
  installRepairSync(fakeBot)
  // nmp 先发 'packet' 再发 'position'（physics.js 在 'position' 里写 confirm）
  client.emit('packet', { teleportId: 7, x: 10.5, y: -3.25, z: 200.75, dx: 0, dy: 0, dz: 0, yaw: 45, pitch: -10 }, { name: 'position' })
  client.emit('position', { teleportId: 7, x: 10.5, y: -3.25, z: 200.75, yaw: 45, pitch: -10 })
  client.write('teleport_confirm', { teleportId: 7 })
  assert.deepStrictEqual(writes[0][1], { teleportId: 7, x: 10.5, y: -3.25, z: 200.75, yRot: 45, xRot: -10 })
  client.write('block_dig', { status: 0, location: {}, face: 0, sequence: 1 })
  client.write('block_dig', { status: 1, location: {}, face: 0, sequence: 2 })
  client.write('block_dig', { status: 2, location: {}, face: 0, sequence: 3 })
  client.write('block_dig', { status: 5, location: {}, face: 0, sequence: 4 })
  assert.deepStrictEqual(writes.slice(1).map(w => w[1].status), [0, 2, 3, 6],
    '26.3 在 action 1 插入 CHANGE_DESTROY_DIRECTION，≥1 的 status 整体 +1')
  client.write('arm_animation', { hand: 0 })
  assert.deepStrictEqual(writes[5], ['punch', {}])
})

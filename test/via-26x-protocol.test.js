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

test('指纹稳定：容器内容的数字 itemId 归一到稳定全名（跨目录版本不变）', () => {
  const ItemCatalog = require('../src/itemCatalog.js')
  const catalog = new ItemCatalog('26.3')
  // 26.3 数字 id（协议解析/servux 转换）与字符串 id（修复后入账）→ 同一全名
  const numeric = catalog.normalizeContainerEntryForFingerprint({ itemId: 579, itemCount: 64 })
  const string = catalog.normalizeContainerEntryForFingerprint({ itemId: 'minecraft:hay_block', itemCount: 64 })
  assert.strictEqual(numeric.itemId, 'minecraft:hay_block')
  assert.strictEqual(string.itemId, 'minecraft:hay_block')
  // 两条读路径（数字/字符串）对同一只盒子算出同一个指纹输入
  const metaNumeric = { metadata: null, components: [{ type: 'container', data: { contents: [{ itemId: 579, itemCount: 64 }] } }] }
  const metaString = { metadata: null, components: [{ type: 'container', data: { contents: [{ itemId: 'minecraft:hay_block', itemCount: 64 }] } }] }
  assert.strictEqual(
    JSON.stringify(catalog.normalizeMetaForFingerprint('minecraft:shulker_box', metaNumeric)),
    JSON.stringify(catalog.normalizeMetaForFingerprint('minecraft:shulker_box', metaString)),
    '开箱路径与 Servux 路径的指纹输入必须一致'
  )
  // 版本歧义检测：504 在 1.21.11 是 hay_block、在 26.3 是 sculk_vein → 判定为歧义行
  assert.strictEqual(
    catalog.metaHasVersionAmbiguousContainerEntries('minecraft:shulker_box',
      { components: [{ type: 'container', data: { contents: [{ itemId: 504, itemCount: 1 }] } }] }),
    true,
    '旧目录数字 id 与新目录名字冲突的行应跳过迁移'
  )
})

test('spawn_entity 玩家包：26.3 线上 id(159) 解析后命中玩家实体（tpa 后挂链根）', () => {
  const pair = makePair('play', 'toClient')
  const { params } = roundTrip(pair, 'spawn_entity', {
    entityId: 42,
    objectUUID: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
    type: 159, // 26.3 player 线上 id
    x: -81582.35, y: 191.0, z: -40531.5,
    velocity: { present: 1, x: 0, y: 0, z: 0 },
    pitch: 0, yaw: 70, headPitch: 0,
    objectData: 0
  })
  assert.strictEqual(params.type, 159)
  assert.strictEqual(params.objectUUID, '069a79f4-44e9-4726-a5be-fca90e38aaf5')
  // 复刻 mineflayer entities.js:228 的判定：entityDataByInternalId[type].type === 'player'
  const md = require('minecraft-data')('26.3')
  const entityDataByInternalId = Object.fromEntries(md.entitiesArray.map(e => [e.internalId, e]))
  const entityData = entityDataByInternalId[params.type]
  assert.ok(entityData, `spawn_entity type=${params.type} 在 internalId 表查不到（玩家实体不会挂链）`)
  assert.strictEqual(entityData.type, 'player', 'spawn_entity 玩家包应走 addNewPlayer 分支')
})

test('rel_entity_move / entity_move_look：delta 扁平化先于 mineflayer 执行（实体坐标 NaN 根）', () => {
  const EventEmitter = require('node:events')
  const { installRepairSync } = require('../src/via/sync-compat.js')
  const client = new EventEmitter()
  client.write = () => {}
  const fakeBot = { _client: client, entities: {} }
  // 模拟 mineflayer entities.js：处理器读顶层 packet.dX/dY/dZ（26.1 形状）
  let translated = null
  client.on('rel_entity_move', (packet) => {
    translated = { x: (packet.dX ?? NaN) / 4096, y: (packet.dY ?? NaN) / 4096, z: (packet.dZ ?? NaN) / 4096 }
  })
  installRepairSync(fakeBot) // installRepairSync 的 prependListener 必须排在 mineflayer 处理器之前
  // 26.3 线格式解析结果：delta 嵌套（properties=1 线性分支）
  client.emit('rel_entity_move', { entityId: 9, properties: 1, delta: { dX: 4096, dY: -128, dZ: 2048 } })
  assert.deepStrictEqual(translated, { x: 1, y: -1 / 32, z: 0.5 },
    'flatten 未生效 → mineflayer translate(undefined/4096) = NaN，实体坐标被污染')
  // 老版本包（顶层 dX 已存在）原样放行
  client.emit('rel_entity_move', { entityId: 9, dX: 1, dY: 2, dZ: 3 })
  assert.deepStrictEqual(translated, { x: 1 / 4096, y: 2 / 4096, z: 3 / 4096 })
  // entity_move_look 同样扁平化（properties=2 stepped 分支带 tickOffset）
  let movedLook = null
  client.on('entity_move_look', (packet) => { movedLook = packet })
  client.emit('entity_move_look', { entityId: 9, properties: 2, delta: { tickOffset: 3, dX: 10, dY: 0, dZ: -10 }, yaw: 70, pitch: -20 })
  assert.strictEqual(movedLook.dX, 10)
  assert.strictEqual(movedLook.dY, 0)
  assert.strictEqual(movedLook.dZ, -10)
})

test('sync_entity_position 修复不再覆盖 mineflayer 已转好的弧度朝向', () => {
  const EventEmitter = require('node:events')
  const { installRepairSync } = require('../src/via/sync-compat.js')
  const client = new EventEmitter()
  client.write = () => {}
  const pos = { x: NaN, y: NaN, z: NaN, set (x, y, z) { this.x = x; this.y = y; this.z = z } }
  const vel = { x: NaN, y: NaN, z: NaN, set (x, y, z) { this.x = x; this.y = y; this.z = z } }
  const entity = { position: pos, velocity: vel, yaw: 1.23, pitch: -0.5 }
  const fakeBot = { _client: client, entities: { 42: entity } }
  // mineflayer 处理器先跑（弧度转换成功，position/velocity 被 26.3 缺字段污染成 NaN）
  client.on('sync_entity_position', (packet) => {
    entity.position.set(packet.x, packet.y, packet.z)
    entity.velocity.set(packet.dx, packet.dy, packet.dz)
    entity.yaw = packet.yaw / 180 * Math.PI
    entity.pitch = packet.pitch / 180 * Math.PI
  })
  installRepairSync(fakeBot)
  client.emit('sync_entity_position', { entityId: 42, pathType: 0, path: { x: 1.5, y: 64, z: -2.5 }, yaw: 90, pitch: -10, onGround: true })
  assert.strictEqual(entity.position.x, 1.5)
  assert.strictEqual(entity.velocity.x, 0)
  assert.ok(Math.abs(entity.yaw - Math.PI / 2) < 1e-9, 'yaw 应保持 mineflayer 的弧度值不被度数覆盖')
  assert.ok(entity.pitch < 0, 'pitch 应保持弧度符号')
})

test('26.3 粒子 id 表重排：entity_effect@28 带颜色 / sonic_boom@35 / geyser 系数据结构', () => {
  require('../src/via').activate()
  const names263 = require('../data/via/26.3/particles.json').names263
  const md = require('minecraft-data')
  const T = md('26.3').protocol.types.Particle
  const mappings = T[1][0].type[1].mappings
  assert.strictEqual(mappings[28], 'entity_effect', '26.3 id28 应为 entity_effect（26.1 表是 sonic_boom）')
  assert.strictEqual(mappings[35], 'sonic_boom')
  assert.strictEqual(Object.keys(mappings).length, names263.length, 'mapper 应覆盖全部 128 个 26.3 粒子')
  const fields = T[1][1].type[1].fields
  // Via fill26_2 真值：geyser_base/geyser_poof = i32+f32，geyser/geyser_plume = i32
  assert.strictEqual(fields.entity_effect, 'i32')
  assert.deepStrictEqual(fields.geyser, ['container', [{ name: 'value', type: 'i32' }]])
  assert.deepStrictEqual(fields.geyser_base, ['container', [{ name: 'value', type: 'i32' }, { name: 'scale', type: 'f32' }]])
  assert.strictEqual(fields.sulfur_bubbles, 'void', '无数据新粒子显式 void（protodef 对缺失字段宽松，显式声明更稳）')
  // 带数据的粒子必须有字段；无数据粒子 protodef 宽松处理（26.1 的 cloud/crit 等同样无字段）
})

test('entity_metadata 药水粒子真包字节（21B）全量消费不再剩 4 字节', () => {
  const pair = makePair('play', 'toClient')
  // 2026-11-18 部署实测样本：血量 16.0 + entity_effect 颜色 0xFF33EBFF 的实体 metadata
  const hex = '65e1f5a5bf050903418000000a11011cff33ebffff'
  const buf = Buffer.from(hex, 'hex')
  const { data } = pair.des.parsePacketBuffer(buf)
  assert.strictEqual(data.name, 'entity_metadata')
  assert.strictEqual(data.params.entityId, 1474919137)
  assert.strictEqual(data.params.metadata[1].value[0].type, 'entity_effect')
  assert.strictEqual(data.params.metadata[1].value[0].data, -13374465, '颜色应为 0xFF33EBFF')
  // 不抛 "Chunk size is 21 but only 17 was read" 即为全量消费（parsePacketBuffer 异常即测试失败）
  // 粒子 id 28 → entity_effect 的位移同时覆盖 world_particles（同一 Particle 类型）
  const wp = roundTrip(pair, 'world_particles', {
    particle: { type: 'sulfur_bubbles' },
    overrideLimiter: false, alwaysShow: true,
    x: 1.5, y: 2.5, z: 3.5,
    velocityOffset: { x: 0, y: 0, z: 0 },
    amount: 1, maxSpeed: 0.1, longDistance: false
  })
  assert.strictEqual(wp.params.particle.type, 'sulfur_bubbles')
})

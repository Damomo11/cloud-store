// 外科手术复现：26.3 生产管线（26.3 序列化 → 反序列化 → sync-compat → mineflayer
// entities 插件监听链）里，实体坐标何时被污染成 NaN。
// 用法：node scripts/repro-entity-nan.js
'use strict'

require('../src/via').activate()
const EventEmitter = require('node:events')
const md = require('minecraft-data')
const { createSerializer, createDeserializer } = require('minecraft-protocol/src/transforms/serializer.js')
const ser = createSerializer({ version: '26.3', state: 'play', isServer: true })
const des = createDeserializer({ version: '26.3', state: 'play' })
const entitiesPlugin = require('mineflayer/lib/plugins/entities.js')
const { installRepairSync } = require('../src/via/sync-compat.js')

const registry = md('26.3')
const client = new EventEmitter()
client.write = () => {}
const bot = {
  version: '26.3',
  registry,
  supportFeature: f => { try { return registry.supportFeature(f) } catch { return false } },
  emit: () => {},
  on: () => {},
  _client: client,
  entities: {},
  players: {},
  uuidToUsername: {},
  username: 'NanKinz1',
  entity: null,
  player: null,
  vehicle: null,
  oxygenLevel: 20,
  getControlState: () => false,
  swingArm: () => {},
  _playerFromUUID: uuid => Object.values(bot.players).find(p => p.uuid === uuid)
}
installRepairSync(bot) // 生产顺序：createBot 后立刻挂载
entitiesPlugin(bot, {}) // mineflayer 插件因 'inject_allowed' 延迟注入，实际靠后

const fmt = v => (v === undefined ? 'undefined' : Number.isNaN(v) ? 'NaN' : Number(v).toFixed(3))
const posOf = id => {
  const e = bot.entities[id]
  if (!e) return '（实体不存在）'
  return `x=${fmt(e.position.x)} y=${fmt(e.position.y)} z=${fmt(e.position.z)} vel=(${fmt(e.velocity.x)},${fmt(e.velocity.y)},${fmt(e.velocity.z)})`
}
const linkOf = name => {
  const e = bot.players[name]?.entity
  return e ? `${fmt(e.position.x)},${fmt(e.position.y)},${fmt(e.position.z)}` : '（未挂链）'
}
let step = 0
// 与生产一致：serialize → deserialize → emit（nmp 会先发 'packet' 再发具名事件）
function feed (name, params, label) {
  step++
  const buf = ser.createPacketBuffer({ name, params })
  const { data } = des.parsePacketBuffer(buf)
  console.log(`[${step}] ${label || name}`)
  client.emit('packet', data, { name: data.name })
  client.emit(data.name, data.params)
  return data.params
}

// 1) player_info ADD：MoMortis1917 + uuid（1.21.2+ 的 bitflags 动作数组）
const UUID = Buffer.from('123e4567e89b12d3a456426614174000', 'hex')
feed('player_info', {
  action: { add_player: true, update_listed: true, update_latency: true },
  data: [{ uuid: UUID, player: { name: 'MoMortis1917', properties: [] }, listed: true, latency: 0 }]
}, 'player_info ADD')
// 2) spawn_entity：26.3 player 线上 id=159，出生坐标仓库附近
feed('spawn_entity', {
  entityId: 61,
  objectUUID: UUID,
  type: 159,
  x: -23050.5, y: -53.0, z: -24777.5,
  velocity: { present: 0, x: 0, y: 0, z: 0 },
  pitch: 0, yaw: 90, headPitch: 0,
  objectData: 0
}, 'spawn_entity player@仓库')
console.log(`     entity[61]=${posOf(61)} | players.entity=${linkOf('MoMortis1917')}`)
// 3) rel_entity_move：properties=1（onGround|stepCount=0）线性 dX=+4096（+1 格）
feed('rel_entity_move', { entityId: 61, properties: 'steps0g', delta: { dX: 4096, dY: 0, dZ: 0 } }, 'rel_entity_move +1格')
console.log(`     entity[61]=${posOf(61)}`)
// 4) sync_entity_position LINEAR 到 (100, 64, -200)
feed('sync_entity_position', {
  entityId: 61, pathType: 0, path: { x: 100.5, y: 64, z: -200.25 }, yaw: 45, pitch: -10, onGround: true
}, 'sync LINEAR →(100.5,64,-200.25)')
console.log(`     entity[61]=${posOf(61)}`)
// 5) entity_move_look：properties=2 stepped（tickOffset 3 + delta）
feed('entity_move_look', {
  entityId: 61, properties: 'steps1', delta: { steps: [{ tickOffset: 3, dX: 128, dY: -64, dZ: -128 }] }, yaw: 70, pitch: -20
}, 'entity_move_look stepped')
console.log(`     entity[61]=${posOf(61)}`)
// 6) sync_entity_position STEPPED（1 步）
feed('sync_entity_position', {
  entityId: 61, pathType: 1, path: { steps: [{ x: 200.5, y: 70, z: -300.25, tickOffset: 0 }] }, yaw: 0, pitch: 0, onGround: true
}, 'sync STEPPED →(200.5,70,-300.25)')
console.log(`     entity[61]=${posOf(61)}`)
// 7) destroy → 重生成（模拟跨维度 tp 后实体重置；实体 id 复用）
feed('destroy_entity', { entityIds: [61] }, 'destroy_entity')
feed('spawn_entity', {
  entityId: 61,
  objectUUID: UUID,
  type: 159,
  x: -95975.13, y: 185.0, z: -95892.2,
  velocity: { present: 0, x: 0, y: 0, z: 0 },
  pitch: 0, yaw: 0, headPitch: 0,
  objectData: 0
}, 'spawn_entity player@tp目的地')
console.log(`     entity[61]=${posOf(61)} | players.entity=${linkOf('MoMortis1917')}`)
console.log('\n最终状态：')
console.log(`  entity[61].position = ${posOf(61)}`)
console.log(`  players.MoMortis1917.entity = ${linkOf('MoMortis1917')}`)
const e = bot.entities[61]
const bad = e ? [e.position.x, e.position.y, e.position.z, e.velocity.x, e.velocity.y, e.velocity.z].some(Number.isNaN) : true
console.log(bad ? '>>> 复现出 NaN' : '>>> 全链无 NaN（生产 NaN 来自监听链之外）')

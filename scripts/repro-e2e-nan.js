// 端到端复现：真 mineflayer（全插件集，与生产 createBot 同序）+ 本地 26.3 mock 服务器，
// 驱动 tpa 场景的完整包序列，观察玩家实体坐标何时变 NaN。
// 用法：node scripts/repro-e2e-nan.js
'use strict'

require('../src/via').activate()
const mineflayer = require('mineflayer')
const nmp = require('minecraft-protocol')
const md = require('minecraft-data')
const { installRepairSync } = require('../src/via/sync-compat.js')

const PORT = 25601
const reg = md('26.3')
const loginSample = reg.loginPacket
// SpawnInfo 真值结构（26.3：dimension varint + gamemode mapper + previousGamemode varint…）
const OVERWORLD = {
  dimension: 0,
  name: 'minecraft:overworld',
  hashedSeed: 0n,
  gamemode: 'survival',
  previousGamemode: 0,
  isDebug: false,
  isFlat: true,
  death: undefined,
  portalCooldown: 0,
  seaLevel: 63
}

const server = nmp.createServer({
  version: '26.3', port: PORT, motd: 'repro', 'online-mode': false, registryCodec: loginSample.dimensionCodec,
  errorHandler: (client, err) => { console.log('[server][errorHandler]', err.stack?.split('\n').slice(0, 6).join('\n')) },
  // 26.3 已移除 login 阶段的 server_data 包，nmp 服务端还按 chainedChatWithHashing 写它 → 掐掉
  beforeLogin: (client) => {
    const orig = client.supportFeature
    client.supportFeature = f => f === 'chainedChatWithHashing' ? false : orig(f)
  }
})
server.on('error', e => console.log('[server] error:', e.message))
// 诊断：包名级 write 错误追踪
server.on('connection', (client) => {
  const rawWrite = client.write.bind(client)
  client.write = (name, params) => {
    try { rawWrite(name, params) } catch (e) {
      console.log(`[server][write-trace] state=${client.state} name=${name} 失败:`, e.message.slice(0, 160))
      const keys = params && typeof params === 'object' ? Object.keys(params).join(',') : String(params)
      console.log(`[server][write-trace] params keys: ${keys}`)
    }
  }
})

const PLAYER_UUID = Buffer.from('123e4567e89b12d3a456426614174000', 'hex')

server.on('login', (client) => {
  console.log('[server] bot 进入 play 状态，开始驱动场景')
  const rawWrite = client.write.bind(client)
  client.write = (name, params) => {
    try { rawWrite(name, params) } catch (e) {
      console.log(`[server] write ${name} 失败:`, e.message.slice(0, 200))
      console.log(e.stack.split('\n').slice(1, 4).join('\n'))
    }
  }
  client.write('login', {
    entityId: 1,
    isHardcore: false,
    worldNames: ['minecraft:overworld', 'minecraft:the_nether'],
    maxPlayers: 100,
    viewDistance: 8,
    simulationDistance: 8,
    reducedDebugInfo: true,
    enableRespawnScreen: false,
    doLimitedCrafting: false,
    worldState: OVERWORLD,
    encrypted: false,
    enforcesSecureChat: false
  })

  const step = (ms, label, fn) => setTimeout(() => {
    try { fn() } catch (e) { console.log(`[server] ${label} 失败:`, e.message) }
  }, ms)

  // 场景时间轴（毫秒）
  step(300, 'self position', () => client.write('position', {
    teleportId: 1, x: -23045.5, y: -53, z: -24777.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {}
  }))
  step(600, 'player_info ADD', () => client.write('player_info', {
    action: { add_player: true, update_listed: true, update_latency: true },
    data: [{ uuid: PLAYER_UUID, player: { name: 'MoMortis1917', properties: [] }, listed: true, latency: 0 }]
  }))
  step(900, 'spawn_entity player@仓库', () => client.write('spawn_entity', {
    entityId: 61, objectUUID: PLAYER_UUID, type: 159,
    x: -23050.5, y: -53.0, z: -24777.5,
    velocity: { present: 0, x: 0, y: 0, z: 0 },
    pitch: 0, yaw: 90, headPitch: 0, objectData: 0
  }))
  step(1200, 'rel_entity_move +1格', () => client.write('rel_entity_move', {
    entityId: 61, properties: 'steps0g', delta: { dX: 4096, dY: 0, dZ: 0 }
  }))
  step(1500, 'sync LINEAR →(100.5,64,-200.25)', () => client.write('sync_entity_position', {
    entityId: 61, pathType: 0, path: { x: 100.5, y: 64, z: -200.25 }, yaw: 45, pitch: -10, onGround: true
  }))
  step(1800, 'tp：respawn + position + spawn_entity@目的地', () => {
    client.write('respawn', {
      worldState: { ...OVERWORLD, dimension: 1, name: 'minecraft:the_nether' },
      copyMetadata: 1
    })
    client.write('position', {
      teleportId: 2, x: -95975.13, y: 185.0, z: -95892.2, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {}
    })
    client.write('spawn_entity', {
      entityId: 61, objectUUID: PLAYER_UUID, type: 159,
      x: -95974.0, y: 185.0, z: -95891.0,
      velocity: { present: 0, x: 0, y: 0, z: 0 },
      pitch: 0, yaw: 0, headPitch: 0, objectData: 0
    })
  })
  step(2400, 'entity_move_look stepped@目的地', () => client.write('entity_move_look', {
    entityId: 61, properties: 'steps1', delta: { steps: [{ tickOffset: 3, dX: 128, dY: -64, dZ: -128 }] }, yaw: 70, pitch: -20
  }))
  step(2800, 'sync STEPPED@目的地', () => client.write('sync_entity_position', {
    entityId: 61, pathType: 1, path: { steps: [{ x: -95970.0, y: 185.0, z: -95890.0, tickOffset: 0 }] }, yaw: 0, pitch: 0, onGround: true
  }))
})

// ---- bot 侧：与生产 createBot 相同的装配顺序 ----
const bot = mineflayer.createBot({
  host: '127.0.0.1', port: PORT, username: 'NanKinz1', version: '26.3', auth: 'offline'
})
installRepairSync(bot)

const fmt = v => (Number.isNaN(v) ? 'NaN' : Number(v).toFixed(2))
function dump (tag) {
  const e = bot.players.MoMortis1917?.entity
  const self = bot.entity
  console.log(`[${tag}] self=${self ? `${fmt(self.position.x)},${fmt(self.position.y)},${fmt(self.position.z)}` : '?'} | ` +
    `玩家实体=${e ? `${fmt(e.position.x)},${fmt(e.position.y)},${fmt(e.position.z)}` : '（未挂链）'}`)
  const bad = e && Number.isNaN(e.position.x)
  if (bad) console.log(`>>> 玩家实体坐标 NaN（复现成功）`)
}
const watch = () => dump(`t=${Date.now() % 100000}`)
bot.once('spawn', () => { console.log('[bot] spawned'); watch() })
for (const ev of ['entitySpawn', 'entityMoved', 'respawn']) {
  bot.on(ev, () => watch(ev))
}
setTimeout(() => { dump('最终'); process.exit(0) }, 4000)

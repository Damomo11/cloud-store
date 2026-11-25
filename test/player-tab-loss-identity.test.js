// 场景：协议层丢包（Via 解析炸 / PartialReadError）或 tab 条目被清导致
// bot.players[username].uuid 查不到时，getPlayer 不能直接落 name: 幽灵号——
// 那会绕过 canonical/v3→v4 改挂，让有仓库的正版玩家被误报“没有可用仓库”
// （生产实测：HayComrade 管理员 !修装备 触发 defaultStorageOwnerForPlayer throw）。
// 修复后应先问 DB（getPlayerByUsername），沿用同名正版号；DB 也没有才落 name:。
const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

function createFixture ({ onlinePlayers = {}, dbPlayers = {} } = {}) {
  const upserted = []
  const knownPlayers = { ...dbPlayers } // uuid -> username，模拟 DB 已知玩家
  const db = {
    upsertPlayer: (uuid, username) => upserted.push({ uuid, username }),
    canonicalPlayerUuid: uuid => uuid,
    resolveOfflineUuidToMojang: uuid => uuid,
    //getPlayerByUsername: mock DB 按用户名找已知正版行
    getPlayerByUsername: username => {
      const rows = Object.entries(knownPlayers)
        .map(([uuid, name]) => ({ uuid, username: name }))
        .filter(row => row.username.toLowerCase() === String(username).toLowerCase())
      return rows[0] || null
    }
  }
  const bot = {
    username: 'BotA',
    players: { ...onlinePlayers }
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.debugChat = false
  const service = new CloudStoreService(bot, db, { getDisplayName: () => '?' }, {}, config, { acceptIncoming: () => true })
  return { service, upserted }
}

test('tab 条目丢失时 getPlayer 沿用 DB 已知正版号，不再落 name: 幽灵号', () => {
  const { service, upserted } = createFixture({
    onlinePlayers: {}, // bot.players 里没有这个玩家（tab 丢失/离线）
    dbPlayers: { 'uuid-real': 'HayComrade' }
  })

  const player = service.getPlayer('HayComrade')

  assert.equal(player.uuid, 'uuid-real')
  assert.equal(player.username, 'HayComrade')
  assert.equal(upserted.length, 1)
  assert.equal(upserted[0].uuid, 'uuid-real')
  assert.ok(!upserted[0].uuid.startsWith('name:'))
})

test('tab 有 UUID 时优先用在线上报的，不查 DB', () => {
  const { service, upserted } = createFixture({
    onlinePlayers: { HayComrade: { uuid: 'uuid-online' } },
    dbPlayers: { 'uuid-stale': 'HayComrade' }
  })

  const player = service.getPlayer('HayComrade')

  assert.equal(player.uuid, 'uuid-online')
  assert.equal(upserted[0].uuid, 'uuid-online')
})

test('DB 也没有该玩家才落 name: 幽灵号（真新玩家不受影响）', () => {
  const { service } = createFixture({ onlinePlayers: {}, dbPlayers: {} })

  const player = service.getPlayer('BrandNewGuy')

  assert.equal(player.uuid, 'name:BrandNewGuy')
})

test('end-to-end：tab 丢失的仓库管理员 !修装备 不再误报没有可用仓库', async () => {
  const sent = []
  let queuedTask = null
  const { service } = createFixture({
    onlinePlayers: {}, // HayComrade 不在 bot.players：协议丢包后的真实故障形态
    dbPlayers: { 'uuid-real': 'HayComrade' }
  })
  // defaultStorageOwnerForPlayer 走真实实现：db 知道 uuid-real 有个人仓库
  service.db.getEffectiveDefaultOwnerUuid = uuid => (uuid === 'uuid-real' ? 'uuid-real' : '')
  service.db.hasPersonalWarehouse = uuid => uuid === 'uuid-real'
  service.msg = (username, message) => sent.push(`${username}: ${message}`)
  service.enqueueTask = (username, type, run) => {
    queuedTask = { username, type, run }
    return Promise.resolve()
  }

  await service.handleChat('HayComrade', '!修装备', { source: 'chat', channel: 'public' })

  assert.ok(queuedTask, '修装备任务应成功入队而非在解析 owner 时抛错')
  assert.equal(queuedTask.username, 'HayComrade')
  assert.equal(queuedTask.type, 'withdraw')
})

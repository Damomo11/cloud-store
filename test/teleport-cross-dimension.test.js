const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

const { Vec3 } = require('vec3')

function makeEntity (pos, username = null, type = 'player') {
  return { type, username, position: pos.clone() }
}

// 最小 bot mock：players 表与 entities 表可分别控制，模拟跨维度传送后的失效形态。
function makeBot ({ players = {}, entities = new Map(), selfPos = new Vec3(0, 64, 0), worldReady = true } = {}) {
  const world = {
    getColumnAt: () => (worldReady ? { x: 0, z: 0 } : null)
  }
  return {
    players,
    entities,
    world,
    entity: { position: selfPos },
    chat () {},
    username: 'TestBot',
    inventory: { items: () => [] }
  }
}

function makeService (bot) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.timing = { ...config.timing, teleportRequestTimeoutMs: 2000, teleportDetectRadius: 8, postTeleportWaitMs: 200 }
  const db = {
    upsertPlayer () {},
    isAdmin: () => false,
    addCommandReply () {},
    addBalanceItems () {},
    addTransaction () {},
    currentCommandLogId: () => 0,
    clearRecoveryTask () {},
    hasPersonalWarehouse: () => true
  }
  const service = Object.create(CloudStoreService.prototype)
  service.bot = bot
  service.config = config
  service.db = db
  service.botId = 'test-bot'
  service.msg = () => {}
  service.traceReply = () => {}
  service.redactSensitiveText = text => text
  service.splitMessage = text => [text]
  service.saveRecoveryTask = () => {}
  service.accountResidualAsMomo = () => {}
  return service
}

test('resolvePlayerEntity prefers players table and reports source', () => {
  const entity = makeEntity(new Vec3(3, 64, 3), 'MoMortis1917')
  const bot = makeBot({ players: { MoMortis1917: { uuid: 'u1', entity } } })
  const service = makeService(bot)
  const resolved = service.resolvePlayerEntity('MoMortis1917')
  assert.equal(resolved.entity, entity)
  assert.equal(resolved.source, 'players')
})

test('resolvePlayerEntity falls back to case-insensitive players variant', () => {
  // players 表的键与查询名大小写不同（数据库记录 vs 服务器显示名场景）
  const entity = makeEntity(new Vec3(1, 64, 1), 'MoMortis1917')
  const bot = makeBot({ players: { momortis1917: { uuid: 'u1', entity } } })
  const service = makeService(bot)
  const resolved = service.resolvePlayerEntity('MoMortis1917')
  assert.equal(resolved.entity, entity)
  assert.equal(resolved.source, 'players-variant')
})

test('resolvePlayerEntity falls back to bot.entities when players reference is detached (cross-dimension)', () => {
  // 跨维度传送后 players 表实体为 null，但实体表里有 spawn 包实体
  const liveEntity = makeEntity(new Vec3(2, 66, 2), 'MoMortis1917')
  const entities = new Map([[100, liveEntity]])
  const bot = makeBot({ players: { MoMortis1917: { uuid: 'u1', entity: null } }, entities })
  const service = makeService(bot)
  const resolved = service.resolvePlayerEntity('MoMortis1917')
  assert.equal(resolved.entity, liveEntity)
  assert.equal(resolved.source, 'entities')
})

test('resolvePlayerEntity returns null entity when everything is missing', () => {
  const bot = makeBot({ players: { MoMortis1917: { uuid: 'u1', entity: null } }, entities: new Map() })
  const service = makeService(bot)
  const resolved = service.resolvePlayerEntity('MoMortis1917')
  assert.equal(resolved.entity, null)
  assert.equal(resolved.source, '')
})

test('waitForPlayerNearby passes when player entity is within radius via entities fallback', async () => {
  const startPos = new Vec3(-23056.5, 53, -24777.5)
  const playerPos = new Vec3(92813, 66, 83233)   // 玩家在 bot 旁 ~3 格
  const botPos = new Vec3(92811.3, 66, 83231.39)
  const liveEntity = makeEntity(playerPos, 'MoMortis1917')
  const bot = makeBot({
    players: { MoMortis1917: { uuid: 'u1', entity: null } },  // 跨维度后引用失效
    entities: new Map([[200, liveEntity]]),
    selfPos: botPos
  })
  const service = makeService(bot)
  // startPos 会被 waitForPlayerNearby 内部取 this.bot.entity.position.clone()，
  // 这里 bot 已在新维度：直接给距离 3 格的实体 → 立即通过
  const ok = await service.waitForPlayerNearby('MoMortis1917', 1000, 8)
  assert.equal(ok, true)
  void startPos
})

test('waitForPlayerNearby times out when player is genuinely absent (no jump, no entity)', async () => {
  const bot = makeBot({
    players: { Ghost: { uuid: 'u9', entity: null } },
    entities: new Map(),
    selfPos: new Vec3(0, 64, 0)
  })
  const service = makeService(bot)
  service.config.timing.teleportRequestTimeoutMs = 600
  const ok = await service.waitForPlayerNearby('Ghost', 600, 8)
  assert.equal(ok, false)
})

test('waitForPlayerNearby degrades to pass-through after cross-dimension jump with unresolved entity', async () => {
  // 复现线上 bug：bot 坐标跳到玩家维度（>50 格），players 引用失效，
  // 实体表也没有该玩家（spawn 关联完全丢失）。宽限窗结束后应降级放行。
  const bot = makeBot({
    players: { MoMortis1917: { uuid: 'u1', entity: null } },
    entities: new Map(),
    selfPos: new Vec3(92811.3, 66, 83231.39),
    worldReady: true
  })
  const service = makeService(bot)
  service.config.timing.teleportRequestTimeoutMs = 8000
  // waitForPlayerNearby 内部 startPos 取当前（新维度）位置，
  // 需要模拟“发出 tpa 时在仓库维度”。直接把 startPos 注入：用原型调用并预热 bot.entity。
  // 简化：把 startPos 设为远点 —— 通过临时替换 bot.entity.position 的 clone 起点。
  // 做法：第一次读取后移动 bot（模拟传送瞬间坐标更新）。
  let firstRead = true
  const realEntity = bot.entity
  Object.defineProperty(bot, 'entity', {
    get () {
      if (firstRead) {
        firstRead = false
        // 返回带旧维度坐标的临时 entity，让 startPos 记为仓库位置
        return { position: new Vec3(-23056.5, 53, -24777.5) }
      }
      return realEntity
    },
    configurable: true
  })
  const ok = await service.waitForPlayerNearby('MoMortis1917', 4000, 8)
  assert.equal(ok, true)
}, { timeout: 15000 })

test('teleportToPlayer times out cleanly and logs entity state when player never accepts', async () => {
  const bot = makeBot({
    players: { Away: { uuid: 'u2', entity: null } },
    entities: new Map(),
    selfPos: new Vec3(0, 64, 0)
  })
  const service = makeService(bot)
  service.config.timing.teleportRequestTimeoutMs = 500
  const messages = []
  service.msg = (username, message) => messages.push(message)
  const ok = await service.teleportToPlayer('Away')
  assert.equal(ok, false)
  assert.ok(messages.some(text => text.includes('已取消')))
})

test('warehouse lookAtPlayer resolves entity via fallback and throws when absent', async () => {
  const Warehouse = require('../src/warehouse')
  const liveEntity = makeEntity(new Vec3(5, 66, 5), 'MoMortis1917')
  const bot = makeBot({
    players: { MoMortis1917: { uuid: 'u1', entity: null } },
    entities: new Map([[300, liveEntity]]),
    selfPos: new Vec3(2, 66, 2)
  })
  bot.lookAt = async () => {}
  const db = { prepare: () => ({ run () {}, all () { return [] }, get () { return null } }) }
  const warehouse = Object.create(Warehouse.prototype)
  warehouse.bot = bot
  warehouse.config = structuredClone(DEFAULT_CONFIG)
  warehouse.db = db
  warehouse.catalog = { fromPrismarineItem: item => ({ itemKey: item.itemKey, itemId: item.itemId, displayName: item.name, amount: item.count }) }
  const resolved = warehouse.resolvePlayerEntity('MoMortis1917')
  assert.equal(resolved, liveEntity)
  await warehouse.lookAtPlayer('MoMortis1917')

  const emptyBot = makeBot({ players: {}, entities: new Map(), selfPos: new Vec3(0, 64, 0) })
  emptyBot.lookAt = async () => {}
  const emptyWarehouse = Object.create(Warehouse.prototype)
  emptyWarehouse.bot = emptyBot
  emptyWarehouse.config = structuredClone(DEFAULT_CONFIG)
  emptyWarehouse.db = db
  emptyWarehouse.catalog = warehouse.catalog
  await assert.rejects(() => emptyWarehouse.lookAtPlayer('Nobody'), /找不到玩家/)
})

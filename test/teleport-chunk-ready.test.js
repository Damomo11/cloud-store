const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

function createService (options = {}) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.timing.postTeleportWaitMs = options.waitMs ?? 60
  config.debugChat = false

  const bot = {
    username: 'BotA',
    entity: { position: new Vec3(0, 64, 0) },
    players: {
      Alice: { entity: { position: new Vec3(5, 64, 5) } }
    },
    // 只按区块是否加载回答，模拟服务端分批下发
    world: {
      getColumnAt: pos => {
        if (options.missing) return null
        if (options.botChunkMissing && pos.equals(bot.entity.position)) return null
        if (options.playerChunkMissing && pos.equals(bot.players.Alice.entity.position)) return null
        return { loaded: true }
      }
    }
  }

  const service = new CloudStoreService(bot, {}, {}, {}, config)
  if (options.cancelled) service.isActiveCancelled = () => true
  return { service, bot, config }
}

test('teleport waits end as soon as both chunks are loaded', async () => {
  const { service } = createService({ waitMs: 5000 })

  const startedAt = Date.now()
  const ready = await service.waitForTeleportChunksReady('Alice')
  const elapsed = Date.now() - startedAt

  assert.equal(ready, true)
  assert.ok(elapsed < 1000, `两侧区块就绪后应立刻返回，实际耗时 ${elapsed}ms`)
})

test('teleport keeps waiting while the bot chunk is not loaded', async () => {
  const { service } = createService({ waitMs: 60, botChunkMissing: true })

  const ready = await service.waitForTeleportChunksReady('Alice')

  assert.equal(ready, false, '超时仍未就绪返回 false，调用方继续交付')
})

test('teleport keeps waiting while the player chunk is not loaded', async () => {
  const { service } = createService({ waitMs: 60, playerChunkMissing: true })

  const ready = await service.waitForTeleportChunksReady('Alice')

  assert.equal(ready, false)
})

test('teleport keeps waiting when the player entity is missing', async () => {
  const { service, bot } = createService({ waitMs: 60 })
  delete bot.players.Alice

  const ready = await service.waitForTeleportChunksReady('Alice')

  assert.equal(ready, false)
})

test('teleport chunk wait bails out when the task is cancelled', async () => {
  const { service } = createService({ waitMs: 5000, cancelled: true })

  const startedAt = Date.now()
  const ready = await service.waitForTeleportChunksReady('Alice')
  const elapsed = Date.now() - startedAt

  assert.equal(ready, false)
  assert.ok(elapsed < 1000, '取消后应立刻退出，不等满超时')
})

test('teleport chunk wait tolerates a bot without world.getColumnAt', async () => {
  const { service, bot } = createService({ waitMs: 60 })
  bot.world = {}

  const ready = await service.waitForTeleportChunksReady('Alice')

  assert.equal(ready, false, '取不到区块时视作未就绪，不抛错')
})

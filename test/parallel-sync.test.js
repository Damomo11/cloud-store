const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const { BotTaskPool } = require('../src/taskPool')
const { DEFAULT_CONFIG } = require('../src/config')

function block (x) {
  return { x, y: 64, z: 10, name: 'barrel' }
}

// 每个 bot 一个 service：warehouse 桩记录分区扫描调用，返回带标记的快照。
function createService ({ botName, pool, failPartition = false, prepareBlocks = null, applyResult } = {}) {
  const calls = { partitions: [], applyScans: [], prepared: 0 }
  const config = structuredClone(DEFAULT_CONFIG)
  config.debug = false
  config.debugChat = false
  config.server = { ...config.server, botName, username: botName }
  const bot = { username: botName, chat: () => {} }
  const db = {
    claimLegacyRecoveryTask: () => {},
    addCommandReply: () => {},
    saveRecoveryTask: () => {},
    clearRecoveryTask: () => {},
    getRecoveryTask: () => null,
    addTransaction: () => {}
  }
  const warehouse = {
    attachTrace: () => {},
    detachTrace: () => {},
    async prepareSyncBlocks (radius) {
      calls.prepared++
      return prepareBlocks
    },
    async scanSyncPartition (radius, blocks) {
      if (failPartition) throw new Error('扫描中断：bot 掉线')
      calls.partitions.push(blocks.map(b => b.x))
      return {
        radius,
        blocks,
        snapshots: blocks.map(b => ({ chest: { chestId: `${botName}:${b.x}` }, slots: [], preReadSeq: 0 })),
        actualItems: []
      }
    },
    async scanBarrelBlocks (blocks, radius) {
      calls.partitions.push(blocks.map(b => b.x))
      return { radius, blocks, snapshots: blocks.map(b => ({ chest: { chestId: `${botName}:${b.x}` }, slots: [], preReadSeq: 0 })), actualItems: [] }
    },
    async withWarehouseLock (fn) {
      return fn()
    },
    async applyWarehouseScan (scan) {
      calls.applyScans.push(scan)
      return applyResult || { chestCount: scan.blocks.length, openedChestCount: scan.snapshots.length, rescanCount: 0, failures: [], addedToMomo: [], unresolved: [] }
    }
  }
  const service = new CloudStoreService(bot, db, { aggregatePrismarineItems: () => [] }, warehouse, config, pool)
  service.ready = true
  service.trace = () => {}
  return { service, calls }
}

test('splitBlocksForParallelSync 切空间连续条带：并集=全集且互不重叠', () => {
  const { service } = createService({ botName: 'bot-a' })
  const blocks = Array.from({ length: 10 }, (_, index) => block(index + 1))
  const strips = service.splitBlocksForParallelSync(3, blocks)
  assert.equal(strips.length, 3)
  const flat = strips.flat().map(b => b.x)
  assert.deepEqual([...flat].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], '并集是全集')
  assert.equal(new Set(flat).size, 10, '互不重叠')
  for (const strip of strips) {
    const xs = strip.map(b => b.x)
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] === xs[i - 1] + 1, '条带内坐标连续')
  }
})

test('collectSyncParticipants 只挑空闲健康 bot 且尊重 maxParallelSyncBots 上限', () => {
  const pool = new BotTaskPool(DEFAULT_CONFIG)
  const { service: a } = createService({ botName: 'bot-a', pool })
  const { service: b } = createService({ botName: 'bot-b', pool })
  const { service: c } = createService({ botName: 'bot-c', pool })
  pool.register(a)
  pool.register(b)
  pool.register(c)

  let team = a.collectSyncParticipants(a)
  assert.equal(team.length, 3, '0=不限，3 台全部参与')

  a.config.warehouse.maxParallelSyncBots = 2
  team = a.collectSyncParticipants(a)
  assert.equal(team.length, 2, '上限 2（含协调 bot）')

  b.active = { type: 'withdraw' }
  c.recoveringFromDeath = true
  a.config.warehouse.maxParallelSyncBots = 0
  team = a.collectSyncParticipants(a)
  assert.deepEqual(team, [a], '忙/死亡恢复中的 bot 不参与')
})

test('syncWarehouseWithTeam 多 bot 分区并行，协调 bot 拿全量快照一次性落账', async () => {
  const pool = new BotTaskPool(DEFAULT_CONFIG)
  const blocks = Array.from({ length: 8 }, (_, index) => block(index + 1))
  const { service: a, calls: callsA } = createService({ botName: 'bot-a', pool, prepareBlocks: blocks })
  const { service: b, calls: callsB } = createService({ botName: 'bot-b', pool })
  const { service: c, calls: callsC } = createService({ botName: 'bot-c', pool })
  pool.register(a)
  pool.register(b)
  pool.register(c)

  const result = await a.syncWarehouseWithTeam(a, 16, { events: [], summary: null })

  assert.equal(result.botCount, 3)
  assert.equal(callsA.prepared, 1, '木桶清单只由协调 bot 枚举一次')
  assert.equal(callsA.partitions.length + callsB.partitions.length + callsC.partitions.length, 3, '3 台各扫一个分区')
  assert.equal(callsA.applyScans.length, 1, '落账只发生一次')
  const applied = callsA.applyScans[0]
  assert.equal(applied.blocks.length, 8, '落账拿到的是全量桶清单')
  assert.equal(applied.snapshots.length, 8, '快照合并自所有分区')
  assert.equal(b.active, null, '借用的 bot 标记已清理')
  assert.equal(c.active, null)
})

test('任一分区失败整体中止，不落账，借用标记清理', async () => {
  const pool = new BotTaskPool(DEFAULT_CONFIG)
  const blocks = Array.from({ length: 6 }, (_, index) => block(index + 1))
  const { service: a, calls: callsA } = createService({ botName: 'bot-a', pool, prepareBlocks: blocks })
  const { service: b } = createService({ botName: 'bot-b', pool, failPartition: true })
  pool.register(a)
  pool.register(b)

  await assert.rejects(() => a.syncWarehouseWithTeam(a, 16, { events: [], summary: null }), /扫描中断/)
  assert.equal(callsA.applyScans.length, 0, '没有写入任何记录，旧库存原样保留')
  assert.equal(b.active, null, '借用标记已清理')
})

test('桶数<=1 或只有一台可用时退回单 bot 路径', async () => {
  const pool = new BotTaskPool(DEFAULT_CONFIG)
  const { service: a, calls: callsA } = createService({ botName: 'bot-a', pool, prepareBlocks: [block(1)] })
  pool.register(a)

  const result = await a.syncWarehouseWithTeam(a, 16, { events: [], summary: null })
  assert.equal(result.botCount, 1)
  assert.equal(callsA.partitions.length, 1, '单 bot 路径扫一次')
  assert.equal(callsA.applyScans.length, 1)
})

test('没有 taskPool 时也退回单 bot 路径', async () => {
  const blocks = [block(1), block(2)]
  const { service: a, calls: callsA } = createService({ botName: 'bot-a', pool: null, prepareBlocks: blocks })
  const result = await a.syncWarehouseWithTeam(a, 16, { events: [], summary: null })
  assert.equal(result.botCount, 1)
  assert.equal(callsA.partitions.length, 1)
})

const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const { BotTaskPool } = require('../src/taskPool')
const { DEFAULT_CONFIG } = require('../src/config')

function createRoutingService () {
  const db = {
    isAdmin: () => false,
    upsertPlayer: () => {},
    createCommandLog: () => 1,
    runWithCommandContext: async (id, fn) => fn(),
    runWithBotContext: async (context, fn) => fn(),
    addCommandReply: () => {},
    hasPersonalWarehouse: () => true,
    getCustomWarehouse: () => ({ name: 'demo', nameLower: 'demo', creatorUuid: 'uuid-creator' }),
    isCustomWarehouseMember: () => true,
    isCustomWarehouseAdmin: () => false,
    currentCommandLogId: () => 0
  }
  const taskPool = { acceptIncoming: () => true, workers: new Set() }
  const bot = { username: 'BotA', players: {} }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.debugChat = false
  const catalog = { getDisplayName: () => '经验瓶' }
  const service = new CloudStoreService(bot, db, catalog, null, config, taskPool)

  service.defaultStorageOwnerForPlayer = player => ({ ...player, scope: 'personal' })

  const enqueued = []
  service.enqueueTask = (username, type, run, options = {}) => {
    enqueued.push({ type, options })
    return Promise.resolve()
  }
  return { service, enqueued }
}

test('business commands from a private source pin the task to the whispered bot', async () => {
  const cases = [
    ['!存', 'deposit'],
    ['!取 石头 10', 'withdraw'],
    ['!存取 石头 10', 'withdraw'],
    ['!修装备', 'withdraw'],
    ['!个人 存', 'deposit'],
    ['!demo 存', 'deposit']
  ]
  for (const [text, type] of cases) {
    const { service, enqueued } = createRoutingService()
    await service.handleChat('User', text, { source: 'whisper', channel: 'private' })
    assert.equal(enqueued.length, 1, `${text} should enqueue one task`)
    assert.equal(enqueued[0].type, type, `${text} type`)
    assert.equal(enqueued[0].options.stickyWorker, service, `${text} sticky worker`)
  }
})

test('business commands from public chat keep pool-wide dispatch', async () => {
  const { service, enqueued } = createRoutingService()
  await service.handleChat('User', '!存', { source: 'chat', channel: 'public' })
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0].options.stickyWorker, null)
})

function createPoolWorker (name) {
  return {
    ready: true,
    active: null,
    recoveringFromDeath: false,
    bot: { username: name },
    async runExclusive (username, type, fn) {
      this.active = { type, username }
      try {
        return await fn()
      } finally {
        this.active = null
      }
    },
    handleCommandError () {}
  }
}

function tick () {
  return new Promise(resolve => setImmediate(resolve))
}

test('sticky task runs on its pinned worker even when another idle worker exists', async () => {
  const pool = new BotTaskPool({})
  const workerA = createPoolWorker('BotA')
  const workerB = createPoolWorker('BotB')
  pool.register(workerA)
  pool.register(workerB)

  const executedOn = []
  await pool.enqueue({ username: 'User', type: 'withdraw', stickyWorker: workerB, run: worker => executedOn.push(worker) })

  assert.deepEqual(executedOn, [workerB])
})

test('sticky task waits for its busy worker without blocking other tasks', async () => {
  const pool = new BotTaskPool({})
  const workerA = createPoolWorker('BotA')
  const workerB = createPoolWorker('BotB')
  pool.register(workerA)
  pool.register(workerB)

  const events = []
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })

  const firstDone = pool.enqueue({
    username: 'User', type: 'withdraw', stickyWorker: workerB, run: () => firstGate
  })
  const secondDone = pool.enqueue({
    username: 'User', type: 'withdraw', stickyWorker: workerB, run: worker => events.push(`second@${worker.bot.username}`)
  })
  const otherDone = pool.enqueue({
    username: 'User', type: 'deposit', run: worker => events.push(`other@${worker.bot.username}`)
  })
  await tick()

  assert.deepEqual(events, ['other@BotA'])

  releaseFirst()
  await Promise.all([firstDone, secondDone, otherDone])
  assert.deepEqual(events, ['other@BotA', 'second@BotB'])
})

test('sticky task falls back to any idle worker after its pinned worker goes offline', async () => {
  const pool = new BotTaskPool({})
  const workerA = createPoolWorker('BotA')
  const workerB = createPoolWorker('BotB')
  pool.register(workerA)
  pool.register(workerB)

  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const firstDone = pool.enqueue({ username: 'User', type: 'withdraw', stickyWorker: workerB, run: () => firstGate })
  const secondDone = pool.enqueue({
    username: 'User', type: 'withdraw', stickyWorker: workerB, run: worker => events.push(worker)
  })
  const events = []
  await tick()

  pool.unregister(workerB)
  releaseFirst()
  await Promise.all([firstDone, secondDone])

  assert.deepEqual(events, [workerA])
})

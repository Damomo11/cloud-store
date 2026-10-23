const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const hotReload = require('../src/hotReload')
const { DEFAULT_CONFIG } = require('../src/config')

function createService ({ admin = true, taskPool = null } = {}) {
  const sent = []
  const commandLogs = []
  const db = {
    isAdmin: () => admin,
    upsertPlayer: () => {},
    createCommandLog: entry => {
      commandLogs.push(entry)
      return commandLogs.length
    },
    runWithCommandContext: async (id, fn) => fn(),
    runWithBotContext: async (context, fn) => fn(),
    addCommandReply: () => {}
  }
  const pool = taskPool || {
    acceptIncoming: () => true,
    workers: new Set(),
    snapshot: () => ({ queued: [], active: [], onlineBots: 0 })
  }
  const bot = {
    username: 'BotA',
    players: { Admin: { uuid: 'uuid-admin' } },
    chat: message => sent.push(message)
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.commands.msg = '/msg {player} {message}'
  config.commands.publicFallback = false
  config.debugChat = false
  const service = new CloudStoreService(bot, db, null, null, config, pool)
  // warehouse 桩：invalidateConnection 会在 shutdown 阶段被调用（标记取消 + 断开）
  service.warehouse = { invalidateConnection: () => {} }
  service.msg = (username, message) => sent.push(`/msg ${username} ${message}`)
  return { service, sent, commandLogs, taskPool: pool, db, bot }
}

// 把 runHotReload 的外部依赖全部换成桩，测试 service 层的命令编排。
// service.hotReloadStubs 是测试注入口；生产为 null 时 runHotReload 用真实实现。
function stubHotReloadDeps (fixture, { gitPullError } = {}) {
  const calls = { gitExec: null, successorStarted: false }
  fixture.service.hotReloadStubs = {
    gitExec: () => { calls.gitExec = ['git.stub', 'pull']; return ['git.stub', 'pull'] },
    gitPull: async ({ exec }) => {
      if (exec) calls.gitExec = exec()
      if (gitPullError) throw gitPullError
      return { updated: true, output: 'Already up to date.' }
    },
    waitForIdle: async () => true,
    scheduleSuccessorProcess: () => {
      calls.successorStarted = true
      return { start: () => null, cancel: () => {} }
    }
  }
  return calls
}

test('admin !热重载 runs pull, waits for idle, then restarts', async () => {
  const fixture = createService()
  const calls = stubHotReloadDeps(fixture)
  const shutdownCalls = []
  const exitCalls = []
  fixture.service.setHotReloadHooks(() => shutdownCalls.push(1), async () => exitCalls.push(1))

  const result = await fixture.service.handleHotReload('Admin')

  assert.equal(result.status, 'restarting')
  assert.equal(calls.gitExec?.[0] !== undefined, true, 'git pull executed')
  assert.equal(calls.successorStarted, true, 'successor process scheduled')
  assert.equal(shutdownCalls.length, 1, 'shutdown hook called once')
  assert.equal(exitCalls.length, 1, 'exit hook called once')
  assert.ok(fixture.sent[0].includes('开始热重载'), 'flow start notified')
  assert.ok(fixture.sent.some(text => text.includes('机器人已空闲')), 'idle restart notified')
})

test('!热重载 dispatch through handleIncoming requires admin', async () => {
  const fixture = createService()
  stubHotReloadDeps(fixture)
  fixture.service.setHotReloadHooks(() => {}, async () => true)
  await fixture.service.handleIncoming('Admin', '!热重载', 'whisper', { channel: 'private' })
  assert.ok(fixture.sent.some(text => text.includes('开始热重载')), 'admin command executed')

  const other = createService({ admin: false })
  stubHotReloadDeps(other)
  const shutdownCalls = []
  other.service.setHotReloadHooks(() => shutdownCalls.push(1), async () => true)
  await other.service.handleIncoming('Admin', '!热重载', 'whisper', { channel: 'private' })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(other.sent.some(text => text.includes('你没有权限')), 'non-admin rejected')
  assert.equal(shutdownCalls.length, 0, 'non-admin never reaches shutdown')
})

test('private message without ! prefix also triggers hot reload', async () => {
  const fixture = createService()
  stubHotReloadDeps(fixture)
  fixture.service.setHotReloadHooks(() => {}, async () => true)
  fixture.service.handleIncoming('Admin', '热重载', 'whisper', { channel: 'private' })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(fixture.sent.some(text => text.includes('开始热重载')), 'bare private text works')
})

test('second !热重载 while one is running is rejected', async () => {
  const fixture = createService()
  stubHotReloadDeps(fixture)
  let releaseExit
  const exitGate = new Promise(resolve => { releaseExit = resolve })
  fixture.service.setHotReloadHooks(() => {}, async () => { await exitGate; return true })

  const first = fixture.service.handleHotReload('Admin')
  const second = await fixture.service.handleHotReload('Admin')
  assert.equal(second.status, 'already_running')
  releaseExit()
  await first
})

test('git pull failure aborts hot reload without shutdown', async () => {
  const fixture = createService()
  stubHotReloadDeps(fixture, { gitPullError: new Error('git pull 失败（退出码 128）') })
  const shutdownCalls = []
  const exitCalls = []
  fixture.service.setHotReloadHooks(() => shutdownCalls.push(1), async () => exitCalls.push(1))

  const result = await fixture.service.handleHotReload('Admin')
  assert.equal(result.status, 'pull_failed')
  assert.equal(shutdownCalls.length, 0, 'no shutdown on pull failure')
  assert.equal(exitCalls.length, 0, 'no exit on pull failure')
  assert.ok(fixture.sent.some(text => text.includes('热重载中止')))
  // 失败后标志复位，可以再次发起
  const again = await fixture.service.handleHotReload('Admin')
  assert.notEqual(again.status, 'already_running')
})

test('isTaskPoolIdle detects active workers, queue and death recovery', () => {
  assert.equal(hotReload.isTaskPoolIdle(null), true)
  assert.equal(hotReload.isTaskPoolIdle(undefined), true)

  const idlePool = { snapshot: () => ({ queued: [], active: [], onlineBots: 2 }), workers: new Set() }
  assert.equal(hotReload.isTaskPoolIdle(idlePool), true)

  // worker 标志优先：snapshot 看不到死亡恢复/急救中的 bot
  assert.equal(hotReload.isTaskPoolIdle({
    snapshot: () => ({ queued: [], active: [], onlineBots: 1 }),
    workers: new Set([{ recoveringFromDeath: true }])
  }), false)
  assert.equal(hotReload.isTaskPoolIdle({
    snapshot: () => ({ queued: [], active: [], onlineBots: 1 }),
    workers: new Set([{ emergencyRescueActive: true }])
  }), false)
  assert.equal(hotReload.isTaskPoolIdle({
    snapshot: () => ({ queued: [], active: [], onlineBots: 1 }),
    workers: new Set([{ active: { type: 'withdraw' } }])
  }), false)

  assert.equal(hotReload.isTaskPoolIdle({
    snapshot: () => ({ queued: [], active: [{ type: 'withdraw' }], onlineBots: 1 }),
    workers: new Set()
  }), false, 'snapshot active task is not idle')
  assert.equal(hotReload.isTaskPoolIdle({
    snapshot: () => ({ queued: [{ id: 1 }], active: [], onlineBots: 1 }),
    workers: new Set()
  }), false, 'queued task is not idle')

  // 没有 snapshot 时按 worker 标志兜底
  assert.equal(hotReload.isTaskPoolIdle({ workers: new Set() }), true)
  assert.equal(hotReload.isTaskPoolIdle({ workers: new Set([{ active: { type: 'deposit' } }]) }), false)
})

test('waitForIdle resolves true once the pool becomes idle and false on timeout', async () => {
  let idle = false
  const pool = {
    snapshot: () => idle
      ? { queued: [], active: [], onlineBots: 1 }
      : { queued: [], active: [{ type: 'withdraw' }], onlineBots: 1 },
    workers: new Set()
  }
  // 200ms 后转为空闲
  setTimeout(() => { idle = true }, 200)
  const result = await hotReload.waitForIdle({
    taskPool: pool,
    timeoutMs: 5000,
    pollMs: 10,
    sleep: async () => {}
  })
  assert.equal(result, true)

  const busyPool = {
    snapshot: () => ({ queued: [], active: [{ type: 'withdraw' }], onlineBots: 1 }),
    workers: new Set()
  }
  const timedOut = await hotReload.waitForIdle({
    taskPool: busyPool,
    timeoutMs: 100,
    pollMs: 20,
    sleep: async () => {}
  })
  assert.equal(timedOut, false, 'timeout returns false')

  // 一开始就空闲：立即返回 true
  const instantPool = {
    snapshot: () => ({ queued: [], active: [], onlineBots: 1 }),
    workers: new Set()
  }
  const instant = await hotReload.waitForIdle({ taskPool: instantPool, sleep: async () => {} })
  assert.equal(instant, true, 'already-idle pool resolves immediately')
})

test('scheduleSuccessorProcess spawns node with the entry file and can be cancelled', async () => {
  const spawns = []
  hotReload.scheduleSuccessorProcess({
    entryFile: 'src/index.js',
    spawnImplementation: (command, args, options) => {
      spawns.push({ command, args, options })
      return { unref: () => {}, kill: () => {} }
    },
    startDelayMs: 10
  })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(spawns.length, 1, 'successor spawned after delay')
  assert.equal(spawns[0].command, process.execPath)
  assert.equal(spawns[0].args[0], 'src/index.js')
  assert.equal(spawns[0].options.detached, true)

  let cancelledSpawnCount = 0
  const cancelled = hotReload.scheduleSuccessorProcess({
    entryFile: 'src/index.js',
    spawnImplementation: () => { cancelledSpawnCount += 1; return { unref: () => {}, kill: () => {} } },
    startDelayMs: 10
  })
  cancelled.cancel()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(cancelledSpawnCount, 0, 'cancelled successor never spawns')
})

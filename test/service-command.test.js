const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')
const { BotTaskPool } = require('../src/taskPool')

function createService ({ admin = true } = {}) {
  const sent = []
  const commandLogs = []
  const replies = []
  const db = {
    isAdmin: () => admin,
    upsertPlayer: () => {},
    canonicalPlayerUuid: uuid => uuid,
    resolveOfflineUuidToMojang: uuid => uuid,
    createCommandLog: entry => {
      commandLogs.push(entry)
      return commandLogs.length
    },
    runWithCommandContext: async (id, fn) => fn(),
    runWithBotContext: async (context, fn) => fn(),
    addCommandReply: reply => replies.push(reply)
  }
  const taskPool = {
    accepted: 0,
    acceptIncoming: () => {
      taskPool.accepted++
      return true
    }
  }
  const bot = {
    username: 'BotA',
    players: {
      Admin: { uuid: 'uuid-admin' }
    },
    chat: message => sent.push(message)
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.commands.msg = '/msg {player} {message}'
  config.debugChat = false
  const service = new CloudStoreService(bot, db, null, null, config, taskPool)
  return { service, sent, commandLogs, replies, taskPool }
}

test('admin bot game command bypasses shared task dedupe', async () => {
  const fixture = createService()
  fixture.service.handleIncoming('Admin', '!指令 /say hello', 'chat', { channel: 'public' })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(fixture.taskPool.accepted, 0)
  assert.deepEqual(fixture.sent, ['/say hello'])
  assert.equal(fixture.commandLogs[0].commandText, '!指令 /say hello')
})

test('admin bot game command dedupes repeated events on the same bot', async () => {
  const fixture = createService()
  fixture.service.handleIncoming('Admin', '!指令 /say hello', 'chat', { channel: 'public' })
  fixture.service.handleIncoming('Admin', '!指令 /say hello', 'messagestr', { channel: 'public' })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(fixture.taskPool.accepted, 0)
  assert.deepEqual(fixture.sent, ['/say hello'])
  assert.equal(fixture.commandLogs.length, 1)
})

test('private bot game command confirms only to the receiving bot', async () => {
  const fixture = createService()
  fixture.service.handleIncoming('Admin', '!指令 hello world', 'whisper', { channel: 'private' })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(fixture.sent, ['hello world', '/msg Admin 已执行：hello world'])
  assert.equal(fixture.replies[0].message, '已执行：hello world')
})

test('non-admin bot game command is rejected', async () => {
  const fixture = createService({ admin: false })
  fixture.service.handleIncoming('Admin', '!指令 /stop', 'whisper', { channel: 'private' })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(fixture.sent, ['/msg Admin 你没有权限让机器人发送游戏内指令。'])
  assert.equal(fixture.replies[0].message, '你没有权限让机器人发送游戏内指令。')
})

test('admin can toggle detailed craft logs for this bot at runtime', () => {
  const fixture = createService()
  const lines = []
  fixture.service.craftDebugWriter = line => lines.push(line)

  fixture.service.handleIncoming('Admin', '！调试 合成日志 开', 'whisper', { channel: 'private' })
  assert.equal(fixture.service.craftDebugEnabled, true)
  fixture.service.debugCraft('batch_start', { operationId: 'craft:test', triggers: 10 })

  fixture.service.handleIncoming('Admin', '!调试 合成日志 关', 'whisper', { channel: 'private' })
  fixture.service.debugCraft('batch_end', { operationId: 'craft:test' })

  assert.equal(fixture.service.craftDebugEnabled, false)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /craft-debug/)
  assert.match(lines[0], /"botId":"bota"/)
  assert.match(lines[0], /"event":"batch_start"/)
  assert.match(lines[0], /"triggers":10/)
  assert.equal(fixture.taskPool.accepted, 0)
  assert.ok(fixture.sent.some(message => message.includes('合成日志已开启')))
  assert.ok(fixture.sent.some(message => message.includes('合成日志已关闭')))
})

test('private admins can toggle craft logs without the command prefix', () => {
  const fixture = createService()

  fixture.service.handleIncoming('Admin', '调试 合成日志 开', 'whisper', { channel: 'private' })

  assert.equal(fixture.service.craftDebugEnabled, true)
  assert.ok(fixture.sent.some(message => message.includes('合成日志已开启')))
})

test('non-admin craft debug commands are silently ignored', () => {
  const fixture = createService({ admin: false })

  fixture.service.handleIncoming('Admin', '!调试 合成日志 开', 'whisper', { channel: 'private' })

  assert.notEqual(fixture.service.craftDebugEnabled, true)
  assert.equal(fixture.taskPool.accepted, 0)
  assert.deepEqual(fixture.sent, [])
})

function createBotGroup (options = {}) {
  const pool = new BotTaskPool(DEFAULT_CONFIG)
  const fixtures = ['BotA', 'BotB', 'BotC'].map(name => {
    const fixture = createService(options)
    fixture.service.bot.username = name
    fixture.service.botId = name.toLowerCase()
    fixture.service.ready = true
    fixture.service.taskPool = pool
    pool.register(fixture.service)
    return fixture
  })
  return { pool, fixtures, replies: () => fixtures.flatMap(fixture => fixture.sent) }
}

test('public craft debug toggles every online bot before sending one final reply', () => {
  const group = createBotGroup()
  const calls = []
  for (const fixture of group.fixtures) {
    const original = fixture.service.handleCraftDebugCommand.bind(fixture.service)
    fixture.service.handleCraftDebugCommand = (...args) => {
      assert.deepEqual(group.replies(), [], 'reply sent before all bots finished')
      calls.push(fixture.service.bot.username)
      return original(...args)
    }
    fixture.service.active = { type: 'craft' }
  }
  group.fixtures[0].service.handleIncoming('Admin', '!调试 合成日志 开', 'chat', { channel: 'public' })

  assert.deepEqual(calls, ['BotA', 'BotB', 'BotC'])
  assert.ok(group.fixtures.every(fixture => fixture.service.craftDebugEnabled))
  assert.equal(group.replies().length, 1)
  assert.match(group.replies()[0], /3 个机器人.*合成日志已开启/)
  assert.ok(group.fixtures.every(fixture => fixture.service.active.type === 'craft'))
})

test('public debug chat events across bots share dedupe and a later off command still applies', () => {
  const group = createBotGroup()
  for (const command of ['!调试 合成日志 开', '!调试 合成日志 关']) {
    for (const fixture of group.fixtures) {
      for (const source of ['chat', 'messagestr', 'packet:player_chat']) {
        fixture.service.handleIncoming('Admin', command, source, { channel: 'public' })
      }
    }
  }
  assert.equal(group.replies().length, 2)
  assert.ok(group.fixtures.every(fixture => fixture.service.craftDebugEnabled === false))
  assert.match(group.replies()[1], /合成日志已关闭/)
})

test('invalid public debug syntax returns one usage reply without changing any bot', () => {
  const group = createBotGroup()
  for (const fixture of group.fixtures) {
    fixture.service.handleIncoming('Admin', '!调试 合成输出 开', 'chat', { channel: 'public' })
  }
  assert.equal(group.replies().length, 1)
  assert.match(group.replies()[0], /格式：!调试 合成日志 开 关/)
  assert.ok(group.fixtures.every(fixture => fixture.service.craftDebugEnabled === false))
})

test('private debug affects only the addressed bot and dedupes its repeated packet event', () => {
  const group = createBotGroup()
  for (const source of ['whisper', 'messagestr:private']) {
    group.fixtures[1].service.handleIncoming('Admin', '调试 合成日志 开', source, { channel: 'private' })
  }
  assert.deepEqual(group.fixtures.map(fixture => fixture.service.craftDebugEnabled), [false, true, false])
  assert.equal(group.replies().length, 1)
  assert.match(group.replies()[0], /机器人 BotB 的合成日志已开启/)
})

test('public debug ignores bots whose connection is invalid or not ready', () => {
  const group = createBotGroup()
  group.fixtures[1].service.connectionInvalidated = true
  group.fixtures[2].service.ready = false
  group.fixtures[0].service.handleIncoming('Admin', '!调试 合成日志 开', 'chat', { channel: 'public' })
  assert.deepEqual(group.fixtures.map(fixture => fixture.service.craftDebugEnabled), [true, false, false])
  assert.equal(group.replies().length, 1)
  assert.match(group.replies()[0], /1 个机器人.*合成日志已开启/)
})

test('a failed debug toggle does not stop the other bots and is reported in the single reply', () => {
  const group = createBotGroup()
  group.fixtures[1].service.handleCraftDebugCommand = () => { throw new Error('toggle failed') }
  group.fixtures[0].service.handleIncoming('Admin', '!调试 合成日志 开', 'chat', { channel: 'public' })
  assert.deepEqual(group.fixtures.map(fixture => fixture.service.craftDebugEnabled), [true, false, true])
  assert.equal(group.replies().length, 1)
  assert.match(group.replies()[0], /2 个机器人.*合成日志已开启/)
  assert.match(group.replies()[0], /BotB.*toggle failed/)
})

test('non-admin public debug stays silent and leaves every bot unchanged', () => {
  const group = createBotGroup({ admin: false })
  for (const fixture of group.fixtures) {
    fixture.service.handleIncoming('Admin', '!调试 合成日志 开', 'chat', { channel: 'public' })
  }
  assert.deepEqual(group.replies(), [])
  assert.ok(group.fixtures.every(fixture => fixture.service.craftDebugEnabled === false))
})

test('formatted public system chat shares the same broadcast reply as messagestr events', () => {
  const group = createBotGroup()
  const message = '『椰汁橙』Admin > !调试 合成日志 开'
  for (const fixture of group.fixtures) {
    fixture.service.handleSystemChatPacket({ content: { text: message } })
    fixture.service.handleMessageString(message, 'system')
  }
  assert.ok(group.fixtures.every(fixture => fixture.service.craftDebugEnabled))
  assert.equal(group.replies().length, 1)
  assert.match(group.replies()[0], /3 个机器人.*合成日志已开启/)
})

test('formatted private system chat affects only its recipient and dedupes whisper events', () => {
  const group = createBotGroup()
  const message = '[Admin -> BotB] 调试 合成日志 开'
  for (const fixture of group.fixtures) {
    fixture.service.handleSystemChatPacket({ content: { text: message } })
    fixture.service.handleMessageString(message, 'system')
  }
  group.fixtures[1].service.handleIncoming('Admin', '调试 合成日志 开', 'whisper', { channel: 'private' })
  assert.deepEqual(group.fixtures.map(fixture => fixture.service.craftDebugEnabled), [false, true, false])
  assert.equal(group.replies().length, 1)
})

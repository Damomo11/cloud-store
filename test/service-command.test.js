const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

function createService ({ admin = true } = {}) {
  const sent = []
  const commandLogs = []
  const replies = []
  const db = {
    isAdmin: () => admin,
    upsertPlayer: () => {},
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

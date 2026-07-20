const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

function createFixture () {
  const sent = []
  const db = {
    isAdmin: () => true,
    upsertPlayer: () => {},
    createCommandLog: () => 1,
    runWithCommandContext: async (id, fn) => fn(),
    runWithBotContext: async (context, fn) => fn(),
    addCommandReply: () => {}
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
  const service = new CloudStoreService(bot, db, null, null, config, null)
  return { service, sent }
}

test('bot game command is blocked while a warehouse task is active', async () => {
  const fixture = createFixture()
  fixture.service.active = { type: 'deposit', username: 'Player1', phase: 'deposit_collecting' }
  fixture.service.handleIncoming('Admin', '!指令 1', 'chat', { channel: 'public' })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(fixture.sent, ['/msg Admin 机器人正在为 Player1 执行存货任务，暂时不允许使用 !指令，以免打断返回 /home。'])
})

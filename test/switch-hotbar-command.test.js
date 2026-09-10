const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

function createFixture ({ admin = true } = {}) {
  const sent = []
  const db = {
    isAdmin: () => admin,
    upsertPlayer: () => {},
    createCommandLog: () => 1,
    runWithCommandContext: async (id, fn) => fn(),
    runWithBotContext: async (context, fn) => fn(),
    addCommandReply: () => {}
  }
  const taskPool = {
    accepted: 0,
    acceptIncoming () { this.accepted++; return true }
  }
  const inventory = { slots: { 36: null, 38: { name: 'minecraft:stone', count: 3 } } }
  const bot = {
    username: 'BotA',
    players: { Admin: { uuid: 'uuid-admin' } },
    inventory,
    quickBarSlot: 0,
    setQuickBarSlotCalls: [],
    setQuickBarSlot (slot) {
      this.setQuickBarSlotCalls.push(slot)
      this.quickBarSlot = slot
    },
    chat: message => sent.push(message)
  }
  Object.defineProperty(bot, 'heldItem', {
    get () { return inventory.slots[36 + this.quickBarSlot] }
  })
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.commands.msg = '/msg {player} {message}'
  config.debugChat = false
  const service = new CloudStoreService(bot, db, { getDisplayName: name => name }, null, config, taskPool)
  return { service, bot, sent, taskPool }
}

function settle () {
  return new Promise(resolve => setImmediate(resolve))
}

test('whispering 切换 3 switches the bot to hotbar slot 3 without going through the task pool', async () => {
  const { service, bot, sent, taskPool } = createFixture()
  service.handleIncoming('Admin', '切换 3', 'whisper', { channel: 'private' })
  await settle()

  assert.deepEqual(bot.setQuickBarSlotCalls, [2])
  assert.equal(bot.heldItem.name, 'minecraft:stone')
  assert.equal(taskPool.accepted, 0)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /已切换到快捷栏第 3 格：空手 -> minecraft:stone x3/)
})

test('public !切换 also executes directly like other bot control commands', async () => {
  const { service, bot, taskPool } = createFixture()
  service.handleIncoming('Admin', '!切换 2', 'chat', { channel: 'public' })
  await settle()

  assert.deepEqual(bot.setQuickBarSlotCalls, [1])
  assert.equal(taskPool.accepted, 0)
})

test('切换 rejects invalid slot numbers', async () => {
  const { service, bot, sent } = createFixture()
  service.handleIncoming('Admin', '切换 10', 'whisper', { channel: 'private' })
  await settle()

  assert.deepEqual(bot.setQuickBarSlotCalls, [])
  assert.equal(sent.length, 1)
  assert.match(sent[0], /格式：切换 1~9/)
})

test('切换 is admin-only', async () => {
  const { service, bot, sent } = createFixture({ admin: false })
  service.handleIncoming('Someone', '切换 1', 'whisper', { channel: 'private' })
  await settle()

  assert.deepEqual(bot.setQuickBarSlotCalls, [])
  assert.equal(sent.length, 1)
  assert.match(sent[0], /你没有权限切换机器人快捷栏/)
})

test('切换 refuses while the bot is running a deposit or withdraw task', async () => {
  const { service, bot, sent } = createFixture()
  service.active = { type: 'withdraw', username: 'Player1' }
  service.handleIncoming('Admin', '切换 4', 'whisper', { channel: 'private' })
  await settle()

  assert.deepEqual(bot.setQuickBarSlotCalls, [])
  assert.match(sent[0], /正在为 Player1 执行取货任务/)
})

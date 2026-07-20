const test = require('node:test')
const assert = require('node:assert/strict')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

function createFixture () {
  let queuedTask = null
  const sent = []
  const db = {
    upsertPlayer: () => {},
    getEffectiveDefaultOwnerUuid: uuid => uuid,
    hasPersonalWarehouse: () => true,
    currentCommandLogId: () => 1,
    addCommandReply: () => {}
  }
  const taskPool = {
    enqueue: task => {
      queuedTask = task
      return Promise.resolve()
    }
  }
  const bot = {
    username: 'BotA',
    players: {
      Admin: { uuid: 'uuid-admin' },
      Target: { uuid: 'uuid-target' }
    },
    chat: message => sent.push(message)
  }
  const catalog = {
    getDisplayName: itemId => itemId === 'minecraft:experience_bottle' ? '附魔之瓶' : itemId
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.commands.msg = '/msg {player} {message}'
  config.debugChat = false
  const service = new CloudStoreService(bot, db, catalog, {}, config, taskPool)
  return {
    service,
    sent,
    getQueuedTask: () => queuedTask
  }
}

test('repair command defaults target to actor and withdraws experience bottles', async () => {
  const fixture = createFixture()
  await fixture.service.handleChat('Admin', '!修装备')

  const task = fixture.getQueuedTask()
  assert.equal(task.type, 'withdraw')
  const calls = []
  await task.run({
    handleWithdraw: (...args) => {
      calls.push(args)
    }
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'Admin')
  assert.equal(calls[0][4], 'Admin')
  assert.equal(calls[0][3][0].itemId, 'minecraft:experience_bottle')
  assert.equal(calls[0][3][0].amount, 64)
  assert.equal(calls[0][5].deliveryMode, 'repair')
})

test('repair command accepts an explicit target player', async () => {
  const fixture = createFixture()
  await fixture.service.handleChat('Admin', '!修装备 Target')

  const task = fixture.getQueuedTask()
  const calls = []
  await task.run({
    handleWithdraw: (...args) => {
      calls.push(args)
    }
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0][4], 'Target')
})

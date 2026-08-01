const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { installFatalProtocolPacketCapture, releaseBotConnection } = require('../src/botConnection')

function createBot () {
  const calls = []
  return {
    calls,
    end: reason => calls.push(['end', reason]),
    _client: {
      socket: {
        destroy: () => calls.push(['destroy'])
      }
    }
  }
}

test('failed connection is released so a replacement bot can launch', () => {
  const bot = createBot()
  const service = {}
  const unregistered = []
  const state = { bot, service, deviceCode: { userCode: 'ABCD' } }

  assert.equal(releaseBotConnection(state, bot, service, { unregister: value => unregistered.push(value) }, 'retry auth'), true)
  assert.equal(state.bot, null)
  assert.equal(state.service, null)
  assert.equal(state.deviceCode, null)
  assert.deepEqual(unregistered, [service])
  assert.deepEqual(bot.calls, [['end', 'retry auth'], ['destroy']])
})

test('normal end cleanup does not try to terminate an already-ended transport', () => {
  const bot = createBot()
  const service = {}
  const state = { bot, service }

  assert.equal(releaseBotConnection(state, bot, service, null, 'ended', { terminate: false }), true)
  assert.deepEqual(bot.calls, [])
})

test('late events from an old bot cannot release its replacement', () => {
  const oldBot = createBot()
  const newBot = createBot()
  const oldService = {}
  const newService = {}
  const state = { bot: newBot, service: newService }

  assert.equal(releaseBotConnection(state, oldBot, oldService, { unregister: () => assert.fail('must not unregister stale service') }, 'late end'), false)
  assert.equal(state.bot, newBot)
  assert.equal(state.service, newService)
  assert.deepEqual(oldBot.calls, [])
})

test('fatal protocol capture saves the latest decompressed packet inside the configured directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-protocol-capture-'))
  try {
    const splitter = new EventEmitter()
    const client = new EventEmitter()
    client.splitter = splitter
    client.version = '1.21.11'
    const capture = installFatalProtocolPacketCapture({ username: 'BotA', _client: client }, { directory })
    const packet = Buffer.from('0a080011', 'hex')
    splitter.emit('data', packet)

    const packetPath = capture.dump(new Error('SlotComponent read error'), { botName: 'BotA' })

    assert.deepEqual(fs.readFileSync(packetPath), packet)
    const metadata = JSON.parse(fs.readFileSync(packetPath.replace(/\.bin$/, '.json'), 'utf8'))
    assert.equal(metadata.version, '1.21.11')
    assert.equal(metadata.bytes, packet.length)
    assert.match(metadata.error, /SlotComponent/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

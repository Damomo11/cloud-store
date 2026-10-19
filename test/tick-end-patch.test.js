// 回归测试：Minecraft 26.3 起服务器要求每个客户端 tick 末尾收到 serverbound
// `tick_end` 包，否则第二个移动包触发 invalid_player_movement 踢出（上游
// mineflayer#4189）。tickEndPatch 必须在每个移动类包后补发 tick_end，
// 其他包不补发；协议不支持 tick_end 时静默跳过；卸载后恢复原始 write。
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { installClientTickEndPatch, MOVEMENT_PACKETS } = require('../src/tickEndPatch')

function makeFakeBot () {
  const client = new EventEmitter()
  client.state = 'play'
  const writes = []
  client.write = (name, packet) => { writes.push({ name, packet: packet ?? null }) }
  return { bot: { _client: client }, client, writes }
}

test('movement packets are followed by a tick_end packet', () => {
  const { bot, client, writes } = makeFakeBot()
  installClientTickEndPatch(bot)
  client.write('position', { x: 1 })
  client.write('look', { yaw: 0 })
  client.write('position_look', { x: 2 })
  client.write('flying', {})
  const names = writes.map(w => w.name)
  assert.deepEqual(names, [
    'position', 'tick_end',
    'look', 'tick_end',
    'position_look', 'tick_end',
    'flying', 'tick_end'
  ])
})

test('non-movement packets are not followed by tick_end', () => {
  const { bot, client, writes } = makeFakeBot()
  installClientTickEndPatch(bot)
  client.write('chat_command', { command: '/home ck' })
  client.write('teleport_confirm', { teleportId: 7 })
  const names = writes.map(w => w.name)
  assert.deepEqual(names, ['chat_command', 'teleport_confirm'])
})

test('missing tick_end in older protocol is silently skipped', () => {
  const { bot, client, writes } = makeFakeBot()
  // 1.21.2 之前：写 tick_end 会抛错
  const origWrite = client.write.bind(client)
  client.write = (name, packet) => {
    if (name === 'tick_end') throw new Error('unknown packet tick_end')
    return origWrite(name, packet)
  }
  installClientTickEndPatch(bot)
  client.write('position', { x: 1 })
  const names = writes.map(w => w.name)
  assert.deepEqual(names, ['position'])
})

test('uninstall restores the original write function', () => {
  const { bot, client, writes } = makeFakeBot()
  const original = client.write
  const uninstall = installClientTickEndPatch(bot)
  assert.notEqual(client.write, original)
  uninstall()
  assert.equal(client.write, original)
  client.write('position', { x: 3 })
  assert.deepEqual(writes.map(w => w.name), ['position'])
})

test('double install is a no-op and writes pass through one layer', () => {
  const { bot, client, writes } = makeFakeBot()
  installClientTickEndPatch(bot)
  installClientTickEndPatch(bot)
  client.write('position', { x: 1 })
  assert.deepEqual(writes.map(w => w.name), ['position', 'tick_end'])
})

test('write return value is forwarded to the caller', () => {
  const { bot, client } = makeFakeBot()
  let marker = null
  const origWrite = client.write.bind(client)
  client.write = (name, packet) => { origWrite(name, packet); return 'SENT' }
  installClientTickEndPatch(bot)
  marker = client.write('position', { x: 1 })
  assert.equal(marker, 'SENT')
})

test('movement packet name set matches mineflayer physics writers', () => {
  // mineflayer/lib/plugins/physics.js 只写这四种移动包
  assert.deepEqual([...MOVEMENT_PACKETS].sort(), ['flying', 'look', 'position', 'position_look'])
})

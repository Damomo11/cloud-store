// 回归测试：Minecraft 26.3 起服务器要求每个客户端 tick 末尾收到 serverbound
// `tick_end` 包，否则第二个位置包触发 invalid_player_movement 踢出（上游
// mineflayer#4189）。tickEndPatch 按 PR#4128 语义实现两层保护：
// ① physicsTick 末尾补发 tick_end；② 同一 tick 内第二个位置包前先补 tick_end。
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { installClientTickEndPatch, MOVEMENT_PACKETS, POSITION_PACKETS } = require('../src/tickEndPatch')

function makeFakeBot () {
  const client = new EventEmitter()
  client.state = 'play'
  const writes = []
  client.write = (name, packet) => { writes.push({ name, packet: packet ?? null }) }
  const bot = new EventEmitter()
  bot._client = client
  return { bot, client, writes }
}

test('physicsTick emits a tick_end and resets the per-tick flag', () => {
  const { bot, client, writes } = makeFakeBot()
  installClientTickEndPatch(bot)
  client.write('position', { x: 1 })
  assert.deepEqual(writes.map(w => w.name), ['position'])
  bot.emit('physicsTick')
  assert.deepEqual(writes.map(w => w.name), ['position', 'tick_end'])
  // tick_end 已重置标记：新 tick 内的第一个位置包直接放行，
  // 它的收尾 tick_end 由下一个 physicsTick 补发（PR#4128 语义）
  client.write('position', { x: 2 })
  assert.deepEqual(writes.map(w => w.name), ['position', 'tick_end', 'position'])
})

test('second position packet within one server tick is preceded by a tick_end', () => {
  const { bot, client, writes } = makeFakeBot()
  installClientTickEndPatch(bot)
  // 不经过 physicsTick，模拟 teleport 强制回包与常规回包落在同一事件循环
  client.write('position_look', { x: 1 })
  client.write('position_look', { x: 2 })
  assert.deepEqual(writes.map(w => w.name), ['position_look', 'tick_end', 'position_look'])
})

test('look and flying packets do not trip the position guard', () => {
  const { bot, client, writes } = makeFakeBot()
  installClientTickEndPatch(bot)
  client.write('position', { x: 1 })
  client.write('look', { yaw: 0 })
  client.write('flying', {})
  // look/flying 不是位置包，不会补 tick_end（服务器只按位置包计数）
  assert.deepEqual(writes.map(w => w.name), ['position', 'look', 'flying'])
})

test('non-movement packets pass through untouched', () => {
  const { bot, client, writes } = makeFakeBot()
  installClientTickEndPatch(bot)
  client.write('chat_command', { command: '/home ck' })
  bot.emit('physicsTick')
  client.write('teleport_confirm', { teleportId: 7 })
  assert.deepEqual(writes.map(w => w.name), ['chat_command', 'tick_end', 'teleport_confirm'])
})

test('missing tick_end in older protocol is silently skipped', () => {
  const { bot, client, writes } = makeFakeBot()
  const origWrite = client.write.bind(client)
  client.write = (name, packet) => {
    if (name === 'tick_end') throw new Error('unknown packet tick_end')
    return origWrite(name, packet)
  }
  const fixedWrites = writes
  const botClient = bot._client
  installClientTickEndPatch(bot)
  // 包装后 write 调 tick_end 抛错 → 静默跳过，position 正常发出
  botClient.write('position', { x: 1 })
  bot.emit('physicsTick')
  botClient.write('position', { x: 2 })
  assert.deepEqual(fixedWrites.map(w => w.name), ['position', 'position'])
})

test('uninstall restores the original write function and removes the listener', () => {
  const { bot, client, writes } = makeFakeBot()
  const original = client.write
  const uninstall = installClientTickEndPatch(bot)
  assert.notEqual(client.write, original)
  uninstall()
  assert.equal(client.write, original)
  client.write('position', { x: 3 })
  bot.emit('physicsTick')
  assert.deepEqual(writes.map(w => w.name), ['position'])
})

test('double install returns the existing uninstall and wraps write only once', () => {
  const { bot, client, writes } = makeFakeBot()
  const uninstall1 = installClientTickEndPatch(bot)
  const uninstall2 = installClientTickEndPatch(bot)
  assert.equal(typeof uninstall2, 'function')
  client.write('position', { x: 1 })
  bot.emit('physicsTick')
  // 只包装一层：position 后仅 physicsTick 补的一个 tick_end，不会翻倍
  assert.deepEqual(writes.map(w => w.name), ['position', 'tick_end'])
  uninstall1()
  uninstall2?.()
})

test('physicsTick outside the play state does not send tick_end', () => {
  const { bot, client, writes } = makeFakeBot()
  installClientTickEndPatch(bot)
  client.state = 'configuration'
  bot.emit('physicsTick')
  assert.deepEqual(writes.map(w => w.name), [])
})

test('write return value is forwarded to the caller', () => {
  const { bot, client } = makeFakeBot()
  let marker
  const origWrite = client.write.bind(client)
  client.write = (name, packet) => { origWrite(name, packet); return 'SENT' }
  installClientTickEndPatch(bot)
  marker = client.write('position', { x: 1 })
  assert.equal(marker, 'SENT')
})

test('movement packet sets match mineflayer physics writers', () => {
  // mineflayer/lib/plugins/physics.js 只写这四种移动包；其中两种带位置
  assert.deepEqual([...MOVEMENT_PACKETS].sort(), ['flying', 'look', 'position', 'position_look'])
  assert.deepEqual([...POSITION_PACKETS].sort(), ['position', 'position_look'])
})

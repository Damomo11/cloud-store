// mineflayer 的 time 插件读 packet.time + packet.age 两个 i64 字段（1.21.x 双字段格式），
// 而 26.x 的 update_time 只有一个 i64（字段名 age）+ clockUpdates 数组
// （mc-data 26.1 packet_update_time；26.2/26.3 未再改动 —— v26_1to26_2/v26_2to26_3 无 SET_TIME 转换）。
// 不 patch 的话 longToBigInt(undefined) 直接 uncaught。
//
// 做法：在 mineflayer require('./plugins/time') 之前替换 require.cache 里的 exports
// （与 chunk-26 的注入同款手法）。via activate() 在 require('mineflayer') 之前执行，时序成立。

'use strict'

let installed = false

function longToBigInt (arr) {
  return BigInt.asIntN(64, (BigInt(arr[0]) << 32n)) | BigInt(arr[1])
}

// 兼容 26.x 单字段（age）与 1.21.x 双字段（time/age）的 update_time
function injectTimeCompat (bot) {
  bot.time = {
    doDaylightCycle: null,
    bigTime: null,
    time: null,
    timeOfDay: null,
    day: null,
    isDay: null,
    moonPhase: null,
    bigAge: null,
    age: null
  }
  bot._client.on('update_time', (packet) => {
    const time = longToBigInt(packet.time ?? packet.age ?? [0, 0])
    const age = longToBigInt(packet.age ?? packet.time ?? [0, 0])
    const doDaylightCycle = packet.tickDayTime !== undefined ? !!packet.tickDayTime : time >= 0n
    const finalTime = doDaylightCycle ? time : (time < 0n ? -time : time)

    bot.time.doDaylightCycle = doDaylightCycle
    bot.time.bigTime = finalTime
    bot.time.time = Number(finalTime)
    bot.time.timeOfDay = bot.time.time % 24000
    bot.time.day = Math.floor(bot.time.time / 24000)
    bot.time.isDay = bot.time.timeOfDay >= 0 && bot.time.timeOfDay < 13000
    bot.time.moonPhase = bot.time.day % 8
    bot.time.bigAge = age
    bot.time.age = Number(age)

    bot.emit('time')
  })
}

function installTimeCompat () {
  if (installed) return
  installed = true

  const timePath = require.resolve('mineflayer/lib/plugins/time.js')
  require(timePath) // 先让真实模块进缓存
  require.cache[timePath].exports = injectTimeCompat
}

module.exports = { installTimeCompat }

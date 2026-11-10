// 1.21.2+ 服务器在跨维度/重生后，要等客户端上报「世界加载完成」（player_loaded，空包）
// 才开始接受该玩家的移动/转头包。mineflayer 从不发送这个包：跨维度 tpa 落地后立刻
// 发出的转头包会被服务端直接丢弃约 2~3 秒（超时才放行），而 mineflayer 本地「已发
// 角度」已被更新、同一角度不会重发——表现就是跨维度落地永远不转头；同维度传送不
// 产生 respawn 包、服务端不在等待状态，所以主世界一切正常。
// 原版客户端的顺序是「回传送确认号 → 世界加载完成 → 上报 player_loaded」。bot 没有
// 加载画面，模拟成：收到 respawn 记标记，下一个 position 包到达时补发（传送确认号
// 此时已由 physics 插件自动回出；本监听注册在其后，天然排在确认之后）。另外
// 1.21.4 起原版客户端一进服（login）也会先报到，晚报到容易让移动包被判非法，这里
// 一并对齐。player_loaded 与 player_input 同批加入（1.21.2），在 respawn 回调里用
// supportFeature 判版本（此时 registry 已注入）；login 报到则直接 try 写，老版本
// 没有这个包会抛错，静默吞掉即可，绝不瞎发。
function installPlayerLoadedReport (bot) {
  const client = bot?._client
  if (!client) return

  const writePlayerLoaded = () => {
    try { client.write('player_loaded', {}) } catch {}
  }

  // 进服报到（对齐 1.21.4+ 原版行为；老版本 write 失败静默跳过）
  bot.on('login', writePlayerLoaded)

  // 跨维度/重生后补报：服务端收到之前会一直丢弃该玩家的移动/转头包
  let awaitingLoadedReport = false
  client.on('respawn', () => {
    awaitingLoadedReport = typeof bot.supportFeature === 'function' && bot.supportFeature('newPlayerInputPacket')
  })
  client.on('position', () => {
    if (!awaitingLoadedReport) return
    awaitingLoadedReport = false
    writePlayerLoaded()
  })
}

module.exports = { installPlayerLoadedReport }

// Minecraft 26.3 起，原版服务器（ServerGamePacketListenerImpl.handleMovePlayer）
// 在每个客户端 tick 内只接受一个带位置的移动包，只有收到 serverbound `tick_end`
// 包（handleClientTickEnd）才会重置该标记。vanilla 客户端从 1.21.2 起每个物理
// tick 末尾都发送该包，而 mineflayer 包括最新 4.39.0 都不发（上游 issue #4189、
// PR #4128 尚未合入），于是 bot 的第二个移动包必然触发
// multiplayer.disconnect.invalid_player_movement 踢出并无限重连。
//
// 本补丁按 PR #4128 的语义实现两层保护：
// 1. 挂 mineflayer 的 physicsTick：tickPhysics 在 login 后以 50ms interval 运行，
//    物理启用时每 tick 发射 physicsTick。在 tick 末尾补发空 tick_end，重置
//    positionSentSinceTickEnd。tick_end 在 1.21.11/26.1 协议数据里均已定义
//    为空容器，直接 write 即可。
//    注意 physicsTick 事件只在物理启用时发射——挂载/死亡等不发移动包的状态
//    不会有问题；spawn 之前的 teleport 回包由第 2 层保护。
// 2. 包级保护：teleport 后的强制 position_look 回包（forcedMove）发生在物理
//    tick 之外，可能与下一个常规移动包落进同一个服务器 tick。包装 client.write，
//    若同一 tick 内已发过位置包，先补一个 tick_end 关闭该 tick 再放行。
// 协议不支持 tick_end（1.21.2 之前）时写入抛错，静默降级为无操作。

const MOVEMENT_PACKETS = new Set(['position', 'position_look', 'look', 'flying'])
const POSITION_PACKETS = new Set(['position', 'position_look'])

function writeTickEnd (client) {
  try {
    client.write('tick_end', {})
    return true
  } catch {
    // 1.21.2 之前的协议没有该包；服务器也不需要它
    return false
  }
}

function installClientTickEndPatch (bot) {
  const client = bot?._client
  if (!client || typeof client.write !== 'function') return () => {}
  if (typeof client._tickEndUninstall === 'function') return client._tickEndUninstall
  let uninstalled = false
  let positionSentSinceTickEnd = false

  const onPhysicsTick = () => {
    if (uninstalled || client.state !== 'play') return
    positionSentSinceTickEnd = false
    writeTickEnd(client)
  }
  bot.on('physicsTick', onPhysicsTick)

  const origWrite = client.write
  const patchedWrite = function (name, packet) {
    if (POSITION_PACKETS.has(name) && positionSentSinceTickEnd) {
      // 同一服务器 tick 内的第二个位置包：先补 tick_end 关闭这个 tick
      writeTickEnd(client)
    }
    const result = origWrite.call(this, name, packet)
    if (POSITION_PACKETS.has(name)) {
      positionSentSinceTickEnd = true
    }
    return result
  }
  patchedWrite._tickEndOriginal = origWrite
  client.write = patchedWrite

  const uninstall = () => {
    if (uninstalled) return
    uninstalled = true
    bot.removeListener?.('physicsTick', onPhysicsTick)
    if (client.write === patchedWrite) client.write = origWrite
    client._tickEndUninstall = null
  }
  client._tickEndUninstall = uninstall
  client.once?.('end', uninstall)
  client.once?.('close', uninstall)
  return uninstall
}

module.exports = { installClientTickEndPatch, MOVEMENT_PACKETS, POSITION_PACKETS }

// Minecraft 26.3 起，原版服务器在每个客户端 tick 内只接受一个带位置的移动包，
// 只有收到 serverbound `tick_end` 包才会重置该标记（vanilla 客户端从 1.21.2 起
// 每个物理 tick 末尾都会发送）。mineflayer 从不发送 tick_end（上游 issue #4189、
// PR #4128 尚未合入），于是 bot 的第二个移动包必然触发
// multiplayer.disconnect.invalid_player_movement 踢出。
// 这里包装 client.write，在每个移动类包后补发一个 tick_end（该包在 1.21.2+ 的
// 协议数据里已定义为空容器），与 vanilla 客户端行为一致；协议不支持时（1.21.2
// 之前）发送会抛错，静默跳过即可。

const MOVEMENT_PACKETS = new Set(['position', 'position_look', 'look', 'flying'])

function installClientTickEndPatch (bot) {
  const client = bot?._client
  if (!client || typeof client.write !== 'function') return () => {}
  const origWrite = client.write
  if (origWrite._tickEndOriginal) return () => {}

  const patchedWrite = function (name, packet) {
    const result = origWrite.call(this, name, packet)
    if (MOVEMENT_PACKETS.has(name)) {
      try {
        origWrite.call(this, 'tick_end', {})
      } catch {
        // 1.21.2 之前的协议没有该包，服务器也不需要它
      }
    }
    return result
  }
  patchedWrite._tickEndOriginal = origWrite
  client.write = patchedWrite

  const uninstall = () => {
    if (client.write !== patchedWrite) return
    client.write = origWrite
  }
  client.once?.('end', uninstall)
  client.once?.('close', uninstall)
  return uninstall
}

module.exports = { installClientTickEndPatch, MOVEMENT_PACKETS }

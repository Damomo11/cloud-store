// 26.3 sync_entity_position（entity_position_sync）的运行时修复。
//
// 26.3 线格式（见 protocol-patch.js 注释）：entityId + PositionPath(type dispatch) + yRot/xRot/onGround，
// 没有 26.1 的速度字段（dx/dy/dz），STEPPED 路径也没有前导 x/y/z。mineflayer entities.js 的
// 处理器无条件读 packet.dx/dy/dz 和 packet.x/y/z：
//   - LINEAR：x/y/z 有值，但 velocity.set(undefined…) → NaN
//   - STEPPED：x/y/z 也 undefined → 实体坐标被污染成 NaN，寻路/交互会跟着炸
//
// 本模块在 mineflayer 的处理器之后注册（createBot 返回后挂载，监听顺序靠后），对每个
// sync_entity_position 包做一次修复：position 取 LINEAR 的 x/y/z 或 STEPPED 的最后一步，
// velocity 清零。老版本包（无 path 字段）直接跳过，无副作用。

'use strict'

function installRepairSync (bot) {
  if (!bot || !bot._client) return
  bot._client.on('sync_entity_position', (packet) => {
    if (!packet || !packet.path) return // 非 26.3 格式（回退 1.21.11 等）
    const entity = bot.entities && bot.entities[packet.entityId]
    if (!entity) return
    let x = packet.path.x
    let y = packet.path.y
    let z = packet.path.z
    if (x === undefined) {
      const steps = packet.path.steps
      if (!steps || !steps.length) return
      const last = steps[steps.length - 1]
      x = last.x
      y = last.y
      z = last.z
    }
    if ([x, y, z].some(v => v === undefined || Number.isNaN(v))) return
    entity.position.set(x, y, z)
    entity.velocity.set(0, 0, 0)
    entity.yaw = packet.yaw !== undefined ? packet.yaw : entity.yaw
    entity.pitch = packet.pitch !== undefined ? packet.pitch : entity.pitch
  })
}

module.exports = { installRepairSync }

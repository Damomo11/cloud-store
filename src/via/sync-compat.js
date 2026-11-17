// 26.3 服务器进出的运行时兼容层（协议结构见 protocol-patch.js 注释）。
//
// 1. sync_entity_position 读侧修复：
//    26.3 线格式 = entityId + PositionPath(type dispatch) + yRot/xRot/onGround，没有 26.1 的
//    速度字段（dx/dy/dz），STEPPED 路径也没有前导 x/y/z。mineflayer entities.js 无条件读
//    packet.dx/dy/dz 和 packet.x/y/z → 实体坐标/速度被污染成 NaN。本模块在 mineflayer 的
//    处理器之后注册（createBot 返回后挂载，监听顺序靠后），用 LINEAR 坐标或 STEPPED 最后一步
//    修复 position，velocity 清零。老版本包（无 path 字段）直接跳过。
//
// 1b. rel_entity_move / entity_move_look 读侧扁平化（prependListener，先于 mineflayer 执行）：
//    26.3 把 delta 收进 properties 之后的 VecDelta（解析成嵌套 packet.delta.{tickOffset?,dX,dY,dZ}），
//    mineflayer entities.js 按 26.1 顶层 packet.dX/dY/dZ 读（entities.js:303/322）→
//    translate(undefined/4096) = NaN → 每个走动实体的第一个 move 包就把坐标污染成 NaN
//    （sync_entity_position 只在 >8 格位移/定期才来，救不回来 → "玩家=NaN,NaN,NaN"，
//    lookAt(NaN) 后 bot 朝向 NaN → invalid_player_movement 踢出，2026-11-18 部署实测）。
//    用 prependListener 把 delta 拷回顶层，老版本包（已是顶层）原样放行。
//
// 2. 写侧适配（nmp 的 'packet' 事件先于具体包事件发出，所以这里能在 mineflayer 写之前缓存数据）：
//    - accept_teleportation：26.3 = [teleportId, x, y, z, yRot, xRot]，mineflayer physics.js
//      只写 {teleportId} → 服务器拿到 NaN 坐标 → invalid_player_movement 踢出（2026-11 部署实测）。
//      包装 write，从缓存的最近一次 teleport 补齐坐标。
//    - block_dig：线结构同 26.1，但 26.3 在 action 1 插入了 CHANGE_DESTROY_DIRECTION，
//      1.21.11 的 abort(1)/stop(2)/drop(3,4)/release(5) 整体 +1（Via EntityPacketRewriter26_3 同款映射）。
//    - arm_animation：26.3 删除该包（换成无 payload 的 punch + swing_animation 体系），
//      mineflayer swing/dig 时写它 → nmp 直接抛 unknown packet。映射为 punch。

'use strict'

function installRepairSync (bot) {
  if (!bot || !bot._client) return

  // ---- 读侧：sync_entity_position 实体修复 ----
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
    // yaw/pitch 不动：26.3 解析结果里 yaw/pitch 是 f32 且 mineflayer 的处理器已先跑过
    // （fromNotchianYaw 转弧度），这里再覆盖会把弧度错写成原始度数。
  })

  // ---- 读侧：rel_entity_move / entity_move_look delta 扁平化（先于 mineflayer 执行）----
  const flattenMoveDelta = (packet) => {
    if (!packet || packet.dX !== undefined) return // 老 26.1 格式已是顶层
    const d = packet.delta || {}
    packet.dX = d.dX ?? 0
    packet.dY = d.dY ?? 0
    packet.dZ = d.dZ ?? 0
  }
  bot._client.prependListener('rel_entity_move', flattenMoveDelta)
  bot._client.prependListener('entity_move_look', flattenMoveDelta)

  // ---- 写侧：teleport_confirm 补坐标 / block_dig status 移位 / arm_animation → punch ----
  let lastTeleport = null
  bot._client.on('packet', (data, meta) => {
    if (meta?.name === 'position') {
      // 26.3 的 clientbound teleport 结构与 26.1 相同（PositionMoveRotation），坐标可用
      lastTeleport = { x: data.x, y: data.y, z: data.z, yaw: data.yaw, pitch: data.pitch }
    }
  })

  const origWrite = bot._client.write.bind(bot._client)
  bot._client.write = function (name, params) {
    if (name === 'teleport_confirm') {
      if (lastTeleport) {
        params = {
          ...params,
          x: lastTeleport.x,
          y: lastTeleport.y,
          z: lastTeleport.z,
          yRot: lastTeleport.yaw,
          xRot: lastTeleport.pitch
        }
      }
    } else if (name === 'block_dig' && params && typeof params.status === 'number' && params.status >= 1) {
      // 1.21.11 status: 0=start,1=abort,2=stop,3=drop_all,4=drop,5=release
      // 26.3 在 1 处插入 CHANGE_DESTROY_DIRECTION → ≥1 的全部 +1
      params = { ...params, status: params.status + 1 }
    } else if (name === 'arm_animation') {
      name = 'punch'
      params = {}
    }
    return origWrite(name, params)
  }
}

module.exports = { installRepairSync }

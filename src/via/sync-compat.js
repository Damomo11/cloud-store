// 26.3 服务器进出的运行时兼容层（协议结构见 protocol-patch.js 注释）。
//
// 1. sync_entity_position 读侧扁平化（prependListener，先于 mineflayer 执行）：
//    26.3 线格式 = entityId + PositionPath(type dispatch) + yRot/xRot/onGround，没有 26.1 的
//    速度字段（dx/dy/dz），STEPPED 路径也没有前导 x/y/z。mineflayer entities.js 无条件读
//    packet.dx/dy/dz 和 packet.x/y/z → 实体坐标/速度被污染成 NaN。
//    必须"改包"而不是"修账"：mineflayer 的插件注入是延迟的（等 'inject_allowed'），
//    installRepairSync 在 createBot 之后立刻挂载反而先于 mineflayer 的处理器执行，
//    修账型修复随后就会被 mineflayer 的 position.set(packet.x=undefined) 覆盖回 NaN
//    （2026-11-18 部署实测：9112b09 带 move 扁平化但玩家实体坐标仍 NaN）。改包型与顺序无关。
//
// 1b. rel_entity_move / entity_move_look 读侧扁平化（prependListener，先于 mineflayer 执行）：
//    26.3 的 properties 是打包位段（onGround(bit0) | stepCount<<1，ClientboundMoveEntityPacket
//    packProperties），VecDelta：stepCount=0 → {dX,dY,dZ}；>0 → {steps:[{tickOffset,dX,dY,dZ}×N]}
//    （2026-11-18 实测 tsl 服发 properties=4 双步包，按 0-3 模式枚举解析会余 7 字节/步报
//    partial packet、整包丢弃）。mineflayer entities.js 按 26.1 顶层 packet.dX/dY/dZ 读
//    （entities.js:303/322）→ translate(undefined/4096) = NaN → 走动实体坐标被污染（2026-11-18
//    部署实测 → "玩家=NaN,NaN,NaN" → lookAt(NaN) → invalid_player_movement 踢出）。
//    用 prependListener 把 delta 拷回顶层：LINEAR 直拷，STEPPED 取各步之和（mineflayer
//    每包应用一次位移），onGround 从分支名后缀恢复；老版本包（已是顶层）原样放行。
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

  // ---- 读侧：sync_entity_position 扁平化（prependListener，先于 mineflayer 执行）----
  // 关键：mineflayer 的插件注入是延迟的（plugin_loader.js 等 'inject_allowed' 才 injectPlugins），
  // createBot() 返回时插件还没装——installRepairSync 紧跟 createBot 调用，我们的监听器反而排在
  // mineflayer 前面。旧修复是"修账型"（挂在后面把 entity.position 修回来），实际却先跑，
  // 随后被 mineflayer 的处理器 position.set(packet.x=undefined) 重新污染成 NaN（2026-11-18 实锤：
  // 9112b09 已带 move 扁平化但 tpa 后玩家实体坐标仍 NaN）。
  // 现改成与 move 相同的"改包型"：把 26.3 的 PositionPath 坐标拷回 26.1 顶层 x/y/z、速度清零，
  // 让 mineflayer 自己的处理器算出正确值——注册顺序无关。
  const flattenSyncPath = (packet) => {
    if (!packet || !packet.path) return // 非 26.3 格式（回退 1.21.11 等）
    let x = packet.path.x
    let y = packet.path.y
    let z = packet.path.z
    if (x === undefined) {
      const steps = packet.path.steps
      if (!steps || !steps.length) {
        // 病理形态（空步列表）：保持实体当前位置，防止 mineflayer 写 NaN
        const entity = bot.entities && bot.entities[packet.entityId]
        if (entity?.position) {
          packet.x = entity.position.x
          packet.y = entity.position.y
          packet.z = entity.position.z
        }
        packet.dx = 0; packet.dy = 0; packet.dz = 0
        return
      }
      const last = steps[steps.length - 1]
      x = last.x
      y = last.y
      z = last.z
    }
    if ([x, y, z].some(v => v === undefined || Number.isNaN(v))) return
    packet.x = x
    packet.y = y
    packet.z = z
    packet.dx = 0
    packet.dy = 0
    packet.dz = 0
    // yaw/pitch 保持解析原值（f32 度数）：mineflayer 的处理器自己 fromNotchianYaw 转弧度
  }
  bot._client.prependListener('sync_entity_position', flattenSyncPath)

  // ---- 读侧：rel_entity_move / entity_move_look delta 扁平化（先于 mineflayer 执行）----
  // 26.3 的 properties 是打包位段（onGround(bit0) | stepCount<<1），经 protocol-patch 的
  // mapper 解析后这里是 'steps<N>[g]' 分支名；delta 在 stepCount=0 时是
  // {dX,dY,dZ}（LINEAR），>0 时是 {steps:[{tickOffset,dX,dY,dZ}×N]}（STEPPED）。
  // mineflayer 每包只应用一次位移，多步路径取各步之和作为总位移。
  const flattenMoveDelta = (packet) => {
    if (!packet || packet.dX !== undefined) return // 老 26.1 格式已是顶层
    const d = packet.delta || {}
    if (Array.isArray(d.steps) && d.steps.length) {
      packet.dX = d.steps.reduce((sum, step) => sum + (step?.dX || 0), 0)
      packet.dY = d.steps.reduce((sum, step) => sum + (step?.dY || 0), 0)
      packet.dZ = d.steps.reduce((sum, step) => sum + (step?.dZ || 0), 0)
    } else {
      packet.dX = d.dX ?? 0
      packet.dY = d.dY ?? 0
      packet.dZ = d.dZ ?? 0
    }
    if (typeof packet.properties === 'string') packet.onGround = packet.properties.endsWith('g')
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

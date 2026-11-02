'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// interaction-reach.js — 方块交互距离的**单一真源**
//
// 背景：这套常量原先在 inventory-executor / crafting-executor / collect-executor 里各写了
// 一份，注释也各自复述同一段真服对照实验。三份独立数字 = 迟早漂移，而漂移的表现是
// 「bot 站在服务端根本不受理的位置上重试到超时」这种极难归因的失败。
//
// 几何口径（必须与服务端一致）：服务端量的是**眼睛**到方块**碰撞盒最近点**的距离，
// 上限是 block_interaction_range，**不是**脚下到方块中心。
// 真服对照实验（桶 overworld:5857:129:28182 的两个候选站位）：
//   - (5860,130,28178) 按本口径 4.60 格
//   - (5860,130,28182) 按本口径 2.98 格
// 旧口径（脚→中心 ≤6）把前者判成够得到，于是每次访问容器都要在一个服务端不受理的站位上
// 重试满 10 秒。
//
// SERVER_BLOCK_INTERACTION_RANGE：**原版默认 4.5，真服实测吻合**。
//
// 历史：曾被改成 7（04f8a56「按本服实测支持 7 格」），随后被 95a6fe7 回滚为 4.5。
// 两轮真服实测数据都指向原版 4.5，而非 7：
//   - cyc105：开箱成功 ×15 全部 ≤2.8 格，唯一失败 6.45 → open_timeout。
//   - 本次（bot1，2026-08-02）：开箱成功 ×49 全部 ≤4.3 格，唯一失败 5.91 → open_timeout。
// 若服务端上限真是 7，5.91/6.45 就应成功——但两者都失败，说明服务端根本不受理
// 4.5~7 之间的交互包。服务器所有者声称「最远交互 7 格」与实测不符（可能指实体交互
// 或攻击距离，而非方块交互）。
//
// 因此 CONTAINER_REACH_DISTANCE 必须保守取 4.5−0.2=4.3：
//   - 若取 6.8，bot 会站在 5.91 格就直接开箱（"已在交互距离内,直接开箱"），服务端
//     静默丢弃交互包 → open_timeout，正是本次 poppy 取料 0/16 的真因。
//   - 保守值让 bot 多走两步（OBFS 站位候选会走到 4.3 以内），但服务端必定受理。
// 收紧的代价只是多走两步；放宽的代价是「站在服务端不受理的位置上重试到超时」。
// ─────────────────────────────────────────────────────────────────────────────

// 服务端 block_interaction_range（眼睛→碰撞盒最近点）。原版默认 4.5，真服实测吻合。
const SERVER_BLOCK_INTERACTION_RANGE = Number(
  process.env.SERVER_BLOCK_INTERACTION_RANGE || 4.5,
)

// 站位抖动与服务端位置同步误差的余量。比服务端上限更宽只会让 bot 在不受理的位置上空转。
const REACH_SAFETY_MARGIN = Number(process.env.CONTAINER_REACH_SAFETY_MARGIN || 0.2)

// 判定「已经够得到、可以直接交互」的上限（眼睛→碰撞盒最近点口径）。
const CONTAINER_REACH_DISTANCE = Number(
  process.env.CONTAINER_REACH_DISTANCE ||
    Math.max(1, SERVER_BLOCK_INTERACTION_RANGE - REACH_SAFETY_MARGIN),
)

// bot 眼高（脚→眼）。
const EYE_HEIGHT = 1.62

// 判定「要不要再走近点」的阈值，口径是**脚→方块中心**的三维距离（调用方现有写法）。
// 必须比 CONTAINER_REACH_DISTANCE 明显保守：同一个脚→中心距离下，眼睛→最近点最坏情况会
// 更大（眼比脚高 1.62，而最近点最多只比中心近 0.5·√3≈0.87）。取
//   reach − EYE_HEIGHT + 0.87
// 的下取整，保证「脚→中心 ≤ 阈值」时眼→最近点必定仍在 reach 内，不会出现
// 「判成够近 → 交互被服务端静默拒绝 → 重试到超时」。
const CONTAINER_APPROACH_DISTANCE = Number(
  process.env.CONTAINER_APPROACH_DISTANCE ||
    Math.max(2, Math.floor((CONTAINER_REACH_DISTANCE - EYE_HEIGHT + 0.87) * 10) / 10),
)

// 容器方块中心点（用于 lookAt 与交互距离判定）。
function containerCenter (blockPos) {
  if (!blockPos) return null
  return { x: blockPos.x + 0.5, y: blockPos.y + 0.5, z: blockPos.z + 0.5 }
}

// 眼睛 → 方块碰撞盒最近点的距离（与服务端同口径）。botPos 是**脚**坐标。
function reachDistanceToBlock (botPos, center) {
  if (!botPos || !center) return Number.POSITIVE_INFINITY
  const ex = botPos.x
  const ey = botPos.y + EYE_HEIGHT
  const ez = botPos.z
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  const nx = clamp(ex, center.x - 0.5, center.x + 0.5)
  const ny = clamp(ey, center.y - 0.5, center.y + 0.5)
  const nz = clamp(ez, center.z - 0.5, center.z + 0.5)
  return Math.hypot(ex - nx, ey - ny, ez - nz)
}

function canReachContainer (botPos, center, maxDist = CONTAINER_REACH_DISTANCE) {
  if (!botPos || !center) return false
  return reachDistanceToBlock(botPos, center) <= maxDist
}

module.exports = {
  SERVER_BLOCK_INTERACTION_RANGE,
  REACH_SAFETY_MARGIN,
  CONTAINER_REACH_DISTANCE,
  CONTAINER_APPROACH_DISTANCE,
  EYE_HEIGHT,
  containerCenter,
  reachDistanceToBlock,
  canReachContainer,
}

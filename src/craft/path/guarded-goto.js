'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// guarded-goto.js — 共享「带看门狗的局部寻路」
//
// 背景（为什么存在）：
//   各执行器（collect / combat / interact / crafting / inventory）过去各自手写
//   `pathfinder.goto + Promise.race(setTimeout(固定毫秒))`：超时就直接失败，没有
//   卡死脱困、没有净距离进展判定。而 station-executor 的 executeMoveTo（标准快速三维
//   移动的地面段）有一整套成熟看门狗（4s 无进展触发 unstick 救援、最多 4 次、45s 硬
//   停判失败）。固定毫秒超时是错的：距离是欧氏距离，但 A* 的代价是地形复杂度——复杂
//   建筑内 30 格可能比旷野 300 格更难算，用固定毫秒赌"近的就该秒到"必然误杀。
//
// 本模块把 executeMoveTo 地面段的「寻路可靠性核心」抽出来共享：
//   - 同样的 no-progress 看门狗（同一 next 未推进 + 位置未推进，见 createStallTracker）
//   - 同样的 unstick 物理脱困（暂停 pathfinder 控制 → 朝 next 做有界脉冲 → 恢复）
//   - 同样的常量（4s 触发 / 最多 4 次 / 45s 硬停）
//   只在「真卡死 / 死亡 / 救援耗尽 / 调用方 deadline 到」时失败，绝无固定 nav 超时。
//
// 边界（本模块不做，交给调用方）：
//   - 不切装备（full_armor / elytra_armor）：那是"去陌生远方防摔死"的语义，且装备切换
//     会把主手工具/剑收回背包，会误伤正在挖矿/战斗的执行器。要不要穿甲由调用方决定。
//   - 不做鞘翅回退：局部收尾寻路（到容器/工作台/动物旁）本就是近距离，长途才用鞘翅，
//     长途由服务端 startTransitPlan 负责。
//   - 不写 testtome 诊断文件：那是 transit 的端到端分析，局部移动只需 console 日志。
//   - 不做 survival（吃东西回血）：局部收尾时间短。
//
// unstick / sleep 从 station-executor.js 原样迁移到此（单一实现），executeMoveTo 复用
// 同一份，避免两套脱困逻辑漂移。
// ─────────────────────────────────────────────────────────────────────────────

const {
  isRetryableClimbEntry,
  shouldEscalateRetryableClimbEntry
} = require('./climbables')

function sleep (ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function unstick (bot, tag, stuckEvent, signal, plannedNext = null) {
  if (!bot.entity) return

  // 阶段 0: 停所有 control state 让 bot 自然落地
  bot.setControlState('forward', false)
  bot.setControlState('back', false)
  bot.setControlState('sprint', false)
  bot.setControlState('jump', false)
  await sleep(500, signal)
  if (!bot.entity || !bot.entity.position) return
  const startPos = bot.entity.position.clone()
  console.log(`${tag} unstick 阶段0(落地): pos=(${startPos.x.toFixed(1)},${startPos.y.toFixed(1)},${startPos.z.toFixed(1)}) onGround=${bot.entity.onGround}`)
  if (stuckEvent) stuckEvent.recordPhase0({ pos: { x: startPos.x, y: startPos.y, z: startPos.z }, onGround: bot.entity.onGround })

  const directions = [
    { name: '北', dx: 0, dz: -1 },
    { name: '南', dx: 0, dz: 1 },
    { name: '东', dx: 1, dz: 0 },
    { name: '西', dx: -1, dz: 0 },
  ]
  let bestDir = null
  let bestScore = -Infinity
  let bestKind = null  // 'walk' / 'jumpUp'
  const probeDetail = []
  for (const d of directions) {
    let score = 0
    let kind = null
    let landingDrop = null
    let probeBlocks = {}
    try {
      const blockAt0 = bot.blockAt(startPos.offset(d.dx, 0, d.dz))         // 0 高度
      const blockAt1 = bot.blockAt(startPos.offset(d.dx, 1, d.dz))         // 1 高度
      const blockAt2 = bot.blockAt(startPos.offset(d.dx, 2, d.dz))         // 2 高度(头顶)
      const at0Empty = blockAt0?.boundingBox === 'empty'
      const at1Empty = blockAt1?.boundingBox === 'empty'
      const at2Empty = blockAt2?.boundingBox === 'empty'
      probeBlocks = {
        h0: blockAt0?.name ?? null,
        h1: blockAt1?.name ?? null,
        h2: blockAt2?.name ?? null,
      }

      if (at0Empty && at1Empty) {
        // 只有旁侧 3 格内存在落脚面才算可走。旧逻辑只看身体/头部为空，树顶
        // 脱困时会把无底悬崖也当成最佳方向。
        for (let depth = 1; depth <= 4; depth++) {
          const support = bot.blockAt(startPos.offset(d.dx, -depth, d.dz))
          probeBlocks[`support${depth}`] = support?.name ?? null
          if (support && support.boundingBox !== 'empty' && support.name !== 'water' && support.name !== 'lava') {
            landingDrop = depth - 1
            break
          }
        }
        if (landingDrop != null) {
          score += 4
          kind = 'walk'
        }
      } else if (!at0Empty && at1Empty && at2Empty) {
        // 0 高度是方块(高 1 格),1 + 2 高度是空气 → 可以跳上去
        score += 3
        kind = 'jumpUp'
      }

      // 看 2 格远再加分(走出去更彻底)
      const blockAt0Far = bot.blockAt(startPos.offset(d.dx * 2, 0, d.dz * 2))
      const blockAt1Far = bot.blockAt(startPos.offset(d.dx * 2, 1, d.dz * 2))
      probeBlocks.h0Far = blockAt0Far?.name ?? null
      probeBlocks.h1Far = blockAt1Far?.name ?? null
      if (blockAt0Far?.boundingBox === 'empty' && blockAt1Far?.boundingBox === 'empty') {
        score += 1
      }
    } catch (e) { /* ignore */ }
    probeDetail.push({ name: d.name, score, kind, landingDrop, blocks: probeBlocks })
    if (score > bestScore) {
      bestScore = score
      bestDir = { ...d, landingDrop }
      bestKind = kind
    }
  }
  console.log(`${tag} unstick 阶段1(探测): 最优方向=${bestDir?.name} 方式=${bestKind ?? '?'} 落差=${bestDir?.landingDrop ?? '?'} score=${bestScore}`)

  // 探测周围实体(可能挡路的看不见的方块/盔甲架/玩家)
  const nearbyEntities = []
  try {
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e === bot.entity) continue
      const dx = e.position.x - startPos.x
      const dz = e.position.z - startPos.z
      const dy = e.position.y - startPos.y
      const dist = Math.hypot(dx, dy, dz)
      if (dist <= 3) {
        nearbyEntities.push({
          type: e.type ?? null,
          name: e.name ?? e.username ?? null,
          dist: Number(dist.toFixed(2)),
          dx: Number(dx.toFixed(2)),
          dy: Number(dy.toFixed(2)),
          dz: Number(dz.toFixed(2)),
        })
      }
    }
    if (nearbyEntities.length > 0) {
      console.log(`${tag} unstick 3 米内实体: ${nearbyEntities.map(e => `${e.type}(${e.name})@${e.dist}m`).join(', ')}`)
    } else {
      console.log(`${tag} unstick 3 米内无实体`)
    }
  } catch (e) { /* ignore */ }
  if (stuckEvent) stuckEvent.recordPhase1({ probeDetail, bestDir: bestDir?.name ?? null, bestKind, bestScore, nearbyEntities })

  // 阶段 2:优先朝 pathfinder 当前 next 做有界短脉冲。旧逻辑总选一个任意
  // cardinal 方向并跑 1.5 秒，实测会把距节点不足一格的 bot 推离 4-7 格，
  // 将一个局部执行问题放大成全图绕路。只有没有有效 next 时才回退探测方向。
  const directionPlan = unstickDirectionPlan({ startPos, plannedNext, bestDir, bestKind })
  const hasPlannedNext = directionPlan.hasPlannedNext
  const usePlannedNext = directionPlan.usePlannedNext
  const targetDx = directionPlan.targetDx
  const targetDz = directionPlan.targetDz
  const rescueMode = directionPlan.rescueMode
  let targetYaw = null
  if (Math.hypot(targetDx, targetDz) > 0.05) {
    targetYaw = Math.atan2(-targetDx, -targetDz)
    try {
      await bot.look(targetYaw, 0, true)
    } catch (e) { /* ignore */ }
  }

  const startsInWater = bot.entity.isInWater === true
  const targetBelow = usePlannedNext && plannedNext.y < startPos.y - 0.25
  const pulse = unstickPulsePlan({
    startsInWater,
    targetBelow,
    hasPlannedNext: usePlannedNext,
    onGround: bot.entity.onGround === true,
    plannedNext: usePlannedNext ? plannedNext : null,
    bestKind,
  })
  const jumpPulse = pulse.jump
  const sneakPulse = pulse.sneak
  bot.setControlState('forward', true)
  bot.setControlState('sprint', false)
  bot.setControlState('jump', jumpPulse)
  bot.setControlState('sneak', sneakPulse)

  const microTrace = []
  const traceStart = Date.now()
  const traceTimer = setInterval(() => {
    if (!bot.entity || !bot.entity.position) return
    const v = bot.entity.velocity
    const cs = (bot.controlState || {})
    microTrace.push({
      at: Date.now() - traceStart,
      pos: { x: Number(bot.entity.position.x.toFixed(3)), y: Number(bot.entity.position.y.toFixed(3)), z: Number(bot.entity.position.z.toFixed(3)) },
      vel: v ? { x: Number(v.x.toFixed(4)), y: Number(v.y.toFixed(4)), z: Number(v.z.toFixed(4)) } : null,
      yaw: Number((bot.entity.yaw ?? 0).toFixed(3)),
      onGround: bot.entity.onGround,
      cs: { f: !!cs.forward, b: !!cs.back, s: !!cs.sprint, j: !!cs.jump, sn: !!cs.sneak },
    })
    if (microTrace.length >= 15) clearInterval(traceTimer)
  }, 100)

  try {
    const deadline = Date.now() + 700
    while (Date.now() < deadline) {
      await sleep(50, signal)
      const pos = bot.entity?.position
      if (!pos) break
      const movedXZ = Math.hypot(pos.x - startPos.x, pos.z - startPos.z)
      const nextXZ = usePlannedNext ? Math.hypot(plannedNext.x - pos.x, plannedNext.z - pos.z) : Infinity
      if (movedXZ >= 1.25 || nextXZ <= 0.3) break
    }
  } finally {
    clearInterval(traceTimer)
    bot.clearControlStates()
  }

  const cur = bot.entity?.position
  if (cur) {
    const moved = Math.hypot(cur.x - startPos.x, cur.z - startPos.z)
    console.log(`${tag} unstick 完成 位置 (${cur.x.toFixed(1)},${cur.y.toFixed(1)},${cur.z.toFixed(1)}) onGround=${bot.entity.onGround} 实际位移=${moved.toFixed(2)} 方块`)
    if (stuckEvent) stuckEvent.recordPhase23({
      rescueMode,
      plannedNext: hasPlannedNext ? {
        x: plannedNext.x,
        y: plannedNext.y,
        z: plannedNext.z,
        reachKind: plannedNext.reachKind ?? null,
        requiresJump: plannedNext.requiresJump === true,
      } : null,
      jumpPulse,
      sneakPulse,
      targetYaw,
      finalPos: { x: cur.x, y: cur.y, z: cur.z },
      onGround: bot.entity.onGround,
      moved: Number(moved.toFixed(3)),
      microTrace,
    })
  }
}

// ── 看门狗常量（与 station-executor.executeMoveTo 地面段一致）──────────────────
// 局部移动与标准三维移动地面段用同一套看门狗参数，行为一致。
const UNSTICK_TRIGGER_MS = Number(process.env.GUARDED_GOTO_UNSTICK_MS || 4000)     // 同一 next 连续无进展多久触发 unstick
const BUILDING_STALL_GRACE_MS = 8000
const MAX_UNSTICK = Number(process.env.GUARDED_GOTO_MAX_UNSTICK || 4)             // 最多脱困次数
const LOCAL_STALL_HARD_LIMIT_MS = Number(process.env.GUARDED_GOTO_HARD_STALL_MS || 45000) // 脱困耗尽后硬停判失败
const PROGRESS_TICK_MS = 1000
// 锚点位移超过这么多格才算「真的走出去了」。以 4s 触发窗口计，走路 4.3 格/秒、
// 爬梯 2.35 格/秒、潜行 1.3 格/秒都能在窗口内轻松超过，正常移动不会误判。
const STALL_PROGRESS_EPSILON = Number(process.env.GUARDED_GOTO_PROGRESS_EPSILON || 2.5)
// 「人原地没动过」的墙钟兜底，不受 A* 计算期豁免影响，见 createStallTracker。
const NO_POSITION_PROGRESS_MS = Number(process.env.GUARDED_GOTO_NO_PROGRESS_MS || 180000)
const REPEATED_NEXT_AVOID_AFTER_FAILURES = 3
const CLIMB_ENTRY_AVOID_TTL_MS = 90000
const DEFAULT_REPEATED_NEXT_AVOID_TTL_MS = 120000

function repeatedNextAvoidancePolicy (node, failureCount) {
  const retryableClimbEntry = isRetryableClimbEntry(node)
  const avoid = retryableClimbEntry
    ? shouldEscalateRetryableClimbEntry(node, failureCount)
    : Number.isFinite(failureCount) && failureCount >= REPEATED_NEXT_AVOID_AFTER_FAILURES
  return {
    avoid,
    preserve: retryableClimbEntry && !avoid,
    retryableClimbEntry,
    ttlMs: retryableClimbEntry ? CLIMB_ENTRY_AVOID_TTL_MS : DEFAULT_REPEATED_NEXT_AVOID_TTL_MS,
  }
}

function snapshotPathfinderDebug (bot) {
  try {
    const dbg = bot.pathfinder?.getDebugState ? bot.pathfinder.getDebugState() : null
    if (!dbg || typeof dbg !== 'object') return null
    return dbg
  } catch (e) {
    return null
  }
}

// pfSnapshot 有活跃路径且 bot 正在移动时返回 next 节点的整数坐标键；否则 null（A* 计算期或已停）。
function activeNextKey (bot, pfSnapshot) {
  const pathLen = pfSnapshot?.status?.pathLen
  const next = pfSnapshot?.next
  if (!(typeof pathLen === 'number' && pathLen > 0)) return null
  if (!next || !Number.isFinite(next.x) || !Number.isFinite(next.y) || !Number.isFinite(next.z)) return null
  if (typeof bot.pathfinder?.isMoving === 'function' && !bot.pathfinder.isMoving()) return null
  return `${Math.floor(next.x)},${Math.floor(next.y)},${Math.floor(next.z)}`
}

// 普通 pathfinder 控制已经对同一节点连续数秒无位移时，救援不能重复同一套
// forward-only 输入。真服 oak_log 下坡节点取证：目标低一格、控制状态持续
// forward+sprint，但 bot 在方块边缘和蕨类中 30 秒只移动 0.02 格。地面救援改用
// 一次短促 jump-forward，越过碰撞边缘后仍由 A* 接管；水中保持上浮/下潜语义。
function unstickPulsePlan ({ startsInWater, targetBelow, hasPlannedNext, onGround, plannedNext, bestKind }) {
  if (startsInWater) return { jump: !targetBelow, sneak: targetBelow }
  const stalledGroundEdge = hasPlannedNext && onGround
  return {
    jump: stalledGroundEdge || plannedNext?.requiresJump === true || bestKind === 'jumpUp',
    sneak: false,
  }
}

// A* can legally emit a multi-block fall as the next node. On top of a tree the
// direct edge may be physically unexecutable even though the destination column
// is valid, so repeated jump-forward pulses never leave the branch. When the
// probe found a nearby landing surface within the safe 3-block range, step onto
// that surface first and let A* replan from there.
function unstickDirectionPlan ({ startPos, plannedNext, bestDir, bestKind }) {
  const hasPlannedNext = Number.isFinite(plannedNext?.x) && Number.isFinite(plannedNext?.y) && Number.isFinite(plannedNext?.z)
  const plannedDrop = hasPlannedNext && Number.isFinite(startPos?.y) ? startPos.y - plannedNext.y : 0
  const safeProbe = bestKind === 'walk' &&
    Number.isFinite(bestDir?.dx) && Number.isFinite(bestDir?.dz) &&
    Number.isFinite(bestDir?.landingDrop) && bestDir.landingDrop >= 0 && bestDir.landingDrop <= 3
  const useProbeForSteepDrop = hasPlannedNext && plannedDrop > 1.5 && safeProbe
  const usePlannedNext = hasPlannedNext && !useProbeForSteepDrop
  // Aim at the centre of the adjacent probe column. A cardinal unit vector is
  // not sufficient when the player is already near a block edge: its 0.6-wide
  // hitbox can keep clipping the neighbouring leaf even though the probed
  // column itself is empty. The centred vector moves away from that collision
  // before walking off the safe edge.
  const probeTargetDx = Number.isFinite(startPos?.x) && Number.isFinite(bestDir?.dx)
    ? Math.floor(startPos.x) + 0.5 + bestDir.dx - startPos.x
    : (bestDir?.dx ?? 0)
  const probeTargetDz = Number.isFinite(startPos?.z) && Number.isFinite(bestDir?.dz)
    ? Math.floor(startPos.z) + 0.5 + bestDir.dz - startPos.z
    : (bestDir?.dz ?? 0)
  return {
    hasPlannedNext,
    usePlannedNext,
    targetDx: usePlannedNext ? plannedNext.x - startPos.x : probeTargetDx,
    targetDz: usePlannedNext ? plannedNext.z - startPos.z : probeTargetDz,
    rescueMode: useProbeForSteepDrop
      ? 'steep_drop_probe_pulse'
      : (hasPlannedNext ? 'planned_next_pulse' : 'probe_fallback_pulse'),
  }
}

function isPathfinderMining (bot, pfSnapshot) {
  if (pfSnapshot?.status?.digging === true || pfSnapshot?.digging === true) return true
  try {
    return typeof bot.pathfinder?.isMining === 'function' && bot.pathfinder.isMining() === true
  } catch (_) {
    return false
  }
}

function isPathfinderBuilding (bot, pfSnapshot) {
  if (pfSnapshot?.status?.placing === true || pfSnapshot?.placing === true) return true
  try {
    return typeof bot.pathfinder?.isBuilding === 'function' && bot.pathfinder.isBuilding() === true
  } catch (_) {
    return false
  }
}

/**
 * 停滞跟踪器：同时维护「同一 next 未推进」和「位置未推进」两个判据。
 *
 * 为什么必须有位置判据：崖壁/藤蔓地形上 A* 会在两个相邻节点之间来回震荡，next 每秒
 * 都在换，只按 nextKey 计时的看门狗每 tick 都被清零 —— 对这类死循环结构性失明，
 * unstick 与硬停判失败都永远不可达。锚点位移超过 epsilon 才算真进展，next 怎么换
 * 都不影响计时。
 *
 * activeMs 与 wallMs 的分工：activeMs 只在「有活跃路径且在移动」时累计（沿用原判据，
 * A* 计算期不算停滞），驱动 unstick 与 45s 硬停；wallMs 每次观测都累计，是「人原地
 * 没动过」的最终兜底 —— 「挖一格→路径作废→重算」这种循环里可执行片段极短，activeMs
 * 攒得比墙钟慢一个量级，只有 wallMs 能收敛。
 */
function createStallTracker (progressEpsilon = STALL_PROGRESS_EPSILON) {
  let anchor = null
  let watchedNextKey = null
  let nextKeyMs = 0
  let positionMs = 0
  let wallMs = 0

  return {
    observe (pos, nextKey, elapsedMs) {
      if (!anchor || Math.hypot(pos.x - anchor.x, pos.y - anchor.y, pos.z - anchor.z) > progressEpsilon) {
        anchor = { x: pos.x, y: pos.y, z: pos.z }
        positionMs = 0
        wallMs = 0
      } else {
        wallMs += elapsedMs
      }
      if (nextKey) {
        if (nextKey !== watchedNextKey) {
          watchedNextKey = nextKey
          nextKeyMs = 0
        } else {
          nextKeyMs += elapsedMs
        }
        positionMs += elapsedMs
      }
      return {
        executing: !!nextKey,
        activeStallMs: Math.max(nextKeyMs, positionMs),
        wallStallMs: wallMs,
      }
    },
    rescued () {
      nextKeyMs = 0
      positionMs = 0
    },
  }
}

/**
 * 带看门狗的局部寻路：跑 bot.pathfinder.goto(goal)，配同一套 no-progress 脱困救援。
 *
 * 只在以下情况 reject（绝无固定 nav 超时）：
 *   - 硬停：连续无进展达 LOCAL_STALL_HARD_LIMIT_MS 且脱困已用尽 → reason='guarded_stall'
 *   - 位置兜底：bot 实际坐标在 NO_POSITION_PROGRESS_MS 内没走出 epsilon → reason='guarded_no_progress'
 *   - goto 自身 reject（noPath / PathStopped 等）且已用尽救援 → 原因透传
 *   - bot 死亡 → reason='guarded_bot_died'
 *   - 调用方 deadline 到（可选）→ reason='guarded_deadline'
 *   - 调用方 signal abort → 抛 AbortError
 * goto 成功（goal_reached）→ resolve()。
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} goal mineflayer-pathfinder goal 实例
 * @param {object} [opts]
 * @param {string} [opts.tag] 日志前缀
 * @param {AbortSignal} [opts.signal] 外部取消信号
 * @param {number} [opts.deadline] 绝对毫秒时间戳，超过即失败（默认无——只靠看门狗）
 * @param {number} [opts.maxUnstick]
 * @param {number} [opts.hardStallMs]
 * @param {number} [opts.unstickTriggerMs]
 * @param {number} [opts.noProgressMs]
 * @param {number} [opts.progressEpsilon]
 * @returns {Promise<void>} 成功 resolve；失败 reject 带 .reason
 */
async function guardedGoto (bot, goal, opts = {}) {
  const navigationStartedAt = Date.now()
  let previousTelemetryPhase = null
  const tag = opts.tag || '[guarded-goto]'
  const signal = opts.signal || null
  const deadline = typeof opts.deadline === 'number' ? opts.deadline : null
  const maxUnstick = Number.isFinite(opts.maxUnstick) ? opts.maxUnstick : MAX_UNSTICK
  const hardStallMs = Number.isFinite(opts.hardStallMs) ? opts.hardStallMs : LOCAL_STALL_HARD_LIMIT_MS
  const unstickTriggerMs = Number.isFinite(opts.unstickTriggerMs) ? opts.unstickTriggerMs : UNSTICK_TRIGGER_MS
  const noProgressMs = Number.isFinite(opts.noProgressMs) ? opts.noProgressMs : NO_POSITION_PROGRESS_MS
  const progressEpsilon = Number.isFinite(opts.progressEpsilon) ? opts.progressEpsilon : STALL_PROGRESS_EPSILON
  const pathPolicy = {
    allowPartialPath: opts.allowPartialPath !== false,
    partialMinPathLength: Math.max(5, Math.floor(Number(opts.partialMinPathLength) || 5)),
    partialMinVisitedNodes: Math.max(1, Math.floor(Number(opts.partialMinVisitedNodes) || 2_000)),
  }

  if (opts.ensureArmor !== false && typeof bot._ensurePreparationArmor === 'function') {
    await bot._ensurePreparationArmor()
  }
  try {
    previousTelemetryPhase = bot._preparationTelemetry?.currentPhase() || null
    bot._preparationTelemetry?.phase('navigation')
  } catch (_) {}

  return new Promise((resolve, reject) => {
    const pf = bot.pathfinder
    if (!pf) {
      try { bot._preparationTelemetry?.phase(previousTelemetryPhase || 'command_work') } catch (_) {}
      return reject(makeErr('pathfinder_not_ready'))
    }
    const releaseAdaptiveSpeed = opts.adaptiveSpeed === false || typeof bot._acquireAdaptivePathSpeed !== 'function'
      ? null
      : bot._acquireAdaptivePathSpeed()

    let resolved = false
    let unstickAttempts = 0
    let isRescuing = false
    const stallTracker = createStallTracker(progressEpsilon)
    let lastWatchdogTickAt = Date.now()
    let buildingSinceAt = null
    let lastRescueNextKey = null
    let consecutiveSameNextRescues = 0
    let progressTimer = null
    let metricsRecorded = false
    const pathMetrics = { computeMs: 0, visitedNodes: 0, nodesLen: 0, partialExecuted: false }

    function onPathUpdate (update) {
      if (!update || typeof update !== 'object') return
      pathMetrics.computeMs += Math.max(0, Number(update.time) || 0)
      pathMetrics.visitedNodes = Math.max(pathMetrics.visitedNodes, Math.max(0, Number(update.visitedNodes) || 0))
      pathMetrics.nodesLen = Math.max(pathMetrics.nodesLen, Array.isArray(update.path) ? update.path.length : 0)
    }

    function onPathDebug (debug) {
      if (!debug || typeof debug !== 'object') return
      if ((debug.reason === 'path_assigned_initial' || debug.reason === 'path_assigned_continue') &&
          debug.resultStatus === 'partial') pathMetrics.partialExecuted = true
    }

    try {
      bot.on?.('path_update', onPathUpdate)
      bot.on?.('path_debug', onPathDebug)
    } catch (_) { /* metrics remain optional */ }

    function recordMetrics (result, reason = null) {
      if (metricsRecorded) return
      metricsRecorded = true
      try {
        const debug = snapshotPathfinderDebug(bot) || {}
        const rawGoal = goal && typeof goal === 'object' ? goal : {}
        const goalSnapshot = Number.isFinite(Number(rawGoal.x)) && Number.isFinite(Number(rawGoal.z))
          ? {
              x: Number(rawGoal.x),
              y: Number.isFinite(Number(rawGoal.y)) ? Number(rawGoal.y) : null,
              z: Number(rawGoal.z),
            }
          : null
        bot._preparationTelemetry?.recordNav({
          goal: goalSnapshot,
          result,
          reason,
          computeMs: pathMetrics.computeMs,
          visitedNodes: pathMetrics.visitedNodes,
          nodesLen: Math.max(pathMetrics.nodesLen, Math.max(0, Number(debug.status?.pathLen || debug.pathLen) || 0)),
          partialExecuted: pathMetrics.partialExecuted,
          totalMs: Date.now() - navigationStartedAt,
        })
      } catch (_) { /* telemetry never changes navigation */ }
      try { bot._preparationTelemetry?.phase(previousTelemetryPhase || 'command_work') } catch (_) {}
    }

    function makeErr (reason) {
      const e = new Error(reason)
      e.reason = reason
      e.isGuardedGotoError = true
      return e
    }

    function cleanup () {
      clearInterval(progressTimer)
      try { releaseAdaptiveSpeed?.() } catch (_) { /* ignore */ }
      try { bot.removeListener('death', onDeath) } catch (_) { /* ignore */ }
      try { bot.removeListener('path_update', onPathUpdate) } catch (_) { /* ignore */ }
      try { bot.removeListener('path_debug', onPathDebug) } catch (_) { /* ignore */ }
      if (signal) { try { signal.removeEventListener('abort', onAbort) } catch (_) { /* ignore */ } }
    }

    function cancelPath (reason) {
      try {
        if (typeof pf.cancelNow === 'function') pf.cancelNow(reason)
        else { pf.stop(); pf.setGoal(null) }
      } catch (_) { /* ignore */ }
    }

    function finishOk () {
      if (resolved) return
      resolved = true
      cleanup()
      recordMetrics('ok')
      resolve()
    }

    function finishFail (reason) {
      if (resolved) return
      resolved = true
      cleanup()
      cancelPath(`guarded_fail:${reason}`)
      bot.setControlState('forward', false)
      bot.setControlState('back', false)
      bot.setControlState('sprint', false)
      bot.setControlState('jump', false)
      const result = /(?:No path|no_path)/i.test(reason)
        ? 'noPath'
        : /(?:timeout|deadline|Took to long)/i.test(reason) ? 'timeout' : 'error'
      recordMetrics(result, reason)
      reject(makeErr(reason))
    }

    const onDeath = () => finishFail('guarded_bot_died')
    bot.once('death', onDeath)

    const onAbort = () => {
      if (resolved) return
      resolved = true
      cleanup()
      cancelPath('guarded_abort')
      recordMetrics('error', 'aborted')
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    // Local preparation paths start walking once the fork has a meaningful,
    // guarded best-so-far segment. This removes the visible standstill while
    // preserving complete-path behavior for tiny/low-confidence searches.
    const startGoto = () => pf.goto(goal)
    const gotoPromise = typeof bot._withPathfinderPolicy === 'function'
      ? bot._withPathfinderPolicy(pathPolicy, startGoto)
      : startGoto()
    gotoPromise.then(() => {
      finishOk()
    }).catch((err) => {
      if (resolved) return
      // 救援期间 pauseControls 会让 goto 抛 PathStopped，此时不算失败（救援结束会重规划）。
      if (isRescuing && err && err.name === 'PathStopped') return
      finishFail(`goto_reject:${err?.message || err}`)
    })

    progressTimer = setInterval(async () => {
      if (resolved) return
      const now = Date.now()
      const activeElapsedMs = Math.max(0, now - lastWatchdogTickAt)
      lastWatchdogTickAt = now

      if (deadline != null && now > deadline) { finishFail('guarded_deadline'); return }
      if (isRescuing) return
      const cur = bot.entity?.position
      if (!cur) return

      const pfSnapshot = snapshotPathfinderDebug(bot)
      // 挖掘/搭建期间不算停滞：pathfinder 在破坏方块或原地跳搭时静止是正常动作，
      // 4s 看门狗若照常触发会 cancel 掉接近完成的挖掘，或在 placeBlock 的 5s
      // 服务端确认窗口结束前拆掉路径。两类操作都由 fork 自己的 promise 完成/失败来
      // 收敛；这里只豁免 active 停滞，180s 墙钟兜底仍会处理真正卡死。
      const miningNow = isPathfinderMining(bot, pfSnapshot)
      const buildingNow = isPathfinderBuilding(bot, pfSnapshot)
      if (miningNow) {
        stallTracker.rescued()
        lastWatchdogTickAt = Date.now()
        return
      }
      if (!buildingNow) buildingSinceAt = null
      if (buildingNow && buildingSinceAt == null) buildingSinceAt = Date.now()
      if (buildingNow && Date.now() - buildingSinceAt < BUILDING_STALL_GRACE_MS) {
        stallTracker.rescued()
        lastWatchdogTickAt = Date.now()
        return
      }
      const nextKey = activeNextKey(bot, pfSnapshot)
      const stall = stallTracker.observe(cur, nextKey, activeElapsedMs)

      if (stall.wallStallMs >= noProgressMs) { finishFail('guarded_no_progress'); return }
      if (!stall.executing) return

      if (stall.activeStallMs >= hardStallMs && unstickAttempts >= maxUnstick) {
        finishFail('guarded_stall')
        return
      }
      if (stall.activeStallMs < unstickTriggerMs || unstickAttempts >= maxUnstick) return

      unstickAttempts += 1
      isRescuing = true
      const stalledActiveMs = stall.activeStallMs
      stallTracker.rescued()
      if (nextKey === lastRescueNextKey) consecutiveSameNextRescues += 1
      else consecutiveSameNextRescues = 1
      lastRescueNextKey = nextKey
      const sameNextRescueCount = consecutiveSameNextRescues
      console.warn(`${tag} guardedGoto: next=${nextKey} 连续未推进 ${(stalledActiveMs / 1000).toFixed(1)}s, rescue #${unstickAttempts}/${maxUnstick} sameNext=${sameNextRescueCount}/3`)

      // 前两次保留可能唯一的攀爬入口；同一 next 第三次实证失败后也必须
      // 短时避让，否则相邻采集目标会无限复用同一条不可执行边。
      if (pfSnapshot?.next && typeof bot._avoidPathNode === 'function') {
        const policy = repeatedNextAvoidancePolicy(pfSnapshot.next, sameNextRescueCount)
        if (policy.preserve) {
          console.warn(`${tag} guardedGoto: 攀爬入口暂保留 next=${nextKey} failure=${sameNextRescueCount}/${REPEATED_NEXT_AVOID_AFTER_FAILURES}`)
        } else if (policy.avoid) {
          const reason = policy.retryableClimbEntry
            ? `guarded_climb_entry_failed_${sameNextRescueCount}:${nextKey}`
            : `guarded_same_next_${sameNextRescueCount}:${nextKey}`
          const avoided = bot._avoidPathNode(pfSnapshot.next, reason, policy.ttlMs) === true
          if (avoided) {
            if (policy.retryableClimbEntry) {
              console.warn(`${tag} guardedGoto: 攀爬入口重复失败,临时避让 next=${nextKey} ttl=${Math.round(policy.ttlMs / 1000)}s`)
            }
            consecutiveSameNextRescues = 0
          }
        }
      }

      let pauseToken = null
      try {
        pauseToken = bot.pathfinder.pauseControls(`guarded_rescue_${unstickAttempts}`)
        await sleep(200, signal)
        await unstick(bot, tag, null, signal, pfSnapshot?.next)
        if (resolved) return
        const resumed = bot.pathfinder.resumeControls(pauseToken, `guarded_rescue_${unstickAttempts}_complete`)
        pauseToken = null
        if (!resumed) throw new Error('pathfinder_resume_rejected')
        lastWatchdogTickAt = Date.now()
      } catch (err) {
        if (pauseToken && !resolved) {
          try { bot.pathfinder.resumeControls(pauseToken, 'guarded_rescue_error') } catch (_) { /* ignore */ }
        }
        if (resolved) return
        if (err?.name === 'AbortError' || (signal && signal.aborted)) { onAbort(); return }
        finishFail(`guarded_rescue_error:${err?.message || err}`)
      } finally {
        try { bot.clearControlStates() } catch (_) { /* ignore */ }
        isRescuing = false
      }
    }, PROGRESS_TICK_MS)
  })
}

module.exports = { sleep, unstick, guardedGoto, repeatedNextAvoidancePolicy }
module.exports._test = {
  activeNextKey,
  isPathfinderMining,
  isPathfinderBuilding,
  createStallTracker,
  repeatedNextAvoidancePolicy,
  unstickPulsePlan,
  unstickDirectionPlan,
  UNSTICK_TRIGGER_MS,
  BUILDING_STALL_GRACE_MS,
  MAX_UNSTICK,
  LOCAL_STALL_HARD_LIMIT_MS,
  STALL_PROGRESS_EPSILON,
  NO_POSITION_PROGRESS_MS,
  REPEATED_NEXT_AVOID_AFTER_FAILURES,
  CLIMB_ENTRY_AVOID_TTL_MS,
  DEFAULT_REPEATED_NEXT_AVOID_TTL_MS,
}

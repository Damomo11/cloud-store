const { performance } = require('perf_hooks')

const AStar = require('./lib/astar')
const Move = require('./lib/move')
const Movements = require('./lib/movements')
const gotoUtil = require('./lib/goto')
const PATH_DIG_TRACE = process.env.BOT_PATH_DIG_TRACE === '1'
const Lock = require('./lib/lock')
const { selectMoveControls, isPlannedSnowStepHop, advancePlannedSnowStepPulse } = require('./lib/move-control')
const { cloneMoveForExecution, isNodeReached, shouldForceJump } = require('./lib/path-node')
const { createPartialSegmentGuard } = require('./lib/partial-segment-guard')

const Vec3 = require('vec3').Vec3

// Grace period before a persistently unexecutable edge forces a replan. Long enough to ride
// out transient airborne/entity-push states, far below the 12s generic no-progress budget.
const BLOCKED_NO_MOTION_REPLAN_MS = Math.max(
  200,
  Number(process.env.PATH_BLOCKED_NO_MOTION_REPLAN_MS || 1500)
)
const SURFACE_NO_PROGRESS_REPLAN_MS = Math.max(
  200,
  Number(process.env.PATH_SURFACE_NO_PROGRESS_REPLAN_MS || 1500)
)

const Physics = require('./lib/physics')
const nbt = require('prismarine-nbt')
const interactableBlocks = require('./lib/interactable.json')

const olelaCapabilities = Object.freeze({
  forkVersion: '2.4.5-olela.18-r5-lossless',
  apiVersion: 1,
  features: Object.freeze({
    partialSegment: 1,
    strictGotoTerminalStatus: 1,
    pathDebug: 1,
    pathChunkInvalidation: 1,
    manualPauseResume: 1,
    immediateCancel: 1,
    detachedExecutionPath: 1,
    typedNodeArrival: 1,
    blockActions: 1,
    dynamicClimbables: 1
  })
})

function pathBreakAllowed (movements, block) {
  const guard = movements?._olelaPathBreakGuard
  if (typeof guard !== 'function') return true
  try {
    return guard(block) === true
  } catch (_) {
    return false
  }
}

function pathGridPoint (node) {
  if (!node) return null
  return {
    x: Math.floor(node.x),
    y: Number.isFinite(node.gridY) ? node.gridY : Math.floor(node.y),
    z: Math.floor(node.z)
  }
}

function selectBestHarvestTool (block, availableTools, effects, isSafe = () => true) {
  let fastest = block.digTime(null, false, false, false, [], effects)
  let bestTool = null
  for (const tool of (availableTools || [])) {
    let safe = false
    try { safe = isSafe(tool) === true } catch (_) { safe = false }
    if (!safe) continue
    const enchants = tool?.nbt ? nbt.simplify(tool.nbt).Enchantments : []
    const digTime = block.digTime(tool?.type ?? null, false, false, false, enchants, effects)
    if (digTime < fastest) {
      fastest = digTime
      bestTool = tool
    }
  }
  return bestTool
}

function isStairBlock (block) {
  return typeof block?.name === 'string' && block.name.endsWith('_stairs')
}

function inject (bot) {
  const waterType = bot.registry.blocksByName.water.id
  let stateMovements = new Movements(bot)
  let stateGoal = null
  let astarContext = null
  let astartTimedout = false
  let dynamicGoal = false
  let path = []
  let pathUpdated = false
  let partialSegmentActive = false
  let digging = false
  let diggingTarget = null
  let placing = false
  let placingBlock = null
  let placingTarget = null
  let interacting = false
  let interactingAction = null
  let controlledDrop = null
  let lastNodeTime = performance.now()
  let lastMoveDebugAt = 0
  let lastMoveDebugPathLen = -1
  let lastMoveDebugMode = null
  // performance.now() is small right after startup, so a 0 baseline would swallow the first report.
  let lastDigUnloadedWarnAt = -Infinity
  let lastMonitorErrorAt = -Infinity
  let blockedNoMotionKey = null
  let blockedNoMotionSince = 0
  let plannedSnowStepPulse = null
  let returningPos = null
  let controlPause = null
  let controlPauseId = 0
  let operationGeneration = 0
  const partialSegmentGuard = createPartialSegmentGuard()
  const physics = new Physics(bot)
  const lockPlaceBlock = new Lock()
  const lockEquipItem = new Lock()
  const lockUseBlock = new Lock()

  bot.pathfinder = {}
  bot.pathfinder.olelaCapabilities = olelaCapabilities

  bot.pathfinder.thinkTimeout = 5000 // ms
  bot.pathfinder.tickTimeout = 40 // ms, amount of thinking per tick (max 50 ms)
  bot.pathfinder.searchRadius = -1 // in blocks, limits of the search area, -1: don't limit the search
  bot.pathfinder.enablePathShortcut = false // disabled by default as it can cause bugs in specific configurations
  bot.pathfinder.LOSWhenPlacingBlocks = true
  bot.pathfinder.allowPartialPath = false // Olela patch: when true, execute best-so-far partial segments while A* keeps searching.
  bot.pathfinder.partialMinPathLength = 5 // Baritone-style: ignore tiny best-so-far segments that do not make meaningful progress.
  bot.pathfinder.partialMinVisitedNodes = 2000 // Avoid executing the first local 40ms best-so-far line before A* has seen enough of the area.
  bot.pathfinder.surfaceNoProgressReplanMs = SURFACE_NO_PROGRESS_REPLAN_MS

  bot.pathfinder.bestHarvestTool = (block) => {
    const availableTools = bot.inventory.items()
    const effects = bot.entity.effects
    const isSafe = typeof bot.pathfinder.isHarvestToolSafe === 'function'
      ? bot.pathfinder.isHarvestToolSafe
      : () => true
    return selectBestHarvestTool(block, availableTools, effects, isSafe)
  }

  bot.pathfinder.getPathTo = (movements, goal, timeout) => {
    const generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout })
    const { value: { result, astarContext: context } } = generator.next()
    astarContext = context
    return result
  }

  bot.pathfinder.getPathFromTo = function * (movements, startPos, goal, options = {}) {
    const optimizePath = options.optimizePath ?? true
    const resetEntityIntersects = options.resetEntityIntersects ?? true
    const timeout = options.timeout ?? bot.pathfinder.thinkTimeout
    const tickTimeout = options.tickTimeout ?? bot.pathfinder.tickTimeout
    const searchRadius = options.searchRadius ?? bot.pathfinder.searchRadius
    let start
    if (options.startMove) {
      start = options.startMove
    } else {
      const p = startPos.floored()
      const dy = startPos.y - p.y
      const b = bot.blockAt(p) // The block we are standing in
      // Offset the floored bot position by one if we are standing on a block that has not the full height but is solid
      const offset = (b && dy > 0.001 && bot.entity.onGround && !stateMovements.emptyBlocks.has(b.type)) ? 1 : 0
      start = new Move(p.x, p.y + offset, p.z, movements.countScaffoldingItems(), 0)
    }
    if (movements.allowEntityDetection) {
      if (resetEntityIntersects) {
        movements.clearCollisionIndex()
      }
      movements.updateCollisionIndex()
    }
    const astarContext = new AStar(start, movements, goal, timeout, tickTimeout, searchRadius)
    let result = astarContext.compute()
    if (optimizePath) result.path = postProcessPath(result.path)
    yield { result, astarContext }
    while (result.status === 'partial') {
      result = astarContext.compute()
      if (optimizePath) result.path = postProcessPath(result.path)
      yield { result, astarContext }
    }
  }

  function canUseBestSoFarSegment (results) {
    return Boolean(
      bot.pathfinder.allowPartialPath &&
      results &&
      (results.status === 'partial' || results.status === 'timeout') &&
      Array.isArray(results.path) &&
      results.path.length >= bot.pathfinder.partialMinPathLength &&
      (results.visitedNodes ?? 0) >= bot.pathfinder.partialMinVisitedNodes
    )
  }

  function acceptBestSoFarSegment (results) {
    if (!results || typeof results !== 'object') return false
    results.partialSegmentGuard = partialSegmentGuard.snapshot()
    if (!canUseBestSoFarSegment(results)) return false

    const decision = partialSegmentGuard.consider({
      start: bot.entity?.position,
      path: results.path,
      goal: stateGoal
    })
    results.partialSegmentGuard = decision
    if (!decision.accepted) return false

    results.status = 'partialSegment'
    // Treat the best-so-far path as one executable segment. Once the bot walks
    // it, the next planning pass must start from the bot's real current
    // position instead of continuing the old A* tree rooted at the old start.
    astarContext = null
    astartTimedout = false
    partialSegmentActive = true
    return true
  }

  Object.defineProperties(bot.pathfinder, {
    goal: {
      get () {
        return stateGoal
      }
    },
    movements: {
      get () {
        return stateMovements
      }
    }
  })

  function shortNode (node) {
    if (!node || typeof node !== 'object') return node
    const out = {
      x: Number(node.x?.toFixed ? node.x.toFixed(3) : node.x),
      y: Number(node.y?.toFixed ? node.y.toFixed(3) : node.y),
      z: Number(node.z?.toFixed ? node.z.toFixed(3) : node.z)
    }
    if (typeof node.cost === 'number') out.cost = Number(node.cost.toFixed(3))
    if (Array.isArray(node.toBreak) && node.toBreak.length > 0) out.toBreak = node.toBreak.length
    if (Array.isArray(node.toPlace) && node.toPlace.length > 0) out.toPlace = node.toPlace.length
    if (node.parkour) out.parkour = true
    if (node.requiresJump) out.requiresJump = true
    if (node.requiresLanding) out.requiresLanding = true
    if (typeof node.controlledDropDistance === 'number') out.controlledDropDistance = node.controlledDropDistance
    if (typeof node.surfaceY === 'number') out.surfaceY = Number(node.surfaceY.toFixed(3))
    if (typeof node.plannedSurfaceY === 'number') out.plannedSurfaceY = Number(node.plannedSurfaceY.toFixed(3))
    if (node.snowSurface) out.snowSurface = true
    if (typeof node.gridY === 'number') out.gridY = node.gridY
    if (typeof node.reachKind === 'string') out.reachKind = node.reachKind
    if (typeof node.waterDirection === 'number') out.waterDirection = node.waterDirection
    if (typeof node.climbDirection === 'number') out.climbDirection = node.climbDirection
    if (typeof node.climbBlockName === 'string') out.climbBlockName = node.climbBlockName
    if (typeof node.climbTransition === 'string') out.climbTransition = node.climbTransition
    if (node.trapdoorPassage === true) out.trapdoorPassage = true
    if (Array.isArray(node.blockActions) && node.blockActions.length > 0) out.blockActions = node.blockActions.length
    return out
  }

  function shortVec (vec) {
    if (!vec) return null
    return {
      x: Number(vec.x?.toFixed ? vec.x.toFixed(3) : vec.x),
      y: Number(vec.y?.toFixed ? vec.y.toFixed(3) : vec.y),
      z: Number(vec.z?.toFixed ? vec.z.toFixed(3) : vec.z)
    }
  }

  function blockNameAt (vec) {
    return blockDetailAt(vec)?.name ?? null
  }

  function blockDetailAt (vec) {
    try {
      if (!vec) return null
      const b = bot.blockAt(new Vec3(Math.floor(vec.x), Math.floor(vec.y), Math.floor(vec.z)))
      if (!b) return null
      let properties = null
      try { properties = b.getProperties?.() ?? null } catch (_) { /* ignore */ }
      return {
        name: b.name ?? null,
        type: b.type ?? null,
        stateId: b.stateId ?? null,
        boundingBox: b.boundingBox ?? null,
        properties,
        shapes: Array.isArray(b.shapes) ? b.shapes : []
      }
    } catch (e) {
      return null
    }
  }

  function pathDebugSnapshot (reason, extra = {}) {
    const pos = bot.entity?.position
    const vel = bot.entity?.velocity
    const cs = bot.controlState || {}
    const next = path[0] || null
    const next2 = path[1] || null
    const dx = next && pos ? next.x - pos.x : null
    const dy = next && pos ? next.y - pos.y : null
    const dz = next && pos ? next.z - pos.z : null
    return {
      reason,
      status: {
        pathLen: path.length,
        pathUpdated,
        astartTimedout,
        partialSegmentActive,
        digging,
        placing,
        interacting,
        returningPos: shortVec(returningPos),
        lastNodeAgeMs: Number((performance.now() - lastNodeTime).toFixed(1)),
        stopPathing: false,
        controlPaused: controlPause !== null,
        controlPauseId: controlPause?.token.id ?? null
      },
      pos: shortVec(pos),
      vel: shortVec(vel),
      onGround: !!bot.entity?.onGround,
      isInWater: !!bot.entity?.isInWater,
      yaw: Number((bot.entity?.yaw ?? 0).toFixed(3)),
      pitch: Number((bot.entity?.pitch ?? 0).toFixed(3)),
      controlState: { forward: !!cs.forward, back: !!cs.back, left: !!cs.left, right: !!cs.right, sprint: !!cs.sprint, jump: !!cs.jump, sneak: !!cs.sneak },
      next: shortNode(next),
      next2: shortNode(next2),
      nextDelta: next && pos ? { dx: Number(dx.toFixed(3)), dy: Number(dy.toFixed(3)), dz: Number(dz.toFixed(3)), xz: Number(Math.hypot(dx, dz).toFixed(3)) } : null,
      nextBlocks: next ? {
        foot: blockNameAt({ x: next.x, y: next.y - 1, z: next.z }),
        body: blockNameAt(next),
        head: blockNameAt({ x: next.x, y: next.y + 1, z: next.z })
      } : null,
      nextBlockDetails: next ? {
        foot: blockDetailAt({ x: next.x, y: next.y - 1, z: next.z }),
        body: blockDetailAt(next),
        head: blockDetailAt({ x: next.x, y: next.y + 1, z: next.z })
      } : null,
      pathHead: path.slice(0, 8).map(shortNode),
      ...extra
    }
  }

  function emitPathDebug (reason, extra = {}) {
    bot.emit('path_debug', pathDebugSnapshot(reason, extra))
  }

  bot.pathfinder.getDebugState = () => pathDebugSnapshot('manual')
  bot.pathfinder.getPartialSegmentGuardState = () => partialSegmentGuard.snapshot()

  function cancelActiveOperations () {
    operationGeneration += 1
    const wasDigging = digging
    digging = false
    diggingTarget = null
    placing = false
    placingBlock = null
    placingTarget = null
    interacting = false
    interactingAction = null
    controlledDrop = null

    if (typeof bot._cancelControlledPathDrop === 'function') {
      try { bot._cancelControlledPathDrop() } catch (_) { /* ignore */ }
    }

    if (typeof bot._cancelPathBlockAction === 'function') {
      try { bot._cancelPathBlockAction() } catch (_) { /* ignore */ }
    }

    if (wasDigging && typeof bot.stopDigging === 'function') {
      try { bot.stopDigging() } catch (_) { /* ignore */ }
    }

    lockEquipItem.release()
    lockPlaceBlock.release()
    lockUseBlock.release()
    stateMovements.clearCollisionIndex()
  }

  function isOperationCurrent (generation) {
    return generation === operationGeneration
  }

  function resetPath (reason, clearStates = true) {
    if (path.length > 0) emitPathDebug('before_reset', { resetReason: reason, clearStates })
    if (path.length > 0) bot.emit('path_reset', reason)
    if (partialSegmentActive) partialSegmentGuard.noteReset(reason)
    path = []
    partialSegmentActive = false
    cancelActiveOperations()
    pathUpdated = false
    astarContext = null
    astartTimedout = false
    if (clearStates) bot.clearControlStates()
  }

  bot.pathfinder.setGoal = (goal, dynamic = false) => {
    partialSegmentGuard.reset()
    if (controlPause) {
      const paused = controlPause
      controlPause = null
      bot.emit('path_resume', {
        tokenId: paused.token.id,
        reason: 'goal_updated',
        resumed: false,
        staleGoal: true
      })
    }
    stateGoal = goal
    dynamicGoal = dynamic
    bot.emit('goal_updated', goal, dynamic)
    resetPath('goal_updated')
  }

  bot.pathfinder.setMovements = (movements) => {
    stateMovements = movements
    partialSegmentGuard.reset()
    resetPath('movements_updated')
  }

  bot.pathfinder.isMoving = () => path.length > 0
  bot.pathfinder.isMining = () => digging
  bot.pathfinder.isBuilding = () => placing
  bot.pathfinder.isInteracting = () => interacting
  bot.pathfinder.isControlPaused = () => controlPause !== null

  bot.pathfinder.pauseControls = (reason = 'manual') => {
    if (controlPause) throw new Error(`pathfinder controls already paused by token ${controlPause.token.id}`)
    if (!stateGoal) throw new Error('cannot pause pathfinder controls without an active goal')

    const token = Object.freeze({ id: ++controlPauseId })
    controlPause = { token, goal: stateGoal, reason }
    resetPath('control_paused')
    returningPos = null
    placingBlock = null
    lastNodeTime = performance.now()
    fullStop()
    bot.emit('path_pause', { tokenId: token.id, reason })
    emitPathDebug('control_paused', { tokenId: token.id, pauseReason: reason })
    return token
  }

  bot.pathfinder.resumeControls = (token, reason = 'manual') => {
    if (!controlPause || token !== controlPause.token) return false
    const paused = controlPause
    controlPause = null
    bot.clearControlStates()
    if (stateGoal !== paused.goal) {
      bot.emit('path_resume', { tokenId: token.id, reason, resumed: false, staleGoal: true })
      return false
    }

    resetPath('control_resumed')
    lastNodeTime = performance.now()
    bot.emit('path_resume', { tokenId: token.id, reason, resumed: true, staleGoal: false })
    emitPathDebug('control_resumed', { tokenId: token.id, resumeReason: reason })
    return true
  }

  bot.pathfinder.cancelNow = (reason = 'manual_cancel') => {
    const hadGoal = stateGoal !== null
    cancelActiveOperations()
    controlPause = null
    stateGoal = null
    dynamicGoal = false
    path = []
    astarContext = null
    astartTimedout = false
    pathUpdated = false
    partialSegmentActive = false
    returningPos = null
    bot.clearControlStates()
    if (bot.entity?.velocity) {
      bot.entity.velocity.x = 0
      bot.entity.velocity.z = 0
    }
    if (hadGoal) bot.emit('path_stop', reason)
  }

  bot.pathfinder.goto = (goal) => {
    return gotoUtil(bot, goal)
  }

  bot.pathfinder.stop = () => {
    bot.pathfinder.cancelNow('stop')
  }

  // monitorMovement runs on physicsTick, so any synchronous throw would travel up
  // EventEmitter.emit and kill the whole multi-bot process. Degrade to a replan instead.
  bot.on('physicsTick', () => {
    try {
      monitorMovement()
    } catch (err) {
      const now = performance.now()
      if (now - lastMonitorErrorAt > 5000) {
        lastMonitorErrorAt = now
        console.error(`[pathfinder] monitor error: ${err?.message || err}\n${err?.stack || ''}`)
      }
      try { resetPath('monitor_error') } catch (_) { /* ignore */ }
    }
  })

  function postProcessPath (path) {
    // reconstructPath returns A*'s own Move instances. Never center or consume
    // those objects while the same A* context may continue on the next tick.
    path = path.map(cloneMoveForExecution)
    for (let i = 0; i < path.length; i++) {
      const curPoint = path[i]
      // Olela patch: upstream `break`s here, leaving this node and every later one on A*'s raw
      // integer block coordinates. Upstream's loose controller tolerated that; this fork steers
      // with a precise physics simulator, and aiming at a block *corner* makes every candidate
      // move collide — selectMoveControls then returns blocked_no_motion and the bot stands
      // still until the watchdog gives up. Since canDig paths always contain a toBreak node,
      // that made mine_underground navigation fail before it ever dug anything (real-server:
      // 254 reachable targets, 0 mined). Center x/z here too and keep going. The dug block is
      // addressed via toBreak[], not via this position, so digging is unaffected; y stays on the
      // grid cell because the bot ends up standing where the block used to be.
      // 只居中 x/z，不碰 y、也不设 reachKind：方块还没被挖开，落脚面高度此刻无从得知
      // （脚下若是台阶/雪层，真实落脚面比网格低半格）。reachKind 一旦设成 'surface'，
      // isNodeReached 就要求 |dy| ≤ 0.05，非整格地面上的挖掘节点会永远判不到达；留空则
      // 走 |dy| ≤ 0.999 的兼容容差，与上游对挖掘节点的原有宽松语义一致。
      if (curPoint.toBreak.length > 0 || curPoint.toPlace.length > 0) {
        curPoint.gridY = Math.floor(curPoint.y)
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.z = Math.floor(curPoint.z) + 0.5
        continue
      }
      if (Number(curPoint.controlledDropDistance) > 3) {
        // The movement edge already stores the feet position above the chosen
        // support block. Do not let unloaded destination geometry shift it
        // down by one during execution post-processing.
        curPoint.gridY = Math.floor(curPoint.y)
        curPoint.reachKind = 'surface'
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.z = Math.floor(curPoint.z) + 0.5
        continue
      }
      const b = bot.blockAt(new Vec3(curPoint.x, curPoint.y, curPoint.z))
      curPoint.gridY = Math.floor(curPoint.y)
      if (typeof curPoint.plannedSurfaceY === 'number') {
        curPoint.reachKind = 'surface'
        curPoint.surfaceY = curPoint.plannedSurfaceY
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.y = curPoint.plannedSurfaceY
        curPoint.z = Math.floor(curPoint.z) + 0.5
        continue
      }
      if (b && b.type === waterType) {
        curPoint.reachKind = 'water'
        const previousGridY = i > 0
          ? (Number.isFinite(path[i - 1].gridY) ? path[i - 1].gridY : Math.floor(path[i - 1].y))
          : Math.floor(bot.entity.position.y + 1e-6)
        curPoint.waterDirection = Math.sign(curPoint.gridY - previousGridY)
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.y = curPoint.gridY
        curPoint.z = Math.floor(curPoint.z) + 0.5
        continue
      }
      if (curPoint.reachKind === 'climbable' || (b && stateMovements?.climbables?.has(b.type))) {
        curPoint.reachKind = 'climbable'
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.y = curPoint.gridY
        curPoint.z = Math.floor(curPoint.z) + 0.5
        continue
      }
      // Warehouse terrain adapters expose wooden doors and fence gates as
      // passable planning cells. Their collision shapes still describe the
      // closed panel, so getPositionOnTopOf() would otherwise move execution
      // to the top of the two-block door (y + 1). Keep the planner's feet
      // coordinate for a door passage; the door controller owns opening it.
      const passableDoor = typeof b?.name === 'string' &&
        ((b.name.endsWith('_door') && !b.name.startsWith('iron_')) || b.name.endsWith('_fence_gate'))
      if (passableDoor) {
        curPoint.reachKind = 'surface'
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.y = curPoint.gridY
        curPoint.z = Math.floor(curPoint.z) + 0.5
        continue
      }
      curPoint.reachKind = 'surface'
      let standingBlock = b
      let np = getPositionOnTopOf(standingBlock)
      if (np === null) {
        standingBlock = bot.blockAt(new Vec3(curPoint.x, curPoint.y - 1, curPoint.z))
        np = getPositionOnTopOf(standingBlock)
      }
      if (np) {
        curPoint.x = np.x
        curPoint.y = np.y
        curPoint.z = np.z
        if (standingBlock?.name === 'snow') {
          curPoint.snowSurface = true
          curPoint.surfaceY = np.y
        }
      } else {
        curPoint.x = Math.floor(curPoint.x) + 0.5
        curPoint.y = curPoint.y - 1
        curPoint.z = Math.floor(curPoint.z) + 0.5
      }
    }

    if (!bot.pathfinder.enablePathShortcut || stateMovements.exclusionAreasStep.length !== 0 || path.length === 0) return path

    const newPath = []
    let lastNode = bot.entity.position
    for (let i = 1; i < path.length; i++) {
      const node = path[i]
      if (Math.abs(node.y - lastNode.y) > 0.5 || node.toBreak.length > 0 || node.toPlace.length > 0 || !physics.canStraightLineBetween(lastNode, node)) {
        newPath.push(path[i - 1])
        lastNode = path[i - 1]
      }
    }
    newPath.push(path[path.length - 1])
    return newPath
  }

  function isExecutionHeadContinuous (node, position) {
    if (!node || !position || bot.pathfinder.enablePathShortcut) return true
    // Interaction nodes may intentionally target a farther block while the
    // executor first moves to its placement/dig return position.
    if (node.toBreak?.length > 0 || node.toPlace?.length > 0 || node.blockActions?.length > 0) return true
    // Technical edges intentionally retreat a fraction of a block before the
    // jump/landing. After the previous node is consumed that preparation can
    // temporarily span two floored columns without making the edge stale.
    const maxColumnDelta = (node.requiresJump === true || node.requiresLanding === true) ? 2 : 1
    return Math.abs(Math.floor(node.x) - Math.floor(position.x)) <= maxColumnDelta &&
      Math.abs(Math.floor(node.z) - Math.floor(position.z)) <= maxColumnDelta
  }

  function prepareExecutionPath (results, source) {
    if (!Array.isArray(results?.path)) return false
    const position = bot.entity?.position
    while (results.path.length > 0 && isNodeReached(results.path[0], position, bot.entity)) {
      results.path.shift()
    }
    if (results.path.length === 0 || isExecutionHeadContinuous(results.path[0], position)) return true

    emitPathDebug('path_head_discontinuous', {
      source,
      candidateHead: results.path.slice(0, 8).map(shortNode),
      candidateFirstDelta: {
        dx: Number((results.path[0].x - position.x).toFixed(3)),
        dy: Number((results.path[0].y - position.y).toFixed(3)),
        dz: Number((results.path[0].z - position.z).toFixed(3))
      }
    })
    return false
  }

  function abandonStalePlan () {
    path = []
    partialSegmentActive = false
    cancelActiveOperations()
    astarContext = null
    astartTimedout = false
    pathUpdated = false
    fullStop()
  }

  function isPositionNearPath (pos, path) {
    let prevNode = null
    for (const node of path) {
      let comparisonPoint = null
      if (
        prevNode === null ||
        (
          Math.abs(prevNode.x - node.x) <= 2 &&
          Math.abs(prevNode.y - node.y) <= 2 &&
          Math.abs(prevNode.z - node.z) <= 2
        )
      ) {
        // Unoptimized path, or close enough to last point
        // to just check against the current point
        comparisonPoint = node
      } else {
        // Optimized path - the points are far enough apart
        //   that we need to check the space between them too

        // First, a quick check - if point it outside the path
        // segment's AABB, then it isn't near.
        const minBound = prevNode.min(node)
        const maxBound = prevNode.max(node)
        if (
          pos.x - 0.5 < minBound.x - 1 ||
          pos.x - 0.5 > maxBound.x + 1 ||
          pos.y - 0.5 < minBound.y - 2 ||
          pos.y - 0.5 > maxBound.y + 2 ||
          pos.z - 0.5 < minBound.z - 1 ||
          pos.z - 0.5 > maxBound.z + 1
        ) {
          continue
        }

        comparisonPoint = closestPointOnLineSegment(pos, prevNode, node)
      }

      const dx = Math.abs(comparisonPoint.x - pos.x - 0.5)
      const dy = Math.abs(comparisonPoint.y - pos.y - 0.5)
      const dz = Math.abs(comparisonPoint.z - pos.z - 0.5)
      if (dx <= 1 && dy <= 2 && dz <= 1) return true

      prevNode = node
    }

    return false
  }

  function closestPointOnLineSegment (point, segmentStart, segmentEnd) {
    const segmentLength = segmentEnd.minus(segmentStart).norm()

    if (segmentLength === 0) {
      return segmentStart
    }

    // t is like an interpolation from segmentStart to segmentEnd
    //  for the closest point on the line
    let t = (point.minus(segmentStart)).dot(segmentEnd.minus(segmentStart)) / segmentLength

    // bound t to be on the segment
    t = Math.max(0, Math.min(1, t))

    return segmentStart.plus(segmentEnd.minus(segmentStart).scaled(t))
  }

  // Return the average x/z position of the highest standing positions
  // in the block.
  function getPositionOnTopOf (block) {
    if (!block || block.shapes.length === 0) return null
    const p = new Vec3(0.5, 0, 0.5)
    let n = 1
    for (const shape of block.shapes) {
      const h = shape[4]
      if (h === p.y) {
        p.x += (shape[0] + shape[3]) / 2
        p.z += (shape[2] + shape[5]) / 2
        n++
      } else if (h > p.y) {
        n = 2
        p.x = 0.5 + (shape[0] + shape[3]) / 2
        p.y = h
        p.z = 0.5 + (shape[2] + shape[5]) / 2
      }
    }
    p.x /= n
    p.z /= n
    return block.position.plus(p)
  }

  /** Stop movement without mutating the locally tracked server position. */
  function fullStop () {
    bot.clearControlStates()

    // Force horizontal velocity to 0 (otherwise inertia can move us too far)
    // Kind of cheaty, but the server will not tell the difference
    bot.entity.velocity.x = 0
    bot.entity.velocity.z = 0
  }

  function moveToEdge (refBlock, edge) {
    // If allowed turn instantly should maybe be a bot option
    const allowInstantTurn = false
    function getViewVector (pitch, yaw) {
      const csPitch = Math.cos(pitch)
      const snPitch = Math.sin(pitch)
      const csYaw = Math.cos(yaw)
      const snYaw = Math.sin(yaw)
      return new Vec3(-snYaw * csPitch, snPitch, -csYaw * csPitch)
    }
    // Target viewing direction while approaching edge
    // The Bot approaches the edge while looking in the opposite direction from where it needs to go
    // The target Pitch angle is roughly the angle the bot has to look down for when it is in the position
    // to place the next block
    const targetBlockPos = refBlock.offset(edge.x + 0.5, edge.y, edge.z + 0.5)
    const targetPosDelta = bot.entity.position.clone().subtract(targetBlockPos)
    const targetYaw = Math.atan2(-targetPosDelta.x, -targetPosDelta.z)
    const targetPitch = -1.421
    const viewVector = getViewVector(targetPitch, targetYaw)
    // While the bot is not in the right position rotate the view and press back while crouching
    if (bot.entity.position.distanceTo(refBlock.clone().offset(edge.x + 0.5, 1, edge.z + 0.5)) > 0.4) {
      bot.lookAt(bot.entity.position.offset(viewVector.x, viewVector.y, viewVector.z), allowInstantTurn)
      bot.setControlState('sneak', true)
      bot.setControlState('back', true)
      return false
    }
    bot.setControlState('back', false)
    return true
  }

  function moveToBlock (pos) {
    // minDistanceSq = Min distance sqrt to the target pos were the bot is centered enough to place blocks around him
    const minDistanceSq = 0.2 * 0.2
    const targetPos = pos.clone().offset(0.5, 0, 0.5)
    if (bot.entity.position.distanceSquared(targetPos) > minDistanceSq) {
      bot.lookAt(targetPos)
      bot.setControlState('forward', true)
      return false
    }
    bot.setControlState('forward', false)
    return true
  }

  function stop (reason = 'stopped') {
    bot.pathfinder.cancelNow(reason)
  }

  function isOwnDigTarget (pos) {
    return digging && diggingTarget !== null && pos != null &&
      diggingTarget.x === pos.x && diggingTarget.y === pos.y && diggingTarget.z === pos.z
  }

  function isOwnPlacementTarget (pos) {
    return placing && placingTarget !== null && pos != null &&
      placingTarget.x === pos.x && placingTarget.y === pos.y && placingTarget.z === pos.z
  }

  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!oldBlock || !newBlock) return
    // Olela patch: the block we are digging right now is not foreign terrain change.
    // prismarine-world emits the generic `blockUpdate` before `blockUpdate:${pos}`, so this
    // listener always runs before mineflayer resolves bot.dig(). Without the exclusion every
    // broken block threw the whole path away (and wrote a stray cancel-digging packet through
    // cancelActiveOperations) before the dig even reported success — tunnelling replanned per block.
    if (isOwnDigTarget(oldBlock.position)) return
    // The generic update for our own scaffold block arrives before mineflayer resolves
    // placeBlock(). Treating it as foreign terrain invalidates the rest of the tower path,
    // causing a needless A* restart after every successful placement.
    if (isOwnPlacementTarget(oldBlock.position)) return
    if (isPositionNearPath(oldBlock.position, path) && oldBlock.type !== newBlock.type) {
      resetPath('block_updated', false)
    }
  })

  bot.on('chunkColumnLoad', (chunk) => {
    // ── Olela:只在"当前要走的路径"有节点落在刚加载的区块里时才重算 ──
    // 原版:只要新区块挨着 A* 访问过的区块就整条扔掉重算。bot 边走边加载新区块 → 频繁触发 →
    // "走两步又停"(配合完整路径优先 patch,站着重算更明显)。改为:仅当 path 有节点落在刚加载
    // 的这个区块(路径穿过刚揭示的新地形,需重新验证)才重置;远处区块加载与本路径无关,不动。
    // 真实方块增删(没了/多了)由下方 blockUpdate 监听器另行 resetPath,保留不变。
    if (!astarContext || path.length === 0) return
    const cx = chunk.x >> 4
    const cz = chunk.z >> 4
    for (const node of path) {
      if ((node.x >> 4) === cx && (node.z >> 4) === cz) {
        resetPath('chunk_loaded', false)
        return
      }
    }
  })

  function monitorMovement () {
    if (controlPause) return
    // Test freemotion
    if (stateMovements && stateMovements.allowFreeMotion && stateGoal && stateGoal.entity) {
      const target = stateGoal.entity
      if (physics.canStraightLine([target.position])) {
        bot.lookAt(target.position.offset(0, 1.6, 0))

        if (target.position.distanceSquared(bot.entity.position) > stateGoal.rangeSq) {
          bot.setControlState('forward', true)
        } else {
          bot.clearControlStates()
        }
        return
      }
    }
    if (stateGoal) {
      if (!stateGoal.isValid()) {
        stop()
      } else if (stateGoal.hasChanged()) {
        partialSegmentGuard.reset()
        resetPath('goal_moved', false)
      }
    }

    if (astarContext && astartTimedout) {
      const results = astarContext.compute()
      results.path = postProcessPath(results.path)
      const usingPartialSegment = acceptBestSoFarSegment(results)
      if (usingPartialSegment && !prepareExecutionPath(results, 'continue')) {
        bot.emit('path_update', results)
        abandonStalePlan()
        return
      }
      if (!usingPartialSegment) {
        astartTimedout = results.status === 'partial'
      }
      bot.emit('path_update', results)
      // ───────── Olela PATCH A:完整路径优先(防来回往返) ─────────
      // 原版:partial 阶段就把半路径赋给 path 让 bot 边走边算,bot 跟着每 tick
      // 跳变的 bestNode 来回往返、反复探路(长距离/爬高最明显)。
      // 改为:partial 阶段 bot 原地等待、不暴露半路径,只持续累计计算,直到
      // A* 出完整结果(success/timeout/noPath)再走。path_update 仍照常 emit
      // 真实 partial 路径,goto 的事件判定不受影响。
      if (!usingPartialSegment && results.status !== 'success') {
        path = []
        fullStop()
        return
      }
      // 搜索完成或拿到一个可执行分段:重置卡死计时(计算耗时不算 stuck)再走。
      path = results.path
      lastNodeTime = performance.now()
      lastMoveDebugAt = 0
      lastMoveDebugPathLen = -1
      emitPathDebug('path_assigned_continue', {
        resultStatus: results.status,
        resultCost: typeof results.cost === 'number' ? Number(results.cost.toFixed(3)) : results.cost,
        resultVisitedNodes: results.visitedNodes,
        resultGeneratedNodes: results.generatedNodes
      })
      // ─────────────────────────────────────────────────────────
    }

    if (bot.pathfinder.LOSWhenPlacingBlocks && returningPos) {
      if (!moveToBlock(returningPos)) return
      returningPos = null
    }

    if (path.length === 0) {
      lastNodeTime = performance.now()
      if (stateGoal && stateMovements) {
        if (stateGoal.isEnd(bot.entity.position.floored())) {
          if (!dynamicGoal) {
            bot.emit('goal_reached', stateGoal)
            stateGoal = null
            fullStop()
          }
        } else if (!pathUpdated) {
          const results = bot.pathfinder.getPathTo(stateMovements, stateGoal)
          const usingPartialSegment = acceptBestSoFarSegment(results)
          if (usingPartialSegment && !prepareExecutionPath(results, 'initial')) {
            bot.emit('path_update', results)
            abandonStalePlan()
            return
          }
          if (!usingPartialSegment) {
            astartTimedout = results.status === 'partial'
          }
          bot.emit('path_update', results)
          pathUpdated = true
          // ── Olela PATCH A ── 首次计算即 partial:先别走,后续 tick 由上面的
          // (astarContext && astartTimedout) 块继续累计计算直到完整路径。
          if (!usingPartialSegment && results.status !== 'success') {
            path = []
            fullStop()
            return
          }
          path = results.path
          lastNodeTime = performance.now()
          lastMoveDebugAt = 0
          lastMoveDebugPathLen = -1
          emitPathDebug('path_assigned_initial', {
            resultStatus: results.status,
            resultCost: typeof results.cost === 'number' ? Number(results.cost.toFixed(3)) : results.cost,
            resultVisitedNodes: results.visitedNodes,
            resultGeneratedNodes: results.generatedNodes
          })
        }
      }
    }

    if (path.length === 0) {
      return
    }

    let nextPoint = path[0]
    const p = bot.entity.position

    // A server correction can put the bot back after one or more planned nodes
    // were consumed. Never chase a now non-adjacent execution node: discard the
    // stale suffix and replan from the authoritative current position.
    if (performance.now() - lastNodeTime >= 100 && !isExecutionHeadContinuous(nextPoint, p)) {
      emitPathDebug('path_head_discontinuous', { source: 'runtime' })
      resetPath('path_discontinuous')
      return
    }

    // A* still selects the exact safe landing block. Large vertical edges are
    // executed by the elytra controller so an unlimited planned drop never
    // becomes an uncontrolled fall.
    if (controlledDrop || (Number(nextPoint.controlledDropDistance) > 3 && nextPoint.controlledDropComplete !== true)) {
      if (!controlledDrop) {
        if (typeof bot._executeControlledPathDrop !== 'function') {
          resetPath('controlled_drop_unavailable')
          return
        }
        controlledDrop = nextPoint
        const generation = operationGeneration
        const pendingDrop = controlledDrop
        fullStop()

        let pending
        try {
          pending = bot._executeControlledPathDrop({
            x: nextPoint.x,
            y: nextPoint.y,
            z: nextPoint.z,
            dropDistance: nextPoint.controlledDropDistance
          })
        } catch (err) {
          pending = Promise.reject(err)
        }
        Promise.resolve(pending).then(result => {
          if (!isOperationCurrent(generation) || controlledDrop !== pendingDrop) return
          controlledDrop = null
          if (!result?.ok) {
            resetPath('controlled_drop_error')
            return
          }
          pendingDrop.controlledDropComplete = true
          lastNodeTime = performance.now()
        }, err => {
          if (!isOperationCurrent(generation) || controlledDrop !== pendingDrop) return
          console.warn(`controlled path drop failed: ${err?.message || err}`)
          controlledDrop = null
          resetPath('controlled_drop_error')
        })
      }
      return
    }

    // Execute exact, state-aware interactions attached by movement planners.
    // The movement plugin owns the action implementation (for example,
    // closing one specific trapdoor and waiting for the server state update);
    // the pathfinder only serializes it with movement and lifecycle changes.
    if (interacting || (Array.isArray(nextPoint.blockActions) && nextPoint.blockActions.length > 0)) {
      if (!interacting) {
        if (typeof bot._executePathBlockAction !== 'function') {
          resetPath('block_action_unavailable')
          return
        }
        interacting = true
        interactingAction = nextPoint.blockActions[0]
        const generation = operationGeneration
        const pendingAction = interactingAction
        fullStop()

        let pending
        try {
          pending = bot._executePathBlockAction(pendingAction)
        } catch (err) {
          pending = Promise.reject(err)
        }
        Promise.resolve(pending).then(() => {
          if (!isOperationCurrent(generation) || !interacting || interactingAction !== pendingAction) return
          if (nextPoint.blockActions?.[0] === pendingAction) nextPoint.blockActions.shift()
          interacting = false
          interactingAction = null
          lastNodeTime = performance.now()
        }, err => {
          if (!isOperationCurrent(generation) || interactingAction !== pendingAction) return
          console.warn(`path block action failed: ${err?.message || err}`)
          if (typeof bot._avoidPathNode === 'function') {
            try { bot._avoidPathNode(nextPoint, `block_action_error:${pendingAction.kind || 'unknown'}`, 30000) } catch (_) { /* ignore */ }
          }
          resetPath('block_action_error')
        })
      }
      return
    }

    // Handle digging
    if (digging || nextPoint.toBreak.length > 0) {
      if (!digging && bot.entity.onGround) {
        const b = nextPoint.toBreak[0]
        const block = bot.blockAt(new Vec3(b.x, b.y, b.z), false)
        // blockAt(..., false) returns null for an unloaded column. bestHarvestTool and bot.dig
        // both dereference it synchronously, and monitorMovement runs on physicsTick, so the
        // TypeError would take the whole process down. Replan instead.
        if (!block) {
          const now = performance.now()
          if (now - lastDigUnloadedWarnAt > 5000) {
            lastDigUnloadedWarnAt = now
            console.warn(`[pathfinder] dig target (${b.x},${b.y},${b.z}) is not loaded, replanning`)
          }
          resetPath('dig_block_unloaded')
          return
        }
        if (!pathBreakAllowed(stateMovements, block)) {
          console.warn(
            `[pathfinder] blocked unsafe path dig ${block.name || '?'} at (${b.x},${b.y},${b.z}), replanning`
          )
          if (typeof bot._avoidPathNode === 'function') {
            try { bot._avoidPathNode(nextPoint, 'unsafe_path_break', 30000) } catch (_) { /* ignore */ }
          }
          resetPath('unsafe_path_break')
          return
        }
        nextPoint.toBreak.shift()
        digging = true
        diggingTarget = new Vec3(b.x, b.y, b.z)
        const generation = operationGeneration
        const tool = bot.pathfinder.bestHarvestTool(block)
        fullStop()

        if (PATH_DIG_TRACE) {
          console.log(
            `[pathfinder][dig-trace] start block=${block.name || '?'} at=(${b.x},${b.y},${b.z}) ` +
            `node=(${nextPoint.x},${nextPoint.y},${nextPoint.z}) remainingBreaks=${nextPoint.toBreak.length} ` +
            `pathLen=${path.length} tool=${tool?.name || 'hand'}`
          )
        }

        const digBlock = () => {
          if (!isOperationCurrent(generation) || !digging) return
          bot.dig(block, true)
            .then(function () {
              if (!isOperationCurrent(generation)) return
              lastNodeTime = performance.now()
              digging = false
              diggingTarget = null
              bot.pathfinder._digFailKey = null
              bot.pathfinder._digFailStreak = 0
              if (PATH_DIG_TRACE) {
                console.log(`[pathfinder][dig-trace] done block=${block.name || '?'} at=(${b.x},${b.y},${b.z})`)
              }
            }, err => {
              if (!isOperationCurrent(generation)) return
              // Olela patch: the upstream code swallowed this error and recomputed the same
              // path forever, so a single undiggable node burned the whole navigation window
              // (observed on the real server: identical 3-node dig path retried until deadline).
              // Log the real reason and, after a few consecutive failures on the same block,
              // mark the node temporarily avoided so A* routes around it instead of looping.
              const key = `${b.x},${b.y},${b.z}`
              if (bot.pathfinder._digFailKey === key) {
                bot.pathfinder._digFailStreak = (bot.pathfinder._digFailStreak || 0) + 1
              } else {
                bot.pathfinder._digFailKey = key
                bot.pathfinder._digFailStreak = 1
              }
              const streak = bot.pathfinder._digFailStreak
              if (PATH_DIG_TRACE) {
                console.warn(
                  `[pathfinder][dig-trace] failed block=${block?.name || '?'} at=(${key}) ` +
                  `streak=${streak} error=${err?.message || err}`
                )
              }
              if (streak <= 3) {
                console.warn(`[pathfinder] dig failed at (${key}) ${block?.name || '?'} #${streak}: ${err?.message || err}`)
              }
              if (streak >= 3 && typeof bot._avoidPathNode === 'function') {
                try { bot._avoidPathNode({ x: b.x, y: b.y, z: b.z }, 'dig_error', 60000) } catch (_) { /* ignore */ }
              }
              // resetPath 自身会置 digging=false，并需要读到 wasDigging=true 来做停挖清理，
              // 所以这里绝不能提前改 digging。
              resetPath('dig_error')
            })
        }

        const handleToolPreparationFailure = (err) => {
          if (!isOperationCurrent(generation) || !digging) return
          console.warn(`[pathfinder] failed to prepare held item before path dig: ${err?.message || err}`)
          resetPath('dig_tool_prepare_error')
        }

        if (!tool) {
          if (bot.heldItem) {
            const unequip = typeof bot.unequip === 'function'
              ? bot.unequip('hand')
              : Promise.reject(new Error('unequip_unavailable'))
            unequip.then(digBlock, handleToolPreparationFailure)
          } else {
            digBlock()
          }
        } else {
          bot.equip(tool, 'hand')
            .then(digBlock, handleToolPreparationFailure)
        }
      }
      return
    }
    // Handle block placement
    // TODO: sneak when placing or make sure the block is not interactive
    if (placing || nextPoint.toPlace.length > 0) {
      if (!placing) {
        placing = true
        placingBlock = nextPoint.toPlace.shift()
        placingTarget = null
        fullStop()
      }

      // Open gates or doors
      if (placingBlock?.useOne) {
        if (!lockUseBlock.tryAcquire()) return
        const generation = operationGeneration
        const pendingPlacement = placingBlock
        bot.activateBlock(bot.blockAt(new Vec3(pendingPlacement.x, pendingPlacement.y, pendingPlacement.z))).then(() => {
          if (!isOperationCurrent(generation) || placingBlock !== pendingPlacement) return
          lockUseBlock.release()
          placingBlock = nextPoint.toPlace.shift() || null
          if (!placingBlock) {
            placing = false
            lastNodeTime = performance.now()
          }
        }, err => {
          if (!isOperationCurrent(generation) || placingBlock !== pendingPlacement) return
          console.error(err)
          lockUseBlock.release()
        })
        return
      }
      const block = stateMovements.getScaffoldingItem()
      if (!block) {
        resetPath('no_scaffolding_blocks')
        return
      }
      if (bot.pathfinder.LOSWhenPlacingBlocks && placingBlock.y === bot.entity.position.floored().y - 1 && placingBlock.dy === 0) {
        if (!moveToEdge(new Vec3(placingBlock.x, placingBlock.y, placingBlock.z), new Vec3(placingBlock.dx, 0, placingBlock.dz))) return
      }
      let canPlace = true
      if (placingBlock.jump) {
        // Equip before starting the jump. Equipping after takeoff races the ascent and
        // often sends placeBlock while the bot is already falling; the server then waits
        // 5s for a block update and returns place_error.
        if (!placingBlock._olelaEquipped) {
          if (placingBlock._olelaEquipPending) return
          if (!lockEquipItem.tryAcquire()) return
          const generation = operationGeneration
          const pendingPlacement = placingBlock
          placingBlock._olelaEquipPending = true
          bot.equip(block, 'hand').then(() => {
            if (!isOperationCurrent(generation) || !placing || placingBlock !== pendingPlacement) return
            pendingPlacement._olelaEquipPending = false
            pendingPlacement._olelaEquipped = true
            lockEquipItem.release()
          }, err => {
            if (!isOperationCurrent(generation)) return
            pendingPlacement._olelaEquipPending = false
            lockEquipItem.release()
            console.warn(`[pathfinder] scaffold equip failed: ${err?.message || err}`)
            resetPath('place_equip_error')
          })
          return
        }
        bot.setControlState('jump', true)
        const targetTopY = placingBlock.y + placingBlock.dy + 1
        const clearance = bot.entity.position.y - targetTopY
        const velocityY = bot.entity.velocity?.y
        const rising = !Number.isFinite(velocityY) || velocityY > 0.02
        // The entity's feet must clear the *top* of the destination block. The old
        // formula measured from the destination base, so it sent the packet while the
        // player hitbox still occupied the block and the server rejected the placement.
        // A normal jump only peaks about 0.25 blocks above targetTopY, leaving a narrow
        // but sufficient rising window.
        canPlace = clearance >= 0.18 && rising
      }
      if (canPlace) {
        const generation = operationGeneration
        const pendingPlacement = placingBlock
        const placeNow = () => {
          if (!isOperationCurrent(generation) || !placing || placingBlock !== pendingPlacement) return
          const refBlock = bot.blockAt(new Vec3(pendingPlacement.x, pendingPlacement.y, pendingPlacement.z), false)
          if (!refBlock) {
            resetPath('place_reference_unloaded')
            return
          }
          if (!lockPlaceBlock.tryAcquire()) return
          placingTarget = refBlock.position.plus(new Vec3(pendingPlacement.dx, pendingPlacement.dy, pendingPlacement.dz))
          if (interactableBlocks.includes(refBlock.name)) {
            bot.setControlState('sneak', true)
          }
          bot.placeBlock(refBlock, new Vec3(pendingPlacement.dx, pendingPlacement.dy, pendingPlacement.dz))
            .then(function () {
              if (!isOperationCurrent(generation) || placingBlock !== pendingPlacement) return
              bot.setControlState('sneak', false)
              if (bot.pathfinder.LOSWhenPlacingBlocks && pendingPlacement.returnPos) returningPos = pendingPlacement.returnPos.clone()
              lockPlaceBlock.release()
              placingTarget = null
              placing = false
              placingBlock = null
              lastNodeTime = performance.now()
            }, err => {
              if (!isOperationCurrent(generation)) return
              // Some servers apply the block but omit/delay the blockUpdate event that
              // mineflayer's placeBlock promise waits for. The bot is then visibly standing
              // on the new scaffold while the promise rejects after 5s. Treat an occupied,
              // physical destination as authoritative success instead of tearing the path down.
              const placedBlock = placingTarget == null ? null : bot.blockAt(placingTarget, false)
              const hasPhysicalSupport = placedBlock != null && (
                placedBlock.physical === true ||
                placedBlock.boundingBox === 'block' ||
                (Array.isArray(placedBlock.shapes) && placedBlock.shapes.length > 0)
              )
              if (hasPhysicalSupport) {
                bot.setControlState('sneak', false)
                if (bot.pathfinder.LOSWhenPlacingBlocks && pendingPlacement.returnPos) returningPos = pendingPlacement.returnPos.clone()
                lockPlaceBlock.release()
                placingTarget = null
                placing = false
                placingBlock = null
                lastNodeTime = performance.now()
                if (PATH_DIG_TRACE) {
                  console.log(`[pathfinder][place-trace] confirmed-after-timeout block=${placedBlock.name || '?'} at=(${placedBlock.position.x},${placedBlock.position.y},${placedBlock.position.z})`)
                }
                return
              }
              lockPlaceBlock.release()
              placingTarget = null
              console.warn(`[pathfinder] scaffold place failed at (${pendingPlacement.x},${pendingPlacement.y},${pendingPlacement.z}): ${err?.message || err}`)
              resetPath('place_error')
            })
        }
        if (pendingPlacement.jump) {
          placeNow()
        } else {
          if (!lockEquipItem.tryAcquire()) return
          bot.equip(block, 'hand').then(() => {
            lockEquipItem.release()
            placeNow()
          }, err => {
            lockEquipItem.release()
            if (!isOperationCurrent(generation)) return
            console.warn(`[pathfinder] scaffold equip failed: ${err?.message || err}`)
            resetPath('place_equip_error')
          })
        }
      }
      return
    }

    let dx = nextPoint.x - p.x
    let dy = nextPoint.y - p.y
    let dz = nextPoint.z - p.z
    if (isNodeReached(nextPoint, p, bot.entity)) {
      // arrived at next point
      lastNodeTime = performance.now()
      emitPathDebug('node_reached', {
        reached: shortNode(nextPoint),
        remainingBeforeShift: path.length,
        reachedDelta: { dx: Number(dx.toFixed(3)), dy: Number(dy.toFixed(3)), dz: Number(dz.toFixed(3)) }
      })
      path.shift()
      if (path.length === 0) { // done
        // If the block the bot is standing on is not a full block only checking for the floored position can fail as
        // the distance to the goal can get greater then 0 when the vector is floored.
        if (!dynamicGoal && stateGoal && (stateGoal.isEnd(p.floored()) || stateGoal.isEnd(p.floored().offset(0, 1, 0)))) {
          bot.emit('goal_reached', stateGoal)
          stateGoal = null
        }
        if (partialSegmentActive) {
          partialSegmentGuard.noteCompleted()
          partialSegmentActive = false
          if (stateGoal) {
            pathUpdated = false
            astarContext = null
            astartTimedout = false
          }
        }
        fullStop()
        return
      }
      // not done yet
      nextPoint = path[0]
      if (performance.now() - lastNodeTime >= 100 && !isExecutionHeadContinuous(nextPoint, p)) {
        emitPathDebug('path_head_discontinuous', { source: 'runtime_after_shift' })
        resetPath('path_discontinuous')
        return
      }
      if (
        nextPoint.toBreak.length > 0 ||
        nextPoint.toPlace.length > 0 ||
        (Array.isArray(nextPoint.blockActions) && nextPoint.blockActions.length > 0)
      ) {
        fullStop()
        return
      }
      dx = nextPoint.x - p.x
      dy = nextPoint.y - p.y
      dz = nextPoint.z - p.z
    }

    bot.look(Math.atan2(-dx, -dz), 0)
    bot.setControlState('forward', true)
    bot.setControlState('jump', false)

    const edgeRequiresJump = nextPoint.requiresJump === true
    const requiresJump = shouldForceJump(nextPoint, dy)
    const preferGrounded = nextPoint.snowSurface === true && !requiresJump && Number.isFinite(dy) && dy <= 0.05
    const horizontalDistance = Math.hypot(dx, dz)
    const plannedSnowStepNodeKey = `${operationGeneration}:${nextPoint.x},${nextPoint.y},${nextPoint.z}`
    const continuingPlannedSnowStep = plannedSnowStepPulse?.nodeKey === plannedSnowStepNodeKey &&
      bot.entity?.onGround === false
    const allowPlannedSnowStepHop = !requiresJump && (continuingPlannedSnowStep || isPlannedSnowStepHop({
      node: nextPoint,
      verticalDelta: dy,
      horizontalDistance
    }))
    const canStraightSprint = stateMovements.allowSprinting && physics.canStraightLine(path, true)
    const canSprintJump = stateMovements.allowSprinting && physics.canSprintJump(path)
    const canStraightWalk = physics.canStraightLine(path, false, !preferGrounded)
    const canWalkJump = physics.canWalkJump(path)
    let controls = selectMoveControls({
      isInWater: bot.entity.isInWater,
      descendInWater: nextPoint.reachKind === 'water' && Number.isFinite(nextPoint.gridY) &&
        nextPoint.gridY < Math.floor(p.y + 1e-6),
      requiresJump,
      preferGrounded,
      allowPlannedSnowStepHop,
      canStraightSprint,
      canSprintJump,
      canStraightWalk,
      canWalkJump
    })
    let moveMode = controls.moveMode
    if (moveMode === 'planned_snow_step_hop') {
      const velocityY = bot.entity?.velocity?.y
      const y = bot.entity?.position?.y
      const restingOnSnow = bot.entity?.onGround === false &&
        Number.isFinite(velocityY) && velocityY <= 0 && velocityY >= -0.1 &&
        Number.isFinite(y) && Math.abs(y * 8 - Math.round(y * 8)) <= 0.02
      const pulse = advancePlannedSnowStepPulse(plannedSnowStepPulse, {
        nodeKey: plannedSnowStepNodeKey,
        settled: bot.entity?.onGround === true || restingOnSnow
      })
      plannedSnowStepPulse = pulse.state
      controls = { ...controls, ...pulse.controls }
      moveMode = pulse.moveMode
      if (moveMode === 'planned_snow_step_takeoff' && bot.entity?.velocity) {
        bot.entity.velocity.x = 0
        bot.entity.velocity.z = 0
        // prismarine-physics can report onGround=true while the feet are inside
        // a layered-snow block, then ignore control.jump entirely. Apply the
        // vanilla jump impulse to the local physics state; the next tick sends
        // the resulting position normally and begins horizontal advance.
        bot.entity.velocity.y = Math.max(bot.entity.velocity.y || 0, 0.42)
      }
    } else {
      plannedSnowStepPulse = null
    }
    bot.setControlState('forward', controls.forward)
    bot.setControlState('jump', controls.jump)
    bot.setControlState('sneak', controls.sneak === true)
    bot.setControlState('sprint', controls.sprint)
    const now = performance.now()
    if (now - lastMoveDebugAt >= 1000 || path.length !== lastMoveDebugPathLen || moveMode !== lastMoveDebugMode) {
      emitPathDebug('move_tick', {
        moveMode,
        checks: { edgeRequiresJump, requiresJump, preferGrounded, continuingPlannedSnowStep, allowPlannedSnowStepHop, canStraightSprint, canSprintJump, canStraightWalk, canWalkJump },
        targetYaw: Number(Math.atan2(-dx, -dz).toFixed(3))
      })
      lastMoveDebugAt = now
      lastMoveDebugPathLen = path.length
      lastMoveDebugMode = moveMode
    }

    // Progress-aware futility detection. The old fixed 3.5-second node age
    // treated slow but genuine water/vertical movement as a failure, then a
    // temporary avoidance penalty could turn one local delay into a huge
    // detour. Track best distance to the current execution node instead: any
    // meaningful approach refreshes the timer. Technical nodes get a larger
    // no-progress budget, while ordinary ground blockage still resets fast.
    const progressKey = `${operationGeneration}:${nextPoint.x},${nextPoint.y},${nextPoint.z}`
    const progressDistance = Math.hypot(dx, dy, dz)
    let progress = bot.pathfinder._nodeProgress
    if (!progress || progress.key !== progressKey) {
      progress = { key: progressKey, bestDistance: progressDistance, lastProgressAt: now }
      bot.pathfinder._nodeProgress = progress
    } else if (progressDistance <= progress.bestDistance - 0.08) {
      progress.bestDistance = progressDistance
      progress.lastProgressAt = now
    }

    // blocked_no_motion means the control simulator ruled out every way of traversing this
    // edge, so waiting out the 12s no-progress budget cannot change the answer — only fresh
    // block data can. Replan after a short grace period instead (the grace rides out transient
    // airborne//entity-push states). Observed on the real server: A* kept planning a walk edge
    // into a hillside while the controller refused to move, and the caller's unstick burned
    // ~14s of rescue attempts per target before the node was finally avoided.
    if (moveMode === 'blocked_no_motion') {
      if (blockedNoMotionKey !== progressKey) {
        blockedNoMotionKey = progressKey
        blockedNoMotionSince = now
      } else if (now - blockedNoMotionSince > BLOCKED_NO_MOTION_REPLAN_MS) {
        emitPathDebug('blocked_no_motion_replan', { moveMode, blockedMs: Number((now - blockedNoMotionSince).toFixed(1)) })
        const failedGridPoint = pathGridPoint(nextPoint)
        if (failedGridPoint && typeof bot._avoidPathNode === 'function') {
          bot._avoidPathNode(failedGridPoint, `blocked_no_motion:${progressKey}`, 30000)
        }
        blockedNoMotionKey = null
        resetPath('blocked_no_motion')
        return
      }
    } else if (blockedNoMotionKey !== null) {
      blockedNoMotionKey = null
    }

    const isWaterMove = bot.entity.isInWater || nextPoint.reachKind === 'water'
    const isClimbMove = nextPoint.reachKind === 'climbable'
    const isTechnicalVertical = nextPoint.requiresJump === true || nextPoint.requiresLanding === true
    const noProgressMs = now - progress.lastProgressAt
    const ordinarySurfaceMove = nextPoint.reachKind === 'surface' &&
      !isWaterMove && !isClimbMove && !isTechnicalVertical &&
      nextPoint.toBreak.length === 0 && nextPoint.toPlace.length === 0 &&
      (!Array.isArray(nextPoint.blockActions) || nextPoint.blockActions.length === 0)
    const surfaceNoProgressLimitMs = Math.max(200, Number(bot.pathfinder.surfaceNoProgressReplanMs) || SURFACE_NO_PROGRESS_REPLAN_MS)
    if (ordinarySurfaceMove && controls.forward === true && noProgressMs > surfaceNoProgressLimitMs) {
      const sourceSupport = blockDetailAt({ x: p.x, y: p.y - 1, z: p.z })
      const targetSupport = blockDetailAt({ x: nextPoint.x, y: nextPoint.y - 1, z: nextPoint.z })
      const stairSurfaceMove = isStairBlock(sourceSupport) || isStairBlock(targetSupport)
      const reason = stairSurfaceMove ? 'surface_no_progress_stairs' : 'surface_no_progress'
      emitPathDebug('surface_no_progress_replan', {
        moveMode,
        noProgressMs: Number(noProgressMs.toFixed(1)),
        sourceSupport: sourceSupport?.name ?? null,
        targetSupport: targetSupport?.name ?? null
      })
      const failedGridPoint = pathGridPoint(nextPoint)
      if (failedGridPoint && typeof bot._avoidPathNode === 'function') {
        bot._avoidPathNode(failedGridPoint, `${reason}:${progressKey}`, 30000)
      }
      resetPath(reason)
      return
    }
    // The station executor performs a physical rescue after 8 seconds on the
    // same active node. Keep pathfinder's own replan deadline above that so an
    // A* reset cannot erase the evidence before rescue gets one real attempt.
    const noProgressLimitMs = isWaterMove ? 16000 : (isClimbMove ? 16000 : (isTechnicalVertical ? 14000 : 12000))
    if (noProgressMs > noProgressLimitMs) {
      emitPathDebug('stuck_threshold', {
        moveMode,
        checks: { edgeRequiresJump, requiresJump, preferGrounded, continuingPlannedSnowStep, allowPlannedSnowStepHop, canStraightSprint, canSprintJump, canStraightWalk, canWalkJump },
        stuckMs: Number((performance.now() - lastNodeTime).toFixed(1)),
        noProgressMs: Number(noProgressMs.toFixed(1)),
        noProgressLimitMs,
        progressDistance: Number(progressDistance.toFixed(3)),
        bestProgressDistance: Number(progress.bestDistance.toFixed(3))
      })
      resetPath('stuck')
    }
  }
}

module.exports = {
  pathfinder: inject,
  Movements: require('./lib/movements'),
  goals: require('./lib/goals'),
  olelaCapabilities,
  _test: { pathBreakAllowed, pathGridPoint, selectBestHarvestTool }
}

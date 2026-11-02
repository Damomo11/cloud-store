'use strict'

const { Vec3: DefaultVec3 } = require('vec3')
const Move = require('../../vendor/mineflayer-pathfinder/lib/move')

// Minecraft Java 1.21.4 trapdoors. Keep this explicit so a newly added block is
// denied by default until its interaction and collision semantics are verified.
const TRAPDOOR_NAMES = new Set([
  'acacia_trapdoor',
  'bamboo_trapdoor',
  'birch_trapdoor',
  'cherry_trapdoor',
  'copper_trapdoor',
  'crimson_trapdoor',
  'dark_oak_trapdoor',
  'exposed_copper_trapdoor',
  'iron_trapdoor',
  'jungle_trapdoor',
  'mangrove_trapdoor',
  'oak_trapdoor',
  'oxidized_copper_trapdoor',
  'pale_oak_trapdoor',
  'spruce_trapdoor',
  'warped_trapdoor',
  'waxed_copper_trapdoor',
  'waxed_exposed_copper_trapdoor',
  'waxed_oxidized_copper_trapdoor',
  'waxed_weathered_copper_trapdoor',
  'weathered_copper_trapdoor',
])

const ROLE_SUPPORT = 'support'
const ROLE_BODY = 'body'
const ROLE_HEAD = 'head'
const VALID_ROLES = new Set([ROLE_SUPPORT, ROLE_BODY, ROLE_HEAD])
const DEFAULT_ACTIVATION_TIMEOUT_MS = 1000
const DEFAULT_CONFIRM_TIMEOUT_MS = 750
const DEFAULT_POLL_INTERVAL_MS = 25
const TRAPDOOR_INSTALL = Symbol('olelaTrapdoorPassage')
const TRAPDOOR_PANEL_HEIGHT = 3 / 16
const PLAYER_HEIGHT = 1.8

function blockName (blockOrName) {
  return typeof blockOrName === 'string' ? blockOrName : blockOrName?.name
}

function isTrapdoorName (name) {
  return typeof name === 'string' && TRAPDOOR_NAMES.has(name)
}

function isRegularDoorName (name) {
  return typeof name === 'string' && name.endsWith('_door') && !name.endsWith('_trapdoor')
}

function isPassableDoor (blockOrName) {
  const name = blockName(blockOrName)
  if (typeof name !== 'string' || name.startsWith('iron_')) return false
  return isRegularDoorName(name) || name.endsWith('_fence_gate')
}

function readProperties (block) {
  try {
    const properties = block?.getProperties?.()
    return properties && typeof properties === 'object' ? properties : {}
  } catch (_) {
    return {}
  }
}

function propertyIsTrue (value) {
  return value === true || String(value).toLowerCase() === 'true'
}

function trapdoorMaterial (name) {
  if (!isTrapdoorName(name)) return null
  if (name === 'iron_trapdoor') return 'iron'
  if (name.includes('copper_trapdoor')) return 'copper'
  return 'wood'
}

function normalizeRole (role) {
  if (role === 'foot' || role === 'bridge') return ROLE_SUPPORT
  return role
}

function closedGeometryIsPassable (role, half) {
  role = normalizeRole(role)
  if (!VALID_ROLES.has(role) || (half !== 'bottom' && half !== 'top')) return false
  if (role === ROLE_SUPPORT) return true
  if (role === ROLE_BODY) return half === 'bottom'
  return half === 'top'
}

function copyPosition (position) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return null
  return { x: position.x, y: position.y, z: position.z }
}

function makeAction (block, role) {
  const position = copyPosition(block?.position)
  if (!position) return null
  return { x: position.x, y: position.y, z: position.z, kind: 'trapdoor', open: false }
}

/**
 * Classifies one trapdoor at one exact path role. An open trapdoor is only
 * plannable when closing it produces collision geometry known to be walkable:
 * a support/bridge below the feet, bottom-half at body level, or top-half at
 * head level. Unsafe geometry is never toggled speculatively.
 */
function evaluateTrapdoorPassage (block, requestedRole) {
  const name = blockName(block)
  const role = normalizeRole(requestedRole)
  if (!isTrapdoorName(name)) {
    return {
      recognized: false,
      canPlanThrough: false,
      passableNow: false,
      needsClose: false,
      action: null,
      reason: 'not_trapdoor',
    }
  }
  if (!VALID_ROLES.has(role)) {
    return {
      recognized: true,
      canPlanThrough: false,
      passableNow: false,
      needsClose: false,
      action: null,
      reason: 'invalid_role',
    }
  }

  const properties = readProperties(block)
  const half = properties.half
  const open = propertyIsTrue(properties.open)
  const powered = propertyIsTrue(properties.powered)
  const waterlogged = propertyIsTrue(properties.waterlogged)
  const material = trapdoorMaterial(name)
  const safeClosedGeometry = closedGeometryIsPassable(role, half)
  const common = { recognized: true, name, material, role, half, open, powered, waterlogged }

  if (!safeClosedGeometry) {
    return {
      ...common,
      canPlanThrough: false,
      passableNow: false,
      needsClose: false,
      action: null,
      reason: 'unsafe_closed_geometry',
    }
  }
  if (!open) {
    return {
      ...common,
      canPlanThrough: true,
      passableNow: true,
      needsClose: false,
      action: null,
      reason: 'safe_closed',
    }
  }
  if (material === 'iron') {
    return {
      ...common,
      canPlanThrough: false,
      passableNow: false,
      needsClose: false,
      action: null,
      reason: 'iron_manual_only',
    }
  }
  if (powered) {
    return {
      ...common,
      canPlanThrough: false,
      passableNow: false,
      needsClose: false,
      action: null,
      reason: 'powered_manual_only',
    }
  }
  if (waterlogged) {
    return {
      ...common,
      canPlanThrough: false,
      passableNow: false,
      needsClose: false,
      action: null,
      reason: 'waterlogged_manual_only',
    }
  }

  const action = makeAction(block, role)
  if (!action) {
    return {
      ...common,
      canPlanThrough: false,
      passableNow: false,
      needsClose: false,
      action: null,
      reason: 'missing_position',
    }
  }
  return {
    ...common,
    canPlanThrough: true,
    passableNow: false,
    needsClose: true,
    action,
    reason: 'close_required',
  }
}

function makeTrapdoorPassageAction (block, role) {
  return evaluateTrapdoorPassage(block, role).action
}

function trapdoorSurfaceY (block, role) {
  const properties = readProperties(block)
  const half = properties.half
  role = normalizeRole(role)
  if (role === ROLE_BODY && half === 'bottom') return block.position.y + TRAPDOOR_PANEL_HEIGHT
  if (role === ROLE_SUPPORT) return block.position.y + (half === 'top' ? 1 : TRAPDOOR_PANEL_HEIGHT)
  return null
}

function addStepCost (moves, block) {
  let cost = 0
  if (typeof moves.exclusionStep === 'function') cost += moves.exclusionStep(block)
  if (typeof moves.getNumEntitiesAt === 'function' && block?.position) {
    cost += moves.getNumEntitiesAt(block.position, 0, 0, 0) * (moves.entityCost ?? 1)
  }
  return cost
}

function buildTrapdoorForwardMove (moves, rawAt, node, dir) {
  const targetX = node.x + dir.x
  const targetZ = node.z + dir.z
  const roles = [
    { role: ROLE_SUPPORT, y: node.y - 1, dy: -1 },
    { role: ROLE_BODY, y: node.y, dy: 0 },
    { role: ROLE_HEAD, y: node.y + 1, dy: 1 }
  ]

  let hasTrapdoor = false
  let bodyProvidesSupport = false
  let plannedSurfaceY = null
  let headUndersideY = Infinity
  const actions = []

  for (const entry of roles) {
    const raw = rawAt(targetX, entry.y, targetZ)
    entry.raw = raw
    if (isTrapdoorName(raw?.name)) hasTrapdoor = true
  }

  // Ordinary terrain is overwhelmingly more common than a trapdoor column.
  // Avoid allocating three mutable descriptors until the raw block names prove
  // that the specialized passage logic is needed.
  if (!hasTrapdoor) return { hasTrapdoor: false, move: null, reason: 'no_trapdoor' }

  for (const entry of roles) {
    entry.descriptor = moves.getBlock(node, dir.x, entry.dy, dir.z)
  }

  for (const entry of roles) {
    const raw = entry.raw
    if (!isTrapdoorName(raw?.name)) continue
    const assessment = evaluateTrapdoorPassage(raw, entry.role)
    if (!assessment.canPlanThrough) return { hasTrapdoor: true, move: null, reason: assessment.reason }
    if (assessment.action) actions.push(assessment.action)

    if (entry.role === ROLE_BODY) {
      bodyProvidesSupport = true
      plannedSurfaceY = trapdoorSurfaceY(raw, ROLE_BODY)
    } else if (entry.role === ROLE_SUPPORT && !bodyProvidesSupport) {
      plannedSurfaceY = trapdoorSurfaceY(raw, ROLE_SUPPORT)
    } else if (entry.role === ROLE_HEAD) {
      headUndersideY = raw.position.y + (assessment.half === 'top' ? 13 / 16 : 0)
    }
  }

  const supportEntry = roles[0]
  const bodyEntry = roles[1]
  const headEntry = roles[2]
  if (!isTrapdoorName(bodyEntry.raw?.name) && (bodyEntry.descriptor?.safe !== true || bodyEntry.descriptor?.liquid === true)) {
    return { hasTrapdoor: true, move: null, reason: 'body_blocked' }
  }
  if (!isTrapdoorName(headEntry.raw?.name) && (headEntry.descriptor?.safe !== true || headEntry.descriptor?.liquid === true)) {
    return { hasTrapdoor: true, move: null, reason: 'head_blocked' }
  }
  if (!bodyProvidesSupport && !isTrapdoorName(supportEntry.raw?.name) && supportEntry.descriptor?.physical !== true) {
    return { hasTrapdoor: true, move: null, reason: 'missing_support' }
  }

  const sourceSurfaceY = Number.isFinite(node.plannedSurfaceY)
    ? node.plannedSurfaceY
    : Number.isFinite(node.surfaceY)
      ? node.surfaceY
      : node.y
  const targetSurfaceY = Number.isFinite(plannedSurfaceY)
    ? plannedSurfaceY
    : supportEntry.descriptor.height
  if (!Number.isFinite(targetSurfaceY)) return { hasTrapdoor: true, move: null, reason: 'unknown_surface' }
  if (targetSurfaceY - sourceSurfaceY > 1.2) return { hasTrapdoor: true, move: null, reason: 'rise_too_high' }
  if (headUndersideY - targetSurfaceY < PLAYER_HEIGHT) {
    return { hasTrapdoor: true, move: null, reason: 'head_clearance' }
  }

  let cost = 1 + actions.length * 2
  cost += addStepCost(moves, supportEntry.descriptor)
  cost += addStepCost(moves, bodyEntry.descriptor)
  cost += addStepCost(moves, headEntry.descriptor)
  if (cost >= 100) return { hasTrapdoor: true, move: null, reason: 'excluded' }

  const move = new Move(targetX, node.y, targetZ, node.remainingBlocks, cost)
  move.trapdoorPassage = true
  move.reachKind = 'surface'
  move.blockActions = actions
  if (Number.isFinite(plannedSurfaceY)) move.plannedSurfaceY = plannedSurfaceY
  if (sourceSurfaceY - targetSurfaceY > 0.2) move.requiresLanding = true
  if (targetSurfaceY - sourceSurfaceY > 0.6) move.requiresJump = true
  return { hasTrapdoor: true, move, reason: actions.length ? 'close_then_pass' : 'closed_passage' }
}

function columnHasTrapdoor (rawAt, x, z, minY, maxY) {
  for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
    if (isTrapdoorName(rawAt(x, y, z)?.name)) return true
  }
  return false
}

function patchTrapdoorMoves (moves, bot) {
  if (!moves || typeof moves.getMoveForward !== 'function' || typeof moves.getNeighbors !== 'function') {
    throw new TypeError('Movements getMoveForward/getNeighbors are required')
  }
  const Vec3 = DefaultVec3
  const rawAt = typeof moves._rawBlockAt === 'function'
    ? moves._rawBlockAt
    : (x, y, z) => bot.blockAt(new Vec3(x, y, z), false)
  const originalForward = moves.getMoveForward.bind(moves)
  const originalNeighbors = moves.getNeighbors.bind(moves)

  moves.getMoveForward = function getTrapdoorMoveForward (node, dir, neighbors) {
    const passage = buildTrapdoorForwardMove(this, rawAt, node, dir)
    if (!passage.hasTrapdoor) return originalForward(node, dir, neighbors)
    if (passage.move) neighbors.push(passage.move)
  }

  moves.getNeighbors = function getTrapdoorNeighbors (node) {
    const neighbors = originalNeighbors(node)
    const sourceHasTrapdoor = columnHasTrapdoor(rawAt, node.x, node.z, node.y - 1, node.y + 1)
    return neighbors.filter(move => {
      if (move.trapdoorPassage === true) return true
      const dx = move.x - node.x
      const dz = move.z - node.z
      const minY = Math.min(node.y, move.y) - 1
      const maxY = Math.max(node.y, move.y) + 1
      if (columnHasTrapdoor(rawAt, move.x, move.z, minY, maxY)) return false
      if (sourceHasTrapdoor && ((dx !== 0 && dz !== 0) || (dx === 0 && dz === 0))) return false
      return true
    })
  }

  return { rawAt, originalForward, originalNeighbors }
}

function positionKey (position) {
  return `${position.x},${position.y},${position.z}`
}

function actionPosition (action) {
  return copyPosition(action)
}

function evaluateExactCloseTarget (block) {
  const name = blockName(block)
  if (!isTrapdoorName(name)) return { ok: false, reason: 'target_not_trapdoor' }
  const properties = readProperties(block)
  const open = propertyIsTrue(properties.open)
  if (!open) return { ok: true, closed: true, reason: 'safe_closed' }
  if (trapdoorMaterial(name) === 'iron') return { ok: false, reason: 'iron_manual_only' }
  if (propertyIsTrue(properties.powered)) return { ok: false, reason: 'powered_manual_only' }
  if (propertyIsTrue(properties.waterlogged)) return { ok: false, reason: 'waterlogged_manual_only' }
  return { ok: true, closed: false, reason: 'close_required' }
}

function timeoutError (label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`)
  error.code = 'ETIMEDOUT'
  return error
}

function cancelledError () {
  const error = new Error('block action cancelled')
  error.code = 'ECANCELLED'
  return error
}

function withTimeout (value, timeoutMs, label, signal) {
  let timer
  let onAbort
  const cancellation = new Promise((resolve, reject) => {
    if (!signal) return
    if (signal.aborted) return reject(cancelledError())
    onAbort = () => reject(cancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([
    Promise.resolve(value),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs)
    }),
    cancellation,
  ]).finally(() => {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  })
}

function delay (ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError())
    let onAbort
    const timer = setTimeout(() => {
      if (onAbort) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal) {
      onAbort = () => {
        clearTimeout(timer)
        reject(cancelledError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function exactPositionArgument (position, Vec3) {
  return Vec3 ? new Vec3(position.x, position.y, position.z) : position
}

function errorMessage (error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Creates an exact-target controller. It never searches around the bot: the
 * only block read or activated is the coordinate embedded in the path action.
 * Calls for the same coordinate share one in-flight Promise, preventing a
 * second activation from reopening a trapdoor while the first is confirming.
 */
function createTrapdoorPassageController (bot, options = {}) {
  const activationTimeoutMs = Math.max(1, options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS)
  const confirmTimeoutMs = Math.max(1, options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS)
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  const Vec3 = options.Vec3 || DefaultVec3
  const inFlight = new Map()

  function readExact (position) {
    return bot.blockAt(exactPositionArgument(position, Vec3))
  }

  async function waitUntilClosed (action, signal) {
    const position = actionPosition(action)
    const deadline = Date.now() + confirmTimeoutMs
    while (true) {
      if (signal.aborted) return { ok: false, changed: false, reason: 'cancelled' }
      let block
      try {
        block = readExact(position)
      } catch (error) {
        return { ok: false, reason: 'confirmation_read_failed', error: errorMessage(error) }
      }
      const state = evaluateExactCloseTarget(block)
      if (state.ok && state.closed) return { ok: true, changed: true, reason: 'closed_confirmed', block }
      if (!state.ok) return { ok: false, reason: state.reason }
      if (Date.now() >= deadline) return { ok: false, reason: 'confirmation_timeout' }
      try {
        await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), signal)
      } catch (error) {
        if (error?.code === 'ECANCELLED') return { ok: false, changed: false, reason: 'cancelled' }
        throw error
      }
    }
  }

  async function run (action, signal) {
    if (signal.aborted) return { ok: false, changed: false, reason: 'cancelled' }
    const position = actionPosition(action)
    let block
    try {
      block = readExact(position)
    } catch (error) {
      return { ok: false, changed: false, reason: 'target_read_failed', error: errorMessage(error) }
    }
    const state = evaluateExactCloseTarget(block)
    if (state.ok && state.closed) return { ok: true, changed: false, reason: 'already_closed', block }
    if (!state.ok) return { ok: false, changed: false, reason: state.reason }

    try {
      await withTimeout(bot.activateBlock(block), activationTimeoutMs, 'trapdoor activation', signal)
    } catch (error) {
      return {
        ok: false,
        changed: false,
        reason: error?.code === 'ECANCELLED'
          ? 'cancelled'
          : error?.code === 'ETIMEDOUT' ? 'activation_timeout' : 'activation_failed',
        error: errorMessage(error),
      }
    }
    return waitUntilClosed(action, signal)
  }

  function ensureClosed (blockOrAction, role) {
    const action = blockOrAction?.kind === 'trapdoor'
      ? blockOrAction
      : makeTrapdoorPassageAction(blockOrAction, role)
    const position = actionPosition(action)
    if (!action || action.kind !== 'trapdoor' || action.open !== false || !position) {
      return Promise.resolve({ ok: false, changed: false, reason: 'invalid_action' })
    }

    const key = positionKey(position)
    const active = inFlight.get(key)
    if (active) return active.promise

    const abortController = new AbortController()
    const operation = run(action, abortController.signal).catch(error => ({
      ok: false,
      changed: false,
      reason: 'controller_failed',
      error: errorMessage(error),
    }))
    const entry = { promise: operation, abortController }
    inFlight.set(key, entry)
    operation.finally(() => {
      if (inFlight.get(key) === entry) inFlight.delete(key)
    }).catch(() => {})
    return operation
  }

  function cancel () {
    for (const entry of inFlight.values()) entry.abortController.abort()
  }

  return {
    ensureClosed,
    cancel,
    evaluate: evaluateTrapdoorPassage,
    isInFlight (position) {
      const exact = copyPosition(position)
      return exact ? inFlight.has(positionKey(exact)) : false
    },
    get inFlightCount () {
      return inFlight.size
    },
  }
}

/**
 * Vendor-facing runner for Move.blockActions. cancel() resolves all callers
 * immediately; an interaction already sent to the server is not reversed.
 */
function createBlockActionRunner (bot, options = {}) {
  const controller = createTrapdoorPassageController(bot, options)
  const pending = new Set()

  function run (action) {
    if (!action || action.kind !== 'trapdoor') {
      return Promise.resolve({ ok: false, changed: false, reason: 'unsupported_block_action' })
    }
    let cancel
    const cancelled = new Promise(resolve => {
      cancel = () => resolve({ ok: false, changed: false, reason: 'cancelled' })
    })
    const token = { cancel }
    pending.add(token)
    return Promise.race([controller.ensureClosed(action), cancelled])
      .finally(() => pending.delete(token))
  }

  function cancel () {
    controller.cancel()
    for (const token of [...pending]) token.cancel()
    pending.clear()
  }

  return {
    run,
    cancel,
    get pendingCount () { return pending.size },
  }
}

function installTrapdoorPassage (moves, bot, options = {}) {
  if (!moves || !bot) throw new TypeError('moves and bot are required')
  if (moves[TRAPDOOR_INSTALL]) return moves[TRAPDOOR_INSTALL]

  const planning = patchTrapdoorMoves(moves, bot)
  const runner = createBlockActionRunner(bot, { ...options, Vec3: options.Vec3 || DefaultVec3 })
  const previousExecute = bot._executePathBlockAction
  const previousCancel = bot._cancelPathBlockAction

  bot._executePathBlockAction = async action => {
    if (action?.kind !== 'trapdoor') {
      if (typeof previousExecute === 'function') return previousExecute(action)
      throw new Error(`unsupported path block action: ${action?.kind || 'unknown'}`)
    }
    const result = await runner.run(action)
    if (result?.ok === true) return result
    const error = new Error(`trapdoor action failed: ${result?.reason || 'unknown'}`)
    error.code = result?.reason || 'ETRAPDOOR'
    error.result = result
    throw error
  }
  bot._cancelPathBlockAction = () => {
    runner.cancel()
    if (typeof previousCancel === 'function') previousCancel()
  }

  const cancel = () => runner.cancel()
  bot.on?.('death', cancel)
  bot.on?.('end', cancel)

  const handle = Object.freeze({ planning, runner, cancel })
  Object.defineProperty(moves, TRAPDOOR_INSTALL, { value: handle, configurable: true })
  return handle
}

module.exports = {
  ROLE_SUPPORT,
  ROLE_BODY,
  ROLE_HEAD,
  TRAPDOOR_NAMES,
  buildTrapdoorForwardMove,
  closedGeometryIsPassable,
  createBlockActionRunner,
  createTrapdoorPassageController,
  evaluateTrapdoorPassage,
  installTrapdoorPassage,
  isPassableDoor,
  isRegularDoorName,
  isTrapdoorName,
  makeTrapdoorPassageAction,
  patchTrapdoorMoves,
  readProperties,
  trapdoorMaterial,
}

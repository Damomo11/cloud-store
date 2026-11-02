'use strict'

const { Vec3 } = require('vec3')

// These blocks have a solid rim but an open centre. Pathfinder models their
// collision as a full support surface, so a node centred above one can drop the
// bot into the cavity. Water/lava/powder-snow cauldrons are separate block names
// in modern protocol registries and must be covered explicitly.
const HOLLOW_CONTAINER_NAMES = Object.freeze([
  'cauldron',
  'water_cauldron',
  'lava_cauldron',
  'powder_snow_cauldron',
  'composter',
  'hopper'
])
const HOLLOW_CONTAINER_SET = new Set(HOLLOW_CONTAINER_NAMES)
const SHULKER_BOX_NAMES = Object.freeze([
  'shulker_box',
  'white_shulker_box',
  'orange_shulker_box',
  'magenta_shulker_box',
  'light_blue_shulker_box',
  'yellow_shulker_box',
  'lime_shulker_box',
  'pink_shulker_box',
  'gray_shulker_box',
  'light_gray_shulker_box',
  'cyan_shulker_box',
  'purple_shulker_box',
  'blue_shulker_box',
  'brown_shulker_box',
  'green_shulker_box',
  'red_shulker_box',
  'black_shulker_box'
])
const UNSAFE_CONTAINER_SUPPORT_SET = new Set([...HOLLOW_CONTAINER_NAMES, ...SHULKER_BOX_NAMES])
const CARDINAL_DIRECTIONS = Object.freeze([
  Object.freeze({ x: -1, z: 0 }),
  Object.freeze({ x: 1, z: 0 }),
  Object.freeze({ x: 0, z: -1 }),
  Object.freeze({ x: 0, z: 1 })
])
const HARD_ESCAPE_HAZARDS = new Set([
  'lava',
  'fire',
  'soul_fire',
  'powder_snow',
  'cactus',
  'magma_block',
  'sweet_berry_bush',
  'cobweb',
  'web'
])
const DEFAULT_ESCAPE_TIMEOUT_MS = 4000
const DEFAULT_RETRY_COOLDOWN_MS = 1000
const DEFAULT_AVOID_TTL_MS = 120000
const INSTALL_STATE = Symbol('hollowContainerSupport')

function blockName (blockOrName) {
  if (typeof blockOrName === 'string') return blockOrName
  return typeof blockOrName?.name === 'string' ? blockOrName.name : null
}

function isHollowContainer (blockOrName) {
  return HOLLOW_CONTAINER_SET.has(blockName(blockOrName))
}

function isUnsafeContainerSupport (blockOrName) {
  return UNSAFE_CONTAINER_SUPPORT_SET.has(blockName(blockOrName))
}

function supportPositionForNode (node) {
  if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.z)) return null
  return {
    x: Math.floor(node.x),
    y: Math.floor(node.y) - 1,
    z: Math.floor(node.z)
  }
}

function filterHollowContainerNeighbors (neighbors, blockAt) {
  if (!Array.isArray(neighbors) || typeof blockAt !== 'function') return neighbors
  return neighbors.filter(node => {
    const support = supportPositionForNode(node)
    if (!support) return true
    try {
      return !isUnsafeContainerSupport(blockAt(support))
    } catch (_) {
      // An unloaded block must not erase a potentially valid A* edge. Runtime
      // recovery remains the final guard when world data becomes available.
      return true
    }
  })
}

function patchHollowContainerNeighbors (moves, blockAt) {
  if (!moves || typeof moves.getNeighbors !== 'function') {
    throw new TypeError('moves.getNeighbors is required')
  }
  if (typeof blockAt !== 'function') throw new TypeError('blockAt is required')

  const original = moves.getNeighbors
  function getNeighborsWithoutHollowLandings (node) {
    const neighbors = original.call(this, node)
    return filterHollowContainerNeighbors(neighbors, blockAt)
  }
  moves.getNeighbors = getNeighborsWithoutHollowLandings

  let restored = false
  return function restoreHollowContainerNeighbors () {
    if (restored) return false
    restored = true
    if (moves.getNeighbors === getNeighborsWithoutHollowLandings) moves.getNeighbors = original
    return true
  }
}

function isHazardousEscapeBlock (block) {
  const name = blockName(block)
  return block?.liquid === true ||
    (name !== null && (HARD_ESCAPE_HAZARDS.has(name) || name.endsWith('_campfire')))
}

function isPassableEscapeBlock (block) {
  if (!block || isHazardousEscapeBlock(block)) return false
  const name = blockName(block)
  // Escape owns a pathfinder pause token, so the ordinary door controller is
  // intentionally inactive. Do not select an apparently-safe patched door or
  // trapdoor volume that may still be physically closed.
  if (name?.endsWith('_door') || name?.endsWith('_fence_gate')) return false
  if (block.safe === true) return true
  if (block.physical === true) return false
  if (block.boundingBox === 'empty') return true
  return Array.isArray(block.shapes) && block.shapes.length === 0
}

function isStableEscapeSupport (block) {
  if (!block || isUnsafeContainerSupport(block) || isHazardousEscapeBlock(block)) return false
  if (block.physical === true) return true
  return block.boundingBox === 'block' && block.safe !== true
}

function finiteXZ (point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.z)
    ? { x: point.x, z: point.z }
    : null
}

function targetXZ (target) {
  return finiteXZ(target?.entity?.position) || finiteXZ(target)
}

function escapeCandidate (column, direction, sampleBlock) {
  const x = column.x + direction.x
  const z = column.z + direction.z

  const flat = isStableEscapeSupport(sampleBlock(x, column.y - 1, z)) &&
    isPassableEscapeBlock(sampleBlock(x, column.y, z)) &&
    isPassableEscapeBlock(sampleBlock(x, column.y + 1, z))
  if (flat) {
    return {
      x: direction.x,
      z: direction.z,
      rise: 0,
      kind: 'flat',
      destination: { x: x + 0.5, y: column.y, z: z + 0.5 }
    }
  }

  const stepUp = isStableEscapeSupport(sampleBlock(x, column.y, z)) &&
    isPassableEscapeBlock(sampleBlock(x, column.y + 1, z)) &&
    isPassableEscapeBlock(sampleBlock(x, column.y + 2, z))
  if (stepUp) {
    return {
      x: direction.x,
      z: direction.z,
      rise: 1,
      kind: 'step_up',
      destination: { x: x + 0.5, y: column.y + 1, z: z + 0.5 }
    }
  }

  return null
}

function chooseSafeEscapeDirection (column, sampleBlock, options = {}) {
  if (!column || !Number.isFinite(column.x) || !Number.isFinite(column.y) || !Number.isFinite(column.z)) return null
  if (typeof sampleBlock !== 'function') return null

  const target = targetXZ(options.target)
  const position = finiteXZ(options.position)
  const candidates = []
  for (let order = 0; order < CARDINAL_DIRECTIONS.length; order++) {
    const candidate = escapeCandidate(column, CARDINAL_DIRECTIONS[order], sampleBlock)
    if (!candidate) continue
    const reference = target || position
    const distance = reference
      ? Math.hypot(candidate.destination.x - reference.x, candidate.destination.z - reference.z)
      : 0
    candidates.push({ ...candidate, distance, order })
  }

  // A level exit is more reliable than jumping onto an adjacent full block.
  // Within the same class, head toward the active goal (or the nearest edge).
  candidates.sort((a, b) => a.rise - b.rise || a.distance - b.distance || a.order - b.order)
  if (candidates.length === 0) return null
  const { distance: _distance, order: _order, ...chosen } = candidates[0]
  return chosen
}

function hasLeftContainerColumn (position, column) {
  if (!finiteXZ(position) || !column) return false
  return Math.floor(position.x) !== column.x || Math.floor(position.z) !== column.z
}

function containerAtEntityPosition (bot) {
  const position = bot?.entity?.position
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return null
  const column = {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  }
  try {
    const block = bot.blockAt(new Vec3(column.x, column.y, column.z), false)
    return isUnsafeContainerSupport(block) ? { block, column } : null
  } catch (_) {
    return null
  }
}

function createMovementSampler (moves, column) {
  if (typeof moves?.getBlock !== 'function') return () => null
  return (x, y, z) => {
    try {
      return moves.getBlock(column, x - column.x, y - column.y, z - column.z)
    } catch (_) {
      return null
    }
  }
}

function setEscapeControls (bot, direction) {
  if (typeof bot?.setControlState !== 'function') return
  bot.setControlState('back', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  bot.setControlState('sneak', false)
  bot.setControlState('sprint', false)
  bot.setControlState('forward', true)
  bot.setControlState('jump', true)

  if (typeof bot.look === 'function') {
    try {
      const looking = bot.look(Math.atan2(-direction.x, -direction.z), 0, true)
      if (looking && typeof looking.catch === 'function') looking.catch(() => {})
    } catch (_) { /* control input still provides a bounded fallback */ }
  }
}

function clearEscapeControls (bot) {
  if (typeof bot?.setControlState !== 'function') return
  bot.setControlState('forward', false)
  bot.setControlState('jump', false)
  bot.setControlState('sprint', false)
}

function createHollowContainerEscapeController (moves, bot, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const timeoutMs = Math.max(250, Number(options.timeoutMs) || DEFAULT_ESCAPE_TIMEOUT_MS)
  const retryCooldownMs = Math.max(0, Number(options.retryCooldownMs) || DEFAULT_RETRY_COOLDOWN_MS)
  const avoidTtlMs = Math.max(1000, Number(options.avoidTtlMs) || DEFAULT_AVOID_TTL_MS)
  const logger = options.logger || null
  let active = null
  let retryAfter = 0

  function resumeOwnedPause (escape, reason) {
    if (!escape?.pauseToken || typeof bot?.pathfinder?.resumeControls !== 'function') return false
    try {
      return bot.pathfinder.resumeControls(escape.pauseToken, reason) === true
    } catch (_) {
      return false
    }
  }

  function finish (reason, avoid) {
    if (!active) return false
    const escape = active
    active = null
    clearEscapeControls(bot)

    if (avoid && typeof bot?._avoidPathNode === 'function') {
      try {
        bot._avoidPathNode(
          { x: escape.column.x, y: escape.column.y + 1, z: escape.column.z },
          `hollow_container_escape:${escape.name}`,
          avoidTtlMs
        )
      } catch (_) { /* avoidance is advisory; never strand the pause token */ }
    }
    resumeOwnedPause(escape, `hollow_container_${reason}`)
    return true
  }

  function begin (found, direction, startedAt) {
    let pauseToken = null
    const pathfinder = bot?.pathfinder
    if (pathfinder?.goal && typeof pathfinder.pauseControls === 'function') {
      let alreadyPaused = false
      try { alreadyPaused = pathfinder.isControlPaused?.() === true } catch (_) { /* try pause below */ }
      if (!alreadyPaused) {
        try { pauseToken = pathfinder.pauseControls('hollow_container_escape') } catch (_) { /* continue without ownership */ }
      }
    }

    active = {
      name: blockName(found.block),
      column: found.column,
      direction,
      startedAt,
      deadlineAt: startedAt + timeoutMs,
      pauseToken,
      goal: pathfinder?.goal || null
    }
    setEscapeControls(bot, direction)
  }

  return {
    tick () {
      const tickNow = now()
      // Warehouse inventory tasks own the bot while no navigation goal exists.
      if (options.requireActiveGoal && !bot?.pathfinder?.goal) {
        finish('no_goal', false)
        return 'idle'
      }
      if (active) {
        const pathfinder = bot?.pathfinder
        const goalChanged = (pathfinder?.goal || null) !== active.goal
        const pauseLost = active.pauseToken && pathfinder?.isControlPaused?.() !== true
        if (goalChanged || pauseLost) {
          finish(goalChanged ? 'goal_changed' : 'pause_lost', false)
          return 'aborted'
        }
        const position = bot?.entity?.position
        if (hasLeftContainerColumn(position, active.column) && bot?.entity?.onGround === true) {
          finish('complete', true)
          return 'escaped'
        }
        if (tickNow >= active.deadlineAt) {
          retryAfter = tickNow + retryCooldownMs
          const name = active.name
          finish('timeout', false)
          logger?.warn?.(`hollow container escape timed out (${name})`)
          return 'timeout'
        }
        setEscapeControls(bot, active.direction)
        return 'escaping'
      }

      if (tickNow < retryAfter) return 'cooldown'
      const found = containerAtEntityPosition(bot)
      if (!found) return 'idle'
      // pauseControls is an ownership boundary used by eating, survival and
      // other recovery flows. Do not override another controller's movement;
      // this rescue will start on the first tick after that owner resumes.
      if (bot?.pathfinder?.goal && bot.pathfinder.isControlPaused?.() === true) return 'paused'
      const direction = chooseSafeEscapeDirection(
        found.column,
        createMovementSampler(moves, found.column),
        { position: bot.entity.position, target: bot?.pathfinder?.goal }
      )
      if (!direction) return 'blocked'

      begin(found, direction, tickNow)
      return 'started'
    },

    abort (reason = 'abort') {
      retryAfter = 0
      return finish(reason, false)
    },

    snapshot () {
      if (!active) return { active: false, retryAfter }
      return {
        active: true,
        name: active.name,
        column: { ...active.column },
        direction: { ...active.direction, destination: { ...active.direction.destination } },
        startedAt: active.startedAt,
        deadlineAt: active.deadlineAt,
        ownsPauseToken: active.pauseToken !== null,
        retryAfter
      }
    }
  }
}

function installHollowContainerSupport (moves, bot, options = {}) {
  if (!bot || typeof bot.on !== 'function' || typeof bot.removeListener !== 'function') {
    throw new TypeError('bot EventEmitter API is required')
  }
  if (moves?.[INSTALL_STATE]) return moves[INSTALL_STATE]

  // Planning already has a world-aware raw block cache. Reuse it instead of
  // rebuilding a prismarine Block for every generated neighbor; runtime escape
  // sampling still uses the live bot APIs through its own sampler.
  const cachedRawAt = typeof moves?._rawBlockAt === 'function' ? moves._rawBlockAt : null
  const blockAt = cachedRawAt
    ? position => cachedRawAt(position.x, position.y, position.z)
    : position => bot.blockAt(new Vec3(position.x, position.y, position.z), false)
  const restoreNeighbors = patchHollowContainerNeighbors(moves, blockAt)
  const controller = createHollowContainerEscapeController(moves, bot, options)
  let installed = true

  const onPhysicsTick = () => controller.tick()
  const onDeath = () => controller.abort('death')
  const onGoalUpdated = () => controller.abort('goal_updated')
  const onPathStop = () => controller.abort('path_stop')
  const onEnd = () => uninstall('end')

  bot.on('physicsTick', onPhysicsTick)
  bot.on('death', onDeath)
  bot.on('goal_updated', onGoalUpdated)
  bot.on('path_stop', onPathStop)
  bot.on('end', onEnd)

  function uninstall (reason = 'uninstall') {
    if (!installed) return false
    installed = false
    controller.abort(reason)
    bot.removeListener('physicsTick', onPhysicsTick)
    bot.removeListener('death', onDeath)
    bot.removeListener('goal_updated', onGoalUpdated)
    bot.removeListener('path_stop', onPathStop)
    bot.removeListener('end', onEnd)
    restoreNeighbors()
    if (moves[INSTALL_STATE] === handle) delete moves[INSTALL_STATE]
    return true
  }

  const handle = Object.freeze({ controller, uninstall })
  Object.defineProperty(moves, INSTALL_STATE, {
    value: handle,
    configurable: true,
    writable: true
  })
  return handle
}

module.exports = {
  HOLLOW_CONTAINER_NAMES,
  chooseSafeEscapeDirection,
  createHollowContainerEscapeController,
  filterHollowContainerNeighbors,
  hasLeftContainerColumn,
  installHollowContainerSupport,
  isHollowContainer,
  isUnsafeContainerSupport,
  patchHollowContainerNeighbors,
  supportPositionForNode
}

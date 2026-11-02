'use strict'

const Move = require('mineflayer-pathfinder/lib/move')
const { Vec3 } = require('vec3')

const CLIMBABLE_BLOCK_NAMES = Object.freeze([
  'ladder',
  'vine',
  'scaffolding',
  'weeping_vines',
  'weeping_vines_plant',
  'twisting_vines',
  'twisting_vines_plant',
  'cave_vines',
  'cave_vines_plant'
])

const PHYSICS_COMPAT_BLOCK_NAMES = Object.freeze([
  'weeping_vines',
  'weeping_vines_plant',
  'twisting_vines',
  'twisting_vines_plant',
  'cave_vines',
  'cave_vines_plant'
])

// Descending ladders and vines is unreliable in execution (the bot stalls on
// the climbable instead of moving down), so A* must not route descents through
// them. It should walk down, drop, or use stairs/slopes instead. Ascent is
// unaffected, and scaffolding keeps its dedicated sneak-descent physics.
const DESCENT_EXCLUDED_CLIMBABLE_NAMES = Object.freeze(
  CLIMBABLE_BLOCK_NAMES.filter(name => name !== 'scaffolding')
)

const UNSUPPORTED_SCAFFOLDING_DISTANCE = 7
const CLIMB_DESCENT_SPEED = 0.15
const CLIMB_ENTRY_DOWN_READY_XZ = 0.2
const CLIMB_ENTRY_DOWN_ARRIVAL_XZ = 0.35
// Scaffolding is descended by sneaking straight down through the column. Sneak
// also enables edge protection, so if the bot arrives off-center over an
// adjacent solid block it clings to the edge and never drops (observed 0.32
// off-center stall). Only sneak once centered over the column; walk onto it
// first otherwise.
const SCAFFOLD_DESCENT_CENTER_XZ = 0.2
const RAISED_ENTRY_READY_XZ = 1.2
const RAISED_ENTRY_SUPPORT_MARGIN = 0.2
const RAISED_ENTRY_SUPPORT_STEP = 0.25
const RAISED_ENTRY_RETREAT_MAX_TICKS = 12
const RAISED_ENTRY_RETREAT_STALL_TICKS = 6
const RAISED_ENTRY_RETREAT_PROGRESS = 0.01
const CARDINAL_DIRECTIONS = Object.freeze([
  Object.freeze({ x: -1, z: 0 }),
  Object.freeze({ x: 1, z: 0 }),
  Object.freeze({ x: 0, z: -1 }),
  Object.freeze({ x: 0, z: 1 })
])
const VINE_SUPPORT_DIRECTIONS = Object.freeze([
  Object.freeze({ face: 'west', x: -1, z: 0 }),
  Object.freeze({ face: 'east', x: 1, z: 0 }),
  Object.freeze({ face: 'north', x: 0, z: -1 }),
  Object.freeze({ face: 'south', x: 0, z: 1 })
])

const INSTALLED = Symbol('olelaClimbablesInstalled')
const PHYSICS_PATCH = Symbol('olelaClimbablePhysicsPatch')

function blockProperties (block) {
  if (!block) return {}
  try {
    return block.getProperties?.() || block._properties || {}
  } catch (_) {
    return block._properties || {}
  }
}

function isUnsupportedScaffolding (block, scaffoldingId = null) {
  if (!block) return false
  const isScaffolding = block.name === 'scaffolding' ||
    (Number.isInteger(scaffoldingId) && block.type === scaffoldingId)
  if (!isScaffolding) return false
  return Number(blockProperties(block).distance) === UNSUPPORTED_SCAFFOLDING_DISTANCE
}

function isWaterloggedClimbable (block) {
  const value = blockProperties(block).waterlogged
  return value === true || String(value).toLowerCase() === 'true'
}

function resolveClimbableRegistry (registry) {
  const ids = new Set()
  const namesById = new Map()
  for (const name of CLIMBABLE_BLOCK_NAMES) {
    const definition = registry?.blocksByName?.[name]
    if (!definition) continue
    ids.add(definition.id)
    namesById.set(definition.id, name)
  }

  const physicsCompatIds = new Set()
  for (const name of PHYSICS_COMPAT_BLOCK_NAMES) {
    const definition = registry?.blocksByName?.[name]
    if (definition) physicsCompatIds.add(definition.id)
  }

  return {
    ids,
    namesById,
    physicsCompatIds,
    descentExcludedNames: new Set(DESCENT_EXCLUDED_CLIMBABLE_NAMES),
    ladderId: registry?.blocksByName?.ladder?.id ?? null,
    vineId: registry?.blocksByName?.vine?.id ?? null,
    scaffoldingId: registry?.blocksByName?.scaffolding?.id ?? null
  }
}

function registerClimbables (moves, registry) {
  if (!(moves?.climbables instanceof Set)) moves.climbables = new Set()
  const resolved = resolveClimbableRegistry(registry)
  for (const id of resolved.ids) moves.climbables.add(id)
  return resolved
}

function describeClimbable (block, resolved) {
  if (!block || !resolved?.ids?.has(block.type)) return null
  const name = resolved.namesById.get(block.type) || block.name || 'unknown'
  return {
    type: block.type,
    name,
    unsupported: isUnsupportedScaffolding(block, resolved.scaffoldingId) || isWaterloggedClimbable(block),
    needsPhysicsCompat: resolved.physicsCompatIds.has(block.type)
  }
}

function markClimbMove (move, block, direction, resolved) {
  const descriptor = describeClimbable(block, resolved)
  if (!descriptor || descriptor.unsupported) return null
  move.reachKind = 'climbable'
  move.gridY = Math.floor(move.y)
  move.climbDirection = Math.sign(direction)
  move.climbBlockType = descriptor.type
  move.climbBlockName = descriptor.name
  move.climbNeedsPhysicsCompat = descriptor.needsPhysicsCompat
  return move
}

function isRetryableRaisedEntry (node) {
  return node?.reachKind === 'climbable' &&
    node.climbTransition === 'raised_entry' &&
    node.requiresJump === true
}

function isRetryableClimbEntry (node) {
  return isRetryableRaisedEntry(node) || (
    node?.reachKind === 'climbable' &&
    node.climbTransition === 'climbable_entry_down' &&
    node.climbDirection === -1 &&
    node.climbBlockName === 'ladder' &&
    node.requiresLanding === true
  )
}

// 攀爬入口可能是唯一通路，单次碰撞不能立即拉黑；但“唯一入口”也不能成为
// 永久豁免。连续三次在同一入口实证失败后必须短时避让，让 A* 换路，或以
// noPath/guarded_stall 收敛并由上层换目标。调用方应按同一入口独立计数。
const RETRYABLE_CLIMB_ENTRY_AVOID_AFTER_FAILURES = 3

function shouldEscalateRetryableClimbEntry (node, failureCount) {
  return isRetryableClimbEntry(node) &&
    Number.isFinite(failureCount) &&
    failureCount >= RETRYABLE_CLIMB_ENTRY_AVOID_AFTER_FAILURES
}

function moveCost (moves, block) {
  let cost = 1
  if (typeof moves.exclusionStep === 'function') cost += moves.exclusionStep(block)
  if (typeof moves.getNumEntitiesAt === 'function' && block?.position) {
    cost += moves.getNumEntitiesAt(block.position, 0, 0, 0) * (moves.entityCost ?? 1)
  }
  return cost
}

function samePosition (move, block) {
  return move.x === block.position.x && move.y === block.position.y && move.z === block.position.z
}

function isClearForClimbing (block, resolved) {
  const climbable = describeClimbable(block, resolved)
  if (climbable) return !climbable.unsupported
  return block?.safe === true && block?.liquid !== true
}

function addVerticalClimbMove (moves, node, direction, neighbors, resolved) {
  const current = moves.getBlock(node, 0, 0, 0)
  const currentDescriptor = describeClimbable(current, resolved)
  const target = moves.getBlock(node, 0, direction, 0)
  const targetDescriptor = describeClimbable(target, resolved)

  // A wall ladder or hanging vine can start one block above a walkable floor.
  // Enter it with a grounded vertical jump; this is not a general air/tower
  // edge because the target must already be a supported climbable volume.
  if (!currentDescriptor) {
    if (direction <= 0 || !targetDescriptor) return false
    if (targetDescriptor.unsupported) return true
    if (!hasExecutableVerticalSupport(moves, target, targetDescriptor)) return true

    const floor = moves.getBlock(node, 0, -1, 0)
    const head = moves.getBlock(node, 0, 2, 0)
    if (
      floor?.physical !== true ||
      !isClearForClimbing(current, resolved) ||
      !isClearForClimbing(head, resolved)
    ) return true

    const cost = moveCost(moves, target) + 1
    if (cost >= 100) return true
    const move = new Move(
      target.position.x,
      target.position.y,
      target.position.z,
      node.remainingBlocks,
      cost
    )
    markClimbMove(move, target, direction, resolved)
    move.requiresJump = true
    move.climbTransition = 'climbable_entry_up'
    neighbors.push(move)
    return true
  }
  if (currentDescriptor.unsupported) return true
  if (!hasExecutableVerticalSupport(moves, current, currentDescriptor)) return true

  if (!targetDescriptor) {
    if (
      direction > 0 &&
      isClearForClimbing(target, resolved) &&
      isClearForClimbing(moves.getBlock(node, 0, 2, 0), resolved)
    ) {
      const cost = moveCost(moves, target)
      if (cost < 100) {
        const move = new Move(
          target.position.x,
          target.position.y,
          target.position.z,
          node.remainingBlocks,
          cost
        )
        markClimbMove(move, current, direction, resolved)
        move.climbTransition = currentDescriptor.name === 'scaffolding'
          ? 'scaffolding_top'
          : 'climbable_top'
        neighbors.push(move)
      }
    }
    return true
  }
  if (targetDescriptor.unsupported) return true
  if (!hasExecutableVerticalSupport(moves, target, targetDescriptor)) return true

  if (direction > 0) {
    const head = moves.getBlock(node, 0, 2, 0)
    if (!isClearForClimbing(head, resolved)) return true
  }

  const cost = moveCost(moves, target)
  if (cost >= 100) return true
  const move = new Move(
    target.position.x,
    target.position.y,
    target.position.z,
    node.remainingBlocks,
    cost
  )
  markClimbMove(move, target, direction, resolved)
  neighbors.push(move)
  return true
}

function addCardinalEntryMove (moves, node, dir, neighbors, resolved, originalForward) {
  const before = neighbors.length
  originalForward(node, dir, neighbors)

  const target = moves.getBlock(node, dir.x, 0, dir.z)
  const descriptor = describeClimbable(target, resolved)
  if (!descriptor) return

  // Rebuild climbable entry without a floor placement. Hanging vines and
  // ladders are valid volumes even when the block below is air.
  for (let i = neighbors.length - 1; i >= before; i--) {
    if (samePosition(neighbors[i], target)) neighbors.splice(i, 1)
  }
  if (descriptor.unsupported) return

  const source = moves.getBlock(node, 0, 0, 0)
  const sourceDescriptor = describeClimbable(source, resolved)
  if (sourceDescriptor?.unsupported) return

  const head = moves.getBlock(node, dir.x, 1, dir.z)
  if (!isClearForClimbing(head, resolved)) return

  const cost = moveCost(moves, target)
  if (cost >= 100) return
  const move = new Move(
    target.position.x,
    target.position.y,
    target.position.z,
    node.remainingBlocks,
    cost
  )
  markClimbMove(move, target, 0, resolved)
  neighbors.push(move)
}

function filterUnsafeClimbMoves (moves, node, neighbors, resolved) {
  const source = describeClimbable(moves.getBlock(node, 0, 0, 0), resolved)
  return neighbors.filter(move => {
    const dx = move.x - node.x
    const dy = move.y - node.y
    const dz = move.z - node.z
    const targetBlock = moves.getBlock(move, 0, 0, 0)
    const target = describeClimbable(targetBlock, resolved)

    if (target?.unsupported) return false
    if (dy !== 0) {
      if (source && !hasExecutableVerticalSupport(moves, moves.getBlock(node, 0, 0, 0), source)) return false
      if (target && !hasExecutableVerticalSupport(moves, targetBlock, target)) return false
    }
    if (dx !== 0 && dz !== 0 && (source || target)) return false
    if (target && (dx !== 0 || dz !== 0) && dy !== 0) {
      const landingBlock = moves.getBlock(node, dx, 0, dz)
      const cardinalRaisedEntry = !source &&
        Math.abs(dx) + Math.abs(dz) === 1 &&
        dy === 1 &&
        move.requiresJump === true &&
        Array.isArray(move.toBreak) && move.toBreak.length === 0 &&
        Array.isArray(move.toPlace) && move.toPlace.length === 0 &&
        landingBlock?.physical === true &&
        !describeClimbable(landingBlock, resolved)
      if (!cardinalRaisedEntry || !markClimbMove(move, targetBlock, dy, resolved)) return false
      move.climbTransition = 'raised_entry'
      return true
    }
    if (target && !markClimbMove(move, targetBlock, dy, resolved)) return false
    if (
      !source &&
      target?.name === 'ladder' &&
      dx === 0 &&
      dz === 0 &&
      dy === -1 &&
      move.requiresLanding === true
    ) {
      // The native drop edge is valid, but execution must first move the
      // player's hitbox completely off the top platform and into the ladder.
      move.climbTransition = 'climbable_entry_down'
    }
    // Descent avoidance: never route downward through ladders/vines, whether it
    // is a mid-column step or a top-of-ladder entry. Their descent execution
    // stalls, so drop these edges and let A* pick walking, drops, or scaffolding
    // instead. Upward climbs and scaffolding descents are untouched.
    if (move.climbDirection === -1 && resolved.descentExcludedNames.has(move.climbBlockName)) {
      return false
    }
    return true
  })
}

function mappedBlock (block, mappedIds, vineId, scaffoldingId = null) {
  const shouldMap = block && (
    mappedIds.has(block.type) ||
    (Number.isInteger(scaffoldingId) && block.type === scaffoldingId)
  )
  if (!shouldMap || !Number.isInteger(vineId)) return block
  return new Proxy(block, {
    get (target, property, receiver) {
      if (property === 'type') return vineId
      // Modern vines are already collision-empty. Scaffolding is not: its
      // static top plate stops prismarine-physics at every layer even though
      // the server lets a jumping player climb through it. During an explicit
      // vertical scaffolding edge, use vine collision semantics as well as the
      // vine type, then restore real collision as soon as the edge ends.
      if (property === 'boundingBox') return 'empty'
      if (property === 'shapes') return []
      return Reflect.get(target, property, receiver)
    }
  })
}

function installClimbPhysicsCompatibility (bot, resolved) {
  const physics = bot?.physics
  if (!physics || typeof physics.simulatePlayer !== 'function') {
    return {
      setPhase: () => {},
      clear: () => {},
      state: { active: false, direction: 0, blockName: null }
    }
  }

  let patch = physics[PHYSICS_PATCH]
  if (!patch) {
    const original = physics.simulatePlayer.bind(physics)
    patch = {
      active: false,
      direction: 0,
      blockName: null,
      mappedIds: new Set(),
      vineId: resolved.vineId,
      scaffoldingId: resolved.scaffoldingId,
      original
    }
    physics[PHYSICS_PATCH] = patch
    physics.simulatePlayer = function simulateClimbablePlayer (state, world) {
      if (!patch.active) return patch.original(state, world)

      const startY = state?.pos?.y
      const climbWorld = world && typeof world.getBlock === 'function'
        ? Object.assign(Object.create(world), {
            getBlock: position => mappedBlock(
              world.getBlock(position),
              patch.mappedIds,
              patch.vineId,
              patch.blockName === 'scaffolding' ? patch.scaffoldingId : null
            )
          })
        : world
      const result = patch.original(state, climbWorld)

      // Prismarine Physics already recognizes scaffolding for ascent, but it
      // models sneak as a ladder hold. Vanilla requires sneak to pass down
      // through the top platform, so keep the predicted client position in
      // step with that server-side descent while this explicit edge is active.
      if (
        patch.direction < 0 &&
        patch.blockName === 'scaffolding' &&
        Number.isFinite(startY) &&
        result?.pos &&
        result?.vel
      ) {
        result.pos.y = Math.min(result.pos.y, startY - CLIMB_DESCENT_SPEED)
        result.vel.y = -CLIMB_DESCENT_SPEED
        result.onGround = false
      }
      return result
    }
  }

  for (const id of resolved.physicsCompatIds) patch.mappedIds.add(id)
  if (Number.isInteger(resolved.vineId)) patch.vineId = resolved.vineId
  if (Number.isInteger(resolved.scaffoldingId)) patch.scaffoldingId = resolved.scaffoldingId

  return {
    state: patch,
    setPhase (direction, blockName) {
      patch.active = true
      patch.direction = Math.sign(direction)
      patch.blockName = blockName || null
    },
    clear () {
      patch.active = false
      patch.direction = 0
      patch.blockName = null
    }
  }
}

function setControl (bot, name, value) {
  if (typeof bot?.setControlState === 'function') bot.setControlState(name, value)
}

function climbNodeKey (point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return null
  return `${point.x},${point.y},${point.z}`
}

function horizontalDistanceTo (position, point) {
  if (!position || !point) return null
  const dx = point.x - position.x
  const dz = point.z - position.z
  return Number.isFinite(dx) && Number.isFinite(dz) ? Math.hypot(dx, dz) : null
}

function isStandingSupport (block) {
  if (!block || block.name === 'air' || block.name === 'powder_snow' || block.name === 'water' || block.name === 'lava') return false
  return block.name === 'snow' || block.boundingBox === 'block' || (Array.isArray(block.shapes) && block.shapes.length > 0)
}

function resolveAttachedVineSupport (vine, getAdjacent) {
  if (vine?.name !== 'vine' || typeof getAdjacent !== 'function') return null
  const properties = blockProperties(vine)
  const attached = VINE_SUPPORT_DIRECTIONS.filter(direction => properties[direction.face] === true)
  for (const direction of attached) {
    let support = null
    try { support = getAdjacent(direction) } catch (_) { continue }
    if (!isStandingSupport(support)) continue
    return {
      ...direction,
      blockName: support.name || 'unknown'
    }
  }
  return null
}

function hasExecutableVerticalSupport (moves, block, descriptor) {
  // True-server evidence: even a vine with a collidable backing block and a
  // sustained forward+jump input only rises 0.5-0.77 blocks before the server
  // corrects it back down. Treat ordinary vines as passable volumes, never as
  // vertical edges; A* can still use ladders, scaffolding, modern vines, dig,
  // or placement routes without burning a target navigation window here.
  return descriptor?.name !== 'vine'
}

function resolveVineClimbSupport (bot, nextPoint) {
  if (nextPoint?.climbBlockName !== 'vine' || typeof bot?.blockAt !== 'function') return null

  const gridY = Number.isFinite(nextPoint.gridY) ? nextPoint.gridY : Math.floor(nextPoint.y)
  const x = Math.floor(nextPoint.x)
  const z = Math.floor(nextPoint.z)
  // A climbable_top execution node occupies the air above the last vine, so
  // inspect both the destination layer and the layer immediately below it.
  for (const y of [gridY, gridY - 1]) {
    let vine = null
    try { vine = bot.blockAt(new Vec3(x, y, z)) } catch (_) { continue }
    if (vine?.name !== 'vine') continue

    const direction = resolveAttachedVineSupport(
      vine,
      adjacent => bot.blockAt(new Vec3(x + adjacent.x, y, z + adjacent.z))
    )
    if (direction) return { ...direction, x: x + direction.x, y, z: z + direction.z }
  }
  return null
}

function hasRaisedEntryRetreatSupport (bot, nextPoint, distance) {
  const entity = bot?.entity
  const position = entity?.position
  if (!position || typeof bot?.blockAt !== 'function' || entity.isInWater || entity.onGround !== true) return false

  const dx = nextPoint.x - position.x
  const dz = nextPoint.z - position.z
  if (!Number.isFinite(distance) || distance < 0.001) return false

  const retreat = Math.max(0, RAISED_ENTRY_READY_XZ - distance) + RAISED_ENTRY_SUPPORT_MARGIN
  const offsets = []
  for (let offset = RAISED_ENTRY_SUPPORT_STEP; offset < retreat; offset += RAISED_ENTRY_SUPPORT_STEP) offsets.push(offset)
  offsets.push(retreat)

  for (const offset of offsets) {
    const sample = new Vec3(
      position.x - (dx / distance) * offset,
      position.y - 0.2,
      position.z - (dz / distance) * offset
    )
    let support = null
    try { support = bot.blockAt(sample.floored()) } catch (_) { return false }
    if (!isStandingSupport(support)) return false
  }
  return true
}

function createClimbController (bot, physicsCompatibility) {
  let raisedEntryState = null
  let downEntryActive = false

  function clearHorizontalVelocity () {
    if (!bot?.entity?.velocity) return
    bot.entity.velocity.x = 0
    bot.entity.velocity.z = 0
  }

  function clearRaisedEntryState () {
    if (!raisedEntryState) return
    raisedEntryState = null
    clearHorizontalVelocity()
    setControl(bot, 'forward', false)
    setControl(bot, 'back', false)
    setControl(bot, 'jump', false)
    setControl(bot, 'sprint', false)
    setControl(bot, 'left', false)
    setControl(bot, 'right', false)
    setControl(bot, 'sneak', false)
  }

  function clearDownEntryState () {
    if (!downEntryActive) return
    downEntryActive = false
    clearHorizontalVelocity()
    setControl(bot, 'forward', false)
    setControl(bot, 'back', false)
    setControl(bot, 'jump', false)
    setControl(bot, 'sprint', false)
    setControl(bot, 'left', false)
    setControl(bot, 'right', false)
    setControl(bot, 'sneak', false)
  }

  function applyRaisedEntryControls (nextPoint) {
    const key = climbNodeKey(nextPoint)
    const distance = horizontalDistanceTo(bot?.entity?.position, nextPoint)

    if (!raisedEntryState || raisedEntryState.key !== key) {
      clearRaisedEntryState()
      const shouldRetreat = key && Number.isFinite(distance) && distance < RAISED_ENTRY_READY_XZ &&
        hasRaisedEntryRetreatSupport(bot, nextPoint, distance)
      raisedEntryState = {
        key,
        phase: shouldRetreat ? 'retreat' : 'advance',
        retreatTicks: 0,
        stalledTicks: 0,
        bestDistance: distance
      }
      if (shouldRetreat) clearHorizontalVelocity()
    }

    setControl(bot, 'sprint', false)
    setControl(bot, 'left', false)
    setControl(bot, 'right', false)
    setControl(bot, 'sneak', false)

    if (raisedEntryState.phase === 'retreat') {
      const currentDistance = horizontalDistanceTo(bot?.entity?.position, nextPoint)
      if (Number.isFinite(currentDistance) && currentDistance >= RAISED_ENTRY_READY_XZ) {
        raisedEntryState.phase = 'advance'
        clearHorizontalVelocity()
        setControl(bot, 'forward', false)
        setControl(bot, 'back', false)
        setControl(bot, 'jump', false)
        return true
      }

      raisedEntryState.retreatTicks += 1
      if (Number.isFinite(currentDistance) && currentDistance >= raisedEntryState.bestDistance + RAISED_ENTRY_RETREAT_PROGRESS) {
        raisedEntryState.bestDistance = currentDistance
        raisedEntryState.stalledTicks = 0
      } else {
        raisedEntryState.stalledTicks += 1
      }

      // This preparation phase must never become a second stuck state.
      if (
        raisedEntryState.retreatTicks >= RAISED_ENTRY_RETREAT_MAX_TICKS ||
        raisedEntryState.stalledTicks >= RAISED_ENTRY_RETREAT_STALL_TICKS
      ) {
        raisedEntryState.phase = 'advance'
        clearHorizontalVelocity()
        setControl(bot, 'forward', false)
        setControl(bot, 'back', false)
        setControl(bot, 'jump', false)
        return true
      }

      setControl(bot, 'forward', false)
      setControl(bot, 'back', bot?.entity?.onGround === true)
      setControl(bot, 'jump', false)
      return true
    }

    // Advance: the reliable entry is a run-up jump from solid ground that clears
    // the platform lip and lands inside the ladder. Committing forward+jump every
    // tick regardless of state caused the observed 3.5s stall: when the bot ends
    // up airborne on the lip (foot on the platform edge, body already in the
    // ladder) it cannot re-jump (not grounded) and forward just pins it there
    // until the pathfinder's stuck timer forces a replan.
    const advanceDistance = horizontalDistanceTo(bot?.entity?.position, nextPoint)
    if (!Number.isFinite(raisedEntryState.advanceBestDistance)) {
      raisedEntryState.advanceBestDistance = advanceDistance
      raisedEntryState.advanceStalledTicks = 0
    }

    if (bot?.entity?.onGround === true) {
      // Fresh grounded run-up jump.
      raisedEntryState.advanceStalledTicks = 0
      if (Number.isFinite(advanceDistance)) raisedEntryState.advanceBestDistance = advanceDistance
      setControl(bot, 'forward', true)
      setControl(bot, 'back', false)
      setControl(bot, 'jump', true)
      return true
    }

    // Airborne: keep carrying the jump into the ladder only while horizontal
    // progress continues. If progress stalls we are pinned on the lip, so drop
    // the inputs and clear inherited velocity to settle back onto the platform
    // for another clean grounded jump instead of hanging until a stuck reset.
    if (Number.isFinite(advanceDistance) &&
        advanceDistance <= raisedEntryState.advanceBestDistance - RAISED_ENTRY_RETREAT_PROGRESS) {
      raisedEntryState.advanceBestDistance = advanceDistance
      raisedEntryState.advanceStalledTicks = 0
      setControl(bot, 'forward', true)
      setControl(bot, 'back', false)
      setControl(bot, 'jump', true)
      return true
    }

    raisedEntryState.advanceStalledTicks = (raisedEntryState.advanceStalledTicks || 0) + 1
    if (raisedEntryState.advanceStalledTicks >= RAISED_ENTRY_RETREAT_STALL_TICKS) {
      clearHorizontalVelocity()
      setControl(bot, 'forward', false)
      setControl(bot, 'back', false)
      setControl(bot, 'jump', false)
      return true
    }
    setControl(bot, 'forward', true)
    setControl(bot, 'back', false)
    setControl(bot, 'jump', true)
    return true
  }

  function applyDownEntryControls (nextPoint) {
    clearRaisedEntryState()
    downEntryActive = true
    clearHorizontalVelocity()

    setControl(bot, 'sprint', false)
    setControl(bot, 'back', false)
    setControl(bot, 'left', false)
    setControl(bot, 'right', false)
    setControl(bot, 'jump', false)
    setControl(bot, 'sneak', false)

    const position = bot?.entity?.position
    const distance = horizontalDistanceTo(position, nextPoint)
    const gridY = Number.isFinite(nextPoint?.gridY)
      ? nextPoint.gridY
      : Number.isFinite(nextPoint?.y)
        ? Math.floor(nextPoint.y)
        : null
    const aboveTarget = position && Number.isFinite(position.y) && Number.isFinite(gridY)
      ? Math.floor(position.y + 1e-6) > gridY
      : false

    // Walk only far enough to clear the supporting platform. Once centered,
    // neutral controls let the native ladder physics descend without climbing
    // back toward the wall. Horizontal velocity is cleared on every tick so
    // inherited sprint momentum cannot carry the bot across the opening.
    const outsideArrival = Number.isFinite(distance) && distance > CLIMB_ENTRY_DOWN_ARRIVAL_XZ
    setControl(bot, 'forward', Number.isFinite(distance) &&
      distance > CLIMB_ENTRY_DOWN_READY_XZ &&
      (aboveTarget || outsideArrival))
    return true
  }

  function applyScaffoldingDescentControls (nextPoint) {
    setControl(bot, 'sprint', false)
    setControl(bot, 'back', false)
    setControl(bot, 'left', false)
    setControl(bot, 'right', false)
    setControl(bot, 'jump', false)

    const distance = horizontalDistanceTo(bot?.entity?.position, nextPoint)
    // When the position is unknown, default to descending in place. Otherwise
    // only sneak (which enables scaffolding descent and edge protection) once
    // centered over the column; while off-center, walk onto it with sneak off
    // so edge protection cannot lock the bot on an adjacent block.
    const centered = !Number.isFinite(distance) || distance <= SCAFFOLD_DESCENT_CENTER_XZ
    if (centered) {
      setControl(bot, 'forward', false)
      setControl(bot, 'sneak', true)
    } else {
      setControl(bot, 'forward', true)
      setControl(bot, 'sneak', false)
    }
    return true
  }

  function clearOwnedPhase () {
    const ownedControls = physicsCompatibility.state?.active === true
    clearRaisedEntryState()
    clearDownEntryState()
    physicsCompatibility.clear()
    if (ownedControls) setControl(bot, 'sneak', false)
  }

  return {
    applyClimbControls (nextPoint, verticalDelta = 0) {
      if (nextPoint?.reachKind !== 'climbable') {
        clearOwnedPhase()
        return false
      }

      const metadataDirection = Number(nextPoint.climbDirection)
      const direction = Number.isFinite(metadataDirection)
        ? Math.sign(metadataDirection)
        : verticalDelta > 0.05
          ? 1
          : verticalDelta < -0.05
            ? -1
            : 0
      const blockName = nextPoint.climbBlockName || null
      physicsCompatibility.setPhase(direction, blockName)
      setControl(bot, 'sprint', false)

      if (
        nextPoint.climbTransition === 'climbable_entry_down' &&
        direction === -1 &&
        blockName === 'ladder'
      ) {
        return applyDownEntryControls(nextPoint)
      }

      clearDownEntryState()

      // A cardinal one-block entry still needs horizontal momentum. Ordinary
      // column ascent and a same-column jump entry deliberately stay vertical.
      if (nextPoint.climbTransition === 'raised_entry') {
        if (nextPoint.requiresJump === true) return applyRaisedEntryControls(nextPoint)

        clearRaisedEntryState()
        setControl(bot, 'forward', true)
        setControl(bot, 'back', false)
        setControl(bot, 'left', false)
        setControl(bot, 'right', false)
        setControl(bot, 'jump', true)
        setControl(bot, 'sneak', false)
        return true
      }

      clearRaisedEntryState()

      if (direction === 0) {
        setControl(bot, 'jump', false)
        setControl(bot, 'sneak', false)
        return true
      }

      // Scaffolding descent: center over the column before sneaking down.
      if (direction < 0 && blockName === 'scaffolding') {
        return applyScaffoldingDescentControls(nextPoint)
      }

      // A normal vine only climbs on the server while the player is pressing
      // into one of its attached faces. Jumping in the middle of the block
      // looks valid to prismarine-physics but the server corrects the player
      // back down several blocks. Face the actual support and hold forward so
      // prediction and authoritative movement use the same collision.
      const vineSupport = direction > 0 && blockName === 'vine'
        ? resolveVineClimbSupport(bot, nextPoint)
        : null
      if (vineSupport && typeof bot?.look === 'function') {
        try {
          const pendingLook = bot.look(Math.atan2(-vineSupport.x + Math.floor(nextPoint.x), -vineSupport.z + Math.floor(nextPoint.z)), 0, true)
          if (pendingLook && typeof pendingLook.catch === 'function') pendingLook.catch(() => {})
        } catch (_) { /* movement remains bounded by the climb node */ }
      }

      setControl(bot, 'forward', vineSupport !== null)
      setControl(bot, 'back', false)
      setControl(bot, 'left', false)
      setControl(bot, 'right', false)
      setControl(bot, 'jump', direction > 0)
      setControl(bot, 'sneak', false)
      return true
    },

    clearClimbPhase () {
      clearOwnedPhase()
    }
  }
}

function installClimbableSupport (moves, bot = moves?.bot) {
  if (!moves || typeof moves.getBlock !== 'function') {
    throw new TypeError('installClimbableSupport requires a Movements instance')
  }
  if (moves[INSTALLED]) return moves[INSTALLED]

  const registry = bot?.registry || moves.bot?.registry
  const resolved = registerClimbables(moves, registry)
  const originalForward = moves.getMoveForward.bind(moves)
  const originalUp = moves.getMoveUp.bind(moves)
  const originalDown = moves.getMoveDown.bind(moves)
  const originalNeighbors = moves.getNeighbors.bind(moves)

  moves.getMoveForward = function getClimbableMoveForward (node, dir, neighbors) {
    addCardinalEntryMove(this, node, dir, neighbors, resolved, originalForward)
  }
  moves.getMoveUp = function getClimbableMoveUp (node, neighbors) {
    if (!addVerticalClimbMove(this, node, 1, neighbors, resolved)) originalUp(node, neighbors)
  }
  moves.getMoveDown = function getClimbableMoveDown (node, neighbors) {
    if (!addVerticalClimbMove(this, node, -1, neighbors, resolved)) originalDown(node, neighbors)
  }
  moves.getNeighbors = function getClimbableNeighbors (node) {
    return filterUnsafeClimbMoves(this, node, originalNeighbors(node), resolved)
  }

  const physicsCompatibility = installClimbPhysicsCompatibility(bot, resolved)
  const controller = Object.assign(createClimbController(bot, physicsCompatibility), {
    resolved,
    cardinalDirections: CARDINAL_DIRECTIONS
  })
  moves[INSTALLED] = controller
  return controller
}

function getClimbableController (moves) {
  return moves?.[INSTALLED] || null
}

module.exports = {
  CLIMBABLE_BLOCK_NAMES,
  PHYSICS_COMPAT_BLOCK_NAMES,
  DESCENT_EXCLUDED_CLIMBABLE_NAMES,
  UNSUPPORTED_SCAFFOLDING_DISTANCE,
  CLIMB_DESCENT_SPEED,
  CLIMB_ENTRY_DOWN_READY_XZ,
  CLIMB_ENTRY_DOWN_ARRIVAL_XZ,
  RAISED_ENTRY_READY_XZ,
  RAISED_ENTRY_RETREAT_MAX_TICKS,
  CARDINAL_DIRECTIONS,
  blockProperties,
  isWaterloggedClimbable,
  isUnsupportedScaffolding,
  resolveClimbableRegistry,
  registerClimbables,
  describeClimbable,
  markClimbMove,
  isRetryableRaisedEntry,
  isRetryableClimbEntry,
  RETRYABLE_CLIMB_ENTRY_AVOID_AFTER_FAILURES,
  shouldEscalateRetryableClimbEntry,
  installClimbPhysicsCompatibility,
  createClimbController,
  resolveVineClimbSupport,
  installClimbableSupport,
  getClimbableController
}

'use strict'

const Move = require('./move')

function cloneVector (value) {
  if (!value) return value
  if (typeof value.clone === 'function') return value.clone()
  return { ...value }
}

function clonePlacement (placement) {
  if (!placement || typeof placement !== 'object') return placement
  const cloned = { ...placement }
  if (Object.prototype.hasOwnProperty.call(placement, 'returnPos')) {
    cloned.returnPos = cloneVector(placement.returnPos)
  }
  return cloned
}

// A* owns its Move instances. Execution mutates coordinates and consumes
// toBreak/toPlace arrays, so it must receive detached copies.
function cloneMoveForExecution (node) {
  const cloned = new Move(
    node.x,
    node.y,
    node.z,
    node.remainingBlocks,
    node.cost,
    Array.isArray(node.toBreak) ? node.toBreak.map(cloneVector) : [],
    Array.isArray(node.toPlace) ? node.toPlace.map(clonePlacement) : [],
    node.parkour === true
  )

  if (node.requiresJump === true) cloned.requiresJump = true
  if (node.requiresLanding === true) cloned.requiresLanding = true
  if (typeof node.controlledDropDistance === 'number') cloned.controlledDropDistance = node.controlledDropDistance
  if (typeof node.surfaceY === 'number') cloned.surfaceY = node.surfaceY
  if (node.snowSurface === true) cloned.snowSurface = true
  if (typeof node.gridY === 'number') cloned.gridY = node.gridY
  if (typeof node.reachKind === 'string') cloned.reachKind = node.reachKind
  if (typeof node.waterDirection === 'number') cloned.waterDirection = node.waterDirection
  if (typeof node.climbDirection === 'number') cloned.climbDirection = node.climbDirection
  if (typeof node.climbBlockType === 'number') cloned.climbBlockType = node.climbBlockType
  if (typeof node.climbBlockName === 'string') cloned.climbBlockName = node.climbBlockName
  if (typeof node.climbNeedsPhysicsCompat === 'boolean') cloned.climbNeedsPhysicsCompat = node.climbNeedsPhysicsCompat
  if (typeof node.climbTransition === 'string') cloned.climbTransition = node.climbTransition
  if (typeof node.plannedSurfaceY === 'number') cloned.plannedSurfaceY = node.plannedSurfaceY
  if (node.trapdoorPassage === true) cloned.trapdoorPassage = true
  if (Array.isArray(node.blockActions)) cloned.blockActions = node.blockActions.map(clonePlacement)
  return cloned
}

function needsPreciseVerticalArrival (node, state = {}) {
  if (state.isInWater) return false
  return node?.requiresJump === true || node?.requiresLanding === true
}

function verticalVelocity (state) {
  const value = state?.velocity?.y ?? state?.vel?.y
  return Number.isFinite(value) ? value : null
}

function isSettledOnSurface (node, state, verticalDelta = null) {
  if (state?.onGround === true) return true
  if (state?.onGround !== false) return false
  const vy = verticalVelocity(state)
  // Fractional snow surfaces can keep Mineflayer's onGround flag false while
  // the server repeatedly applies the resting -0.0784 Y velocity.
  const tolerance = node?.snowSurface === true ? 0.1 : 0.03
  const atOrBelowSnowSurface = node?.snowSurface !== true || !Number.isFinite(verticalDelta) || verticalDelta >= -1e-6
  return atOrBelowSnowSurface && vy !== null && vy <= 0 && vy >= -tolerance
}

function isInsideGridY (node, position) {
  if (!Number.isFinite(node?.gridY)) return false
  return Math.floor(position.y + 1e-6) === node.gridY
}

function isWaterNodeReached (node, position) {
  if (!Number.isFinite(node?.gridY)) return false
  const currentGridY = Math.floor(position.y + 1e-6)
  // Water physics can carry the bot across an integer Y boundary between
  // planning and execution. Only accept an overshot layer in the planned
  // vertical direction; horizontal water edges retain exact-layer semantics.
  if (node.waterDirection > 0) return currentGridY >= node.gridY
  if (node.waterDirection < 0) return currentGridY <= node.gridY
  return currentGridY === node.gridY
}

function shouldForceJump (node, verticalDelta) {
  return node?.requiresJump === true && Number.isFinite(verticalDelta) && verticalDelta > 0.05
}

function verticalArrivalTolerance (node) {
  return node?.snowSurface === true ? 0.1 : 0.05
}

function horizontalArrivalTolerance (node) {
  // Water currents and buoyancy make exact block-center tracking noisy. Half a
  // block still guarantees the bot occupies the planned water column, while
  // solid-surface and climbable arrivals keep the stricter collision margin.
  return node?.reachKind === 'water' ? 0.5 : 0.35
}

function isNodeReached (node, position, state = {}) {
  if (!node || !position) return false
  const dx = node.x - position.x
  const dy = node.y - position.y
  const dz = node.z - position.z
  const horizontalTolerance = horizontalArrivalTolerance(node)
  if (Math.abs(dx) > horizontalTolerance || Math.abs(dz) > horizontalTolerance) return false

  if (node.reachKind === 'surface') {
    return Math.abs(dy) <= verticalArrivalTolerance(node) && isSettledOnSurface(node, state, dy)
  }
  if (node.reachKind === 'water') {
    return state?.isInWater === true && isWaterNodeReached(node, position)
  }
  if (node.reachKind === 'climbable') {
    return isInsideGridY(node, position)
  }

  // Compatibility for callers that construct raw Move objects without running
  // them through postProcessPath. Runtime execution nodes always have reachKind.
  if (needsPreciseVerticalArrival(node, state)) {
    return Math.abs(dy) <= verticalArrivalTolerance(node) && isSettledOnSurface(node, state, dy)
  }
  return Math.abs(dy) <= 0.999
}

module.exports = {
  cloneMoveForExecution,
  isNodeReached,
  needsPreciseVerticalArrival,
  isSettledOnSurface,
  shouldForceJump
}

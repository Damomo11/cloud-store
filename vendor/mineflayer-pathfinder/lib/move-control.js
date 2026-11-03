'use strict'

function selectMoveControls ({
  isInWater,
  descendInWater,
  requiresJump,
  preferGrounded,
  allowPlannedSnowStepHop,
  canStraightSprint,
  canSprintJump,
  canStraightWalk,
  canWalkJump
}) {
  if (isInWater) {
    if (descendInWater) {
      return { forward: true, jump: false, sneak: true, sprint: false, moveMode: 'water_descend' }
    }
    return { forward: true, jump: true, sneak: false, sprint: false, moveMode: 'water_swim' }
  }

  // Fractional-height edges are classified from real collision surfaces. The
  // straight-line simulator can still accept them, so the edge marker wins.
  if (requiresJump) {
    return {
      forward: true,
      jump: true,
      sprint: Boolean(canSprintJump),
      moveMode: canSprintJump ? 'required_sprint_jump' : 'required_walk_jump'
    }
  }

  if (canStraightSprint) {
    return { forward: true, jump: false, sprint: true, moveMode: 'straight_sprint' }
  }
  // On a flat or descending edge, a valid straight walk is more reliable than
  // a simulator-selected sprint jump, especially on fractional snow surfaces.
  if (preferGrounded && canStraightWalk) {
    return { forward: true, jump: false, sprint: false, moveMode: 'straight_walk' }
  }
  if (canSprintJump) {
    return { forward: true, jump: true, sprint: true, moveMode: 'sprint_jump' }
  }
  if (canStraightWalk) {
    return { forward: true, jump: false, sprint: false, moveMode: 'straight_walk' }
  }
  if (canWalkJump) {
    return { forward: true, jump: true, sprint: false, moveMode: 'walk_jump' }
  }
  // Layered snow can expose a server-side collision lip on a fractional step
  // in either direction. A short walk-jump clears that lip.
  // Keep this last: the caller only enables it for an adjacent, action-free
  // snow step already accepted by A*'s exact-shape clearance checks.
  if (allowPlannedSnowStepHop) {
    return { forward: true, jump: true, sprint: false, moveMode: 'planned_snow_step_hop' }
  }
  return { forward: false, jump: false, sprint: false, moveMode: 'blocked_no_motion' }
}

function isPlannedSnowStepHop ({ node, verticalDelta, horizontalDistance }) {
  if (!node || node.reachKind !== 'surface' || node.snowSurface !== true) return false
  if (node.requiresJump === true || node.requiresLanding === true) return false
  if ((node.toBreak?.length || 0) > 0 || (node.toPlace?.length || 0) > 0) return false
  if ((node.blockActions?.length || 0) > 0) return false
  if (!Number.isFinite(verticalDelta) || Math.abs(verticalDelta) <= 0.05 || Math.abs(verticalDelta) > 0.5) return false
  if (!Number.isFinite(horizontalDistance) || horizontalDistance < 0.2) return false
  return horizontalDistance <= Math.SQRT2 + 0.1
}

function advancePlannedSnowStepPulse (previous, { nodeKey, settled }) {
  const state = previous?.nodeKey === nodeKey
    ? { ...previous }
    : { nodeKey, phase: 'takeoff', sawAirborne: false }

  if (!settled) state.sawAirborne = true
  if (state.phase === 'takeoff') {
    state.phase = 'advance'
    return {
      state,
      controls: { forward: false, jump: true, sprint: false },
      moveMode: 'planned_snow_step_takeoff'
    }
  }

  // Release jump while applying horizontal motion. If takeoff did not happen,
  // or the bot landed back on the source layer, the next tick pulses again.
  if (settled) {
    state.phase = 'takeoff'
    state.sawAirborne = false
  }
  return {
    state,
    controls: { forward: true, jump: false, sprint: false },
    moveMode: 'planned_snow_step_advance'
  }
}

module.exports = { selectMoveControls, isPlannedSnowStepHop, advancePlannedSnowStepPulse }

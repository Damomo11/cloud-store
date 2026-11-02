'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  readSnowLayers,
  snowCollisionHeight,
  snowDescriptor,
  supportHeightWithSnow,
  classifySurfaceTransition
} = require('../../src/path/snow-surface')

const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')('1.21.4')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { Movements } = require('../../vendor/mineflayer-pathfinder')
const movementPlugin = { _test: { ...require('../../src/path/terrain'), ...require('../../src/path/climbables') } }
const snowDefinition = mcData.blocksByName.snow

function snowBlock (layers) {
  return Block.fromStateId(snowDefinition.minStateId + layers - 1, 0)
}

function positionedBlock (definition, position, stateId = definition.defaultState) {
  const block = Block.fromStateId(stateId, 0)
  block.position = position.clone()
  return block
}

function movementHarness () {
  const bot = new EventEmitter()
  bot.registry = mcData
  bot.entity = { isInWater: false }
  const world = new Map()
  const air = mcData.blocksByName.air

  const put = (block) => {
    world.set(block.position.toString(), block)
    return block
  }
  const putNamed = (name, x, y, z) => put(positionedBlock(mcData.blocksByName[name], new Vec3(x, y, z)))
  const putSnow = (layers, x, y, z) => {
    const block = snowBlock(layers)
    block.position = new Vec3(x, y, z)
    return put(block)
  }

  bot.blockAt = (position) => world.get(position.toString()) || positionedBlock(air, position)
  const moves = Object.create(Movements.prototype)
  Object.assign(moves, {
    climbables: new Set(),
    carpets: new Set(),
    blocksToAvoid: new Set(),
    fences: new Set(),
    replaceables: new Set(),
    liquids: new Set(),
    gravityBlocks: new Set(),
    openable: new Set(),
    exclusionAreasStep: [],
    entityCost: 1,
    getNumEntitiesAt: () => 0,
    safeToBreak: () => false,
    exclusionBreak: () => 0,
    exclusionPlace: () => 0,
    placeCost: 1
  })
  movementPlugin._test.configureGroundHazards(moves, bot, '[test]')
  movementPlugin._test.patchFastGetBlock(moves, bot, '[test]')

  return { bot, moves, putNamed, putSnow }
}

function nodeAt (x = 0, y = 1, z = 0) {
  return { x, y, z, remainingBlocks: 0 }
}

test('Minecraft 1.21.4 snow layers retain their real collision heights', () => {
  for (let layers = 1; layers <= 8; layers++) {
    const block = snowBlock(layers)
    const expectedHeight = (layers - 1) / 8
    assert.equal(readSnowLayers(block), layers)
    assert.equal(snowCollisionHeight(block), expectedHeight)

    const descriptor = snowDescriptor(block, 100)
    assert.equal(descriptor.safe, true)
    assert.equal(descriptor.physical, false)
    assert.equal(descriptor.replaceable, false)
    assert.equal(descriptor.height, 100 + expectedHeight)
  }
})

test('snow above a support block contributes its fractional surface height', () => {
  const currentSurface = supportHeightWithSnow(130, 129, snowBlock(1))
  const targetSurface = supportHeightWithSnow(131, 130, snowBlock(3))

  assert.equal(currentSurface, 130)
  assert.equal(targetSurface, 131.25)
  assert.equal(targetSurface - currentSurface, 1.25)
})


test('unknown snow metadata falls back to collision shapes without inventing height', () => {
  const block = { name: 'snow', shapes: [[0, 0, 0, 1, 0.375, 1]] }
  assert.equal(readSnowLayers(block), null)
  assert.equal(snowCollisionHeight(block), 0.375)
})

test('surface transitions distinguish stepping, jumping, and unreachable rises', () => {
  assert.deepEqual(classifySurfaceTransition(1, 1.5), { allowed: true, requiresJump: false, rise: 0.5 })
  assert.deepEqual(classifySurfaceTransition(1, 1.875), { allowed: true, requiresJump: true, rise: 0.875 })
  assert.deepEqual(classifySurfaceTransition(0.5, 1.875), { allowed: false, requiresJump: true, rise: 1.375 })
})

test('forward rejects a bottom slab to eight-layer snow rise', () => {
  const { moves, putNamed, putSnow } = movementHarness()
  putNamed('stone_slab', 0, 0, 0)
  putNamed('stone', 1, 0, 0)
  putSnow(8, 1, 1, 0)

  const node = nodeAt()
  const neighbors = []
  moves.getMoveForward(node, { x: 1, z: 0 }, neighbors)

  assert.equal(moves.getBlock(node, 0, -1, 0).height, 0.5)
  assert.equal(moves.getBlock(node, 1, 0, 0).height, 1.875)
  assert.equal(neighbors.length, 0)
})

test('forward rejects eight-layer snow without raised-surface headroom', () => {
  const { moves, putNamed, putSnow } = movementHarness()
  putNamed('stone', 0, 0, 0)
  putNamed('stone', 1, 0, 0)
  putSnow(8, 1, 1, 0)
  putNamed('stone', 1, 3, 0)

  const neighbors = []
  moves.getMoveForward(nodeAt(), { x: 1, z: 0 }, neighbors)
  assert.equal(neighbors.length, 0)
})

test('fractional snow hop rejects a ceiling that only blocks the jump arc', () => {
  const { moves, putNamed, putSnow } = movementHarness()
  putNamed('stone', 0, 0, 0)
  putSnow(4, 0, 1, 0)
  putNamed('stone', 1, 0, 0)
  putSnow(2, 1, 1, 0)
  putNamed('mangrove_log', 1, 3, 0)

  const neighbors = []
  moves.getMoveForward(nodeAt(), { x: 1, z: 0 }, neighbors)
  assert.equal(neighbors.length, 0)
})

test('destructive snow hop adds jump-arc ceiling obstruction to toBreak', () => {
  const { moves, putNamed, putSnow } = movementHarness()
  putNamed('stone', 0, 0, 0)
  putSnow(4, 0, 1, 0)
  putNamed('stone', 1, 0, 0)
  putSnow(2, 1, 1, 0)
  putNamed('mangrove_log', 1, 3, 0)
  moves.canDig = true
  moves.safeOrBreak = (block, toBreak) => {
    if (block.safe) return 0
    if (block.name !== 'mangrove_log') return 100
    toBreak.push(block.position)
    return 2
  }

  const neighbors = []
  moves.getMoveForward(nodeAt(), { x: 1, z: 0 }, neighbors)
  assert.equal(neighbors.length, 1)
  assert.deepEqual(neighbors[0].toBreak.map(pos => pos.toString()), ['(1, 3, 0)'])
  assert.equal(neighbors[0].surfaceY, 1.125)
  assert.equal(neighbors[0].plannedSurfaceY, 1.125)
  assert.equal(neighbors[0].snowSurface, true)
})

test('diagonal rejects the slab to eight-layer snow false-positive edge', () => {
  const { moves, putNamed, putSnow } = movementHarness()
  putNamed('stone_slab', 0, 0, 0)
  putNamed('stone', 1, 0, 1)
  putSnow(8, 1, 1, 1)

  const neighbors = []
  moves.getMoveDiagonal(nodeAt(), { x: 1, z: 1 }, neighbors)
  assert.equal(neighbors.length, 0)
})

test('diagonal jump-up is split into cardinal steps', () => {
  const { moves, putNamed } = movementHarness()
  movementPlugin._test.patchDiagonalCornerSafety(moves, '[test]')
  putNamed('stone', 0, 0, 0)
  putNamed('stone', 1, 1, 1)

  const neighbors = []
  moves.getMoveDiagonal(nodeAt(), { x: 1, z: 1 }, neighbors)

  assert.equal(neighbors.length, 0)
})

test('standard diagonal still rejects a solid squeeze side without breaking it', () => {
  const { moves, putNamed } = movementHarness()
  movementPlugin._test.patchDiagonalCornerSafety(moves, '[test]')
  moves.canDig = false
  putNamed('stone', 1, 0, 1)
  putNamed('oak_leaves', 0, 1, 1)

  const neighbors = []
  moves.getMoveDiagonal(nodeAt(), { x: 1, z: 1 }, neighbors)

  assert.equal(neighbors.length, 0)
})

test('canDig diagonal clears both squeeze sides before traversing the corner', () => {
  const { moves, putNamed } = movementHarness()
  movementPlugin._test.patchDiagonalCornerSafety(moves, '[test]')
  moves.canDig = true
  moves.safeOrBreak = (block, toBreak) => {
    if (block.safe) return 0
    if (block.name !== 'oak_leaves') return 100
    toBreak.push(block.position)
    return 2
  }
  putNamed('stone', 1, 0, 1)
  putNamed('oak_leaves', 0, 1, 1)
  putNamed('oak_leaves', 1, 1, 0)

  const neighbors = []
  moves.getMoveDiagonal(nodeAt(), { x: 1, z: 1 }, neighbors)

  assert.equal(neighbors.length, 1)
  assert.deepEqual(
    neighbors[0].toBreak.map(p => p.toString()).sort(),
    ['(0, 1, 1)', '(1, 1, 0)']
  )
  assert.equal(moves._diagonalCornerDebugSnapshot().addedBreakBlocks, 1)
})

test('canDig diagonal rejects an unsafe squeeze block that cannot be broken', () => {
  const { moves, putNamed } = movementHarness()
  movementPlugin._test.patchDiagonalCornerSafety(moves, '[test]')
  moves.canDig = true
  moves.safeOrBreak = (block) => block.safe ? 0 : 100
  putNamed('stone', 1, 0, 1)
  putNamed('bedrock', 0, 1, 1)

  const neighbors = []
  moves.getMoveDiagonal(nodeAt(), { x: 1, z: 1 }, neighbors)

  assert.equal(neighbors.length, 0)
  assert.equal(moves._diagonalCornerDebugSnapshot().rejectedUnbreakable, 1)
})

test('reachable eight-layer snow slope is retained and marked as a jump', () => {
  const { moves, putNamed, putSnow } = movementHarness()
  putNamed('stone', 0, 0, 0)
  putNamed('stone', 1, 0, 0)
  putSnow(8, 1, 1, 0)

  const neighbors = []
  moves.getMoveForward(nodeAt(), { x: 1, z: 0 }, neighbors)

  assert.equal(neighbors.length, 1)
  assert.equal(neighbors[0].requiresJump, true)
  assert.equal(neighbors[0].surfaceY, 1.875)
  assert.equal(neighbors[0].cost, 2)
})

test('five-layer snow remains a normal step without a jump premium', () => {
  const { moves, putNamed, putSnow } = movementHarness()
  putNamed('stone', 0, 0, 0)
  putNamed('stone', 1, 0, 0)
  putSnow(5, 1, 1, 0)

  const neighbors = []
  moves.getMoveForward(nodeAt(), { x: 1, z: 0 }, neighbors)

  assert.equal(neighbors.length, 1)
  assert.equal(neighbors[0].requiresJump, undefined)
  assert.equal(neighbors[0].surfaceY, 1.5)
  assert.equal(neighbors[0].cost, 1)
})

test('jump-up checks Y+3 headroom above stacked eight-layer snow', () => {
  const { moves, putNamed, putSnow } = movementHarness()
  putNamed('stone', 0, 0, 0)
  putSnow(8, 0, 1, 0)
  putNamed('stone', 1, 1, 0)
  putSnow(8, 1, 2, 0)
  putNamed('stone', 1, 4, 0)

  const neighbors = []
  moves.getMoveJumpUp(nodeAt(), { x: 1, z: 0 }, neighbors)
  assert.equal(neighbors.length, 0)
})

test('powder snow is a hard ground-path hazard despite its empty bounding box', () => {
  const { moves, putNamed } = movementHarness()
  putNamed('stone', 0, 0, 0)
  putNamed('stone', 1, 0, 0)
  putNamed('powder_snow', 1, 1, 0)

  const powder = moves.getBlock(nodeAt(), 1, 0, 0)
  assert.equal(powder.boundingBox, 'empty')
  assert.equal(powder.safe, false)

  const neighbors = []
  moves.getMoveForward(nodeAt(), { x: 1, z: 0 }, neighbors)
  assert.equal(neighbors.length, 0)
})


test('pulse jump suppresses exactly one simulated frame and rearms after landing', () => {
  const bot = new EventEmitter()
  bot.entity = {
    position: new Vec3(0.5, 1, 0.5),
    isInWater: false,
    onGround: true,
    velocity: new Vec3(0, 0, 0)
  }
  let pathfinderDebug = null
  bot.pathfinder = {
    isControlPaused: () => false,
    getDebugState: () => pathfinderDebug
  }
  bot.controlState = {}
  bot.setControlState = (control, state) => { bot.controlState[control] = state }
  bot.clearControlStates = () => { bot.controlState = {} }
  bot.blockAt = (position) => positionedBlock(
    position.y === 0 ? mcData.blocksByName.snow_block : mcData.blocksByName.air,
    position
  )

  const originalNow = Date.now
  let now = 1000
  Date.now = () => now
  try {
    movementPlugin._test.patchPulseJump(bot, '[test]')
    pathfinderDebug = {
      next: { x: 1.7, y: 2, z: 0.5, requiresJump: true },
      nextDelta: { xz: 1.2, dy: 1 }
    }
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    assert.equal(bot.controlState.forward, false)

    // The pulse listener runs at the end of the event that armed the jump.
    // The next simulation therefore sees the cleared controls, while the next
    // monitorMovement pass may immediately restore forward.
    bot.emit('physicsTick')
    bot.entity.onGround = false
    now += 50
    bot.setControlState('forward', true)
    bot.setControlState('jump', false)
    bot.setControlState('jump', true)
    assert.equal(bot.controlState.forward, true)
    assert.equal(bot.controlState.jump, false)

    bot.entity.onGround = true
    now += 500
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    assert.equal(bot.controlState.forward, false)

    bot.emit('physicsTick')
    bot.entity.onGround = false
    bot.entity.velocity.y = -0.0784
    bot.entity.velocity.x = 0.2
    pathfinderDebug = {
      next: { x: 1.3, y: 2, z: 0.5, requiresJump: true },
      nextDelta: { xz: 0.8, dy: 1 }
    }
    bot.clearControlStates()
    bot.emit('path_reset', 'stuck')
    assert.equal(bot.entity.velocity.x, 0.2)
    pathfinderDebug = null
    bot.emit('physicsTick')
    assert.equal(!!bot.controlState.back, false)

    // resetPath clears the old path immediately after emitting path_reset.
    // Only the first required rise on the newly assigned path may prepare.
    pathfinderDebug = {
      next: { x: 1.3, y: 2, z: 0.5, requiresJump: true },
      nextDelta: { xz: 0.8, dy: 1 }
    }
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    assert.equal(bot.entity.velocity.x, 0)
    assert.equal(!!bot.controlState.forward, false)
    assert.equal(!!bot.controlState.jump, false)

    // Schedule and simulate exactly two frames moving away from the step face.
    bot.emit('physicsTick')
    assert.equal(bot.controlState.back, true)
    assert.equal(bot.controlState.jump, false)
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    pathfinderDebug.nextDelta.dy = 0
    bot.emit('physicsTick')
    assert.equal(bot.controlState.back, true)
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    bot.entity.position.x = 0.4
    bot.emit('physicsTick')
    assert.equal(bot.controlState.back, false)

    // The previous surface node can be reported reached after this listener
    // has completed backoff for debug.next. That late event must not discard
    // the current node's preparation token and recursively start backoff.
    bot.emit('path_debug', {
      reason: 'node_reached',
      reached: { x: 0.5, y: 1, z: 0.5, reachKind: 'surface' }
    })

    // Once settled after the two backoff simulations, re-arm one pure vertical
    // takeoff even when snow still reports onGround=false.
    pathfinderDebug.nextDelta.dy = 1
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    assert.equal(bot.controlState.forward, false)
    assert.equal(bot.controlState.jump, true)

    // If the first pulse lands back on the source block without reaching the
    // rise, the same node retries its jump but must not repeat backoff.
    bot.emit('physicsTick')
    bot.entity.onGround = false
    bot.entity.velocity.y = 0.2
    bot.setControlState('jump', false)
    bot.setControlState('jump', true)
    bot.entity.onGround = true
    bot.entity.velocity.y = 0
    bot.setControlState('jump', false)
    bot.setControlState('jump', true)
    assert.equal(bot.controlState.back, false)
    assert.equal(bot.controlState.jump, true)

    // A survival pause clears the active path, so resume is signalled through
    // path_resume rather than path_reset('control_resumed'). It must re-arm the
    // same snow-surface synthetic takeoff contract.
    bot.emit('physicsTick')
    bot.clearControlStates()
    pathfinderDebug = {
      next: { x: 1.6, y: 2, z: 0.5, requiresJump: true },
      nextDelta: { xz: 1.2, dy: 1 }
    }
    bot.emit('path_resume', { resumed: true })
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    assert.equal(bot.controlState.forward, false)
    assert.equal(bot.controlState.jump, true)

    // Consecutive snow surfaces may never report onGround=true. A strict
    // node_reached for a fractional surface must end the previous jump cycle
    // so the next snow rise gets its own pre-jump pulse.
    bot.emit('physicsTick')
    bot.clearControlStates()
    bot.emit('path_debug', {
      reason: 'node_reached',
      reached: { reachKind: 'surface' },
      reachedDelta: { dy: 0 }
    })
    pathfinderDebug = {
      next: { x: 1.6, y: 2, z: 0.5, requiresJump: true },
      nextDelta: { xz: 1.2, dy: 1 }
    }
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    assert.equal(bot.controlState.forward, false)
    assert.equal(bot.controlState.jump, true)

    // A close cardinal rise performs the same two-frame backoff before the
    // first takeoff, keyed so it cannot recursively prepare the same node.
    bot.emit('physicsTick')
    bot.clearControlStates()
    bot.entity.onGround = true
    pathfinderDebug = {
      next: { x: 1.3, y: 2, z: 0.5, requiresJump: true },
      nextDelta: { xz: 0.9, dy: 1 }
    }
    bot.emit('path_debug', { reason: 'node_reached', reached: { reachKind: 'surface' } })
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    assert.equal(!!bot.controlState.jump, false)
    bot.emit('physicsTick')
    bot.emit('physicsTick')
    bot.entity.position.x = 0.3
    bot.emit('physicsTick')
    assert.equal(bot.controlState.back, false)
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    assert.equal(bot.controlState.forward, false)
    assert.equal(bot.controlState.jump, true)

    // Flat/descending physics-selected jumps keep simultaneous forward+jump;
    // only an explicit required rise receives the vertical-only pulse.
    bot.emit('physicsTick')
    bot.emit('path_debug', { reason: 'node_reached', reached: { reachKind: 'surface' } })
    bot.entity.onGround = true
    pathfinderDebug = {
      next: { x: 1.1, y: 0.75, z: 0.5 },
      nextDelta: { xz: 0.8, dy: -0.25 }
    }
    bot.clearControlStates()
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    assert.equal(bot.controlState.forward, true)
    assert.equal(bot.controlState.jump, true)

    // An active preparation is owned by the current path lifecycle. Pausing
    // or switching nodes cancels back immediately and invalidates its token.
    pathfinderDebug = {
      next: { x: 1.2, y: 2, z: 0.5, requiresJump: true },
      nextDelta: { xz: 0.9, dy: 1 }
    }
    bot.setControlState('jump', false)
    bot.setControlState('jump', true)
    bot.emit('physicsTick')
    assert.equal(bot.controlState.back, true)
    bot.emit('path_reset', 'control_paused')
    assert.equal(bot.controlState.back, false)
    bot.emit('physicsTick')
    assert.equal(bot.controlState.back, false)

    pathfinderDebug = {
      next: { x: 1.2, y: 2, z: 0.5, requiresJump: true },
      nextDelta: { xz: 0.9, dy: 1 }
    }
    bot.setControlState('jump', true)
    bot.emit('physicsTick')
    assert.equal(bot.controlState.back, true)
    pathfinderDebug = {
      next: { x: 1.25, y: 2, z: 0.5, requiresJump: true },
      nextDelta: { xz: 0.95, dy: 1 }
    }
    bot.emit('physicsTick')
    assert.equal(bot.controlState.back, false)

    pathfinderDebug = {
      next: { x: 1.2, y: 2, z: 0.5, requiresJump: true },
      nextDelta: { xz: 0.9, dy: 1 }
    }
    bot.setControlState('jump', true)
    bot.emit('physicsTick')
    assert.equal(bot.controlState.back, true)
    bot.emit('path_stop', 'test_cancel')
    assert.equal(bot.controlState.back, false)
    bot.emit('physicsTick')
    assert.equal(bot.controlState.back, false)
  } finally {
    Date.now = originalNow
  }
})

test('pulse jump keeps forward input at a water surface when isInWater flickers false', () => {
  const bot = new EventEmitter()
  bot.entity = {
    position: new Vec3(10.5, 62, 20.5),
    isInWater: false,
    onGround: false,
    velocity: new Vec3(0, 0, 0)
  }
  bot.pathfinder = {
    isControlPaused: () => false,
    getDebugState: () => ({
      next: { x: 11.5, y: 63, z: 20.5, requiresJump: true },
      nextDelta: { xz: 1, dy: 1 }
    })
  }
  bot.controlState = {}
  bot.setControlState = (control, state) => { bot.controlState[control] = state }
  bot.clearControlStates = () => { bot.controlState = {} }
  bot.blockAt = () => ({ name: 'water', boundingBox: 'empty' })

  movementPlugin._test.patchPulseJump(bot, '[water-surface-test]')
  bot.setControlState('jump', true)
  bot.setControlState('forward', true)

  assert.equal(bot.controlState.jump, true)
  assert.equal(bot.controlState.forward, true)
})

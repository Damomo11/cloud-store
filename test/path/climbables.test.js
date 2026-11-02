'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { Movements, goals: { GoalBlock } } = require('../../vendor/mineflayer-pathfinder')
const AStar = require('../../vendor/mineflayer-pathfinder/lib/astar')
const Move = require('../../vendor/mineflayer-pathfinder/lib/move')
const { isNodeReached } = require('../../vendor/mineflayer-pathfinder/lib/path-node')
const { Physics, PlayerState } = require('prismarine-physics')
const movementPlugin = { _test: { ...require('../../src/path/terrain'), ...require('../../src/path/climbables') } }
const {
  patchFastGetBlock,
  patchPulseJump,
  installClimbControlBridge,
  isRetryableRaisedEntry,
  isRetryableClimbEntry,
  shouldEscalateRetryableClimbEntry
} = movementPlugin._test
const {
  CLIMBABLE_BLOCK_NAMES,
  PHYSICS_COMPAT_BLOCK_NAMES,
  CLIMB_DESCENT_SPEED,
  CLIMB_ENTRY_DOWN_READY_XZ,
  CLIMB_ENTRY_DOWN_ARRIVAL_XZ,
  RAISED_ENTRY_READY_XZ,
  RAISED_ENTRY_RETREAT_MAX_TICKS,
  RETRYABLE_CLIMB_ENTRY_AVOID_AFTER_FAILURES,
  resolveClimbableRegistry,
  isUnsupportedScaffolding,
  isWaterloggedClimbable,
  installClimbPhysicsCompatibility,
  createClimbController,
  resolveVineClimbSupport,
  installClimbableSupport,
  getClimbableController
} = require('../../src/path/climbables')

const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')('1.21.4')

function positionedBlock (name, position, stateId = null) {
  const definition = mcData.blocksByName[name]
  const block = Block.fromStateId(stateId ?? definition.defaultState, 0)
  block.position = position.clone()
  return block
}

function stateIdWithProperties (name, expected) {
  const definition = mcData.blocksByName[name]
  for (let stateId = definition.minStateId; stateId <= definition.maxStateId; stateId++) {
    const block = Block.fromStateId(stateId, 0)
    const properties = block.getProperties()
    if (Object.entries(expected).every(([key, value]) => String(properties[key]) === String(value))) {
      return stateId
    }
  }
  throw new Error(`No ${name} state matched ${JSON.stringify(expected)}`)
}

function movementHarness () {
  const world = new Map()
  const bot = {
    registry: mcData,
    game: { minY: -64 },
    inventory: { items: () => [] },
    entity: { effects: {} },
    pathfinder: { bestHarvestTool: () => null },
    controlState: {},
    on () {},
    blockAt (position) {
      return world.get(position.floored().toString()) || positionedBlock('air', position.floored())
    },
    setControlState (name, value) {
      this.controlState[name] = value
    }
  }
  const moves = new Movements(bot)
  moves.allowParkour = false
  moves.allow1by1towers = false
  moves.allowEntityDetection = false
  moves.canDig = false

  function put (name, x, y, z, stateId = null) {
    const block = positionedBlock(name, new Vec3(x, y, z), stateId)
    world.set(block.position.toString(), block)
    return block
  }

  return { bot, moves, put }
}

function nodeAt (x = 0, y = 1, z = 0) {
  return { x, y, z, remainingBlocks: 0 }
}

test('the 1.21.4 climbable contract contains and registers all nine block types', () => {
  assert.deepEqual(CLIMBABLE_BLOCK_NAMES, [
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
  assert.equal(PHYSICS_COMPAT_BLOCK_NAMES.length, 6)

  const { bot, moves } = movementHarness()
  const controller = installClimbableSupport(moves, bot)
  for (const name of CLIMBABLE_BLOCK_NAMES) {
    assert.equal(moves.climbables.has(mcData.blocksByName[name].id), true, name)
  }
  assert.equal(controller.resolved.ids.size, 9)
  assert.equal(installClimbableSupport(moves, bot), controller, 'installation is idempotent')
})


test('climb control bridge follows the currently active movements controller', () => {
  const first = movementHarness()
  const second = movementHarness()
  const firstController = installClimbableSupport(first.moves, first.bot)
  const secondController = installClimbableSupport(second.moves, second.bot)
  const calls = { firstApply: 0, firstClear: 0, secondApply: 0, secondClear: 0 }
  firstController.applyClimbControls = () => { calls.firstApply += 1 }
  firstController.clearClimbPhase = () => { calls.firstClear += 1 }
  secondController.applyClimbControls = () => { calls.secondApply += 1 }
  secondController.clearClimbPhase = () => { calls.secondClear += 1 }

  const bot = new EventEmitter()
  let activeMovements = first.moves
  let debug = {
    next: { x: 0, y: 2, z: 0, reachKind: 'climbable', climbDirection: 1, climbBlockName: 'vine' },
    nextDelta: { dy: 1 }
  }
  bot.pathfinder = {
    get movements () { return activeMovements },
    isControlPaused: () => false,
    getDebugState: () => debug
  }
  installClimbControlBridge(bot, firstController, '[bridge-test]')

  bot.emit('physicsTick')
  activeMovements = second.moves
  bot.emit('physicsTick')
  debug = null
  bot.emit('physicsTick')

  assert.equal(calls.firstApply, 1)
  assert.equal(calls.firstClear, 1)
  assert.equal(calls.secondApply, 1)
  assert.equal(calls.secondClear, 1)
})

test('modern vine columns produce exactly one-layer up and down edges with execution metadata', () => {
  const { bot, moves, put } = movementHarness()
  installClimbableSupport(moves, bot)
  put('twisting_vines_plant', 0, 1, 0)
  put('weeping_vines_plant', 0, 2, 0)
  put('cave_vines_plant', 0, 3, 0)
  put('stone', 1, 1, 0)
  put('stone', 0, -10, 0)

  const up = []
  moves.getMoveUp(nodeAt(0, 1, 0), up)
  assert.equal(up.length, 1)
  assert.deepEqual({ x: up[0].x, y: up[0].y, z: up[0].z }, { x: 0, y: 2, z: 0 })
  assert.equal(up[0].reachKind, 'climbable')
  assert.equal(up[0].gridY, 2)
  assert.equal(up[0].climbDirection, 1)
  assert.equal(up[0].climbBlockName, 'weeping_vines_plant')
  assert.equal(up[0].climbNeedsPhysicsCompat, true)

  const down = []
  moves.getMoveDown(nodeAt(0, 3, 0), down)
  assert.equal(down.length, 1)
  assert.deepEqual({ x: down[0].x, y: down[0].y, z: down[0].z }, { x: 0, y: 2, z: 0 })
  assert.equal(down[0].climbDirection, -1)
  assert.notEqual(down[0].y, -9, 'the generic landing edge must not survive')

  // Descent avoidance policy: the raw generator still produces the edge, but
  // neighbor selection drops every downward vine/ladder edge.
  const neighborsDown = moves.getNeighbors(nodeAt(0, 3, 0)).filter(move => (
    move.x === 0 && move.y === 2 && move.z === 0 && move.climbDirection === -1
  ))
  assert.equal(neighborsDown.length, 0, 'vine descents are excluded at neighbor selection')
})

test('ladder down-entry and mid-column descents are excluded from neighbor selection', () => {
  const { bot, moves, put } = movementHarness()
  installClimbableSupport(moves, bot)
  put('ladder', 0, 0, 0)
  put('ladder', 0, -1, 0)

  // The top-of-ladder down-entry edge is removed.
  const entry = moves.getNeighbors(nodeAt(0, 1, 0)).filter(move => (
    move.x === 0 && move.y === 0 && move.z === 0 && move.climbDirection === -1
  ))
  assert.equal(entry.length, 0)

  // Mid-column ladder descents are removed as well.
  const continuation = moves.getNeighbors(nodeAt(0, 0, 0)).filter(move => (
    move.x === 0 && move.y === -1 && move.z === 0 && move.climbDirection === -1
  ))
  assert.equal(continuation.length, 0)
})

test('A* will not descend a ladder-only shaft', () => {
  const { bot, moves, put } = movementHarness()
  installClimbableSupport(moves, bot)
  put('ladder', 0, 0, 0)
  put('ladder', 0, -1, 0)
  put('ladder', 0, -2, 0)

  const start = new Move(0, 1, 0, 0, 0)
  const result = new AStar(start, moves, new GoalBlock(0, -2, 0), 1000, 1000).compute()
  assert.equal(result.status, 'noPath')
  assert.equal(result.path.some(move => move.climbDirection === -1), false)
})

test('scaffolding may still descend even though ladders and vines cannot', () => {
  const scaffold = movementHarness()
  installClimbableSupport(scaffold.moves, scaffold.bot)
  const supported = stateIdWithProperties('scaffolding', { distance: 0, bottom: false, waterlogged: false })
  scaffold.put('scaffolding', 0, 1, 0, supported)
  scaffold.put('scaffolding', 0, 2, 0, supported)
  scaffold.put('scaffolding', 0, 3, 0, supported)
  scaffold.put('stone', 0, -10, 0)
  const scaffoldDown = scaffold.moves.getNeighbors(nodeAt(0, 3, 0)).filter(move => (
    move.x === 0 && move.y === 2 && move.z === 0 && move.climbDirection === -1
  ))
  assert.equal(scaffoldDown.length, 1)
  assert.equal(scaffoldDown[0].climbBlockName, 'scaffolding')

  const ladder = movementHarness()
  installClimbableSupport(ladder.moves, ladder.bot)
  ladder.put('ladder', 0, 1, 0)
  ladder.put('ladder', 0, 2, 0)
  ladder.put('ladder', 0, 3, 0)
  ladder.put('stone', 0, -10, 0)
  const ladderDown = ladder.moves.getNeighbors(nodeAt(0, 3, 0)).filter(move => (
    move.x === 0 && move.y === 2 && move.z === 0 && move.climbDirection === -1
  ))
  assert.equal(ladderDown.length, 0)
})

test('a hanging climbable can only be entered from a cardinal neighbor without placing support', () => {
  const { bot, moves, put } = movementHarness()
  installClimbableSupport(moves, bot)
  put('stone', 0, 0, 0)
  put('twisting_vines_plant', 1, 1, 0)
  put('twisting_vines_plant', 1, 2, 0)

  const cardinal = []
  moves.getMoveForward(nodeAt(), { x: 1, z: 0 }, cardinal)
  assert.equal(cardinal.length, 1)
  assert.deepEqual({ x: cardinal[0].x, y: cardinal[0].y, z: cardinal[0].z }, { x: 1, y: 1, z: 0 })
  assert.equal(cardinal[0].reachKind, 'climbable')
  assert.equal(cardinal[0].climbDirection, 0)
  assert.deepEqual(cardinal[0].toPlace, [])

  put('twisting_vines_plant', 1, 1, 1)
  put('twisting_vines_plant', 1, 2, 1)
  put('stone', 1, 0, 1)
  const neighbors = moves.getNeighbors(nodeAt())
  assert.equal(neighbors.some(move => move.x === 1 && move.y === 1 && move.z === 1), false)
})

test('entry never combines a cardinal step with a vertical climb edge', () => {
  const scenarios = [
    ['vine', 0],
    ['scaffolding', stateIdWithProperties('scaffolding', { distance: 0, waterlogged: false })]
  ]

  for (const [name, stateId] of scenarios) {
    const { bot, moves, put } = movementHarness()
    installClimbableSupport(moves, bot)
    put('stone', 0, 0, 0)
    put(name, 1, 0, 0, stateId || null)
    put(name, 1, 1, 0, stateId || null)
    put(name, 1, 2, 0, stateId || null)

    const node = nodeAt()
    const entries = moves.getNeighbors(node).filter(move => (
      move.reachKind === 'climbable' && (move.x !== node.x || move.z !== node.z)
    ))
    assert.ok(entries.length > 0, name)
    assert.equal(entries.every(move => move.y === node.y && move.climbDirection === 0), true, name)
  }
})

test('a grounded jump can enter an executable climbable that starts directly overhead', () => {
  for (const name of ['ladder', 'twisting_vines_plant']) {
    const { bot, moves, put } = movementHarness()
    installClimbableSupport(moves, bot)
    put('stone', 0, 0, 0)
    put(name, 0, 2, 0)

    const entries = []
    moves.getMoveUp(nodeAt(), entries)
    assert.equal(entries.length, 1, name)
    assert.deepEqual({ x: entries[0].x, y: entries[0].y, z: entries[0].z }, { x: 0, y: 2, z: 0 })
    assert.equal(entries[0].reachKind, 'climbable')
    assert.equal(entries[0].climbDirection, 1)
    assert.equal(entries[0].climbBlockName, name)
    assert.equal(entries[0].climbTransition, 'climbable_entry_up')
    assert.equal(entries[0].requiresJump, true)
    assert.deepEqual(entries[0].toBreak, [])
    assert.deepEqual(entries[0].toPlace, [])
  }
})

test('a native cardinal jump can enter a climbable above a one-block pedestal', () => {
  const { bot, moves, put } = movementHarness()
  installClimbableSupport(moves, bot)
  put('stone', 0, 0, 0)
  put('stone', 1, 1, 0)
  put('ladder', 1, 2, 0)

  const raised = moves.getNeighbors(nodeAt()).filter(move => (
    move.x === 1 && move.y === 2 && move.z === 0
  ))
  assert.equal(raised.length, 1)
  assert.equal(raised[0].reachKind, 'climbable')
  assert.equal(raised[0].climbDirection, 1)
  assert.equal(raised[0].climbTransition, 'raised_entry')
  assert.equal(raised[0].requiresJump, true)
  assert.deepEqual(raised[0].toBreak, [])
  assert.deepEqual(raised[0].toPlace, [])
})

test('raised climb entry does not create an unsupported air tower', () => {
  const { bot, moves, put } = movementHarness()
  installClimbableSupport(moves, bot)
  put('ladder', 0, 2, 0)

  const withoutFloor = []
  moves.getMoveUp(nodeAt(), withoutFloor)
  assert.equal(withoutFloor.length, 0)

  const ordinaryAir = []
  moves.getMoveUp(nodeAt(2, 1, 0), ordinaryAir)
  assert.equal(ordinaryAir.length, 0)
})

test('distance 7 scaffolding is rejected for entry and vertical continuation', () => {
  const unsupportedState = stateIdWithProperties('scaffolding', { distance: 7 })
  const unsupported = positionedBlock('scaffolding', new Vec3(0, 0, 0), unsupportedState)
  assert.equal(isUnsupportedScaffolding(unsupported, mcData.blocksByName.scaffolding.id), true)

  const { bot, moves, put } = movementHarness()
  installClimbableSupport(moves, bot)
  put('stone', 0, 0, 0)
  put('scaffolding', 1, 1, 0, unsupportedState)
  put('scaffolding', 1, 2, 0, unsupportedState)

  const entry = []
  moves.getMoveForward(nodeAt(), { x: 1, z: 0 }, entry)
  assert.equal(entry.length, 0)

  const up = []
  moves.getMoveUp(nodeAt(1, 1, 0), up)
  assert.equal(up.length, 0)
})

test('waterlogged ladders and scaffolding are outside the surface-only movement scope', () => {
  const wetLadderState = stateIdWithProperties('ladder', { waterlogged: true })
  const wetScaffoldState = stateIdWithProperties('scaffolding', { waterlogged: true, distance: 0 })
  assert.equal(isWaterloggedClimbable(positionedBlock('ladder', new Vec3(0, 1, 0), wetLadderState)), true)

  for (const [name, stateId] of [['ladder', wetLadderState], ['scaffolding', wetScaffoldState]]) {
    const { bot, moves, put } = movementHarness()
    installClimbableSupport(moves, bot)
    put('stone', 0, 0, 0)
    put(name, 1, 1, 0, stateId)
    put(name, 1, 2, 0, stateId)
    const entry = []
    moves.getMoveForward(nodeAt(), { x: 1, z: 0 }, entry)
    assert.equal(entry.length, 0, name)
  }
})

test('production fast descriptors preserve scaffolding distance and waterlogged state', () => {
  const cases = [
    ['scaffolding', stateIdWithProperties('scaffolding', { distance: 7, waterlogged: false })],
    ['scaffolding', stateIdWithProperties('scaffolding', { distance: 0, waterlogged: true })],
    ['ladder', stateIdWithProperties('ladder', { waterlogged: true })]
  ]

  for (const [name, stateId] of cases) {
    const { bot, moves, put } = movementHarness()
    put('stone', 0, 0, 0)
    put(name, 1, 1, 0, stateId)
    put(name, 1, 2, 0, stateId)
    patchFastGetBlock(moves, bot, '[fast-climb-test]')
    installClimbableSupport(moves, bot)

    const descriptor = moves.getBlock(nodeAt(), 1, 0, 0)
    assert.ok(descriptor._properties)
    const entry = []
    moves.getMoveForward(nodeAt(), { x: 1, z: 0 }, entry)
    assert.equal(entry.length, 0, `${name} ${JSON.stringify(descriptor._properties)}`)
  }
})

test('supported climbable columns expose one safe top exit without general air climbing', () => {
  const supportedState = stateIdWithProperties('scaffolding', { distance: 0, waterlogged: false })
  const scenarios = [
    ['ladder', null, 'climbable_top'],
    ['twisting_vines_plant', null, 'climbable_top'],
    ['scaffolding', supportedState, 'scaffolding_top']
  ]

  for (const [name, stateId, transition] of scenarios) {
    const { bot, moves, put } = movementHarness()
    installClimbableSupport(moves, bot)
    put(name, 0, 1, 0, stateId)

    const top = []
    moves.getMoveUp(nodeAt(), top)
    assert.equal(top.length, 1, name)
    assert.equal(top[0].y, 2)
    assert.equal(top[0].reachKind, 'climbable')
    assert.equal(top[0].gridY, 2)
    assert.equal(top[0].climbDirection, 1)
    assert.equal(top[0].climbBlockName, name)
    assert.equal(top[0].climbTransition, transition)
    assert.deepEqual(top[0].toBreak, [])
    assert.deepEqual(top[0].toPlace, [])

    const aboveTop = []
    moves.getMoveUp(nodeAt(0, 2, 0), aboveTop)
    assert.equal(aboveTop.length, 0, `${name} must not continue climbing through air`)
  }
})

test('a climbable top exit requires clear feet and head volumes', () => {
  for (const obstructionY of [2, 3]) {
    const { bot, moves, put } = movementHarness()
    installClimbableSupport(moves, bot)
    put('ladder', 0, 1, 0)
    put('stone', 0, obstructionY, 0)

    const top = []
    moves.getMoveUp(nodeAt(), top)
    assert.equal(top.length, 0, `obstruction y=${obstructionY}`)
  }
})

test('A* connects a floor through a raised ladder entry and its top exit', () => {
  const { bot, moves, put } = movementHarness()
  installClimbableSupport(moves, bot)
  put('stone', 0, 0, 0)
  put('stone', 1, 0, 0)
  put('ladder', 1, 2, 0)
  put('ladder', 1, 3, 0)

  const start = new Move(0, 1, 0, 0, 0)
  const result = new AStar(start, moves, new GoalBlock(1, 4, 0), 1000, 1000).compute()
  assert.equal(result.status, 'success')
  assert.deepEqual(result.path.map(move => [
    move.x,
    move.y,
    move.z,
    move.climbTransition || null
  ]), [
    [1, 1, 0, null],
    [1, 2, 0, 'climbable_entry_up'],
    [1, 3, 0, null],
    [1, 4, 0, 'climbable_top']
  ])
  assert.equal(result.path.slice(1).every(move => move.reachKind === 'climbable'), true)
})

test('physics compatibility maps modern vines only during an explicit climb phase', () => {
  const resolved = resolveClimbableRegistry(mcData)
  const modernVineId = mcData.blocksByName.cave_vines_plant.id
  let observedType = null
  const bot = {
    physics: {
      simulatePlayer (state, world) {
        observedType = world.getBlock(state.pos).type
        return state
      }
    }
  }
  const compatibility = installClimbPhysicsCompatibility(bot, resolved)
  const state = { pos: new Vec3(0, 5, 0), vel: new Vec3(0, 0, 0), onGround: false }
  const world = { getBlock: () => ({ type: modernVineId, name: 'cave_vines_plant' }) }

  bot.physics.simulatePlayer(state, world)
  assert.equal(observedType, modernVineId)

  compatibility.setPhase(1, 'cave_vines_plant')
  bot.physics.simulatePlayer(state, world)
  assert.equal(observedType, mcData.blocksByName.vine.id)

  compatibility.clear()
  bot.physics.simulatePlayer(state, world)
  assert.equal(observedType, modernVineId)
})

test('scaffolding compatibility climbs through multiple real collision layers', () => {
  const resolved = resolveClimbableRegistry(mcData)
  const supportedState = stateIdWithProperties('scaffolding', { distance: 0, waterlogged: false })
  const world = {
    getBlock (position) {
      const point = position.floored()
      const inColumn = point.x === 0 && point.z === 0 && point.y >= 1 && point.y <= 4
      const name = inColumn ? 'scaffolding' : point.y === 0 ? 'stone' : 'air'
      return positionedBlock(name, point, inColumn ? supportedState : null)
    }
  }
  const physics = Physics(mcData, world)
  const bot = {
    physics,
    version: '1.21.4',
    inventory: { slots: [] },
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    entity: {
      position: new Vec3(0.5, 1, 0.5),
      velocity: new Vec3(0, 0, 0),
      onGround: false,
      isInWater: false,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: false,
      elytraFlying: false,
      yaw: 0,
      pitch: 0,
      effects: {},
      attributes: {}
    }
  }
  const controls = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: true,
    sprint: false,
    sneak: false
  }
  const state = new PlayerState(bot, controls)
  const compatibility = installClimbPhysicsCompatibility(bot, resolved)
  compatibility.setPhase(1, 'scaffolding')

  for (let tick = 0; tick < 20; tick++) bot.physics.simulatePlayer(state, world)
  assert.ok(state.pos.y > 2.5, `expected multi-layer climb, got y=${state.pos.y}`)

  compatibility.clear()
  assert.equal(compatibility.state.active, false)
})

test('climb controls distinguish raised entry, ascent, vine descent, and scaffolding descent', () => {
  const resolved = resolveClimbableRegistry(mcData)
  const controls = {}
  const bot = {
    controlState: controls,
    setControlState (name, value) { controls[name] = value },
    physics: { simulatePlayer: state => state }
  }
  const compatibility = installClimbPhysicsCompatibility(bot, resolved)
  const controller = createClimbController(bot, compatibility)

  controls.sneak = true
  controller.clearClimbPhase()
  assert.equal(controls.sneak, true, 'an inactive climb controller must not clear another owner\'s sneak')

  controls.forward = false
  controls.back = true
  controls.left = true
  controls.right = true
  controls.jump = false
  controller.applyClimbControls({
    reachKind: 'climbable',
    climbDirection: 1,
    climbBlockName: 'ladder',
    climbTransition: 'raised_entry',
    requiresJump: true
  }, 1)
  assert.equal(controls.forward, true)
  assert.equal(controls.back, false)
  assert.equal(controls.left, false)
  assert.equal(controls.right, false)
  assert.equal(controls.jump, true)
  assert.equal(controls.sprint, false)
  assert.equal(controls.sneak, false)

  assert.equal(controller.applyClimbControls({
    reachKind: 'climbable',
    climbDirection: 1,
    climbBlockName: 'weeping_vines_plant'
  }, 1), true)
  assert.equal(controls.jump, true)
  assert.equal(controls.forward, false)
  assert.equal(controls.sprint, false)
  assert.equal(compatibility.state.active, true)

  controller.applyClimbControls({
    reachKind: 'climbable',
    climbDirection: -1,
    climbBlockName: 'vine'
  }, -1)
  assert.equal(controls.jump, false)
  assert.equal(controls.sneak, false)

  controller.applyClimbControls({
    reachKind: 'climbable',
    climbDirection: -1,
    climbBlockName: 'scaffolding'
  }, -1)
  assert.equal(controls.sneak, true)
  const state = { pos: new Vec3(0, 5, 0), vel: new Vec3(0, 0, 0), onGround: true }
  bot.physics.simulatePlayer(state, { getBlock: () => null })
  assert.equal(state.pos.y, 5 - CLIMB_DESCENT_SPEED)
  assert.equal(state.vel.y, -CLIMB_DESCENT_SPEED)
  assert.equal(state.onGround, false)

  controller.applyClimbControls({
    reachKind: 'climbable',
    climbDirection: 0,
    climbBlockName: 'scaffolding'
  }, -0.5)
  assert.equal(controls.jump, false, 'an explicit side-entry direction must override transient Y error')
  assert.equal(controls.sneak, false)

  assert.equal(controller.applyClimbControls({ reachKind: 'surface' }, 0), false)
  assert.equal(compatibility.state.active, false)
  assert.equal(controls.sneak, false)
})

test('ordinary vine ascent presses into its real attached support face', () => {
  const controls = {}
  const looked = []
  const vineState = stateIdWithProperties('vine', {
    west: false,
    east: true,
    north: false,
    south: false
  })
  const vine = positionedBlock('vine', new Vec3(0, 2, 0), vineState)
  const stone = positionedBlock('stone', new Vec3(1, 2, 0))
  const bot = {
    entity: { position: new Vec3(0.5, 1.2, 0.5) },
    setControlState (name, value) { controls[name] = value },
    look (yaw, pitch, force) { looked.push({ yaw, pitch, force }) },
    blockAt (position) {
      const key = position.floored().toString()
      if (key === vine.position.toString()) return vine
      if (key === stone.position.toString()) return stone
      return positionedBlock('air', position.floored())
    },
    physics: { simulatePlayer: state => state }
  }
  const next = {
    x: 0.5,
    y: 2,
    z: 0.5,
    gridY: 2,
    reachKind: 'climbable',
    climbDirection: 1,
    climbBlockName: 'vine'
  }

  assert.deepEqual(resolveVineClimbSupport(bot, next), {
    face: 'east', x: 1, y: 2, z: 0, blockName: 'stone'
  })
  const controller = createClimbController(bot, installClimbPhysicsCompatibility(bot, resolveClimbableRegistry(mcData)))
  controller.applyClimbControls(next, 0.8)

  assert.equal(controls.forward, true)
  assert.equal(controls.jump, true)
  assert.equal(controls.sprint, false)
  assert.equal(looked.length, 1)
  assert.equal(looked[0].yaw, -Math.PI / 2)
  assert.equal(looked[0].force, true)
})

test('ordinary vine ascent is excluded even with a collidable backing block', () => {
  const { bot, moves, put } = movementHarness()
  installClimbableSupport(moves, bot)
  const vineState = stateIdWithProperties('vine', {
    west: false,
    east: false,
    north: false,
    south: true
  })
  put('stone', 0, 0, 0)
  put('vine', 0, 1, 0, vineState)
  put('vine', 0, 2, 0, vineState)
  put('stone', 0, 1, 1)
  put('stone', 0, 2, 1)

  const up = moves.getNeighbors(nodeAt()).find(move => move.x === 0 && move.y === 2 && move.z === 0)
  assert.equal(up, undefined, 'A* must not emit a true-server-unreliable ordinary vine edge')

  const vine = bot.blockAt(new Vec3(0, 2, 0))
  const next = {
    x: 0.5,
    y: 2,
    z: 0.5,
    gridY: 2,
    reachKind: 'climbable',
    climbDirection: 1,
    climbBlockName: 'vine'
  }
  assert.deepEqual(resolveVineClimbSupport(bot, next), {
    face: 'south', x: 0, y: 2, z: 1, blockName: 'stone'
  })
  assert.equal(vine.name, 'vine')
})

test('scaffolding descent centers over the column before sneaking down', () => {
  const controls = {}
  const bot = {
    entity: { position: new Vec3(0.82, 5, 0.5), velocity: new Vec3(0, 0, 0), onGround: true },
    controlState: controls,
    setControlState (name, value) { controls[name] = value },
    physics: { simulatePlayer: state => state }
  }
  const compatibility = installClimbPhysicsCompatibility(bot, resolveClimbableRegistry(mcData))
  const controller = createClimbController(bot, compatibility)
  const next = { reachKind: 'climbable', climbDirection: -1, climbBlockName: 'scaffolding', x: 0.5, y: 4, z: 0.5, gridY: 4 }

  // 0.32 off-center over an adjacent block: walk onto the column, do not sneak
  // so edge protection cannot lock the bot on the neighbouring block.
  controller.applyClimbControls(next, -1)
  assert.equal(controls.forward, true)
  assert.equal(controls.sneak, false)

  // Centered over the column: sneak straight down without forward drift.
  bot.entity.position = new Vec3(0.5, 5, 0.5)
  controller.applyClimbControls(next, -1)
  assert.equal(controls.forward, false)
  assert.equal(controls.sneak, true)
})

test('ladder top-down entry advances to the ready radius then yields to gravity', () => {
  const controls = {
    forward: false,
    back: true,
    left: true,
    right: true,
    jump: true,
    sprint: true,
    sneak: true
  }
  const bot = {
    entity: {
      position: new Vec3(0.5, 1, 0.5 - CLIMB_ENTRY_DOWN_READY_XZ - 0.01),
      velocity: new Vec3(0.18, 0, -0.18),
      onGround: true,
      isInWater: false
    },
    setControlState (name, value) { controls[name] = value }
  }
  const compatibility = {
    state: { active: false, direction: 0, blockName: null },
    setPhase (direction, blockName) {
      this.state.active = true
      this.state.direction = direction
      this.state.blockName = blockName
    },
    clear () { this.state.active = false }
  }
  const controller = createClimbController(bot, compatibility)
  const next = {
    x: 0.5,
    y: 0,
    z: 0.5,
    gridY: 0,
    reachKind: 'climbable',
    climbDirection: -1,
    climbBlockName: 'ladder',
    climbTransition: 'climbable_entry_down',
    requiresLanding: true
  }

  controller.applyClimbControls(next, -1)
  assert.equal(controls.forward, true)
  assert.equal(controls.back, false)
  assert.equal(controls.left, false)
  assert.equal(controls.right, false)
  assert.equal(controls.jump, false)
  assert.equal(controls.sprint, false)
  assert.equal(controls.sneak, false)
  assert.equal(bot.entity.velocity.x, 0)
  assert.equal(bot.entity.velocity.z, 0)
  assert.equal(compatibility.state.direction, -1)
  assert.equal(compatibility.state.blockName, 'ladder')

  bot.entity.position.z = next.z - CLIMB_ENTRY_DOWN_READY_XZ + 0.01
  bot.entity.velocity.x = -0.2
  bot.entity.velocity.z = 0.2
  controller.applyClimbControls(next, -1)
  assert.equal(controls.forward, false)
  assert.equal(bot.entity.velocity.x, 0)
  assert.equal(bot.entity.velocity.z, 0)

  bot.entity.position.y = 0.99
  bot.entity.position.z = next.z - CLIMB_ENTRY_DOWN_ARRIVAL_XZ - 0.01
  controller.applyClimbControls(next, -0.99)
  assert.equal(controls.forward, true, 'inside gridY must still center when outside the node arrival radius')

  bot.entity.position.z = next.z - CLIMB_ENTRY_DOWN_ARRIVAL_XZ + 0.01
  controller.applyClimbControls(next, -0.99)
  assert.equal(controls.forward, false, 'inside gridY must stop once the node can be reached')
  assert.equal(controls.jump, false)
  assert.equal(controls.sneak, false)

  bot.entity.position.y = 1
  bot.entity.position.z = next.z - CLIMB_ENTRY_DOWN_READY_XZ - 0.01
  controller.applyClimbControls(next, -1)
  assert.equal(controls.forward, true)
  controller.clearClimbPhase()
  assert.equal(controls.forward, false, 'path lifecycle cleanup must release down-entry forward ownership')
  assert.equal(bot.entity.velocity.x, 0)
  assert.equal(bot.entity.velocity.z, 0)
})

test('ladder top-down entry clears the lip in all four facings and descends three real physics layers', () => {
  const scenarios = [
    { facing: 'north', outwardX: 0, outwardZ: -1, yaw: Math.PI },
    { facing: 'south', outwardX: 0, outwardZ: 1, yaw: 0 },
    { facing: 'west', outwardX: -1, outwardZ: 0, yaw: -Math.PI / 2 },
    { facing: 'east', outwardX: 1, outwardZ: 0, yaw: Math.PI / 2 }
  ]

  for (const scenario of scenarios) {
    const ladderState = stateIdWithProperties('ladder', {
      facing: scenario.facing,
      waterlogged: false
    })
    const world = {
      getBlock (position) {
        const point = position.floored()
        const inColumn = point.x === 0 && point.z === 0 && point.y <= 0 && point.y >= -3
        const onPlatform = point.x === scenario.outwardX &&
          point.z === scenario.outwardZ && point.y === 0
        const inBackingWall = point.x === -scenario.outwardX &&
          point.z === -scenario.outwardZ && point.y <= 0 && point.y >= -3
        if (inColumn) return positionedBlock('ladder', point, ladderState)
        if (onPlatform) return positionedBlock('acacia_planks', point)
        if (inBackingWall) return positionedBlock('stone', point)
        return positionedBlock('air', point)
      }
    }
    const physics = Physics(mcData, world)
    const controls = {
      forward: false,
      back: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      sneak: false
    }
    const bot = {
      physics,
      version: '1.21.4',
      inventory: { slots: [] },
      jumpTicks: 0,
      jumpQueued: false,
      fireworkRocketDuration: 0,
      setControlState (name, value) { controls[name] = value },
      blockAt: position => world.getBlock(position),
      entity: {
        position: new Vec3(
          0.5 + scenario.outwardX * 0.391,
          1,
          0.5 + scenario.outwardZ * 0.391
        ),
        velocity: new Vec3(
          scenario.outwardX * 0.18,
          -0.0784,
          scenario.outwardZ * 0.18
        ),
        onGround: true,
        isInWater: false,
        isInLava: false,
        isInWeb: false,
        isCollidedHorizontally: false,
        isCollidedVertically: false,
        elytraFlying: false,
        yaw: scenario.yaw,
        pitch: 0,
        effects: {},
        attributes: {}
      }
    }
    const compatibility = installClimbPhysicsCompatibility(bot, resolveClimbableRegistry(mcData))
    const controller = createClimbController(bot, compatibility)
    const state = new PlayerState(bot, controls)
    const targets = [0, -1, -2].map((y, index) => ({
      x: 0.5,
      y,
      z: 0.5,
      gridY: y,
      reachKind: 'climbable',
      climbDirection: -1,
      climbBlockName: 'ladder',
      ...(index === 0
        ? { climbTransition: 'climbable_entry_down', requiresLanding: true }
        : {})
    }))
    let targetIndex = 0
    let firstReachedTick = null
    let sawForward = false
    let sawNeutral = false

    for (let tick = 0; tick < 40 && targetIndex < targets.length; tick++) {
      const next = targets[targetIndex]
      bot.entity.position = state.pos
      bot.entity.velocity = state.vel
      bot.entity.onGround = state.onGround
      bot.entity.yaw = state.yaw
      bot.entity.pitch = state.pitch
      controller.applyClimbControls(next, next.y - state.pos.y)

      if (targetIndex === 0 && controls.forward) sawForward = true
      if (targetIndex === 0 && !controls.forward) sawNeutral = true
      assert.equal(controls.back, false, `${scenario.facing} back tick=${tick}`)
      assert.equal(controls.left, false, `${scenario.facing} left tick=${tick}`)
      assert.equal(controls.right, false, `${scenario.facing} right tick=${tick}`)
      assert.equal(controls.jump, false, `${scenario.facing} jump tick=${tick}`)
      assert.equal(controls.sprint, false, `${scenario.facing} sprint tick=${tick}`)
      assert.equal(controls.sneak, false, `${scenario.facing} sneak tick=${tick}`)

      physics.simulatePlayer(state, world)
      if (isNodeReached(next, state.pos, state)) {
        if (targetIndex === 0) firstReachedTick = tick + 1
        targetIndex += 1
      }
    }

    const finalDistance = Math.hypot(state.pos.x - 0.5, state.pos.z - 0.5)
    assert.equal(sawForward, true, `${scenario.facing} must advance off the platform`)
    assert.equal(sawNeutral, true, `${scenario.facing} must neutralize before entering the ladder`)
    assert.ok(firstReachedTick !== null && firstReachedTick <= 6, `${scenario.facing} firstReachedTick=${firstReachedTick}`)
    assert.equal(targetIndex, targets.length, `${scenario.facing} reached=${targetIndex}/${targets.length} final=${state.pos}`)
    assert.ok(finalDistance <= CLIMB_ENTRY_DOWN_READY_XZ + 1e-6, `${scenario.facing} finalDistance=${finalDistance}`)
  }
})

test('raised entry prepares safe takeoff distance before committing forward jump', () => {
  const controls = {}
  const bot = {
    entity: {
      position: new Vec3(0.5, 1, 1.32),
      velocity: new Vec3(0.1, 0, -0.2),
      onGround: true,
      isInWater: false
    },
    controlState: controls,
    setControlState (name, value) { controls[name] = value },
    blockAt: position => positionedBlock('stone', position)
  }
  const compatibility = {
    state: { active: false },
    setPhase () { this.state.active = true },
    clear () { this.state.active = false }
  }
  const controller = createClimbController(bot, compatibility)
  const next = {
    x: 0.5,
    y: 2,
    z: 0.5,
    reachKind: 'climbable',
    climbDirection: 1,
    climbBlockName: 'ladder',
    climbTransition: 'raised_entry',
    requiresJump: true
  }

  controller.applyClimbControls(next, 1)
  assert.equal(controls.forward, false)
  assert.equal(controls.back, true)
  assert.equal(controls.jump, false)
  assert.equal(controls.sprint, false)
  assert.equal(bot.entity.velocity.x, 0)
  assert.equal(bot.entity.velocity.z, 0)

  bot.entity.position.z = next.z + RAISED_ENTRY_READY_XZ + 0.04
  controller.applyClimbControls(next, 1)
  assert.equal(controls.forward, false, 'the ready frame is neutral so retreat inertia cannot cancel takeoff')
  assert.equal(controls.back, false)
  assert.equal(controls.jump, false)

  controller.applyClimbControls(next, 1)
  assert.equal(controls.forward, true)
  assert.equal(controls.back, false)
  assert.equal(controls.jump, true)

  controller.clearClimbPhase()
  assert.equal(controls.forward, false)
  assert.equal(controls.back, false)
  assert.equal(controls.jump, false)
  assert.equal(controls.sprint, false)
  assert.equal(compatibility.state.active, false)
})

test('raised entry momentum is cleared before vertical ladder ascent', () => {
  const controls = {}
  const bot = {
    entity: {
      position: new Vec3(0.5, 2.14, 0.84),
      velocity: new Vec3(0, 0, 0),
      onGround: false,
      isInWater: false
    },
    setControlState (name, value) { controls[name] = value },
    blockAt: position => positionedBlock('stone', position)
  }
  const compatibility = {
    state: { active: false },
    setPhase () { this.state.active = true },
    clear () { this.state.active = false }
  }
  const controller = createClimbController(bot, compatibility)
  const entry = {
    x: 0.5,
    y: 2,
    z: 0.5,
    reachKind: 'climbable',
    climbDirection: 1,
    climbBlockName: 'ladder',
    climbTransition: 'raised_entry',
    requiresJump: true
  }

  controller.applyClimbControls(entry, -0.14)
  bot.entity.velocity.x = -0.18
  bot.entity.velocity.z = -0.24
  controller.applyClimbControls({
    ...entry,
    y: 3,
    climbTransition: undefined,
    requiresJump: undefined
  }, 0.86)

  assert.equal(bot.entity.velocity.x, 0)
  assert.equal(bot.entity.velocity.z, 0)
  assert.equal(controls.forward, false)
  assert.equal(controls.back, false)
  assert.equal(controls.jump, true)
})

test('raised entry clears the 0.82 boundary and continues up two ladder layers', () => {
  const ladderState = stateIdWithProperties('ladder', { facing: 'south', waterlogged: false })
  const world = {
    getBlock (position) {
      const point = position.floored()
      let name = 'air'
      let stateId = null
      if (point.y === 0 && point.z >= 1 && point.z <= 3) name = 'stone'
      if (point.y === 1 && point.z === 0) name = 'iron_block'
      if (point.z === 0 && point.y >= 2 && point.y <= 4) {
        name = 'ladder'
        stateId = ladderState
      }
      if (point.z === -1 && point.y >= 1 && point.y <= 4) name = 'stone'
      return positionedBlock(name, point, stateId)
    }
  }
  const physics = Physics(mcData, world)
  const controls = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  }
  const bot = {
    physics,
    version: '1.21.4',
    inventory: { slots: [] },
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    controlState: controls,
    setControlState (name, value) { controls[name] = value },
    blockAt: position => world.getBlock(position),
    entity: {
      position: new Vec3(0.5, 1, 1.32),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      isInWater: false,
      isInLava: false,
      isInWeb: false,
      isCollidedHorizontally: false,
      isCollidedVertically: false,
      elytraFlying: false,
      yaw: 0,
      pitch: 0,
      effects: {},
      attributes: {}
    }
  }
  const compatibility = installClimbPhysicsCompatibility(bot, resolveClimbableRegistry(mcData))
  const controller = createClimbController(bot, compatibility)
  const state = new PlayerState(bot, controls)
  const raisedEntry = {
    x: 0.5,
    y: 2,
    z: 0.5,
    gridY: 2,
    reachKind: 'climbable',
    climbDirection: 1,
    climbBlockName: 'ladder',
    climbTransition: 'raised_entry',
    requiresJump: true
  }
  const targets = [
    raisedEntry,
    { ...raisedEntry, y: 3, gridY: 3, climbTransition: undefined, requiresJump: undefined },
    { ...raisedEntry, y: 4, gridY: 4, climbTransition: undefined, requiresJump: undefined }
  ]
  let sawRetreat = false
  let takeoffDistance = null
  let targetIndex = 0
  let ladderEntryZ = null
  let maxLadderDrift = 0

  for (let tick = 0; tick < 80 && targetIndex < targets.length; tick++) {
    const next = targets[targetIndex]
    bot.entity.position = state.pos
    bot.entity.velocity = state.vel
    bot.entity.onGround = state.onGround
    bot.entity.yaw = state.yaw
    bot.entity.pitch = state.pitch
    controller.applyClimbControls(next, next.y - state.pos.y)

    const beforeDistance = Math.hypot(next.x - state.pos.x, next.z - state.pos.z)
    if (controls.back) sawRetreat = true
    if (controls.jump && takeoffDistance === null) takeoffDistance = beforeDistance
    physics.simulatePlayer(state, world)

    if (ladderEntryZ !== null) maxLadderDrift = Math.max(maxLadderDrift, Math.abs(state.pos.z - ladderEntryZ))
    if (isNodeReached(next, state.pos, state)) {
      if (targetIndex === 0) ladderEntryZ = state.pos.z
      targetIndex += 1
    }
  }

  assert.equal(sawRetreat, true)
  assert.ok(takeoffDistance >= RAISED_ENTRY_READY_XZ, `takeoffDistance=${takeoffDistance}`)
  assert.equal(targetIndex, targets.length, `reached=${targetIndex}/${targets.length} final=${state.pos}`)
  assert.ok(maxLadderDrift < 0.01, `ladder drift=${maxLadderDrift}`)
})

test('raised entry settles back to ground when a jump gets pinned airborne on the lip', () => {
  const controls = {}
  const bot = {
    entity: {
      position: new Vec3(0.5, 1.5, 1.30),
      velocity: new Vec3(0.12, 0, -0.1),
      onGround: false,
      isInWater: false
    },
    setControlState (name, value) { controls[name] = value },
    blockAt: position => positionedBlock('stone', position)
  }
  const compatibility = {
    state: { active: false },
    setPhase () { this.state.active = true },
    clear () { this.state.active = false }
  }
  const controller = createClimbController(bot, compatibility)
  const next = {
    x: 0.5,
    y: 2,
    z: 0.5,
    reachKind: 'climbable',
    climbDirection: 1,
    climbBlockName: 'ladder',
    climbTransition: 'raised_entry',
    requiresJump: true
  }

  // Airborne and never progressing (pinned on the lip at a fixed distance):
  // after the stall window the inputs neutralize and inherited horizontal
  // velocity is cleared so the body can settle onto the platform.
  for (let tick = 0; tick < RAISED_ENTRY_RETREAT_MAX_TICKS; tick++) {
    controller.applyClimbControls(next, 0.5)
  }
  assert.equal(controls.forward, false)
  assert.equal(controls.jump, false)
  assert.equal(bot.entity.velocity.x, 0)
  assert.equal(bot.entity.velocity.z, 0)

  // Once grounded again it commits a fresh clean run-up jump.
  bot.entity.onGround = true
  controller.applyClimbControls(next, 0.5)
  assert.equal(controls.forward, true)
  assert.equal(controls.jump, true)
})

test('raised entry does not retreat when rear support ends in void', () => {
  const controls = {}
  const bot = {
    entity: {
      position: new Vec3(0.5, 1, 0.7),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      isInWater: false
    },
    setControlState (name, value) { controls[name] = value },
    blockAt: position => positionedBlock(position.z === 0 ? 'stone' : 'air', position)
  }
  const compatibility = {
    state: { active: false },
    setPhase () { this.state.active = true },
    clear () { this.state.active = false }
  }
  const controller = createClimbController(bot, compatibility)
  controller.applyClimbControls({
    x: 0.5,
    y: 2,
    z: 0.5,
    reachKind: 'climbable',
    climbDirection: 1,
    climbBlockName: 'ladder',
    climbTransition: 'raised_entry',
    requiresJump: true
  }, 1)

  assert.equal(controls.forward, true)
  assert.equal(controls.back, false)
  assert.equal(controls.jump, true)
})

test('raised entry without requiresJump keeps the r2 forward-jump fallback', () => {
  const controls = {}
  const bot = {
    entity: {
      position: new Vec3(0.5, 1, 1.32),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      isInWater: false
    },
    setControlState (name, value) { controls[name] = value },
    blockAt: position => positionedBlock('stone', position)
  }
  const compatibility = {
    state: { active: false },
    setPhase () { this.state.active = true },
    clear () { this.state.active = false }
  }
  const controller = createClimbController(bot, compatibility)
  controller.applyClimbControls({
    x: 0.5,
    y: 2,
    z: 0.5,
    reachKind: 'climbable',
    climbDirection: 1,
    climbBlockName: 'ladder',
    climbTransition: 'raised_entry'
  }, 1)

  assert.equal(controls.forward, true)
  assert.equal(controls.back, false)
  assert.equal(controls.jump, true)
})

test('raised entry retreat is bounded when physics reports no progress', () => {
  const controls = {}
  const bot = {
    entity: {
      position: new Vec3(0.5, 1, 1.32),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      isInWater: false
    },
    setControlState (name, value) { controls[name] = value },
    blockAt: position => positionedBlock('stone', position)
  }
  const compatibility = {
    state: { active: false },
    setPhase () { this.state.active = true },
    clear () { this.state.active = false }
  }
  const controller = createClimbController(bot, compatibility)
  const next = {
    x: 0.5,
    y: 2,
    z: 0.5,
    reachKind: 'climbable',
    climbDirection: 1,
    climbBlockName: 'ladder',
    climbTransition: 'raised_entry',
    requiresJump: true
  }

  let advanceTick = null
  for (let tick = 0; tick <= RAISED_ENTRY_RETREAT_MAX_TICKS; tick++) {
    controller.applyClimbControls(next, 1)
    if (controls.forward) {
      advanceTick = tick
      break
    }
  }
  assert.ok(advanceTick !== null && advanceTick <= RAISED_ENTRY_RETREAT_MAX_TICKS, `advanceTick=${advanceTick}`)
  assert.equal(controls.forward, true)
  assert.equal(controls.back, false)
  assert.equal(controls.jump, true)
})

test('only explicit climb entries receive a bounded repeated-stuck grace period', () => {
  assert.equal(isRetryableRaisedEntry({
    reachKind: 'climbable',
    climbTransition: 'raised_entry',
    requiresJump: true
  }), true)
  assert.equal(isRetryableRaisedEntry({
    reachKind: 'climbable',
    climbTransition: 'raised_entry'
  }), false)
  assert.equal(isRetryableRaisedEntry({
    reachKind: 'climbable',
    requiresJump: true
  }), false)
  assert.equal(isRetryableRaisedEntry({
    reachKind: 'surface',
    climbTransition: 'raised_entry',
    requiresJump: true
  }), false)

  const raisedEntry = {
    reachKind: 'climbable',
    climbTransition: 'raised_entry',
    requiresJump: true
  }
  const downEntry = {
    reachKind: 'climbable',
    climbTransition: 'climbable_entry_down',
    climbDirection: -1,
    climbBlockName: 'ladder',
    requiresLanding: true
  }
  assert.equal(isRetryableClimbEntry(raisedEntry), true)
  assert.equal(isRetryableClimbEntry(downEntry), true)
  assert.equal(isRetryableClimbEntry({ ...downEntry, climbDirection: 1 }), false)
  assert.equal(isRetryableClimbEntry({ ...downEntry, climbBlockName: 'scaffolding' }), false)
  assert.equal(isRetryableClimbEntry({ ...downEntry, requiresLanding: false }), false)
  assert.equal(isRetryableClimbEntry({ ...downEntry, climbTransition: undefined }), false)
  assert.equal(isRetryableClimbEntry({ ...downEntry, reachKind: 'surface' }), false)

  assert.equal(RETRYABLE_CLIMB_ENTRY_AVOID_AFTER_FAILURES, 3)
  assert.equal(shouldEscalateRetryableClimbEntry(raisedEntry, 1), false)
  assert.equal(shouldEscalateRetryableClimbEntry(raisedEntry, 2), false)
  assert.equal(shouldEscalateRetryableClimbEntry(raisedEntry, 3), true)
  assert.equal(shouldEscalateRetryableClimbEntry(raisedEntry, 4), true)
  assert.equal(shouldEscalateRetryableClimbEntry(downEntry, 3), true)
  assert.equal(shouldEscalateRetryableClimbEntry({ reachKind: 'surface' }, 99), false)
})

test('pulse jump yields climbable entry controls to the post-monitor climb bridge', () => {
  const bot = new EventEmitter()
  bot.entity = {
    position: new Vec3(0.3, 1, 0.5),
    isInWater: false,
    onGround: true,
    velocity: new Vec3(0, 0, 0)
  }
  bot.controlState = {}
  bot.setControlState = (name, value) => { bot.controlState[name] = value }
  bot.blockAt = position => positionedBlock(
    position.y === 0 ? 'stone' : 'air',
    position
  )

  let debug = null
  bot.pathfinder = {
    isControlPaused: () => false,
    getDebugState: () => debug
  }
  const compatibility = {
    state: { active: false },
    setPhase () { this.state.active = true },
    clear () { this.state.active = false }
  }
  const controller = createClimbController(bot, compatibility)

  // Production registration order: pulse-jump listener first, climb bridge
  // second. The bridge must retain ownership after every emitted physics tick.
  patchPulseJump(bot, '[climb-entry-test]')
  bot.on('physicsTick', () => {
    controller.applyClimbControls(debug.next, debug.nextDelta.dy)
  })

  const scenarios = [
    {
      next: {
        x: 0.5,
        y: 2,
        z: 0.5,
        reachKind: 'climbable',
        climbDirection: 1,
        climbBlockName: 'ladder',
        climbTransition: 'climbable_entry_up',
        requiresJump: true
      },
      xz: 0.2,
      forward: false
    },
    {
      next: {
        x: 1.55,
        y: 2,
        z: 0.5,
        reachKind: 'climbable',
        climbDirection: 1,
        climbBlockName: 'ladder',
        climbTransition: 'raised_entry',
        requiresJump: true
      },
      xz: 1.25,
      forward: true
    }
  ]

  for (const scenario of scenarios) {
    debug = { next: scenario.next, nextDelta: { xz: scenario.xz, dy: 1 } }
    bot.controlState = {}
    for (let frame = 0; frame < 6; frame++) {
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      bot.emit('physicsTick')
      assert.equal(bot.controlState.forward, scenario.forward, `${scenario.next.climbTransition} frame=${frame}`)
      assert.equal(bot.controlState.jump, true, `${scenario.next.climbTransition} frame=${frame}`)
      assert.equal(bot.controlState.back, false, `${scenario.next.climbTransition} frame=${frame}`)
      assert.equal(bot.controlState.sprint, false, `${scenario.next.climbTransition} frame=${frame}`)
    }
  }
})

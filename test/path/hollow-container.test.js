'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const {
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
} = require('../../src/path/hollow-container')

const air = (name = 'air') => ({ name, safe: true, physical: false, liquid: false, boundingBox: 'empty', shapes: [] })
const solid = (name = 'stone') => ({ name, safe: false, physical: true, liquid: false, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] })
const liquid = (name = 'water') => ({ name, safe: true, physical: false, liquid: true, boundingBox: 'empty', shapes: [] })

function worldSampler (entries = {}) {
  return (x, y, z) => entries[`${x},${y},${z}`] || null
}

function setFlatExit (entries, x, y, z) {
  entries[`${x},${y - 1},${z}`] = solid()
  entries[`${x},${y},${z}`] = air()
  entries[`${x},${y + 1},${z}`] = air()
}

function harness ({ container = 'composter', goal = null } = {}) {
  const bot = new EventEmitter()
  const blocks = {}
  const column = { x: 0, y: 10, z: 0 }
  blocks['0,10,0'] = solid(container)
  setFlatExit(blocks, 1, 10, 0)

  bot.entity = {
    position: new Vec3(0.5, 10.25, 0.5),
    onGround: true,
    velocity: new Vec3(0.17, -0.04, -0.08)
  }
  bot.controlState = {}
  bot.setControlState = (name, value) => { bot.controlState[name] = value }
  bot.blockAt = position => blocks[`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`] || air()
  bot.lookCalls = []
  bot.look = (yaw, pitch, force) => {
    bot.lookCalls.push({ yaw, pitch, force })
    return Promise.resolve()
  }
  bot.avoidCalls = []
  bot._avoidPathNode = (...args) => {
    bot.avoidCalls.push(args)
    return true
  }

  let paused = false
  let nextToken = 0
  bot.pauseCalls = []
  bot.resumeCalls = []
  bot.pathfinder = {
    goal,
    isControlPaused: () => paused,
    pauseControls: reason => {
      const token = Object.freeze({ id: ++nextToken })
      paused = true
      bot.pauseCalls.push({ reason, token })
      return token
    },
    resumeControls: (token, reason) => {
      bot.resumeCalls.push({ token, reason })
      if (!paused) return false
      paused = false
      return true
    }
  }

  const moves = {
    getBlock: (_origin, dx, dy, dz) => blocks[`${column.x + dx},${column.y + dy},${column.z + dz}`] || null,
    getNeighbors: () => []
  }
  return { bot, blocks, column, moves }
}

test('the hollow set is explicit and does not use broad name matching', () => {
  assert.deepEqual(HOLLOW_CONTAINER_NAMES, [
    'cauldron',
    'water_cauldron',
    'lava_cauldron',
    'powder_snow_cauldron',
    'composter',
    'hopper'
  ])
  for (const name of HOLLOW_CONTAINER_NAMES) {
    assert.equal(isHollowContainer(name), true)
    assert.equal(isHollowContainer({ name }), true)
  }
  assert.equal(isHollowContainer('minecart_with_hopper'), false)
  assert.equal(isHollowContainer('decorative_cauldron'), false)
  assert.equal(isHollowContainer(null), false)
})

test('shulker boxes are unsafe path supports even though they are not hollow', () => {
  for (const name of ['shulker_box', 'white_shulker_box', 'black_shulker_box']) {
    assert.equal(isHollowContainer(name), false)
    assert.equal(isUnsafeContainerSupport(name), true)
  }

  const neighbors = [{ x: 1, y: 130, z: 2 }]
  assert.deepEqual(
    filterHollowContainerNeighbors(neighbors, () => ({ name: 'shulker_box' })),
    [],
  )
})

test('runtime rescue starts immediately when authoritative position sinks onto a shulker top', () => {
  const { bot, moves } = harness({ container: 'shulker_box', goal: { x: 10, y: 10, z: 0 } })
  const controller = createHollowContainerEscapeController(moves, bot)

  assert.equal(controller.tick(), 'started')
  assert.equal(controller.snapshot().name, 'shulker_box')
})

test('support positions are the floored node column one block below its feet', () => {
  assert.deepEqual(supportPositionForNode({ x: 3.9, y: 12.875, z: -1.01 }), { x: 3, y: 11, z: -2 })
  assert.equal(supportPositionForNode({ x: 1, y: NaN, z: 2 }), null)
})

test('neighbor filtering removes all six hollow supports and nothing else', () => {
  const neighbors = HOLLOW_CONTAINER_NAMES.map((name, index) => ({ x: index, y: 11, z: 0, name }))
  neighbors.push({ x: 20, y: 11, z: 0, name: 'stone' })
  const result = filterHollowContainerNeighbors(neighbors, position => {
    const source = neighbors.find(node => Math.floor(node.x) === position.x)
    return { name: source?.name || 'stone' }
  })
  assert.deepEqual(result, [neighbors.at(-1)])
})

test('filtering checks support rather than the body block and fails open on missing chunks', () => {
  const neighbors = [{ x: 1, y: 5, z: 2 }]
  let requested = null
  assert.deepEqual(filterHollowContainerNeighbors(neighbors, position => {
    requested = position
    return { name: 'stone' }
  }), neighbors)
  assert.deepEqual(requested, { x: 1, y: 4, z: 2 })
  assert.deepEqual(filterHollowContainerNeighbors(neighbors, () => { throw new Error('unloaded') }), neighbors)
})

test('installer reuses the movement raw block cache for planning filters', () => {
  const bot = new EventEmitter()
  let liveBlockCalls = 0
  bot.blockAt = () => {
    liveBlockCalls += 1
    return solid('stone')
  }
  bot.entity = { position: new Vec3(0.5, 5, 0.5), onGround: true, velocity: new Vec3(0, 0, 0) }
  bot.controlState = {}
  bot.setControlState = () => {}
  bot.pathfinder = {}

  let rawCalls = 0
  const moves = {
    getNeighbors: () => [{ x: 1, y: 5, z: 0 }],
    getBlock: () => air(),
    _rawBlockAt: () => {
      rawCalls += 1
      return solid('composter')
    }
  }

  const handle = installHollowContainerSupport(moves, bot)
  assert.deepEqual(moves.getNeighbors({ x: 0, y: 5, z: 0 }), [])
  assert.equal(rawCalls, 1)
  assert.equal(liveBlockCalls, 0)
  handle.uninstall()
})

test('the planning patch preserves receiver context and can be restored safely', () => {
  const moves = {
    marker: 7,
    getNeighbors (node) {
      assert.equal(this.marker, 7)
      return [{ x: node.x + 1, y: node.y, z: node.z }, { x: node.x + 2, y: node.y, z: node.z }]
    }
  }
  const original = moves.getNeighbors
  const restore = patchHollowContainerNeighbors(moves, position => ({ name: position.x === 1 ? 'hopper' : 'stone' }))
  assert.deepEqual(moves.getNeighbors({ x: 0, y: 10, z: 0 }), [{ x: 2, y: 10, z: 0 }])
  assert.equal(restore(), true)
  assert.equal(restore(), false)
  assert.equal(moves.getNeighbors, original)
})

test('safe direction selection rejects blocked, liquid, hazardous, and hollow exits', () => {
  const blocks = {}
  // West has no head clearance.
  blocks['-1,9,0'] = solid()
  blocks['-1,10,0'] = air()
  blocks['-1,11,0'] = solid()
  // East leads into water.
  blocks['1,9,0'] = solid()
  blocks['1,10,0'] = liquid()
  blocks['1,11,0'] = air()
  // North is supported by another hollow block.
  blocks['0,9,-1'] = solid('cauldron')
  blocks['0,10,-1'] = air()
  blocks['0,11,-1'] = air()
  // South is safe.
  setFlatExit(blocks, 0, 10, 1)

  assert.deepEqual(chooseSafeEscapeDirection({ x: 0, y: 10, z: 0 }, worldSampler(blocks)), {
    x: 0,
    z: 1,
    rise: 0,
    kind: 'flat',
    destination: { x: 0.5, y: 10, z: 1.5 }
  })
})

test('escape direction never relies on a door controller while path controls are paused', () => {
  const blocks = {}
  blocks['-1,9,0'] = solid()
  blocks['-1,10,0'] = air('oak_door')
  blocks['-1,11,0'] = air()
  setFlatExit(blocks, 1, 10, 0)

  const chosen = chooseSafeEscapeDirection({ x: 0, y: 10, z: 0 }, worldSampler(blocks))
  assert.deepEqual({ x: chosen.x, z: chosen.z }, { x: 1, z: 0 })
})

test('flat exits outrank step-up exits and an active target breaks equal ties', () => {
  const blocks = {}
  setFlatExit(blocks, -1, 10, 0)
  setFlatExit(blocks, 0, 10, 1)
  blocks['1,10,0'] = solid()
  blocks['1,11,0'] = air()
  blocks['1,12,0'] = air()

  const targetChoice = chooseSafeEscapeDirection(
    { x: 0, y: 10, z: 0 },
    worldSampler(blocks),
    { target: { x: 50, z: 50 } }
  )
  assert.equal(targetChoice.kind, 'flat')
  assert.deepEqual({ x: targetChoice.x, z: targetChoice.z }, { x: 0, z: 1 })

  delete blocks['-1,9,0']
  delete blocks['0,9,1']
  const stepOnly = chooseSafeEscapeDirection({ x: 0, y: 10, z: 0 }, worldSampler(blocks))
  assert.equal(stepOnly.kind, 'step_up')
  assert.deepEqual({ x: stepOnly.x, z: stepOnly.z }, { x: 1, z: 0 })
})

test('column completion is based on XZ only', () => {
  const column = { x: 2, y: 10, z: -3 }
  assert.equal(hasLeftContainerColumn({ x: 2.9, y: 20, z: -2.1 }, column), false)
  assert.equal(hasLeftContainerColumn({ x: 3, y: 10, z: -2.1 }, column), true)
  assert.equal(hasLeftContainerColumn({ x: 2.9, y: -5, z: -3.01 }, column), true)
})

test('runtime rescue immediately jumps forward without pausing when no goal exists', () => {
  const { bot, moves } = harness()
  const velocityBefore = bot.entity.velocity.clone()
  const controller = createHollowContainerEscapeController(moves, bot)

  assert.equal(controller.tick(), 'started')
  assert.equal(bot.controlState.forward, true)
  assert.equal(bot.controlState.jump, true)
  assert.equal(bot.controlState.sprint, false)
  assert.equal(bot.pauseCalls.length, 0)
  assert.equal(bot.lookCalls.length, 1)
  assert.deepEqual(bot.entity.velocity, velocityBefore)
})

test('an active path is paused by token and resumed only after XZ exit plus landing', () => {
  const { bot, moves } = harness({ goal: { x: 40, y: 10, z: 0 } })
  const controller = createHollowContainerEscapeController(moves, bot)

  assert.equal(controller.tick(), 'started')
  assert.equal(bot.pauseCalls.length, 1)
  const token = bot.pauseCalls[0].token
  assert.equal(controller.snapshot().ownsPauseToken, true)

  bot.entity.position = new Vec3(1.1, 10.9, 0.5)
  bot.entity.onGround = false
  assert.equal(controller.tick(), 'escaping')
  assert.equal(bot.resumeCalls.length, 0)
  assert.equal(bot.avoidCalls.length, 0)

  bot.entity.onGround = true
  assert.equal(controller.tick(), 'escaped')
  assert.equal(bot.controlState.forward, false)
  assert.equal(bot.controlState.jump, false)
  assert.deepEqual(bot.avoidCalls, [[
    { x: 0, y: 11, z: 0 },
    'hollow_container_escape:composter',
    120000
  ]])
  assert.equal(bot.resumeCalls.length, 1)
  assert.equal(bot.resumeCalls[0].token, token)
  assert.equal(bot.resumeCalls[0].reason, 'hollow_container_complete')
})

test('timeout releases owned controls and token without claiming a successful avoidance', () => {
  const { bot, moves } = harness({ goal: { x: 10, y: 10, z: 0 } })
  let time = 1000
  const controller = createHollowContainerEscapeController(moves, bot, {
    now: () => time,
    timeoutMs: 500,
    retryCooldownMs: 250
  })

  assert.equal(controller.tick(), 'started')
  time = 1499
  assert.equal(controller.tick(), 'escaping')
  time = 1500
  assert.equal(controller.tick(), 'timeout')
  assert.equal(bot.controlState.forward, false)
  assert.equal(bot.controlState.jump, false)
  assert.equal(bot.resumeCalls.length, 1)
  assert.equal(bot.resumeCalls[0].reason, 'hollow_container_timeout')
  assert.equal(bot.avoidCalls.length, 0)
  assert.equal(controller.tick(), 'cooldown')
})

test('a replaced goal or revoked pause aborts stale escape control ownership', () => {
  const goal = { x: 10, y: 10, z: 0 }
  const changed = harness({ goal })
  const changedController = createHollowContainerEscapeController(changed.moves, changed.bot)
  assert.equal(changedController.tick(), 'started')
  changed.bot.pathfinder.goal = { x: -10, y: 10, z: 0 }
  assert.equal(changedController.tick(), 'aborted')
  assert.equal(changed.bot.controlState.forward, false)
  assert.equal(changedController.snapshot().active, false)

  const revoked = harness({ goal })
  const revokedController = createHollowContainerEscapeController(revoked.moves, revoked.bot)
  assert.equal(revokedController.tick(), 'started')
  revoked.bot.pathfinder.isControlPaused = () => false
  assert.equal(revokedController.tick(), 'aborted')
  assert.equal(revoked.bot.controlState.jump, false)
})

test('death cleanup releases an owned pause, while a pre-existing pause is never stolen', () => {
  const owned = harness({ goal: { x: 10, y: 10, z: 0 } })
  const ownedController = createHollowContainerEscapeController(owned.moves, owned.bot)
  ownedController.tick()
  assert.equal(ownedController.abort('death'), true)
  assert.equal(owned.bot.resumeCalls[0].reason, 'hollow_container_death')

  const external = harness({ goal: { x: 10, y: 10, z: 0 } })
  external.bot.pathfinder.isControlPaused = () => true
  const externalController = createHollowContainerEscapeController(external.moves, external.bot)
  assert.equal(externalController.tick(), 'paused')
  assert.equal(external.bot.pauseCalls.length, 0)
  assert.equal(externalController.abort('death'), false)
  assert.equal(external.bot.resumeCalls.length, 0)
  assert.equal(external.bot.controlState.forward, undefined)
})

test('no verified safe direction leaves pathfinder and controls untouched', () => {
  const { bot, blocks, moves } = harness({ goal: { x: 10, y: 10, z: 0 } })
  delete blocks['1,9,0']
  delete blocks['1,10,0']
  delete blocks['1,11,0']
  const controller = createHollowContainerEscapeController(moves, bot)

  assert.equal(controller.tick(), 'blocked')
  assert.equal(bot.pauseCalls.length, 0)
  assert.equal(bot.controlState.forward, undefined)
  assert.equal(controller.snapshot().active, false)
})

test('installer wires planning and runtime once, then death/end/uninstall clean up', () => {
  const { bot, blocks, moves } = harness({ goal: { x: 10, y: 10, z: 0 } })
  moves.getNeighbors = () => [
    { x: 0, y: 11, z: 0 },
    { x: 1, y: 10, z: 0 }
  ]
  blocks['0,10,0'] = solid('hopper')
  blocks['1,9,0'] = solid()
  const originalNeighbors = moves.getNeighbors

  const installed = installHollowContainerSupport(moves, bot)
  assert.equal(installHollowContainerSupport(moves, bot), installed)
  assert.deepEqual(moves.getNeighbors({ x: 0, y: 10, z: 0 }), [{ x: 1, y: 10, z: 0 }])

  bot.emit('physicsTick')
  assert.equal(installed.controller.snapshot().active, true)
  bot.emit('death')
  assert.equal(installed.controller.snapshot().active, false)
  assert.equal(bot.resumeCalls.at(-1).reason, 'hollow_container_death')

  bot.emit('physicsTick')
  assert.equal(installed.controller.snapshot().active, true)
  bot.emit('goal_updated', { x: 20, y: 10, z: 0 })
  assert.equal(installed.controller.snapshot().active, false)

  bot.emit('physicsTick')
  assert.equal(installed.controller.snapshot().active, true)
  bot.emit('path_stop', 'cancelled')
  assert.equal(installed.controller.snapshot().active, false)

  bot.emit('physicsTick')
  assert.equal(installed.controller.snapshot().active, true)
  bot.emit('end')
  assert.equal(installed.controller.snapshot().active, false)
  assert.equal(moves.getNeighbors, originalNeighbors)
  assert.equal(bot.listenerCount('physicsTick'), 0)
  assert.equal(bot.listenerCount('goal_updated'), 0)
  assert.equal(bot.listenerCount('path_stop'), 0)
  assert.equal(installed.uninstall(), false)
})

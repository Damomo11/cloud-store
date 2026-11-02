'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { Movements } = require('../../vendor/mineflayer-pathfinder')
const mcData = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')('1.21.4')
const {
  ROLE_SUPPORT,
  ROLE_BODY,
  ROLE_HEAD,
  TRAPDOOR_NAMES,
  buildTrapdoorForwardMove,
  closedGeometryIsPassable,
  createBlockActionRunner,
  createTrapdoorPassageController,
  evaluateTrapdoorPassage,
  isPassableDoor,
  isRegularDoorName,
  isTrapdoorName,
  makeTrapdoorPassageAction,
  patchTrapdoorMoves,
  trapdoorMaterial,
} = require('../../src/path/trapdoor-passage')

function trapdoor (name = 'oak_trapdoor', properties = {}, position = { x: 4, y: 70, z: -3 }) {
  return {
    name,
    position: { ...position },
    getProperties: () => ({
      half: 'bottom',
      open: false,
      powered: false,
      waterlogged: false,
      ...properties,
    }),
  }
}

function deferred () {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function stateIdWithProperties (name, expected) {
  const definition = mcData.blocksByName[name]
  for (let stateId = definition.minStateId; stateId <= definition.maxStateId; stateId++) {
    const block = Block.fromStateId(stateId, 0)
    const properties = block.getProperties()
    if (Object.entries(expected).every(([key, value]) => String(properties[key]) === String(value))) return stateId
  }
  throw new Error(`No ${name} state matched ${JSON.stringify(expected)}`)
}

function planningHarness () {
  const world = new Map()
  const bot = {
    registry: mcData,
    game: { minY: -64 },
    inventory: { items: () => [] },
    entity: { effects: {} },
    pathfinder: { bestHarvestTool: () => null },
    blockAt (position) {
      const point = position.floored()
      const found = world.get(point.toString())
      if (found) return found
      const air = Block.fromStateId(mcData.blocksByName.air.defaultState, 0)
      air.position = point
      return air
    }
  }
  const moves = new Movements(bot)
  moves.allowParkour = true
  moves.allow1by1towers = false
  moves.allowEntityDetection = false
  moves.canDig = false
  moves._rawBlockAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z), false)

  function put (name, x, y, z, properties = null) {
    const definition = mcData.blocksByName[name]
    const stateId = properties ? stateIdWithProperties(name, properties) : definition.defaultState
    const block = Block.fromStateId(stateId, 0)
    block.position = new Vec3(x, y, z)
    world.set(block.position.toString(), block)
    return block
  }

  put('stone', 0, 0, 0)
  patchTrapdoorMoves(moves, bot)
  return { bot, moves, put }
}

test('ordinary columns skip trapdoor descriptor construction', () => {
  let descriptorCalls = 0
  const moves = {
    getBlock: () => {
      descriptorCalls += 1
      return { name: 'air' }
    }
  }
  const rawAt = (x, y, z) => ({ name: 'air', position: { x, y, z } })
  const result = buildTrapdoorForwardMove(
    moves,
    rawAt,
    { x: 0, y: 1, z: 0, remainingBlocks: 0 },
    { x: 1, z: 0 }
  )

  assert.deepEqual(result, { hasTrapdoor: false, move: null, reason: 'no_trapdoor' })
  assert.equal(descriptorCalls, 0)
})

const pathNode = () => ({ x: 0, y: 1, z: 0, remainingBlocks: 0 })

test('the explicit list covers every Minecraft 1.21.4 trapdoor', () => {
  const registryNames = Object.keys(mcData.blocksByName).filter(name => name.includes('trapdoor')).sort()
  assert.deepEqual([...TRAPDOOR_NAMES].sort(), registryNames)
  for (const name of registryNames) assert.equal(isTrapdoorName(name), true, name)
  assert.equal(isTrapdoorName('future_unknown_trapdoor'), false)
})

test('ordinary door classification never consumes trapdoors', () => {
  assert.equal(isRegularDoorName('oak_door'), true)
  assert.equal(isRegularDoorName('copper_door'), true)
  assert.equal(isRegularDoorName('oak_trapdoor'), false)
  assert.equal(isPassableDoor('oak_door'), true)
  assert.equal(isPassableDoor('copper_door'), true)
  assert.equal(isPassableDoor('oak_fence_gate'), true)
  assert.equal(isPassableDoor('iron_door'), false)
  for (const name of TRAPDOOR_NAMES) assert.equal(isPassableDoor(name), false, name)
})

test('materials distinguish wood, every copper stage, and iron', () => {
  assert.equal(trapdoorMaterial('oak_trapdoor'), 'wood')
  assert.equal(trapdoorMaterial('warped_trapdoor'), 'wood')
  assert.equal(trapdoorMaterial('copper_trapdoor'), 'copper')
  assert.equal(trapdoorMaterial('waxed_weathered_copper_trapdoor'), 'copper')
  assert.equal(trapdoorMaterial('iron_trapdoor'), 'iron')
  assert.equal(trapdoorMaterial('stone'), null)
})

test('only the verified closed collision geometries are passable', () => {
  assert.equal(closedGeometryIsPassable(ROLE_SUPPORT, 'bottom'), true)
  assert.equal(closedGeometryIsPassable(ROLE_SUPPORT, 'top'), true)
  assert.equal(closedGeometryIsPassable('foot', 'bottom'), true)
  assert.equal(closedGeometryIsPassable('bridge', 'top'), true)
  assert.equal(closedGeometryIsPassable(ROLE_BODY, 'bottom'), true)
  assert.equal(closedGeometryIsPassable(ROLE_BODY, 'top'), false)
  assert.equal(closedGeometryIsPassable(ROLE_HEAD, 'top'), true)
  assert.equal(closedGeometryIsPassable(ROLE_HEAD, 'bottom'), false)
  assert.equal(closedGeometryIsPassable(ROLE_BODY, undefined), false)
  assert.equal(closedGeometryIsPassable('nearby', 'bottom'), false)
})

test('closed safe trapdoors are immediately passable without an action', () => {
  for (const [role, half] of [[ROLE_SUPPORT, 'bottom'], [ROLE_SUPPORT, 'top'], [ROLE_BODY, 'bottom'], [ROLE_HEAD, 'top']]) {
    const result = evaluateTrapdoorPassage(trapdoor('oak_trapdoor', { half }), role)
    assert.equal(result.canPlanThrough, true)
    assert.equal(result.passableNow, true)
    assert.equal(result.needsClose, false)
    assert.equal(result.action, null)
    assert.equal(result.reason, 'safe_closed')
  }
})

test('body-top and head-bottom trapdoors are denied and never toggled', () => {
  for (const [role, half] of [[ROLE_BODY, 'top'], [ROLE_HEAD, 'bottom']]) {
    for (const open of [false, true]) {
      const result = evaluateTrapdoorPassage(trapdoor('oak_trapdoor', { half, open }), role)
      assert.equal(result.canPlanThrough, false)
      assert.equal(result.needsClose, false)
      assert.equal(result.action, null)
      assert.equal(result.reason, 'unsafe_closed_geometry')
    }
  }
})

test('open wood and copper trapdoors plan one exact close action', () => {
  for (const name of ['pale_oak_trapdoor', 'oxidized_copper_trapdoor', 'waxed_copper_trapdoor']) {
    const block = trapdoor(name, { open: true, half: 'bottom' }, { x: 12, y: 65, z: 9 })
    const result = evaluateTrapdoorPassage(block, ROLE_BODY)
    assert.equal(result.canPlanThrough, true)
    assert.equal(result.passableNow, false)
    assert.equal(result.needsClose, true)
    assert.deepEqual(result.action, {
      x: 12,
      y: 65,
      z: 9,
      kind: 'trapdoor',
      open: false,
    })
  }
})

test('open iron, powered, and waterlogged trapdoors are recognized but never auto-switched', () => {
  const cases = [
    [trapdoor('iron_trapdoor', { open: true }), 'iron_manual_only'],
    [trapdoor('oak_trapdoor', { open: true, powered: true }), 'powered_manual_only'],
    [trapdoor('copper_trapdoor', { open: true, waterlogged: true }), 'waterlogged_manual_only'],
  ]
  for (const [block, reason] of cases) {
    const result = evaluateTrapdoorPassage(block, ROLE_BODY)
    assert.equal(result.recognized, true)
    assert.equal(result.canPlanThrough, false)
    assert.equal(result.needsClose, false)
    assert.equal(result.action, null)
    assert.equal(result.reason, reason)
  }
})

test('already-closed restricted trapdoors remain usable because no switching is needed', () => {
  for (const block of [
    trapdoor('iron_trapdoor'),
    trapdoor('oak_trapdoor', { powered: true }),
    trapdoor('copper_trapdoor', { waterlogged: true }),
  ]) {
    const result = evaluateTrapdoorPassage(block, ROLE_BODY)
    assert.equal(result.canPlanThrough, true)
    assert.equal(result.passableNow, true)
    assert.equal(result.needsClose, false)
  }
})

test('actions copy coordinates instead of retaining mutable block positions', () => {
  const block = trapdoor('oak_trapdoor', { open: true })
  const action = makeTrapdoorPassageAction(block, ROLE_BODY)
  block.position.x = 999
  assert.deepEqual(action, { x: 4, y: 70, z: -3, kind: 'trapdoor', open: false })
})

test('controller activates and confirms only the exact path coordinate', async () => {
  const target = { x: 7, y: 80, z: 2 }
  let current = trapdoor('oak_trapdoor', { open: true }, target)
  const reads = []
  const activated = []
  const bot = {
    blockAt (position) {
      reads.push({ x: position.x, y: position.y, z: position.z })
      return current
    },
    async activateBlock (block) {
      activated.push(block)
      current = trapdoor('oak_trapdoor', { open: false }, target)
    },
  }
  const controller = createTrapdoorPassageController(bot, { pollIntervalMs: 1 })
  const result = await controller.ensureClosed(current, ROLE_BODY)

  assert.equal(result.ok, true)
  assert.equal(result.reason, 'closed_confirmed')
  assert.equal(activated.length, 1)
  assert.equal(activated[0].position.x, target.x)
  assert.ok(reads.length >= 2)
  assert.deepEqual(new Set(reads.map(({ x, y, z }) => `${x},${y},${z}`)), new Set(['7,80,2']))
})

test('same-coordinate requests share the in-flight lock and cannot double-toggle', async () => {
  const target = { x: 1, y: 64, z: 1 }
  let current = trapdoor('oak_trapdoor', { open: true }, target)
  const activation = deferred()
  let activationCount = 0
  const bot = {
    blockAt: () => current,
    activateBlock: () => {
      activationCount += 1
      return activation.promise.then(() => { current = trapdoor('oak_trapdoor', { open: false }, target) })
    },
  }
  const controller = createTrapdoorPassageController(bot, { pollIntervalMs: 1 })
  const action = makeTrapdoorPassageAction(current, ROLE_BODY)
  const first = controller.ensureClosed(action)
  const second = controller.ensureClosed({ ...action })

  assert.equal(first, second)
  assert.equal(controller.inFlightCount, 1)
  assert.equal(controller.isInFlight(target), true)
  activation.resolve()
  assert.equal((await first).ok, true)
  assert.equal((await second).ok, true)
  assert.equal(activationCount, 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.inFlightCount, 0)
})

test('controller waits for the observed open property to become false', async () => {
  const target = { x: 3, y: 64, z: 5 }
  let current = trapdoor('oak_trapdoor', { open: true }, target)
  const bot = { blockAt: () => current, activateBlock: async () => {} }
  const controller = createTrapdoorPassageController(bot, { confirmTimeoutMs: 100, pollIntervalMs: 2 })
  let settled = false
  const pending = controller.ensureClosed(current, ROLE_BODY).then(result => { settled = true; return result })

  await new Promise(resolve => setTimeout(resolve, 8))
  assert.equal(settled, false)
  current = trapdoor('oak_trapdoor', { open: false }, target)
  assert.equal((await pending).reason, 'closed_confirmed')
})

test('activation rejection is caught and releases the lock for retry', async () => {
  const target = { x: 6, y: 64, z: 6 }
  let current = trapdoor('oak_trapdoor', { open: true }, target)
  let fail = true
  let calls = 0
  const bot = {
    blockAt: () => current,
    activateBlock: async () => {
      calls += 1
      if (fail) throw new Error('server rejected interaction')
      current = trapdoor('oak_trapdoor', { open: false }, target)
    },
  }
  const controller = createTrapdoorPassageController(bot, { pollIntervalMs: 1 })
  const first = await controller.ensureClosed(current, ROLE_BODY)
  assert.equal(first.ok, false)
  assert.equal(first.reason, 'activation_failed')
  assert.match(first.error, /server rejected/)

  fail = false
  const second = await controller.ensureClosed(current, ROLE_BODY)
  assert.equal(second.ok, true)
  assert.equal(calls, 2)
})

test('activation timeout is reported without an unhandled rejection', async () => {
  const block = trapdoor('oak_trapdoor', { open: true })
  const bot = { blockAt: () => block, activateBlock: () => new Promise(() => {}) }
  const controller = createTrapdoorPassageController(bot, { activationTimeoutMs: 10, pollIntervalMs: 1 })
  const result = await controller.ensureClosed(block, ROLE_BODY)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'activation_timeout')
})

test('confirmation timeout is reported when the server never changes state', async () => {
  const block = trapdoor('oak_trapdoor', { open: true })
  const bot = { blockAt: () => block, activateBlock: async () => {} }
  const controller = createTrapdoorPassageController(bot, { confirmTimeoutMs: 10, pollIntervalMs: 1 })
  const result = await controller.ensureClosed(block, ROLE_BODY)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'confirmation_timeout')
})

test('controller revalidates that the exact block remains an operable trapdoor before activation', async () => {
  const original = trapdoor('oak_trapdoor', { open: true, half: 'bottom' })
  const changed = { name: 'stone', position: { ...original.position }, getProperties: () => ({}) }
  let calls = 0
  const controller = createTrapdoorPassageController({
    blockAt: () => changed,
    activateBlock: async () => { calls += 1 },
  })
  const result = await controller.ensureClosed({ ...makeTrapdoorPassageAction(original, ROLE_BODY) })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'target_not_trapdoor')
  assert.equal(calls, 0)
})

test('JSON-cloned standard block actions retain everything the runner needs', async () => {
  const target = { x: 8, y: 64, z: 8 }
  let current = trapdoor('copper_trapdoor', { open: true }, target)
  const bot = {
    blockAt: () => current,
    activateBlock: async () => { current = trapdoor('copper_trapdoor', { open: false }, target) },
  }
  const action = JSON.parse(JSON.stringify(makeTrapdoorPassageAction(current, ROLE_BODY)))
  const runner = createBlockActionRunner(bot)
  assert.equal((await runner.run(action)).reason, 'closed_confirmed')
})

test('block action runner accepts Move.blockActions and can cancel pending callers', async () => {
  const activation = deferred()
  const block = trapdoor('oak_trapdoor', { open: true })
  const runner = createBlockActionRunner({
    blockAt: () => block,
    activateBlock: () => activation.promise,
  }, { activationTimeoutMs: 100 })
  const pending = runner.run(makeTrapdoorPassageAction(block, ROLE_BODY))
  assert.equal(runner.pendingCount, 1)
  runner.cancel()
  assert.deepEqual(await pending, { ok: false, changed: false, reason: 'cancelled' })
  assert.equal(runner.pendingCount, 0)
})

test('block action runner rejects unrelated block action kinds', async () => {
  const runner = createBlockActionRunner({})
  assert.equal((await runner.run({ x: 1, y: 2, z: 3, kind: 'place' })).reason, 'unsupported_block_action')
})

test('planning replaces the false jump edge over a closed body-bottom trapdoor', () => {
  const { moves, put } = planningHarness()
  put('oak_trapdoor', 1, 1, 0, {
    half: 'bottom', open: false, powered: false, waterlogged: false
  })

  const neighbors = moves.getNeighbors(pathNode())
  const passage = neighbors.filter(move => move.x === 1 && move.z === 0)
  assert.equal(passage.length, 1)
  assert.equal(passage[0].y, 1)
  assert.equal(passage[0].plannedSurfaceY, 1 + 3 / 16)
  assert.equal(passage[0].requiresJump, undefined)
  assert.deepEqual(passage[0].blockActions, [])
})

test('an open support trapdoor produces one exact close action before crossing', () => {
  const { moves, put } = planningHarness()
  put('copper_trapdoor', 1, 0, 0, {
    half: 'top', open: true, powered: false, waterlogged: false
  })

  const passage = moves.getNeighbors(pathNode()).find(move => move.x === 1 && move.z === 0)
  assert.ok(passage)
  assert.equal(passage.plannedSurfaceY, 1)
  assert.deepEqual(passage.blockActions, [{ x: 1, y: 0, z: 0, kind: 'trapdoor', open: false }])
})

test('a temporary avoid key blocks retrying a failed bottom support trapdoor action', () => {
  const { moves, put } = planningHarness()
  put('oak_trapdoor', 1, 0, 0, {
    half: 'bottom', open: true, powered: false, waterlogged: false
  })
  moves.exclusionAreasStep.push(block => (
    block.position.x === 1 && block.position.y === 0 && block.position.z === 0 ? 1000 : 0
  ))

  assert.equal(moves.getNeighbors(pathNode()).some(move => move.x === 1 && move.z === 0), false)
})

test('head-top is allowed but body-top, head-bottom, and cramped combinations are denied', () => {
  const head = planningHarness()
  head.put('stone', 1, 0, 0)
  head.put('oak_trapdoor', 1, 2, 0, {
    half: 'top', open: true, powered: false, waterlogged: false
  })
  assert.equal(head.moves.getNeighbors(pathNode()).some(move => move.x === 1 && move.z === 0), true)

  for (const [roleY, half] of [[1, 'top'], [2, 'bottom']]) {
    const denied = planningHarness()
    denied.put('stone', 1, 0, 0)
    denied.put('oak_trapdoor', 1, roleY, 0, {
      half, open: false, powered: false, waterlogged: false
    })
    assert.equal(denied.moves.getNeighbors(pathNode()).some(move => move.x === 1 && move.z === 0), false)
  }

  const cramped = planningHarness()
  cramped.put('oak_trapdoor', 1, 1, 0, {
    half: 'bottom', open: false, powered: false, waterlogged: false
  })
  cramped.put('oak_trapdoor', 1, 2, 0, {
    half: 'top', open: false, powered: false, waterlogged: false
  })
  assert.equal(cramped.moves.getNeighbors(pathNode()).some(move => move.x === 1 && move.z === 0), false)
})

test('restricted open trapdoors are not planned, while the same closed support is usable', () => {
  for (const [name, properties] of [
    ['iron_trapdoor', { half: 'top', open: true, powered: false, waterlogged: false }],
    ['oak_trapdoor', { half: 'top', open: true, powered: true, waterlogged: false }],
    ['oak_trapdoor', { half: 'top', open: true, powered: false, waterlogged: true }]
  ]) {
    const denied = planningHarness()
    denied.put(name, 1, 0, 0, properties)
    assert.equal(denied.moves.getNeighbors(pathNode()).some(move => move.x === 1 && move.z === 0), false, name)
  }

  const closedIron = planningHarness()
  closedIron.put('iron_trapdoor', 1, 0, 0, {
    half: 'top', open: false, powered: false, waterlogged: false
  })
  const passage = closedIron.moves.getNeighbors(pathNode()).find(move => move.x === 1 && move.z === 0)
  assert.ok(passage)
  assert.deepEqual(passage.blockActions, [])
})

test('trapdoor columns reject diagonal shortcuts but retain a cardinal exit', () => {
  const diagonal = planningHarness()
  diagonal.put('stone', 1, 0, 1)
  diagonal.put('oak_trapdoor', 1, 1, 1, {
    half: 'bottom', open: false, powered: false, waterlogged: false
  })
  assert.equal(diagonal.moves.getNeighbors(pathNode()).some(move => move.x === 1 && move.z === 1), false)

  const exit = planningHarness()
  exit.put('oak_trapdoor', 0, 1, 0, {
    half: 'bottom', open: false, powered: false, waterlogged: false
  })
  exit.put('stone', 1, 0, 0)
  assert.equal(exit.moves.getNeighbors(pathNode()).some(move => move.x === 1 && move.y === 1 && move.z === 0), true)
})

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const fork = require('../../vendor/mineflayer-pathfinder')
const forkPackage = require('../../vendor/mineflayer-pathfinder/package.json')
const { pathGridPoint } = fork._test
const goto = require('../../vendor/mineflayer-pathfinder/lib/goto')
const { selectMoveControls, isPlannedSnowStepHop, advancePlannedSnowStepPulse } = require('../../vendor/mineflayer-pathfinder/lib/move-control')
const Move = require('../../vendor/mineflayer-pathfinder/lib/move')
const { cloneMoveForExecution, isNodeReached, shouldForceJump } = require('../../vendor/mineflayer-pathfinder/lib/path-node')

function gotoHarness () {
  const bot = new EventEmitter()
  bot.pathfinder = {
    setGoal (goal) {
      bot.emit('goal_updated', goal)
    }
  }
  return bot
}

function injectedBotHarness () {
  const registry = require('prismarine-registry')('1.21.4')
  const Block = require('prismarine-block')('1.21.4')
  const bot = new EventEmitter()
  bot.registry = registry
  bot.version = '1.21.4'
  bot.inventory = { items: () => [], slots: [] }
  bot.entity = {
    position: new Vec3(0.5, 1, 0.5),
    velocity: new Vec3(0, 0, 0),
    effects: {},
    onGround: true,
    isInWater: false,
    isInLava: false,
    yaw: 0,
    pitch: 0,
    metadata: []
  }
  bot.physics = { simulatePlayer: () => {} }
  bot.controlState = {}
  bot.clearControlStates = () => { bot.controlState = {} }
  bot.setControlState = (control, state) => { bot.controlState[control] = state }
  bot.look = () => Promise.resolve()
  bot.lookAt = () => Promise.resolve()
  bot.dig = () => Promise.resolve()
  bot.stopDigging = () => {}
  bot.equip = () => Promise.resolve()
  bot.placeBlock = () => Promise.resolve()
  bot.activateBlock = () => Promise.resolve()
  bot.blockAt = (position) => {
    const block = Block.fromStateId(registry.blocksByName.air.defaultState, 0)
    block.position = position.clone()
    return block
  }
  fork.pathfinder(bot)
  return bot
}

function deferred () {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function pathNode (x = 2, options = {}) {
  const node = new Vec3(x, 1, 0)
  node.cost = x
  node.toBreak = options.toBreak || []
  node.toPlace = options.toPlace || []
  node.parkour = false
  return node
}

function computedPath (status, path, visitedNodes = 1) {
  return {
    status,
    path,
    cost: path.length,
    time: 1,
    visitedNodes,
    generatedNodes: visitedNodes
  }
}

function emitBlockChange (bot, position, oldName, newName) {
  const Block = require('prismarine-block')('1.21.4')
  const named = name => {
    const block = Block.fromStateId(bot.registry.blocksByName[name].defaultState, 0)
    block.position = position.clone()
    return block
  }
  bot.emit('blockUpdate', named(oldName), named(newName))
}

const flushPromises = () => new Promise(resolve => setImmediate(resolve))

test('path dig excludes a faster unsafe tool before selecting the harvest tool', () => {
  const selectBestHarvestTool = fork._test.selectBestHarvestTool
  assert.equal(typeof selectBestHarvestTool, 'function', 'pathfinder must expose its harvest-tool policy for regression coverage')

  const unsafeShears = { name: 'shears', type: 1 }
  const safeShears = { name: 'shears', type: 2 }
  const block = {
    digTime (type) {
      if (type === null) return 1000
      if (type === unsafeShears.type) return 100
      if (type === safeShears.type) return 150
      return 1000
    }
  }

  assert.equal(
    selectBestHarvestTool(block, [unsafeShears, safeShears], {}, item => item !== unsafeShears),
    safeShears,
  )
})

test('path dig keeps the explicit hand baseline instead of selecting an equally fast non-tool', () => {
  const carrot = { name: 'carrot', type: 3 }
  const block = {
    digTime (type) {
      return type === null || type === carrot.type ? 900 : 1200
    }
  }

  assert.equal(fork._test.selectBestHarvestTool(block, [carrot], {}, () => true), null)
})


test('fork exports a frozen capability contract', () => {
  const capabilities = fork.olelaCapabilities
  assert.equal(capabilities.forkVersion, '2.4.5-olela.18-r5-lossless')
  assert.equal(capabilities.apiVersion, 1)
  assert.equal(capabilities.features.partialSegment, 1)
  assert.equal(capabilities.features.manualPauseResume, 1)
  assert.equal(capabilities.features.immediateCancel, 1)
  assert.equal(capabilities.features.detachedExecutionPath, 1)
  assert.equal(capabilities.features.typedNodeArrival, 1)
  assert.equal(capabilities.features.blockActions, 1)
  assert.equal(capabilities.features.dynamicClimbables, 1)
  assert.equal(forkPackage.olelaPatchVersion, '2026.08.06.18-r5-lossless')
  assert.equal(Object.isFrozen(capabilities), true)
  assert.equal(Object.isFrozen(capabilities.features), true)
})

test('a required surface jump overrides straight-line movement modes', () => {
  const controls = selectMoveControls({
    isInWater: false,
    requiresJump: true,
    preferGrounded: true,
    canStraightSprint: true,
    canSprintJump: false,
    canStraightWalk: true,
    canWalkJump: false
  })

  assert.deepEqual(controls, {
    forward: true,
    jump: true,
    sprint: false,
    moveMode: 'required_walk_jump'
  })
})

test('a non-rising edge prefers a grounded walk over a simulated sprint jump', () => {
  const controls = selectMoveControls({
    isInWater: false,
    requiresJump: false,
    preferGrounded: true,
    canStraightSprint: false,
    canSprintJump: true,
    canStraightWalk: true,
    canWalkJump: true
  })

  assert.deepEqual(controls, {
    forward: true,
    jump: false,
    sprint: false,
    moveMode: 'straight_walk'
  })
})

test('grounded preference still falls back to a jump when walking is blocked', () => {
  const controls = selectMoveControls({
    isInWater: false,
    requiresJump: false,
    preferGrounded: true,
    canStraightSprint: false,
    canSprintJump: true,
    canStraightWalk: false,
    canWalkJump: true
  })

  assert.equal(controls.moveMode, 'sprint_jump')
  assert.equal(controls.jump, true)
})

test('validated fractional snow step hops when physics rejects every controller', () => {
  const controls = selectMoveControls({
    isInWater: false,
    requiresJump: false,
    preferGrounded: true,
    allowPlannedSnowStepHop: true,
    canStraightSprint: false,
    canSprintJump: false,
    canStraightWalk: false,
    canWalkJump: false
  })

  assert.deepEqual(controls, {
    forward: true,
    jump: true,
    sprint: false,
    moveMode: 'planned_snow_step_hop'
  })
})

test('planned snow step hop is limited to adjacent action-free fractional steps', () => {
  const node = {
    reachKind: 'surface',
    snowSurface: true,
    toBreak: [],
    toPlace: [],
    blockActions: []
  }
  assert.equal(isPlannedSnowStepHop({ node, verticalDelta: -0.25, horizontalDistance: 1 }), true)
  assert.equal(isPlannedSnowStepHop({ node, verticalDelta: 0.125, horizontalDistance: 1 }), true)
  assert.equal(isPlannedSnowStepHop({ node, verticalDelta: -0.05, horizontalDistance: 1 }), false)
  assert.equal(isPlannedSnowStepHop({ node, verticalDelta: 0.501, horizontalDistance: 1 }), false)
  assert.equal(isPlannedSnowStepHop({ node, verticalDelta: -0.25, horizontalDistance: Math.SQRT2 + 0.11 }), false)
  assert.equal(isPlannedSnowStepHop({ node: { ...node, snowSurface: false }, verticalDelta: -0.25, horizontalDistance: 1 }), false)
  assert.equal(isPlannedSnowStepHop({ node: { ...node, requiresLanding: true }, verticalDelta: -0.25, horizontalDistance: 1 }), false)
  assert.equal(isPlannedSnowStepHop({ node: { ...node, toBreak: [{}] }, verticalDelta: -0.25, horizontalDistance: 1 }), false)
})

test('planned snow step pulse separates takeoff from horizontal advance and rearms after landing', () => {
  let pulse = advancePlannedSnowStepPulse(null, { nodeKey: 'a', settled: true })
  assert.deepEqual(pulse.controls, { forward: false, jump: true, sprint: false })
  assert.equal(pulse.moveMode, 'planned_snow_step_takeoff')

  pulse = advancePlannedSnowStepPulse(pulse.state, { nodeKey: 'a', settled: false })
  assert.deepEqual(pulse.controls, { forward: true, jump: false, sprint: false })
  assert.equal(pulse.moveMode, 'planned_snow_step_advance')
  assert.equal(pulse.state.sawAirborne, true)

  pulse = advancePlannedSnowStepPulse(pulse.state, { nodeKey: 'a', settled: true })
  assert.deepEqual(pulse.controls, { forward: true, jump: false, sprint: false })
  assert.equal(pulse.state.phase, 'takeoff')

  pulse = advancePlannedSnowStepPulse(pulse.state, { nodeKey: 'a', settled: true })
  assert.deepEqual(pulse.controls, { forward: false, jump: true, sprint: false })
  assert.equal(pulse.moveMode, 'planned_snow_step_takeoff')

  pulse = advancePlannedSnowStepPulse(pulse.state, { nodeKey: 'b', settled: true })
  assert.equal(pulse.moveMode, 'planned_snow_step_takeoff')
  assert.equal(pulse.state.nodeKey, 'b')
})

test('fractional snow takeoff applies a vertical impulse then advances while airborne', () => {
  const bot = injectedBotHarness()
  const Block = require('prismarine-block')('1.21.4')
  const snowDefinition = bot.registry.blocksByName.snow
  const airState = bot.registry.blocksByName.air.defaultState
  bot.entity.position = new Vec3(0.2, 1.5, 1.3)
  bot.entity.velocity = new Vec3(0.1, -0.0784, 0.1)
  bot.entity.onGround = true
  bot.blockAt = (position) => {
    const floored = position.floored()
    const isTargetSnow = floored.x === 0 && floored.y === 1 && floored.z === 0
    const block = Block.fromStateId(isTargetSnow ? snowDefinition.minStateId + 1 : airState, 0)
    block.position = floored
    return block
  }
  const movements = {
    allowEntityDetection: false,
    allowFreeMotion: false,
    allowSprinting: false,
    exclusionAreasStep: [],
    emptyBlocks: new Set([bot.registry.blocksByName.air.id]),
    countScaffoldingItems: () => 0,
    clearCollisionIndex: () => {},
    getNeighbors: node => node.z === 0 ? [] : [new Move(0, 1, 0, 0, node.cost + 1)]
  }
  const goal = {
    heuristic: node => Math.abs(node.z),
    isEnd: node => node.z === 0,
    isValid: () => true,
    hasChanged: () => false
  }
  bot.pathfinder.enablePathShortcut = false
  const moveModes = []
  bot.on('path_debug', info => {
    if (typeof info?.moveMode === 'string') moveModes.push(info.moveMode)
  })
  bot.pathfinder.setMovements(movements)
  bot.pathfinder.setGoal(goal)
  bot.emit('physicsTick')

  assert.equal(moveModes.includes('planned_snow_step_takeoff'), true)
  assert.equal(bot.entity.velocity.x, 0)
  assert.equal(bot.entity.velocity.y, 0.42)
  assert.equal(bot.entity.velocity.z, 0)

  bot.entity.position.y = 1.8
  bot.entity.velocity.y = 0.3
  bot.entity.onGround = false
  bot.emit('physicsTick')
  assert.equal(moveModes.includes('planned_snow_step_advance'), true)
  assert.equal(bot.controlState.forward, true)
  assert.equal(bot.controlState.jump, false)
})

test('unvalidated blocked edge remains stopped', () => {
  const controls = selectMoveControls({
    isInWater: false,
    requiresJump: false,
    preferGrounded: true,
    allowPlannedSnowStepHop: false,
    canStraightSprint: false,
    canSprintJump: false,
    canStraightWalk: false,
    canWalkJump: false
  })

  assert.equal(controls.moveMode, 'blocked_no_motion')
  assert.equal(controls.forward, false)
})

test('blocked surface avoidance maps fractional execution coordinates back to A* grid Y', () => {
  assert.deepEqual(pathGridPoint({ x: 5851.5, y: 129.5, z: 28202.38, gridY: 130 }), {
    x: 5851,
    y: 130,
    z: 28202
  })
  assert.deepEqual(pathGridPoint({ x: 5.5, y: 64, z: -2.5 }), { x: 5, y: 64, z: -3 })
})

function surfaceNoProgressHarness (supportName = 'quartz_stairs') {
  const bot = injectedBotHarness()
  const Block = require('prismarine-block')('1.21.4')
  const airState = bot.registry.blocksByName.air.defaultState
  const supportState = bot.registry.blocksByName[supportName].defaultState
  const target = pathNode(-1)
  target.x = -0.5
  target.z = 0.5
  target.gridY = 1
  target.reachKind = 'surface'
  bot.physics.simulatePlayer = state => {
    state.pos.update(target)
    state.onGround = true
  }
  const originalBlockAt = bot.blockAt
  bot.blockAt = position => {
    const point = position.floored()
    const targetSupport = point.x === -1 && point.y === 0 && point.z === 0
    if (!targetSupport) return originalBlockAt(position)
    const block = Block.fromStateId(targetSupport ? supportState : airState, 0)
    block.position = point
    return block
  }
  bot.entity.position = new Vec3(0.301, 1, 0.206)
  bot.pathfinder.surfaceNoProgressReplanMs = 200
  bot.pathfinder.getPathTo = () => computedPath('success', [target])
  const avoided = []
  const resets = []
  const modes = []
  bot._avoidPathNode = (...args) => { avoided.push(args); return true }
  bot.on('path_reset', reason => resets.push(reason))
  bot.on('path_debug', info => {
    if (info.reason === 'move_tick') modes.push(info.moveMode)
  })
  bot.pathfinder.setGoal(new fork.goals.GoalNear(-1, 1, 0, 0))
  return { bot, avoided, resets, modes }
}

test('a straight-sprint stair edge with no real progress is avoided quickly', async () => {
  const { bot, avoided, resets, modes } = surfaceNoProgressHarness()
  bot.emit('physicsTick')
  await new Promise(resolve => setTimeout(resolve, 220))
  bot.emit('physicsTick')

  assert.equal(modes.includes('straight_sprint'), true)
  assert.equal(avoided.length, 1)
  assert.deepEqual(avoided[0][0], { x: -1, y: 1, z: 0 })
  assert.match(avoided[0][1], /^surface_no_progress_stairs:/)
  assert.equal(avoided[0][2], 30000)
  assert.equal(resets.includes('surface_no_progress_stairs'), true)
})

test('real progress refreshes the stair-edge timer instead of avoiding it', async () => {
  const { bot, avoided, resets } = surfaceNoProgressHarness()
  bot.emit('physicsTick')
  await new Promise(resolve => setTimeout(resolve, 120))
  bot.entity.position.x -= 0.1
  bot.emit('physicsTick')
  await new Promise(resolve => setTimeout(resolve, 120))
  bot.emit('physicsTick')

  assert.deepEqual(avoided, [])
  assert.equal(resets.includes('surface_no_progress_stairs'), false)
})

test('stair no-progress detection adds no support-block reads before its deadline', () => {
  const { bot } = surfaceNoProgressHarness()
  let blockReads = 0
  const originalBlockAt = bot.blockAt
  bot.blockAt = position => {
    blockReads += 1
    return originalBlockAt(position)
  }

  bot.emit('physicsTick')

  // Path execution itself needs 12 reads in this fixture. The stair detector
  // must not add its two support reads until the no-progress deadline expires.
  assert.equal(blockReads, 12)
})

test('an ordinary flat surface edge with no real progress is avoided quickly', async () => {
  const { bot, avoided, resets, modes } = surfaceNoProgressHarness('grass_block')
  bot.emit('physicsTick')
  await new Promise(resolve => setTimeout(resolve, 220))
  bot.emit('physicsTick')

  assert.equal(modes.includes('straight_sprint'), true)
  assert.equal(avoided.length, 1)
  assert.deepEqual(avoided[0][0], { x: -1, y: 1, z: 0 })
  assert.match(avoided[0][1], /^surface_no_progress:/)
  assert.equal(avoided[0][2], 30000)
  assert.equal(resets.includes('surface_no_progress'), true)
})

test('without grounded preference the original sprint-jump priority is retained', () => {
  const controls = selectMoveControls({
    isInWater: false,
    requiresJump: false,
    preferGrounded: false,
    canStraightSprint: false,
    canSprintJump: true,
    canStraightWalk: true,
    canWalkJump: true
  })

  assert.equal(controls.moveMode, 'sprint_jump')
})

test('a jump edge stops forcing jump after its vertical component is complete', () => {
  const node = pathNode(2)
  node.requiresJump = true
  assert.equal(shouldForceJump(node, 1), true)
  assert.equal(shouldForceJump(node, 0.051), true)
  assert.equal(shouldForceJump(node, 0.05), false)
  assert.equal(shouldForceJump(node, 0), false)
  assert.equal(shouldForceJump(node, -0.5), false)
})

test('execution recomputes vertical delta after consuming a reached node', () => {
  const bot = injectedBotHarness()
  const Block = require('prismarine-block')('1.21.4')
  const airState = bot.registry.blocksByName.air.defaultState
  const stoneState = bot.registry.blocksByName.stone.defaultState
  bot.blockAt = (position) => {
    const point = position.floored()
    const supportsFirst = point.x === 1 && point.y === 0 && point.z === 0
    const supportsRise = point.x === 2 && point.y === 1 && point.z === 0
    const block = Block.fromStateId(supportsFirst || supportsRise ? stoneState : airState, 0)
    block.position = point
    return block
  }

  const movements = {
    allowEntityDetection: false,
    allowFreeMotion: false,
    allowSprinting: false,
    exclusionAreasStep: [],
    countScaffoldingItems: () => 0,
    clearCollisionIndex: () => {},
    getNeighbors (node) {
      if (node.x === 0) return [new Move(1, 1, 0, 0, node.cost + 1)]
      if (node.x === 1) {
        const rise = new Move(2, 2, 0, 0, node.cost + 1)
        rise.requiresJump = true
        return [rise]
      }
      return []
    }
  }
  const goal = {
    heuristic: node => Math.abs(2 - node.x) + Math.abs(2 - node.y),
    isEnd: node => node.x === 2 && node.y === 2,
    isValid: () => true,
    hasChanged: () => false
  }

  let executionPath = null
  let lastMoveTick = null
  bot.on('path_update', info => { executionPath = info.path })
  bot.on('path_debug', info => {
    if (info.reason === 'move_tick') lastMoveTick = info
  })
  bot.pathfinder.enablePathShortcut = false
  bot.pathfinder.setMovements(movements)
  bot.pathfinder.setGoal(goal)
  bot.emit('physicsTick')

  assert.equal(executionPath.length, 2)
  const expectedRise = { x: executionPath[1].x, y: executionPath[1].y }
  bot.entity.position = new Vec3(executionPath[0].x, executionPath[0].y, executionPath[0].z)
  bot.controlState = {}
  bot.emit('physicsTick')

  assert.equal(lastMoveTick.next.x, expectedRise.x)
  assert.equal(lastMoveTick.next.y, expectedRise.y)
  assert.equal(lastMoveTick.checks.edgeRequiresJump, true)
  assert.equal(lastMoveTick.checks.requiresJump, true)
  assert.equal(bot.controlState.jump, true)
})

// 上游在第一个 toBreak/toPlace 节点处 break，使该节点及之后全部保留 A* 的整数块坐标。
// 本 fork 用精确物理模拟器选控制位，瞄准方块角点会让所有候选移动判定碰撞 → blocked_no_motion，
// 于是 canDig 路径（挖穿采集必然有 toBreak）在挖到任何东西之前就卡死。
test('dig nodes and everything after them are still centered on the block', () => {
  const bot = injectedBotHarness()
  const movements = {
    allowEntityDetection: false,
    allowFreeMotion: false,
    allowSprinting: false,
    exclusionAreasStep: [],
    countScaffoldingItems: () => 0,
    clearCollisionIndex: () => {},
    getNeighbors (node) {
      if (node.x === 0) {
        // 需要破坏方块才能进入的节点。
        return [new Move(1, 1, 0, 0, node.cost + 1, [new Vec3(1, 2, 0)])]
      }
      if (node.x === 1) return [new Move(2, 1, 0, 0, node.cost + 1)]
      return []
    }
  }
  const goal = {
    heuristic: node => Math.abs(2 - node.x),
    isEnd: node => node.x === 2,
    isValid: () => true,
    hasChanged: () => false
  }

  // 必须在事件回调里就地快照：随后的 physicsTick 会 shift 掉 toBreak 并改写节点坐标。
  let snapshot = null
  bot.on('path_update', info => {
    snapshot = info.path.map(n => ({
      x: n.x,
      z: n.z,
      toBreak: n.toBreak.map(b => ({ x: b.x, y: b.y, z: b.z })),
    }))
  })
  bot.pathfinder.enablePathShortcut = false
  bot.pathfinder.setMovements(movements)
  bot.pathfinder.setGoal(goal)
  bot.emit('physicsTick')

  assert.equal(snapshot.length, 2)
  const digIndex = snapshot.findIndex(n => n.toBreak.length > 0)
  assert.notEqual(digIndex, -1, '路径里应当有需要破坏的节点: ' + JSON.stringify(snapshot))
  assert.equal(snapshot[digIndex].x, 1.5)
  assert.equal(snapshot[digIndex].z, 0.5)
  // 破坏的目标由 toBreak[] 指定，不受节点自身居中影响。
  assert.deepEqual(snapshot[digIndex].toBreak[0], { x: 1, y: 2, z: 0 })
  // 关键：dig 节点之后的节点也必须居中，上游的 break 会让它们停在整数坐标。
  for (const node of snapshot.slice(digIndex + 1)) {
    assert.equal(node.x % 1, 0.5, `节点 x=${node.x} 未居中`)
    assert.equal(node.z % 1, 0.5, `节点 z=${node.z} 未居中`)
  }
})

test('execution path nodes are detached from A* coordinates and operation arrays', () => {
  const source = new Move(
    1,
    2,
    3,
    4,
    5,
    [new Vec3(8, 9, 10)],
    [{ x: 4, y: 5, z: 6, returnPos: new Vec3(1, 1, 1) }]
  )
  source.requiresJump = true
  source.surfaceY = 2.75
  source.snowSurface = true
  source.gridY = 2
  source.reachKind = 'surface'
  source.climbDirection = 1
  source.climbBlockType = 835
  source.climbBlockName = 'twisting_vines'
  source.climbNeedsPhysicsCompat = true
  source.climbTransition = 'column'
  source.plannedSurfaceY = 2.1875
  source.trapdoorPassage = true
  source.controlledDropDistance = 24
  source.blockActions = [{ x: 3, y: 2, z: 1, kind: 'trapdoor', open: false }]

  const execution = cloneMoveForExecution(source)
  execution.x = 1.5
  execution.toBreak.shift()
  execution.toPlace[0].returnPos.x = 99

  assert.equal(source.x, 1)
  assert.equal(source.toBreak.length, 1)
  assert.equal(source.toPlace[0].returnPos.x, 1)
  assert.equal(execution.requiresJump, true)
  assert.equal(execution.surfaceY, 2.75)
  assert.equal(execution.snowSurface, true)
  assert.equal(execution.gridY, 2)
  assert.equal(execution.reachKind, 'surface')
  assert.equal(execution.climbDirection, 1)
  assert.equal(execution.climbBlockType, 835)
  assert.equal(execution.climbBlockName, 'twisting_vines')
  assert.equal(execution.climbNeedsPhysicsCompat, true)
  assert.equal(execution.climbTransition, 'column')
  assert.equal(execution.plannedSurfaceY, 2.1875)
  assert.equal(execution.trapdoorPassage, true)
  assert.equal(execution.controlledDropDistance, 24)
  assert.deepEqual(execution.blockActions, source.blockActions)
  assert.notEqual(execution.blockActions, source.blockActions)
  assert.notEqual(execution.blockActions[0], source.blockActions[0])
})

test('a planned large drop delegates to controlled elytra descent before normal controls', async () => {
  const bot = injectedBotHarness()
  const calls = []
  let releaseDrop
  bot._executeControlledPathDrop = drop => {
    calls.push(drop)
    return new Promise(resolve => { releaseDrop = resolve })
  }
  const movements = {
    allowEntityDetection: false,
    allowFreeMotion: false,
    allowSprinting: true,
    exclusionAreasStep: [],
    countScaffoldingItems: () => 0,
    clearCollisionIndex: () => {},
    getNeighbors (node) {
      if (node.x !== 0) return []
      const drop = new Move(1, -23, 0, 0, node.cost + 24)
      drop.requiresLanding = true
      drop.controlledDropDistance = 24
      return [drop]
    }
  }
  const goal = {
    heuristic: node => Math.abs(1 - node.x) + Math.abs(-23 - node.y),
    isEnd: node => node.x === 1 && node.y === -23,
    isValid: () => true,
    hasChanged: () => false
  }

  bot.pathfinder.enablePathShortcut = false
  bot.pathfinder.setMovements(movements)
  bot.pathfinder.setGoal(goal)
  bot.emit('physicsTick')

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { x: 1.5, y: -23, z: 0.5, dropDistance: 24 })
  assert.equal(bot.controlState.forward, undefined)

  bot.entity.position = new Vec3(1.5, -23, 0.5)
  bot.entity.onGround = true
  releaseDrop({ ok: true })
  await new Promise(resolve => setImmediate(resolve))
  bot.emit('physicsTick')
  assert.equal(bot.pathfinder.goal, null)
})

test('Movements plans an unlimited large drop and marks it for controlled descent', () => {
  const mcData = require('minecraft-data')('1.21.4')
  const Block = require('prismarine-block')('1.21.4')
  const world = new Map()
  const makeBlock = (name, x, y, z) => {
    const block = Block.fromStateId(mcData.blocksByName[name].defaultState, 0)
    block.position = new Vec3(x, y, z)
    return block
  }
  world.set(new Vec3(0, 24, 0).toString(), makeBlock('stone', 0, 24, 0))
  world.set(new Vec3(1, 0, 0).toString(), makeBlock('stone', 1, 0, 0))
  const bot = {
    registry: mcData,
    game: { minY: -64 },
    inventory: { items: () => [] },
    entity: { effects: {} },
    pathfinder: { bestHarvestTool: () => null },
    blockAt (position) {
      const point = position.floored()
      return world.get(point.toString()) || makeBlock('air', point.x, point.y, point.z)
    }
  }
  const moves = new fork.Movements(bot)
  moves.allowEntityDetection = false
  moves.canDig = false
  moves.allow1by1towers = false

  assert.equal(moves.maxDropDown, Infinity)
  const neighbors = []
  moves.getMoveDropDown(new Move(0, 25, 0, 0, 0), { x: 1, z: 0 }, neighbors)
  const drop = neighbors.find(node => node.x === 1 && node.y === 1 && node.z === 0)
  assert.ok(drop, 'the 24-block landing edge should be available')
  assert.equal(drop.requiresLanding, true)
  assert.equal(drop.controlledDropDistance, 24)
})


test('jump and drop nodes require precise vertical arrival', () => {
  const jump = pathNode(2)
  jump.requiresJump = true
  assert.equal(isNodeReached(jump, new Vec3(2, 1.92, 0), { onGround: false }), false)
  assert.equal(isNodeReached(jump, new Vec3(2, 1.3, 0), { onGround: false, velocity: new Vec3(0, 0, 0) }), false)
  assert.equal(isNodeReached(jump, new Vec3(2, 1.02, 0), { onGround: true }), true)

  const landing = pathNode(2)
  landing.requiresLanding = true
  assert.equal(isNodeReached(landing, new Vec3(2, 1.8, 0), { onGround: false }), false)
  assert.equal(isNodeReached(landing, new Vec3(2, 1.8, 0), { isInWater: true }), true)

  const ordinary = pathNode(2)
  assert.equal(isNodeReached(ordinary, new Vec3(2, 1.92, 0), { onGround: false }), true)
})

test('typed surface, water, and climbable nodes use their own arrival semantics', () => {
  const surface = pathNode(2)
  surface.y = 1.625
  surface.surfaceY = 1.625
  surface.snowSurface = true
  surface.reachKind = 'surface'
  assert.equal(isNodeReached(surface, new Vec3(2, 1.625, 0), { onGround: true }), true)
  assert.equal(isNodeReached(surface, new Vec3(2, 1.925, 0), { onGround: false, velocity: new Vec3(0, 0, 0) }), false)
  assert.equal(isNodeReached(surface, new Vec3(2, 1.625, 0), { onGround: false, velocity: new Vec3(0, 0.2, 0) }), false)
  assert.equal(isNodeReached(surface, new Vec3(2, 1.625, 0), { onGround: false, velocity: new Vec3(0, 0.01, 0) }), false)
  assert.equal(isNodeReached(surface, new Vec3(2, 1.625, 0), { onGround: false, velocity: new Vec3(0, 0, 0) }), true)
  assert.equal(isNodeReached(surface, new Vec3(2, 1.625, 0), { onGround: false, velocity: new Vec3(0, -0.0784, 0) }), true)

  const restingSnow = pathNode(2)
  restingSnow.y = 151
  restingSnow.surfaceY = 151
  restingSnow.snowSurface = true
  restingSnow.reachKind = 'surface'
  assert.equal(isNodeReached(restingSnow, new Vec3(2, 150.9216, 0), { onGround: false, velocity: new Vec3(0, -0.0784, 0) }), true)
  assert.equal(isNodeReached(restingSnow, new Vec3(2, 150.9216, 0), { onGround: false, velocity: new Vec3(0, 0, 0) }), true)
  assert.equal(isNodeReached(restingSnow, new Vec3(2, 150.899, 0), { onGround: false, velocity: new Vec3(0, -0.0784, 0) }), false)
  assert.equal(isNodeReached(restingSnow, new Vec3(2, 151.0784, 0), { onGround: false, velocity: new Vec3(0, -0.0784, 0) }), false)
  assert.equal(isNodeReached(restingSnow, new Vec3(2, 150.9216, 0), { velocity: new Vec3(0, -0.0784, 0) }), false)
  assert.equal(isNodeReached(restingSnow, new Vec3(2, 150.9216, 0), { onGround: false, velocity: new Vec3(0, -0.101, 0) }), false)

  const ordinarySurface = pathNode(2)
  ordinarySurface.reachKind = 'surface'
  assert.equal(isNodeReached(ordinarySurface, new Vec3(2, 1, 0), { onGround: false, velocity: new Vec3(0, -0.0784, 0) }), false)
  assert.equal(isNodeReached(ordinarySurface, new Vec3(2, 0.9216, 0), { onGround: false, velocity: new Vec3(0, -0.0784, 0) }), false)

  const water = pathNode(2)
  water.gridY = 1
  water.reachKind = 'water'
  assert.equal(isNodeReached(water, new Vec3(2, 1.8, 0), { isInWater: true }), true)
  assert.equal(isNodeReached(water, new Vec3(2, 1.8, 0), { isInWater: false }), false)
  assert.equal(isNodeReached(water, new Vec3(2, 2.01, 0), { isInWater: true }), false)

  const ladder = pathNode(2)
  ladder.gridY = 1
  ladder.reachKind = 'climbable'
  assert.equal(isNodeReached(ladder, new Vec3(2, 1.99, 0), {}), true)
  assert.equal(isNodeReached(ladder, new Vec3(2, 2.01, 0), {}), false)
})

test('ascending and descending ladder execution nodes retain raw volume Y', () => {
  for (const [startY, targetY] of [
    [0, 2],
    [3, 1]
  ]) {
    const bot = injectedBotHarness()
    const Block = require('prismarine-block')('1.21.4')
    const ladderState = bot.registry.blocksByName.ladder.defaultState
    bot.blockAt = (position) => {
      const block = Block.fromStateId(ladderState, 0)
      block.position = position.floored()
      return block
    }
    bot.pathfinder.enablePathShortcut = false
    const direction = Math.sign(targetY - startY)
    const movements = {
      allowEntityDetection: false,
      countScaffoldingItems: () => 0,
      getNeighbors: node => node.y === targetY
        ? []
        : [new Move(0, node.y + direction, 0, 0, node.cost + 1)]
    }
    const goal = {
      heuristic: node => Math.abs(targetY - node.y),
      isEnd: node => node.y === targetY
    }
    const executionPath = bot.pathfinder.getPathFromTo(
      movements,
      bot.entity.position,
      goal,
      { startMove: new Move(0, startY, 0, 0, 0), optimizePath: true }
    ).next().value.result.path

    assert.ok(executionPath)
    assert.deepEqual(executionPath.map(node => ({
      x: node.x,
      y: node.y,
      z: node.z,
      gridY: node.gridY,
      reachKind: node.reachKind
    })), Array.from({ length: Math.abs(targetY - startY) }, (_, index) => ({
      x: 0.5,
      y: startY + direction * (index + 1),
      z: 0.5,
      gridY: startY + direction * (index + 1),
      reachKind: 'climbable'
    })))
  }
})

test('water execution nodes retain their raw volume and require water arrival', () => {
  const bot = injectedBotHarness()
  const Block = require('prismarine-block')('1.21.4')
  const waterState = bot.registry.blocksByName.water.defaultState
  bot.blockAt = (position) => {
    const block = Block.fromStateId(waterState, 0)
    block.position = position.floored()
    return block
  }
  bot.pathfinder.enablePathShortcut = false
  const movements = {
    allowEntityDetection: false,
    countScaffoldingItems: () => 0,
    getNeighbors: node => node.y === 1 ? [] : [new Move(0, 1, 0, 0, 1)]
  }
  const goal = {
    heuristic: node => Math.abs(1 - node.y),
    isEnd: node => node.y === 1
  }
  const executionPath = bot.pathfinder.getPathFromTo(
    movements,
    bot.entity.position,
    goal,
    { startMove: new Move(0, 0, 0, 0, 0), optimizePath: true }
  ).next().value.result.path

  assert.ok(executionPath)
  assert.deepEqual({
    x: executionPath[0].x,
    y: executionPath[0].y,
    z: executionPath[0].z,
    gridY: executionPath[0].gridY,
    reachKind: executionPath[0].reachKind
  }, { x: 0.5, y: 1, z: 0.5, gridY: 1, reachKind: 'water' })
  assert.equal(isNodeReached(executionPath[0], new Vec3(0.5, 1.9, 0.5), { isInWater: false }), false)
  assert.equal(isNodeReached(executionPath[0], new Vec3(0.5, 1.9, 0.5), { isInWater: true }), true)
})

test('a cardinal drop onto snow is typed as a settled snow surface', () => {
  const bot = injectedBotHarness()
  const Block = require('prismarine-block')('1.21.4')
  const snowDefinition = bot.registry.blocksByName.snow
  const airState = bot.registry.blocksByName.air.defaultState
  bot.blockAt = (position) => {
    const floored = position.floored()
    const stateId = floored.y === 1 ? snowDefinition.minStateId + 5 : airState
    const block = Block.fromStateId(stateId, 0)
    block.position = floored
    return block
  }
  bot.pathfinder.enablePathShortcut = false
  const movements = {
    allowEntityDetection: false,
    countScaffoldingItems: () => 0,
    getNeighbors: node => node.y === 2 ? [] : [Object.assign(new Move(0, 2, 0, 0, 1), { requiresLanding: true })]
  }
  const goal = {
    heuristic: node => Math.abs(2 - node.y),
    isEnd: node => node.y === 2
  }
  const executionPath = bot.pathfinder.getPathFromTo(
    movements,
    bot.entity.position,
    goal,
    { startMove: new Move(0, 3, 0, 0, 0), optimizePath: true }
  ).next().value.result.path

  assert.equal(executionPath.length, 1)
  assert.equal(executionPath[0].reachKind, 'surface')
  assert.equal(executionPath[0].requiresLanding, true)
  assert.equal(executionPath[0].snowSurface, true)
  assert.equal(executionPath[0].surfaceY, 1.625)
  assert.equal(executionPath[0].y, 1.625)
  assert.equal(isNodeReached(executionPath[0], new Vec3(0.5, 1.625, 0.5), {
    onGround: false,
    velocity: new Vec3(0, -0.0784, 0)
  }), true)
  assert.equal(isNodeReached(executionPath[0], new Vec3(0.5, 1.5466, 0.5), {
    onGround: false,
    velocity: new Vec3(0, -0.0784, 0)
  }), true)
})

test('partial path post-processing does not mutate the live A* tree', () => {
  const bot = injectedBotHarness()
  const movements = {
    allowEntityDetection: false,
    countScaffoldingItems: () => 0,
    clearCollisionIndex: () => {},
    getNeighbors (node) {
      const until = performance.now() + 2
      while (performance.now() < until) {}
      return [new Move(node.x + 1, node.y, node.z, 0, 1)]
    }
  }
  bot.pathfinder.setMovements(movements)
  const goal = {
    heuristic: node => 100 - node.x,
    isEnd: node => node.x >= 100
  }

  const generator = bot.pathfinder.getPathFromTo(
    movements,
    new Vec3(0.5, 1, 0.5),
    goal,
    { tickTimeout: 1, timeout: 1000 }
  )
  const first = generator.next().value

  assert.equal(first.result.status, 'partial')
  assert.equal(first.result.path[0].x, 1.5)
  assert.equal(first.astarContext.bestNode.data.x, 1)
  assert.equal(first.astarContext.bestNode.data.y, 1)
  assert.equal(first.astarContext.bestNode.data.z, 0)
})

test('manual pause keeps the goal and goto state while immediate cancel clears it', () => {
  const bot = injectedBotHarness()
  const goal = new fork.goals.GoalNear(10, 1, 0, 1)
  let stopEvents = 0
  bot.on('path_stop', () => { stopEvents += 1 })
  bot.pathfinder.setGoal(goal)

  const token = bot.pathfinder.pauseControls('unit_test')
  assert.equal(bot.pathfinder.goal, goal)
  assert.equal(bot.pathfinder.isControlPaused(), true)
  assert.equal(bot.pathfinder.getDebugState().status.controlPaused, true)
  assert.equal(stopEvents, 0)

  assert.equal(bot.pathfinder.resumeControls(token, 'unit_test'), true)
  assert.equal(bot.pathfinder.goal, goal)
  assert.equal(bot.pathfinder.isControlPaused(), false)
  assert.equal(stopEvents, 0)

  bot.pathfinder.cancelNow('unit_test')
  assert.equal(bot.pathfinder.goal, null)
  assert.equal(stopEvents, 1)
})

test('pause tokens are identity-bound and cannot resume another bot', () => {
  const botA = injectedBotHarness()
  const botB = injectedBotHarness()
  botA.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))
  botB.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))

  const tokenA = botA.pathfinder.pauseControls('bot_a')
  const tokenB = botB.pathfinder.pauseControls('bot_b')
  assert.equal(tokenA.id, tokenB.id)
  assert.equal(botB.pathfinder.resumeControls(tokenA, 'cross_bot'), false)
  assert.equal(botB.pathfinder.resumeControls({ id: tokenB.id }, 'forged'), false)
  assert.equal(botB.pathfinder.isControlPaused(), true)
  assert.equal(botB.pathfinder.resumeControls(tokenB, 'owner'), true)
})

test('stop immediately cancels a paused goal and invalidates its token', () => {
  const bot = injectedBotHarness()
  const goal = new fork.goals.GoalNear(10, 1, 0, 1)
  const stopReasons = []
  bot.on('path_stop', reason => stopReasons.push(reason))
  bot.pathfinder.setGoal(goal)
  const token = bot.pathfinder.pauseControls('rescue')

  bot.pathfinder.stop()

  assert.equal(bot.pathfinder.goal, null)
  assert.equal(bot.pathfinder.isControlPaused(), false)
  assert.deepEqual(stopReasons, ['stop'])
  assert.equal(bot.pathfinder.resumeControls(token, 'too_late'), false)
})

test('replacing a paused goal revokes the old pause token explicitly', () => {
  const bot = injectedBotHarness()
  const firstGoal = new fork.goals.GoalNear(10, 1, 0, 1)
  const secondGoal = new fork.goals.GoalNear(20, 1, 0, 1)
  const resumeEvents = []
  bot.on('path_resume', info => resumeEvents.push(info))
  bot.pathfinder.setGoal(firstGoal)
  const token = bot.pathfinder.pauseControls('rescue')

  bot.pathfinder.setGoal(secondGoal)

  assert.equal(bot.pathfinder.goal, secondGoal)
  assert.equal(bot.pathfinder.isControlPaused(), false)
  assert.equal(bot.pathfinder.resumeControls(token, 'stale'), false)
  assert.deepEqual(resumeEvents, [{
    tokenId: token.id,
    reason: 'goal_updated',
    resumed: false,
    staleGoal: true
  }])
})

test('below-threshold partial and terminal failures never become executable paths', async () => {
  for (const status of ['partial', 'noPath', 'timeout']) {
    const bot = injectedBotHarness()
    const goal = new fork.goals.GoalNear(10, 1, 0, 1)
    const result = computedPath(status, [pathNode(2)], 1)
    bot.pathfinder.allowPartialPath = true
    bot.pathfinder.partialMinPathLength = 5
    bot.pathfinder.partialMinVisitedNodes = 2000
    bot.pathfinder.getPathTo = () => result

    if (status === 'partial') {
      bot.pathfinder.setGoal(goal)
      bot.emit('physicsTick')
      assert.equal(bot.pathfinder.getDebugState().status.astartTimedout, true)
    } else {
      const promise = bot.pathfinder.goto(goal)
      bot.emit('physicsTick')
      await assert.rejects(promise, error => error?.name === (status === 'noPath' ? 'NoPath' : 'Timeout'))
    }

    assert.equal(bot.pathfinder.isMoving(), false, `${status} must not assign its best-so-far path`)
    assert.equal(bot.pathfinder.getDebugState().status.partialSegmentActive, false)
  }
})

test('a below-threshold partial keeps its A* context and continues computing', () => {
  const bot = injectedBotHarness()
  const goal = new fork.goals.GoalNear(10, 1, 0, 1)
  const updates = []
  let continuationCalls = 0
  const context = {
    compute: () => {
      continuationCalls += 1
      return computedPath('success', [
        pathNode(3, { toBreak: [new Vec3(3, 1, 0)] })
      ], 10)
    }
  }
  bot.entity.onGround = false
  bot.pathfinder.allowPartialPath = true
  bot.pathfinder.partialMinPathLength = 5
  bot.pathfinder.partialMinVisitedNodes = 2000
  bot.pathfinder.getPathFromTo = function * () {
    yield {
      result: computedPath('partial', [pathNode(2)], 1),
      astarContext: context
    }
  }
  bot.on('path_update', result => updates.push(result.status))

  bot.pathfinder.setGoal(goal)
  bot.emit('physicsTick')
  assert.equal(bot.pathfinder.isMoving(), false)
  bot.emit('physicsTick')

  assert.equal(continuationCalls, 1)
  assert.deepEqual(updates, ['partial', 'success'])
  assert.equal(bot.pathfinder.isMoving(), true)
})

test('a below-threshold terminal continuation rejects goto without moving', async () => {
  const bot = injectedBotHarness()
  const goal = new fork.goals.GoalNear(10, 1, 0, 1)
  const context = {
    compute: () => computedPath('timeout', [pathNode(3)], 10)
  }
  bot.pathfinder.allowPartialPath = true
  bot.pathfinder.partialMinPathLength = 5
  bot.pathfinder.partialMinVisitedNodes = 2000
  bot.pathfinder.getPathFromTo = function * () {
    yield {
      result: computedPath('partial', [pathNode(2)], 1),
      astarContext: context
    }
  }

  const promise = bot.pathfinder.goto(goal)
  bot.emit('physicsTick')
  bot.emit('physicsTick')

  await assert.rejects(promise, error => error?.name === 'Timeout')
  assert.equal(bot.pathfinder.isMoving(), false)
  assert.equal(bot.pathfinder.getDebugState().status.partialSegmentActive, false)
})

test('a partial or timeout that meets both thresholds becomes an executable segment', () => {
  for (const status of ['partial', 'timeout']) {
    const bot = injectedBotHarness()
    const goal = new fork.goals.GoalNear(20, 1, 0, 1)
    const updates = []
    const path = [1, 2, 3, 4, 5].map(x => pathNode(x, { toBreak: [new Vec3(x, 1, 0)] }))
    bot.entity.onGround = false
    bot.pathfinder.allowPartialPath = true
    bot.pathfinder.partialMinPathLength = 5
    bot.pathfinder.partialMinVisitedNodes = 2000
    bot.pathfinder.getPathTo = () => computedPath(status, path, 2000)
    bot.on('path_update', result => updates.push(result.status))

    bot.pathfinder.setGoal(goal)
    bot.emit('physicsTick')

    assert.deepEqual(updates, ['partialSegment'])
    assert.equal(bot.pathfinder.isMoving(), true)
    assert.equal(bot.pathfinder.getDebugState().status.partialSegmentActive, true)
  }
})

test('cancelNow aborts active digging and ignores its later completion', async () => {
  const bot = injectedBotHarness()
  const pendingDig = deferred()
  let stopDiggingCalls = 0
  bot.dig = () => pendingDig.promise
  bot.stopDigging = () => { stopDiggingCalls += 1 }
  bot.pathfinder.getPathTo = () => computedPath('success', [
    pathNode(2, { toBreak: [new Vec3(1, 1, 0)] })
  ])
  bot.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))
  bot.emit('physicsTick')
  assert.equal(bot.pathfinder.isMining(), true)

  bot.pathfinder.cancelNow('dig_cancel')
  assert.equal(bot.pathfinder.isMining(), false)
  assert.equal(stopDiggingCalls, 1)
  pendingDig.resolve()
  await flushPromises()
  assert.equal(bot.pathfinder.isMining(), false)
  assert.equal(bot.pathfinder.goal, null)
})

test('path dig clears an unsafe held tool before using the hand baseline', async () => {
  const bot = injectedBotHarness()
  const unsafeShears = { name: 'shears', type: bot.registry.itemsByName.shears.id }
  const calls = []
  bot.heldItem = unsafeShears
  bot.inventory = { items: () => [unsafeShears], slots: [] }
  bot.pathfinder.isHarvestToolSafe = () => false
  bot.unequip = async destination => {
    calls.push(`unequip:${destination}`)
    bot.heldItem = null
  }
  bot.dig = async () => { calls.push('dig') }
  bot.pathfinder.getPathTo = () => computedPath('success', [
    pathNode(2, { toBreak: [new Vec3(1, 1, 0)] })
  ])

  bot.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))
  bot.emit('physicsTick')
  await flushPromises()

  assert.deepEqual(calls, ['unequip:hand', 'dig'])
})

test('path dig does not continue with the old held item when safe-tool equip fails', async () => {
  const bot = injectedBotHarness()
  const safeTool = { name: 'iron_pickaxe', type: bot.registry.itemsByName.iron_pickaxe.id }
  const resets = []
  let digCalls = 0
  bot.heldItem = { name: 'shears', type: bot.registry.itemsByName.shears.id }
  bot.pathfinder.bestHarvestTool = () => safeTool
  bot.equip = async () => { throw new Error('equip_failed') }
  bot.dig = async () => { digCalls += 1 }
  bot.on('path_reset', reason => resets.push(reason))
  bot.pathfinder.getPathTo = () => computedPath('success', [
    pathNode(2, { toBreak: [new Vec3(1, 1, 0)] })
  ])

  const originalWarn = console.warn
  console.warn = () => {}
  try {
    bot.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))
    bot.emit('physicsTick')
    await flushPromises()
  } finally {
    console.warn = originalWarn
  }

  assert.equal(digCalls, 0)
  assert.deepEqual(resets, ['dig_tool_prepare_error'])
})

test('breaking our own path block keeps the path instead of replanning', async () => {
  const bot = injectedBotHarness()
  const pendingDig = deferred()
  const resets = []
  let stopDiggingCalls = 0
  bot.dig = () => pendingDig.promise
  bot.stopDigging = () => { stopDiggingCalls += 1 }
  bot.on('path_reset', reason => resets.push(reason))
  bot.pathfinder.getPathTo = () => computedPath('success', [
    pathNode(2, { toBreak: [new Vec3(1, 1, 0)] })
  ])
  bot.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))
  bot.emit('physicsTick')
  assert.equal(bot.pathfinder.isMining(), true)

  emitBlockChange(bot, new Vec3(1, 1, 0), 'stone', 'air')
  assert.deepEqual(resets, [])
  assert.equal(stopDiggingCalls, 0)
  assert.equal(bot.pathfinder.isMoving(), true)

  pendingDig.resolve()
  await flushPromises()
  assert.equal(bot.pathfinder.isMining(), false)

  // The suppression must not outlive the dig, or real terrain changes stay invisible.
  emitBlockChange(bot, new Vec3(1, 1, 0), 'air', 'stone')
  assert.deepEqual(resets, ['block_updated'])
})

test('a foreign block change during our own dig still replans', () => {
  const bot = injectedBotHarness()
  const resets = []
  bot.dig = () => new Promise(() => {})
  bot.on('path_reset', reason => resets.push(reason))
  bot.pathfinder.getPathTo = () => computedPath('success', [
    pathNode(2, { toBreak: [new Vec3(1, 1, 0)] })
  ])
  bot.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))
  bot.emit('physicsTick')
  assert.equal(bot.pathfinder.isMining(), true)

  emitBlockChange(bot, new Vec3(2, 1, 0), 'air', 'stone')
  assert.deepEqual(resets, ['block_updated'])
  assert.equal(bot.pathfinder.isMoving(), false)
  bot.pathfinder.cancelNow('test_cleanup')
})

test('an unloaded dig target replans instead of throwing on physicsTick', () => {
  const bot = injectedBotHarness()
  const resets = []
  const loadedBlockAt = bot.blockAt
  let digCalls = 0
  bot.inventory = { items: () => [{ type: 1, nbt: null }], slots: [] }
  bot.blockAt = (position, loadChunk) => {
    if (loadChunk === false && position.x === 1 && position.y === 1 && position.z === 0) return null
    return loadedBlockAt(position)
  }
  bot.dig = () => { digCalls += 1; return Promise.resolve() }
  bot.on('path_reset', reason => resets.push(reason))
  bot.pathfinder.getPathTo = () => computedPath('success', [
    pathNode(2, { toBreak: [new Vec3(1, 1, 0)] })
  ])
  bot.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))

  const originalWarn = console.warn
  const warnings = []
  console.warn = message => warnings.push(String(message))
  try {
    assert.doesNotThrow(() => bot.emit('physicsTick'))
  } finally {
    console.warn = originalWarn
  }

  assert.deepEqual(resets, ['dig_block_unloaded'])
  assert.equal(digCalls, 0)
  assert.equal(bot.pathfinder.isMining(), false)
  assert.equal(bot.pathfinder.isMoving(), false)
  assert.match(warnings[0], /dig target \(1,1,0\) is not loaded/)
})

test('a synchronous monitorMovement failure becomes a path reset, not a crash', () => {
  const bot = injectedBotHarness()
  const resets = []
  bot.on('path_reset', reason => resets.push(reason))
  bot.pathfinder.getPathTo = () => computedPath('success', [pathNode(2)])
  bot.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))
  bot.emit('physicsTick')
  assert.equal(bot.pathfinder.isMoving(), true)

  bot.look = () => { throw new TypeError('boom') }
  const originalError = console.error
  const errors = []
  console.error = message => errors.push(String(message))
  try {
    assert.doesNotThrow(() => bot.emit('physicsTick'))
  } finally {
    console.error = originalError
  }

  assert.deepEqual(resets, ['monitor_error'])
  assert.equal(bot.pathfinder.isMoving(), false)
  assert.match(errors[0], /monitor error: boom/)
})

test('pause invalidates a pending placement equip callback', async () => {
  const bot = injectedBotHarness()
  const pendingEquip = deferred()
  let equipCalls = 0
  let placeCalls = 0
  bot.pathfinder.movements.getScaffoldingItem = () => ({ name: 'stone' })
  bot.equip = () => {
    equipCalls += 1
    return equipCalls === 1 ? pendingEquip.promise : Promise.resolve()
  }
  bot.placeBlock = () => { placeCalls += 1; return Promise.resolve() }
  bot.pathfinder.getPathTo = () => computedPath('success', [
    pathNode(2, { toPlace: [{ x: 1, y: 1, z: 0, dx: 0, dy: 1, dz: 0 }] })
  ])
  bot.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))
  bot.emit('physicsTick')
  assert.equal(bot.pathfinder.isBuilding(), true)

  const token = bot.pathfinder.pauseControls('equip_pending')
  pendingEquip.resolve()
  await flushPromises()
  assert.equal(placeCalls, 0)
  assert.equal(bot.pathfinder.isBuilding(), false)
  assert.equal(bot.pathfinder.isControlPaused(), true)
  assert.equal(bot.pathfinder.resumeControls(token, 'done'), true)
  bot.emit('physicsTick')
  await flushPromises()
  assert.equal(equipCalls, 2)
  assert.equal(placeCalls, 1)
})

test('1x1 tower equips before jumping, places while rising, and keeps its path on the own block update', async () => {
  const bot = injectedBotHarness()
  const resets = []
  const controlAtEquip = []
  let placeCalls = 0

  bot.on('path_reset', reason => resets.push(reason))
  bot.pathfinder.movements.getScaffoldingItem = () => ({ name: 'dirt' })
  bot.equip = () => {
    controlAtEquip.push({ ...bot.controlState })
    return Promise.resolve()
  }
  bot.placeBlock = (referenceBlock, faceVector) => {
    placeCalls += 1
    const dest = referenceBlock.position.plus(faceVector)
    emitBlockChange(bot, dest, 'air', 'dirt')
    return Promise.resolve()
  }

  const towerNode = new Vec3(0, 2, 0)
  towerNode.cost = 1
  towerNode.toBreak = []
  towerNode.toPlace = [{ x: 0, y: 0, z: 0, dx: 0, dy: 1, dz: 0, jump: true }]
  towerNode.parkour = false
  bot.pathfinder.getPathTo = () => computedPath('success', [towerNode])
  bot.pathfinder.setGoal(new fork.goals.GoalNear(0, 2, 0, 0.5))

  bot.emit('physicsTick')
  await flushPromises()
  assert.equal(controlAtEquip.length, 1)
  assert.equal(controlAtEquip[0].jump, undefined)
  assert.equal(placeCalls, 0)

  bot.entity.position.y = 1.2
  bot.entity.velocity.y = 0.2
  bot.entity.onGround = false
  bot.emit('physicsTick')
  assert.equal(bot.controlState.jump, true)
  assert.equal(placeCalls, 0)

  bot.entity.position.y = 2.12
  bot.entity.velocity.y = 0.2
  bot.emit('physicsTick')
  assert.equal(placeCalls, 0)

  bot.entity.position.y = 2.22
  bot.entity.velocity.y = 0.2
  bot.emit('physicsTick')
  await flushPromises()
  assert.equal(placeCalls, 1)
  assert.equal(resets.includes('block_updated'), false)
  assert.equal(resets.includes('place_error'), false)
})

test('1x1 tower accepts a timed-out place promise when the destination is physically occupied', async () => {
  const bot = injectedBotHarness()
  const Block = require('prismarine-block')('1.21.4')
  const resets = []
  let placeCalls = 0
  let placedTarget = null
  const originalBlockAt = bot.blockAt

  bot.on('path_reset', reason => resets.push(reason))
  bot.pathfinder.movements.getScaffoldingItem = () => ({ name: 'dirt' })
  bot.equip = () => Promise.resolve()
  bot.blockAt = position => {
    if (placedTarget?.equals(position)) {
      const placed = Block.fromStateId(bot.registry.blocksByName.dirt.defaultState, 0)
      placed.position = position.clone()
      return placed
    }
    return originalBlockAt(position)
  }
  bot.placeBlock = (referenceBlock, faceVector) => {
    placeCalls += 1
    const dest = referenceBlock.position.plus(faceVector)
    placedTarget = dest.clone()
    return Promise.reject(new Error(`Event blockUpdate:${dest} did not fire within timeout of 5000ms`))
  }

  const towerNode = new Vec3(0, 2, 0)
  towerNode.cost = 1
  towerNode.toBreak = []
  towerNode.toPlace = [{ x: 0, y: 0, z: 0, dx: 0, dy: 1, dz: 0, jump: true }]
  towerNode.parkour = false
  bot.pathfinder.getPathTo = () => computedPath('success', [towerNode])
  bot.pathfinder.setGoal(new fork.goals.GoalNear(0, 2, 0, 0.5))

  bot.emit('physicsTick')
  await flushPromises()
  bot.entity.position.y = 2.22
  bot.entity.velocity.y = 0.2
  bot.entity.onGround = false
  bot.emit('physicsTick')
  await flushPromises()

  assert.equal(placeCalls, 1)
  assert.equal(resets.includes('place_error'), false)
  assert.equal(bot.pathfinder.isBuilding(), false)
})

test('cancelNow invalidates pending place and use callbacks', async () => {
  const placeBot = injectedBotHarness()
  const pendingPlace = deferred()
  let placeCalls = 0
  const returnPos = new Vec3(9, 1, 9)
  placeBot.pathfinder.movements.getScaffoldingItem = () => ({ name: 'stone' })
  placeBot.placeBlock = () => { placeCalls += 1; return pendingPlace.promise }
  placeBot.pathfinder.getPathTo = () => computedPath('success', [
    pathNode(2, { toPlace: [{ x: 1, y: 1, z: 0, dx: 0, dy: 1, dz: 0, returnPos }] })
  ])
  placeBot.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))
  placeBot.emit('physicsTick')
  await flushPromises()
  assert.equal(placeCalls, 1)

  placeBot.pathfinder.cancelNow('place_pending')
  pendingPlace.resolve()
  await flushPromises()
  assert.equal(placeBot.pathfinder.isBuilding(), false)
  assert.equal(placeBot.pathfinder.getDebugState().status.returningPos, null)

  const useBot = injectedBotHarness()
  const pendingUse = deferred()
  let useCalls = 0
  useBot.activateBlock = () => { useCalls += 1; return pendingUse.promise }
  useBot.pathfinder.getPathTo = () => computedPath('success', [
    pathNode(2, { toPlace: [{ x: 1, y: 1, z: 0, useOne: true }] })
  ])
  useBot.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))
  useBot.emit('physicsTick')
  assert.equal(useCalls, 1)

  useBot.pathfinder.cancelNow('use_pending')
  pendingUse.reject(new Error('cancelled use'))
  await flushPromises()
  assert.equal(useBot.pathfinder.isBuilding(), false)
  assert.equal(useBot.pathfinder.goal, null)
})

test('goto stays pending across partial segments and resolves only at the goal', async () => {
  const bot = gotoHarness()
  const goal = { id: 'goal' }
  let settled = false
  const promise = goto(bot, goal).finally(() => { settled = true })

  bot.emit('path_update', { status: 'partialSegment', path: [{ x: 1, y: 2, z: 3 }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)

  bot.emit('goal_reached', goal)
  await promise
  assert.equal(settled, true)
})

test('goto rejects an empty noPath result instead of reporting arrival', async () => {
  const bot = gotoHarness()
  const promise = goto(bot, { id: 'goal' })
  bot.emit('path_update', { status: 'noPath', path: [] })
  await assert.rejects(promise, error => error?.name === 'NoPath')
})

test('goto accepts an empty success result', async () => {
  const bot = gotoHarness()
  const promise = goto(bot, { id: 'goal' })
  bot.emit('path_update', { status: 'success', path: [] })
  await promise
})

test('exact path block actions are serialized and consumed only after confirmation', async () => {
  const bot = injectedBotHarness()
  const pending = deferred()
  const action = { x: 1, y: 1, z: 0, kind: 'trapdoor', open: false }
  const node = pathNode(2)
  node.blockActions = [action]
  let calls = 0
  let cancelCalls = 0
  let executionPath = null

  bot._executePathBlockAction = received => {
    calls += 1
    assert.deepEqual(received, action)
    return pending.promise
  }
  bot._cancelPathBlockAction = () => { cancelCalls += 1 }
  bot.on('path_update', info => { executionPath = info.path })
  bot.pathfinder.getPathTo = () => computedPath('success', [node])
  bot.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))

  bot.emit('physicsTick')
  bot.emit('physicsTick')

  assert.equal(calls, 1)
  assert.equal(executionPath[0].blockActions.length, 1)
  assert.equal(bot.pathfinder.getDebugState().status.interacting, true)

  pending.resolve()
  await flushPromises()

  assert.equal(executionPath[0].blockActions.length, 0)
  assert.equal(bot.pathfinder.getDebugState().status.interacting, false)
  assert.equal(cancelCalls, 1) // setGoal resets the previous operation generation.
})

test('cancelNow cancels a pending path block action and ignores late completion', async () => {
  const bot = injectedBotHarness()
  const pending = deferred()
  const node = pathNode(2)
  node.blockActions = [{ x: 1, y: 1, z: 0, kind: 'trapdoor', open: false }]
  let cancelCalls = 0

  bot._executePathBlockAction = () => pending.promise
  bot._cancelPathBlockAction = () => { cancelCalls += 1 }
  bot.pathfinder.getPathTo = () => computedPath('success', [node])
  bot.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))
  bot.emit('physicsTick')
  assert.equal(bot.pathfinder.getDebugState().status.interacting, true)

  bot.pathfinder.cancelNow('unit_cancel')
  assert.equal(bot.pathfinder.getDebugState().status.interacting, false)
  assert.equal(bot.pathfinder.goal, null)
  assert.equal(cancelCalls, 2)

  pending.resolve()
  await flushPromises()
  assert.equal(bot.pathfinder.goal, null)
})

test('reaching a prior node stops before entering the next block action node', () => {
  const bot = injectedBotHarness()
  const first = pathNode(1)
  const second = pathNode(2)
  second.blockActions = [{ x: 2, y: 1, z: 0, kind: 'trapdoor', open: false }]
  let executionPath = null
  let calls = 0
  bot._executePathBlockAction = () => {
    calls += 1
    return new Promise(() => {})
  }
  bot._cancelPathBlockAction = () => {}
  bot.on('path_update', info => { executionPath = info.path })
  bot.pathfinder.getPathTo = () => computedPath('success', [first, second])
  bot.pathfinder.setGoal(new fork.goals.GoalNear(10, 1, 0, 1))
  bot.emit('physicsTick')

  bot.entity.position = new Vec3(executionPath[0].x, executionPath[0].y, executionPath[0].z)
  bot.entity.onGround = true
  bot.controlState = { forward: true, sprint: true }
  bot.emit('physicsTick')

  assert.equal(calls, 0)
  assert.equal(bot.controlState.forward, undefined)
  assert.equal(bot.controlState.sprint, undefined)
  assert.equal(bot.pathfinder.getDebugState().next.blockActions, 1)

  bot.emit('physicsTick')
  assert.equal(calls, 1)
  bot.pathfinder.cancelNow('test_cleanup')
})

// 挖掘节点的落脚面在方块被挖开前无从得知（脚下若是台阶/雪层，真实落脚面比网格低半格）。
// 若把 reachKind 设成 'surface'，isNodeReached 会要求 |dy| ≤ 0.05，非整格地面上的挖掘
// 节点永远判不到达 —— 比不居中更糟。留空走 |dy| ≤ 0.999 的兼容容差。
test('dig nodes keep the loose vertical arrival tolerance', () => {
  const digNode = { x: 1.5, y: 1, z: 0.5, toBreak: [{ x: 1, y: 2, z: 0 }], toPlace: [] }
  assert.equal(digNode.reachKind, undefined, '挖掘节点不该被标成 surface')
  // 脚下是台阶：真实落脚面比节点 y 低半格，仍必须判成已到达。
  assert.equal(isNodeReached(digNode, { x: 1.5, y: 0.5, z: 0.5 }), true)
  // 水平仍按严格容差：偏出半格不算到达。
  assert.equal(isNodeReached(digNode, { x: 2.5, y: 1, z: 0.5 }), false)
})

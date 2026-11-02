const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const { pathfinder, goals: { GoalBlock } } = require('mineflayer-pathfinder')
const Warehouse = require('../src/warehouse')
const { DEFAULT_CONFIG } = require('../src/config')

function harness () {
  const bot = new EventEmitter()
  bot.version = '1.21.4'
  bot.registry = require('minecraft-data')(bot.version)
  const Block = require('prismarine-block')(bot.version)
  const world = new Map()
  bot.game = { minY: -64 }
  bot.entities = {}
  bot.inventory = { items: () => [], slots: [] }
  bot.entity = {
    position: new Vec3(0.5, 1, 0.5), velocity: new Vec3(0, 0, 0),
    effects: {}, onGround: true, isInWater: false, yaw: 0, pitch: 0, metadata: []
  }
  bot.physics = { simulatePlayer: () => {} }
  bot.controlState = {}
  bot.clearControlStates = () => { bot.controlState = {} }
  bot.setControlState = (name, value) => { bot.controlState[name] = value }
  bot.look = bot.lookAt = bot.activateBlock = () => Promise.resolve()
  bot.blockAt = position => {
    const pos = position.floored()
    if (world.has(pos.toString())) return world.get(pos.toString())
    const block = Block.fromStateId(bot.registry.blocksByName.air.defaultState, 0)
    block.position = pos
    return block
  }
  function put (name, x, y, z, stateId) {
    if (stateId && typeof stateId === 'object') {
      const wanted = stateId
      const definition = bot.registry.blocksByName[name]
      stateId = null
      for (let id = definition.minStateId; id <= definition.maxStateId; id++) {
        const properties = Block.fromStateId(id, 0).getProperties()
        if (Object.entries(wanted).every(([key, value]) => String(properties[key]) === String(value))) {
          stateId = id
          break
        }
      }
      assert.notEqual(stateId, null, `missing state for ${name}`)
    }
    const block = Block.fromStateId(stateId ?? bot.registry.blocksByName[name].defaultState, 0)
    block.position = new Vec3(x, y, z)
    world.set(block.position.toString(), block)
    return block
  }
  pathfinder(bot)
  const warehouse = new Warehouse(bot, {}, {}, structuredClone(DEFAULT_CONFIG))
  return { bot, warehouse, put }
}

test('warehouse uses the fork and keeps digging, building and parkour disabled', () => {
  const { bot, warehouse } = harness()
  warehouse.setupMovements()
  assert.equal(bot.pathfinder.olelaCapabilities?.features.strictGotoTerminalStatus, 1)
  const moves = bot.pathfinder.movements
  assert.equal(moves.canDig, false)
  assert.equal(moves.allow1by1towers, false)
  assert.equal(moves.allowParkour, false)
  assert.deepEqual(moves.scafoldingBlocks, [])
  assert.equal(moves.countScaffoldingItems(), 0)
  assert.equal(moves.getScaffoldingItem(), null)
  assert.ok(Number.isFinite(moves.maxDropDown), 'cloud navigation has no elytra drop executor')
  bot.emit('end')
})

test('repeated warehouse setup reuses terrain controllers without accumulating listeners', () => {
  const { bot, warehouse } = harness()
  warehouse.setupMovements()
  const first = bot.pathfinder.movements
  const listeners = bot.eventNames().map(name => [name, bot.listenerCount(name)])
  for (let i = 0; i < 25; i++) warehouse.setupMovements()
  assert.equal(bot.pathfinder.movements, first)
  assert.deepEqual(bot.eventNames().map(name => [name, bot.listenerCount(name)]), listeners)
  bot.emit('end')
})

test('warehouse plans reachable layered snow with surface metadata and avoids powder snow', () => {
  const { bot, warehouse, put } = harness()
  put('stone', 0, 0, 0)
  put('stone', 1, 0, 0)
  put('snow', 1, 1, 0, bot.registry.blocksByName.snow.minStateId + 7)
  warehouse.setupMovements()
  const moves = bot.pathfinder.movements
  const edges = moves.getNeighbors({ x: 0, y: 1, z: 0, remainingBlocks: 0 })
  const edge = edges.find(move => move.x === 1 && move.z === 0)
  assert.ok(edge, 'reachable snow slope must remain available')
  assert.equal(edge.snowSurface, true)
  assert.equal(edge.surfaceY, 1.875)
  assert.equal(edge.requiresJump, true)
  assert.ok(moves.blocksToAvoid.has(bot.registry.blocksByName.powder_snow.id))
  assert.ok(edges.every(move => !move.toBreak.length && !move.toPlace.length))
  bot.emit('end')
})

test('warehouse finds an ordinary indoor route without dig or placement actions', () => {
  const { bot, warehouse, put } = harness()
  for (let x = -1; x <= 4; x++) {
    for (let z = -1; z <= 1; z++) {
      put('stone', x, 0, z)
      if (z !== 0) {
        put('stone', x, 1, z)
        put('stone', x, 2, z)
      }
      put('stone', x, 3, z)
    }
  }
  warehouse.setupMovements()
  const result = bot.pathfinder.getPathTo(bot.pathfinder.movements, new GoalBlock(3, 1, 0))
  assert.equal(result.status, 'success')
  assert.ok(result.path.length > 0)
  assert.ok(result.path.every(move => !move.toBreak.length && !move.toPlace.length))
  bot.emit('end')
})

test('warehouse keeps wooden door passage nodes at feet height', () => {
  const { bot, warehouse, put } = harness()
  for (let x = -1; x <= 4; x++) {
    put('stone', x, 0, 0)
    put('stone', x, 3, 0)
  }
  put('oak_door', 1, 1, 0, { half: 'lower', open: false, hinge: 'left', powered: false, facing: 'south' })
  put('oak_door', 1, 2, 0, { half: 'upper', open: false, hinge: 'left', powered: false, facing: 'south' })
  warehouse.setupMovements()
  const result = bot.pathfinder.getPathTo(bot.pathfinder.movements, new GoalBlock(3, 1, 0))
  assert.equal(result.status, 'success')
  const doorNode = result.path.find(move => move.x === 1.5)
  assert.ok(doorNode)
  assert.equal(doorNode.y, 1)
  bot.emit('end')
})

test('warehouse rejects diagonal wall clipping and insufficient snow headroom', () => {
  const { bot, warehouse, put } = harness()
  for (let x = 0; x <= 1; x++) for (let z = 0; z <= 1; z++) put('stone', x, 0, z)
  put('stone', 1, 1, 0)
  warehouse.setupMovements()
  const moves = bot.pathfinder.movements
  const start = { x: 0, y: 1, z: 0, remainingBlocks: 0 }
  let neighbors = moves.getNeighbors(start)
  assert.ok(!neighbors.some(move => move.x === 1 && move.z === 1), 'a blocked corner cannot be cut diagonally')
  put('snow', 1, 1, 0, { layers: 8 })
  const roof = put('stone', 1, 3, 0)
  bot.emit('blockUpdate', null, roof)
  neighbors = moves.getNeighbors(start)
  assert.ok(!neighbors.some(move => move.x === 1 && move.z === 0), 'snow lifts the player into the roof')
  bot.emit('end')
})

test('warehouse plans exact trapdoor closure and refuses open iron trapdoors', async () => {
  const { bot, warehouse, put } = harness()
  put('stone', 0, 0, 0)
  put('stone', 1, 0, 0)
  put('oak_trapdoor', 1, 1, 0, { half: 'bottom', open: true, powered: false, waterlogged: false })
  warehouse.setupMovements()
  const moves = bot.pathfinder.movements
  const start = { x: 0, y: 1, z: 0, remainingBlocks: 0 }
  const edge = moves.getNeighbors(start).find(move => move.x === 1 && move.z === 0)
  assert.ok(edge?.trapdoorPassage)
  assert.deepEqual(edge.blockActions, [{ x: 1, y: 1, z: 0, kind: 'trapdoor', open: false }])
  const activations = []
  bot.activateBlock = async block => {
    activations.push(block.position.toString())
    const closed = put('oak_trapdoor', 1, 1, 0, { half: 'bottom', open: false, powered: false, waterlogged: false })
    bot.emit('blockUpdate', block, closed)
  }
  await bot._executePathBlockAction(edge.blockActions[0])
  assert.deepEqual(activations, ['(1, 1, 0)'])
  const iron = put('iron_trapdoor', 1, 1, 0, { half: 'bottom', open: true })
  bot.emit('blockUpdate', null, iron)
  assert.ok(!moves.getNeighbors(start).some(move => move.x === 1 && move.z === 0))
  bot.emit('end')
})

test('warehouse plans typed ladder edges and never lands on hollow containers', () => {
  const { bot, warehouse, put } = harness()
  put('stone', 0, 0, 0)
  put('ladder', 0, 1, 0)
  put('ladder', 0, 2, 0)
  warehouse.setupMovements()
  const moves = bot.pathfinder.movements
  const neighbors = moves.getNeighbors({ x: 0, y: 1, z: 0, remainingBlocks: 0 })
  const up = neighbors.find(move => move.x === 0 && move.y === 2 && move.z === 0)
  assert.equal(up?.reachKind, 'climbable')
  const container = put('cauldron', 1, 0, 0)
  bot.emit('blockUpdate', null, container)
  assert.ok(!moves.getNeighbors({ x: 0, y: 1, z: 0, remainingBlocks: 0 }).some(move => move.x === 1 && move.z === 0))
  bot.emit('end')
})

test('terrain cache is invalidated after a world change or respawn', () => {
  const { bot, warehouse, put } = harness()
  warehouse.setupMovements()
  const moves = bot.pathfinder.movements
  const node = { x: 0, y: 1, z: 0 }
  assert.equal(moves.getBlock(node, 1, 0, 0).name, 'air')
  const stone = put('stone', 1, 1, 0)
  bot.emit('blockUpdate', null, stone)
  assert.equal(moves.getBlock(node, 1, 0, 0).name, 'stone')
  put('air', 1, 1, 0)
  bot.emit('respawn')
  assert.equal(moves.getBlock(node, 1, 0, 0).name, 'air')
  bot.emit('end')
})

for (const depth of [4, 5]) test(`warehouse refuses a ${depth}-block water drop without a flight executor`, () => {
  const { bot, warehouse, put } = harness()
  put('stone', 0, depth, 0)
  put('water', 1, 1, 0)
  warehouse.setupMovements()
  const neighbors = bot.pathfinder.movements.getNeighbors({ x: 0, y: depth + 1, z: 0, remainingBlocks: 0 })
  assert.ok(!neighbors.some(move => move.x === 1 && move.z === 0), 'water is not an unlimited safe fall target')
  bot.emit('end')
})

test('warehouse terrain rescue does not move an idle bot during inventory work', () => {
  const { bot, warehouse, put } = harness()
  put('composter', 0, 1, 0)
  put('stone', 1, 0, 0)
  bot.entity.position.y = 1.25
  warehouse.setupMovements()
  bot.currentWindow = { id: 1 }
  bot.emit('physicsTick')
  assert.notEqual(bot.controlState.forward, true)
  assert.notEqual(bot.controlState.jump, true)
  bot.emit('end')
})

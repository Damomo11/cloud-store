const test = require('node:test')
const assert = require('node:assert/strict')
const Warehouse = require('../src/warehouse')
const { DEFAULT_CONFIG } = require('../src/config')

function vec (x, y, z) {
  return {
    x,
    y,
    z,
    offset (dx, dy, dz) { return vec(this.x + dx, this.y + dy, this.z + dz) },
    distanceTo (other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z) },
    clone () { return vec(this.x, this.y, this.z) }
  }
}

function createWarehouse () {
  const config = structuredClone(DEFAULT_CONFIG)
  config.timing.dropIntervalMs = 0
  const lookTargets = []
  const bot = {
    entity: { position: vec(0, 64, 0) },
    players: {},
    entities: {},
    currentWindow: null,
    inventory: { items: () => [] },
    lookAt: async target => { lookTargets.push(target.clone()) },
    closeWindow () {},
    clickWindow: async () => {}
  }
  const warehouse = new Warehouse(
    bot,
    {},
    {
      fromPrismarineItem: item => ({ ...item, itemKey: `minecraft:${item.name}`, displayName: item.name }),
      getStackSize: () => 64
    },
    config
  )
  return { warehouse, bot, lookTargets }
}

test('取货交付逐堆重瞄玩家：玩家中途移动后，下一堆沿新位置丢出', async () => {
  const { warehouse, bot, lookTargets } = createWarehouse()

  const stacks = [
    { name: 'stone', count: 32, slot: 5 },
    { name: 'cobblestone', count: 32, slot: 6 }
  ]
  const droppedSlots = []
  bot.players.steve = { entity: { position: vec(3, 64, 0) } }
  bot.inventory.items = () => stacks.filter(stack => !droppedSlots.includes(stack.slot))
  bot.clickWindow = async (slot, button, mode) => {
    assert.equal(mode, 4)
    droppedSlots.push(slot)
    // 第一堆丢出后玩家走开并站到新位置：第二堆必须朝新位置瞄准再丢。
    if (slot === 5) bot.players.steve.entity.position = vec(6, 66, 4)
  }

  const dropped = await warehouse.dropItemsToPlayer('steve', [
    { itemKey: 'minecraft:stone', amount: 32 },
    { itemKey: 'minecraft:cobblestone', amount: 32 }
  ])

  assert.deepEqual(
    dropped.map(item => [item.itemKey, item.amount]).sort(),
    [['minecraft:cobblestone', 32], ['minecraft:stone', 32]]
  )
  assert.deepEqual(droppedSlots, [5, 6])
  // 每堆丢出前各瞄准一次，而不是整轮只瞄一次。
  assert.equal(lookTargets.length, 2)
  assert.deepEqual({ x: lookTargets[0].x, y: lookTargets[0].y, z: lookTargets[0].z }, { x: 3, y: 64, z: 0 })
  assert.deepEqual({ x: lookTargets[1].x, y: lookTargets[1].y, z: lookTargets[1].z }, { x: 6, y: 66, z: 4 })
})

test('丢弃途中找不到玩家实体：逐堆瞄准按行显式报错，不再静默沿旧视线丢', async () => {
  const { warehouse, bot } = createWarehouse()

  const stacks = [
    { name: 'stone', count: 32, slot: 5 },
    { name: 'cobblestone', count: 32, slot: 6 }
  ]
  const droppedSlots = []
  bot.players.steve = { entity: { position: vec(3, 64, 0) } }
  bot.inventory.items = () => stacks.filter(stack => !droppedSlots.includes(stack.slot))
  bot.clickWindow = async (slot, button, mode) => {
    assert.equal(mode, 4)
    droppedSlots.push(slot)
    // 第一堆丢出后玩家实体失效（跨维度传送/区块卸载的典型表现）。
    if (slot === 5) bot.players.steve = {}
  }

  await assert.rejects(
    warehouse.dropItemsToPlayer('steve', [
      { itemKey: 'minecraft:stone', amount: 32 },
      { itemKey: 'minecraft:cobblestone', amount: 32 }
    ]),
    /丢前瞄准失败：找不到玩家 steve 的实体/
  )
  // 第一堆已丢出并确认；失败发生在第二堆的瞄准上，而不是整批不动。
  assert.deepEqual(droppedSlots, [5])
})

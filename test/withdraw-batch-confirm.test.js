const test = require('node:test')
const assert = require('node:assert/strict')
const Warehouse = require('../src/warehouse')
const Vec3 = require('vec3')
const { DEFAULT_CONFIG } = require('../src/config')

function createWarehouse (bot) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.timing.containerSettleMs = 0
  config.timing.containerClickIntervalMs = 0
  config.timing.dropIntervalMs = 0
  const catalog = { fromPrismarineItem: item => item, getStackSize: () => 64 }
  return new Warehouse(bot, {}, catalog, config)
}

function createContainer (stacks) {
  const slots = new Array(63).fill(null)
  for (const stack of stacks) slots[stack.slot] = { ...stack }
  const container = {
    inventoryStart: 27,
    inventoryEnd: 63,
    slots,
    selectedItem: null,
    items: () => slots.map((item, slot) => (item ? { ...item, slot } : null)).filter(Boolean)
  }
  return container
}

// 模拟服务器窗口点击：左键拾取/放置，右键单件转移
function createContainerClicker (container) {
  let calls = 0
  const click = async (slot, button) => {
    calls++
    const item = container.slots[slot]
    if (button === 0) {
      if (container.selectedItem) {
        if (!item) {
          container.slots[slot] = { ...container.selectedItem, slot }
          container.selectedItem = null
        } else if (item.itemKey === container.selectedItem.itemKey && item.count + container.selectedItem.count <= 64) {
          item.count += container.selectedItem.count
          container.selectedItem = null
        } else {
          container.slots[slot] = { ...container.selectedItem, slot }
          container.selectedItem = { ...item }
        }
      } else {
        if (!item) throw new Error('pickup from empty slot')
        container.selectedItem = { ...item }
        container.slots[slot] = null
      }
      return
    }
    if (button === 1) {
      if (!container.selectedItem) throw new Error('right-click without cursor item')
      if (!item) {
        container.slots[slot] = { ...container.selectedItem, count: 1, slot }
      } else {
        item.count++
      }
      container.selectedItem.count--
      if (container.selectedItem.count <= 0) container.selectedItem = null
      return
    }
    throw new Error(`unexpected click slot=${slot} button=${button}`)
  }
  click.callCount = () => calls
  return click
}

test('tryWithdrawExactFrom takes whole stacks in one batch and confirms once', async () => {
  const warehouse = createWarehouse({ clickWindow: async () => {} })
  const container = createContainer([
    { name: 'stone', count: 64, slot: 0, itemKey: 'k' },
    { name: 'stone', count: 20, slot: 1, itemKey: 'k' }
  ])
  warehouse.bot.clickWindow = createContainerClicker(container)

  const moved = await warehouse.tryWithdrawExactFrom(container, 'k', 84)

  assert.equal(moved, 84)
  assert.equal(warehouse.countContainerItem(container, 'k'), 0)
  assert.equal(container.selectedItem, null)
})

test('tryWithdrawExactFrom takes an exact partial amount and leaves the rest', async () => {
  const warehouse = createWarehouse({ clickWindow: async () => {} })
  const container = createContainer([
    { name: 'stone', count: 64, slot: 0, itemKey: 'k' }
  ])
  warehouse.bot.clickWindow = createContainerClicker(container)

  const moved = await warehouse.tryWithdrawExactFrom(container, 'k', 33)

  assert.equal(moved, 33)
  assert.equal(container.slots[0].count, 31)
  assert.equal(container.selectedItem, null)
})

test('tryWithdrawExactFrom re-takes a shortfall in the next pass', async () => {
  const warehouse = createWarehouse({ clickWindow: async () => {} })
  const container = createContainer([
    { name: 'stone', count: 64, slot: 0, itemKey: 'k' },
    { name: 'stone', count: 20, slot: 1, itemKey: 'k' }
  ])
  const click = createContainerClicker(container)
  let rejectedOnce = false
  warehouse.bot.clickWindow = async (slot, button) => {
    if (!rejectedOnce && slot === 1) {
      rejectedOnce = true
      throw new Error('simulated click timeout')
    }
    return click(slot, button)
  }

  const moved = await warehouse.tryWithdrawExactFrom(container, 'k', 84)

  assert.equal(moved, 84)
  assert.equal(warehouse.countContainerItem(container, 'k'), 0)
  assert.equal(rejectedOnce, true)
})

function createDropBot () {
  const slots = {}
  const lookAtCalls = []
  const bot = {
    // 丢前瞄准需要玩家实体；默认摆在脚底坐标 (10, 64, 10)。
    players: { Player: { entity: { position: new Vec3(10, 64, 10) } } },
    currentWindow: null,
    inventory: { items: () => Object.values(slots).filter(Boolean) },
    clickWindow: async () => {},
    lookAt: async target => { lookAtCalls.push(target) }
  }
  bot.lookAtCalls = lookAtCalls
  return { bot, slots }
}

// mode 4: button 1 丢整组，button 0 丢单件
function wireDropClicks (bot, slots, { lostClick } = {}) {
  let calls = 0
  bot.clickWindow = async (slot, button, mode) => {
    calls++
    if (mode !== 4) throw new Error(`unexpected mode ${mode}`)
    if (lostClick && lostClick(calls, slot, button)) return
    if (!slots[slot]) throw new Error('drop from empty slot')
    if (button === 1) {
      delete slots[slot]
      return
    }
    slots[slot].count--
    if (slots[slot].count <= 0) delete slots[slot]
  }
  bot.dropClickCount = () => calls
}

test('dropItemsToPlayer drops everything then confirms the batch once', async () => {
  const { bot, slots } = createDropBot()
  slots[36] = { name: 'stone', count: 64, slot: 36, itemKey: 'k' }
  slots[37] = { name: 'stone', count: 36, slot: 37, itemKey: 'k' }
  const warehouse = createWarehouse(bot)
  wireDropClicks(bot, slots)

  const dropped = await warehouse.dropItemsToPlayer('Player', [
    { itemKey: 'k', itemId: 'minecraft:stone', displayName: '石头', amount: 100 }
  ])

  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].amount, 100)
  assert.equal(Object.keys(slots).length, 0)
})

test('dropItemsToPlayer re-drops whatever did not leave the inventory', async () => {
  const { bot, slots } = createDropBot()
  slots[36] = { name: 'stone', count: 64, slot: 36, itemKey: 'k' }
  slots[37] = { name: 'stone', count: 36, slot: 37, itemKey: 'k' }
  const warehouse = createWarehouse(bot)
  wireDropClicks(bot, slots, { lostClick: calls => calls === 1 })

  const dropped = await warehouse.dropItemsToPlayer('Player', [
    { itemKey: 'k', itemId: 'minecraft:stone', displayName: '石头', amount: 100 }
  ])

  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].amount, 100)
  assert.equal(Object.keys(slots).length, 0)
})

test('dropItemsToPlayer drops an exact partial amount from a stack', async () => {
  const { bot, slots } = createDropBot()
  slots[36] = { name: 'stone', count: 64, slot: 36, itemKey: 'k' }
  const warehouse = createWarehouse(bot)
  wireDropClicks(bot, slots)

  const dropped = await warehouse.dropItemsToPlayer('Player', [
    { itemKey: 'k', itemId: 'minecraft:stone', displayName: '石头', amount: 10 }
  ])

  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].amount, 10)
  assert.equal(slots[36].count, 54)
})

test('dropItemsToPlayer never reports more than actually left the inventory', async () => {
  const { bot, slots } = createDropBot()
  slots[36] = { name: 'stone', count: 64, slot: 36, itemKey: 'k' }
  const warehouse = createWarehouse(bot)
  bot.clickWindow = async () => {} // 所有丢物点击都丢失

  const dropped = await warehouse.dropItemsToPlayer('Player', [
    { itemKey: 'k', itemId: 'minecraft:stone', displayName: '石头', amount: 5 }
  ])

  assert.deepEqual(dropped, [])
  assert.equal(slots[36].count, 64)
})

test('dropItemsToPlayer aims at the player feet, not the torso', async () => {
  const { bot, slots } = createDropBot()
  slots[36] = { name: 'stone', count: 10, slot: 36, itemKey: 'k' }
  const warehouse = createWarehouse(bot)
  wireDropClicks(bot, slots)

  await warehouse.dropItemsToPlayer('Player', [
    { itemKey: 'k', itemId: 'minecraft:stone', displayName: '石头', amount: 5 }
  ])

  assert.equal(bot.lookAtCalls.length > 0, true)
  const aimed = bot.lookAtCalls[0]
  assert.equal(aimed.x, 10)
  assert.equal(aimed.y, 64, '瞄准点必须是脚底坐标，不能抬高')
  assert.equal(aimed.z, 10)
})

test('dropItemsToPlayer fails loudly instead of dropping at a stale angle', async () => {
  const { bot, slots } = createDropBot()
  slots[36] = { name: 'stone', count: 10, slot: 36, itemKey: 'k' }
  const warehouse = createWarehouse(bot)
  let clicks = 0
  bot.clickWindow = async () => { clicks++ }
  delete bot.players.Player

  await assert.rejects(
    warehouse.dropItemsToPlayer('Player', [
      { itemKey: 'k', itemId: 'minecraft:stone', displayName: '石头', amount: 5 }
    ]),
    /找不到玩家 Player 的实体/
  )
  assert.equal(clicks, 0, '瞄准失败时不能丢出任何物品')
  assert.equal(slots[36].count, 10)
})

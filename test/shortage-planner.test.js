const test = require('node:test')
const assert = require('node:assert/strict')
const { planShortages } = require('../src/shortagePlanner')

test('aggregates direct allocations and reports a craftable shortage without mutating stock', () => {
  const availableCraftStock = { oak_planks: 4 }
  const result = planShortages({
    requests: [
      { itemId: 'minecraft:stick', displayName: '木棍', amount: 8 },
      { itemId: 'minecraft:torch', displayName: '火把', amount: 2 }
    ],
    allocations: [
      { requestIndex: 0, itemId: 'minecraft:stick', amount: 4 },
      { requestIndex: 1, itemId: 'minecraft:torch', amount: 2 }
    ],
    availableCraftStock,
    craftPlanner: ({ item, quantity, available }) => {
      assert.equal(item, 'stick')
      assert.equal(quantity, 4)
      assert.equal(available.oak_planks, 4)
      return {
        ok: true,
        plan: { inventoryUses: [{ name: 'oak_planks', quantity: 2 }], craftSteps: [], estimatedSlots: 1 }
      }
    }
  })

  assert.deepEqual(result.shortages, [{
    itemId: 'minecraft:stick',
    displayName: '木棍',
    requested: 8,
    allocated: 4,
    missing: 4,
    reason: 'short'
  }])
  assert.deepEqual(result.craft, [{
    itemId: 'minecraft:stick',
    displayName: '木棍',
    amount: 4,
    status: 'planned',
    plan: { inventoryUses: [{ name: 'oak_planks', quantity: 2 }], craftSteps: [], estimatedSlots: 1 }
  }])
  assert.deepEqual(availableCraftStock, { oak_planks: 4 })
})

test('sequential craft candidates cannot reuse shared raw stock', () => {
  const availableCraftStock = { wheat: 1 }
  const calls = []
  const result = planShortages({
    requests: [
      { itemId: 'minecraft:bread', displayName: '面包', amount: 1 },
      { itemId: 'minecraft:cake', displayName: '蛋糕', amount: 1 }
    ],
    allocations: [],
    availableCraftStock,
    craftPlanner: ({ item, quantity, available }) => {
      calls.push({ item, quantity, available: { ...available } })
      if (available.wheat < 1) return { ok: false, reason: 'needs_collection' }
      return { ok: true, plan: { inventoryUses: [{ name: 'wheat', quantity: 1 }], craftSteps: [] } }
    }
  })

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].available, { wheat: 1 })
  assert.deepEqual(calls[1].available, { wheat: 0, bread: 1 })
  assert.equal(result.craft[0].status, 'planned')
  assert.equal(result.craft[1].status, 'unavailable')
  assert.equal(result.craft[1].reason, 'needs_collection')
  assert.deepEqual(availableCraftStock, { wheat: 1 })
})

test('craft batch surplus is available to later shortage candidates', () => {
  const calls = []
  const result = planShortages({
    requests: [
      { itemId: 'minecraft:stick', amount: 1 },
      { itemId: 'minecraft:torch', amount: 1 }
    ],
    allocations: [],
    availableCraftStock: { oak_planks: 1 },
    craftPlanner: ({ item, available }) => {
      calls.push({ item, available: { ...available } })
      if (item === 'stick') {
        return {
          ok: true,
          plan: {
            inventoryUses: [{ name: 'oak_planks', quantity: 1 }],
            craftSteps: [{
              result: { name: 'stick', count: 4 },
              outputs: [{ name: 'stick', count: 4 }],
              times: 1
            }]
          }
        }
      }
      assert.equal(item, 'torch')
      assert.equal(available.stick, 4)
      return {
        ok: true,
        plan: { inventoryUses: [{ name: 'stick', quantity: 1 }], craftSteps: [] }
      }
    }
  })

  assert.equal(calls.length, 2)
  assert.equal(result.craft[0].status, 'planned')
  assert.equal(result.craft[1].status, 'planned')
})

test('unsupported shortage is returned as data instead of throwing', () => {
  const result = planShortages({
    requests: [{ itemId: 'minecraft:diamond_block', amount: 2 }],
    allocations: [],
    availableCraftStock: {},
    craftPlanner: () => ({ ok: false, reason: 'plan_unreachable' })
  })

  assert.deepEqual(result.craft, [{
    itemId: 'minecraft:diamond_block',
    displayName: 'minecraft:diamond_block',
    amount: 2,
    status: 'unsupported',
    reason: 'plan_unreachable'
  }])
})

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { planCraftChestRoute } = require('../../src/craft/withdraw-route')

test('craft route merges allocations for one chest and walks nearest next chest', () => {
  const route = planCraftChestRoute([
    {
      allocation: { itemKey: 'oak_planks', amount: 8 },
      group: { chestId: 'far', recordedAmount: 8, slots: [{ x: 10, y: 64, z: 0, slot: 0 }] }
    },
    {
      allocation: { itemKey: 'cobblestone', amount: 8 },
      group: { chestId: 'near', recordedAmount: 8, slots: [{ x: 2, y: 64, z: 0, slot: 1 }] }
    },
    {
      allocation: { itemKey: 'iron_ingot', amount: 2 },
      group: { chestId: 'near', recordedAmount: 2, slots: [{ x: 2, y: 64, z: 0, slot: 2 }] }
    }
  ], { x: 0, y: 64, z: 0 })

  assert.deepEqual(route.map(group => group.chestId), ['near', 'far'])
  assert.deepEqual(route[0].entries.map(entry => entry.allocation.itemKey), ['cobblestone', 'iron_ingot'])
  assert.equal(route[0].entries.length, 2)
})

test('craft route is deterministic without a bot position', () => {
  const route = planCraftChestRoute([
    { allocation: { itemKey: 'b', amount: 1 }, group: { chestId: 'b', recordedAmount: 1, slots: [{ x: 1, y: 0, z: 0, slot: 0 }] } },
    { allocation: { itemKey: 'a', amount: 1 }, group: { chestId: 'a', recordedAmount: 1, slots: [{ x: 1, y: 0, z: 0, slot: 0 }] } }
  ], null)

  assert.deepEqual(route.map(group => group.chestId), ['a', 'b'])
})

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { planTransfer } = require('../../src/craft/transfer-plan')
const registry = require('minecraft-data')('1.21.11')
const Item = require('prismarine-item')(registry)
const windows = require('prismarine-windows')(registry.version.minecraftVersion)

test('partial transfer costs include trimming an empty target', () => {
  assert.equal(planTransfer(44, 15, 0).length, 8)
  assert.equal(planTransfer(63, 16, 0).length, 4)
  assert.equal(planTransfer(64, 1, 0).length, 3)
  assert.equal(planTransfer(64, 64, 0).length, 2)
})

test('all stack transfers conserve exact source, target and empty cursor in real window semantics', () => {
  for (let available = 1; available <= 64; available++) {
    for (let amount = 1; amount <= available; amount++) {
      for (const targetCount of new Set([0, 1, 64 - amount])) {
        if (targetCount + amount > 64) continue
        const window = windows.createWindow(0, 'minecraft:inventory', 'Inventory')
        window.updateSlot(9, new Item(registry.itemsByName.stone.id, available))
        if (targetCount) window.updateSlot(1, new Item(registry.itemsByName.stone.id, targetCount))
        const plan = planTransfer(available, amount, targetCount)
        for (const action of plan) {
          const slot = action.target ? 1 : 9
          window.acceptClick({ slot, mouseButton: action.button, mode: 0, item: window.slots[slot] })
        }
        const context = `${available}/${amount}/${targetCount}`
        assert.equal(window.slots[9]?.count || 0, available - amount, context)
        assert.equal(window.slots[1].count, targetCount + amount, context)
        assert.equal(window.selectedItem, null, context)
      }
    }
  }
})

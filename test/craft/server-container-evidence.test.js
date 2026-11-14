'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { canReuseCraftWindow } = require('../../src/craft/server-container-evidence')

function evidenceFixture () {
  const container = { id: 5, selectedItem: null }
  const bot = { currentWindow: container, inventory: { selectedItem: null } }
  const snapshot = {
    chestSlots: [{ slot: 0, itemKey: 'minecraft:stone|plain', amount: 12 }],
    playerItems: [{ itemKey: 'minecraft:oak_planks|plain', amount: 4 }],
    cursorEmpty: true
  }
  return { container, bot, snapshot, serverSnapshot: snapshot, local: structuredClone(snapshot) }
}

test('craft window evidence can be reused only while revision, owner, cursor and contents stay unchanged', () => {
  const f = evidenceFixture()
  assert.equal(canReuseCraftWindow({
    expectedRevision: 7,
    currentRevision: 7,
    bot: f.bot,
    container: f.container,
    serverSnapshot: f.snapshot,
    localSnapshot: f.local
  }), true)

  for (const mutate of [
    value => { value.currentRevision = 8 },
    value => { value.bot.currentWindow = { id: 5 } },
    value => { value.container.selectedItem = { name: 'stone', count: 1 } },
    value => { value.bot.inventory.selectedItem = { name: 'stone', count: 1 } },
    value => { value.serverSnapshot.chestSlots[0].amount = 11 },
    value => { value.local.playerItems[0].amount = 3 },
    value => { value.serverSnapshot.cursorEmpty = false }
  ]) {
    const value = evidenceFixture()
    mutate(value)
    assert.equal(canReuseCraftWindow({
      expectedRevision: value.expectedRevision ?? 7,
      currentRevision: value.currentRevision ?? 7,
      bot: value.bot,
      container: value.container,
      serverSnapshot: value.serverSnapshot,
      localSnapshot: value.local
    }), false)
  }
})

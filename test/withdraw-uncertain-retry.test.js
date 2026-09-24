const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { configureTraceLog, startTrace, traceFileFor } = require('../src/traceLog')
const Warehouse = require('../src/warehouse')
const { DEFAULT_CONFIG } = require('../src/config')

const ITEM = {
  itemKey: 'minecraft:stone|plain',
  itemId: 'minecraft:stone',
  displayName: '石头'
}

function makeTempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-uncertain-'))
}

function readTraceLines (directory) {
  return fs.readFileSync(traceFileFor(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function createWarehouse (chests, options = {}) {
  const readsByChest = new Map(chests.map(chest => [chest.chestId, chest.reads.map(read => read.map(entry => ({ ...entry })))]))
  const opened = []
  const replaced = []
  const mismatchCalls = []

  const db = {
    getItemByKey: key => key === ITEM.itemKey ? { ...ITEM } : null,
    listSlotsForItemKey: () => options.noLocation
      ? []
      : chests.flatMap(chest => [{
          chestId: chest.chestId,
          x: 1, y: 2, z: 3,
          blockName: 'barrel',
          slot: 0,
          amount: chest.recorded,
          itemKey: ITEM.itemKey
        }]),
    upsertChest: () => {},
    replaceChestSlots: chestId => replaced.push(chestId),
    addInventoryMismatch: (...args) => mismatchCalls.push(args),
    hasOpenInventoryMismatch: () => false
  }
  const catalog = { fromPrismarineItem: () => ({ ...ITEM }) }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.debug = false
  config.timing.containerSettleMs = 0
  if (options.uncertainRetries !== undefined) config.timing.withdrawUncertainRetries = options.uncertainRetries

  const warehouse = new Warehouse(
    { username: 'BotA', inventory: { items: () => [] } },
    db,
    catalog,
    config
  )
  warehouse.openContainerAt = async chest => {
    opened.push(chest.chestId)
    const queue = readsByChest.get(chest.chestId) || []
    const slots = (queue.length ? queue.shift() : []).map(entry => ({ ...entry }))
    return {
      inventoryStart: 27,
      inventoryEnd: 63,
      items: () => slots.filter(entry => entry.count > 0),
      _slots: slots,
      _chestId: chest.chestId,
      close: () => {}
    }
  }
  // 服务器行为：noApplyChests 里的木桶点击从未真正生效（物品留在桶里）；
  // 其余木桶点击已生效、只是确认观察者迟到（物品已从桶里消失）。
  const neverApplies = options.noApplyChests || []
  const applies = container => !neverApplies.includes(container._chestId)
  warehouse.moveContainerSlotToInventory = async (container, slot) => {
    if (!applies(container)) return
    const entry = container._slots.find(candidate => candidate.slot === slot)
    if (entry) entry.count = 0
  }
  warehouse.movePartialContainerSlotToInventory = async (container, slot, count) => {
    if (!applies(container)) return
    const entry = container._slots.find(candidate => candidate.slot === slot)
    if (entry) entry.count = Math.max(0, entry.count - count)
  }
  warehouse.ensureWindowCursorCleared = async () => true
  const confirmSequence = [...(options.confirmSequence || [])]
  warehouse.waitForInventoryTransfer = async () => {
    if (confirmSequence.length > 1) return confirmSequence.shift()
    return confirmSequence[0] ?? 0
  }

  return { warehouse, opened, replaced, mismatchCalls }
}

test('late click confirmation is retried and counted from the live container state', async () => {
  const directory = makeTempDir()
  configureTraceLog({ enabled: true, directory, retentionDays: 14 })

  const { warehouse } = createWarehouse(
    [{ chestId: 'chest-1', recorded: 1, reads: [[{ slot: 0, count: 1, name: 'stone' }]] }],
    { confirmSequence: [0, 1] }
  )
  warehouse.attachTrace(startTrace({ bot: 'BotA', kind: 'withdraw', actor: 'Steve' }))
  let result
  try {
    result = await warehouse.withdrawAllocationsLocked([{ ...ITEM, amount: 1 }])
  } finally {
    warehouse.detachTrace()
  }

  assert.equal(result.withdrawn.reduce((sum, item) => sum + item.amount, 0), 1, 'the landed click is credited exactly once')
  assert.equal(result.missing.length, 0)

  const lines = readTraceLines(directory)
  assert.equal(lines.filter(line => line.event === 'slot_take_uncertain_retry').length, 1, 'the uncertain click is retried once')
  assert.equal(lines.filter(line => line.event === 'slot_take_plan').length, 1, 'the retry re-pick finds the item already gone, so no second click is planned')
  const taken = lines.find(line => line.event === 'barrel_take_result')
  assert.equal(taken.moved, 1)
})

test('exhausted uncertainty skips the barrel and the task continues with the next barrel', async () => {
  const directory = makeTempDir()
  configureTraceLog({ enabled: true, directory, retentionDays: 14 })

  const { warehouse, opened, replaced } = createWarehouse(
    [
      { chestId: 'chest-1', recorded: 1, reads: [[{ slot: 0, count: 1, name: 'stone' }]] },
      { chestId: 'chest-2', recorded: 1, reads: [[{ slot: 0, count: 1, name: 'stone' }]] }
    ],
    { uncertainRetries: 1, noApplyChests: ['chest-1'], confirmSequence: [0, 0, 1] }
  )
  warehouse.attachTrace(startTrace({ bot: 'BotA', kind: 'withdraw', actor: 'Steve' }))
  let result
  try {
    result = await warehouse.withdrawAllocationsLocked([{ ...ITEM, amount: 2 }])
  } finally {
    warehouse.detachTrace()
  }

  assert.equal(result.withdrawn.reduce((sum, item) => sum + item.amount, 0), 1, 'the healthy barrel still delivers')
  assert.deepEqual(result.missing.map(item => item.amount), [1])
  assert.deepEqual(opened, ['chest-1', 'chest-2'], 'the task moves on to the next barrel instead of aborting')
  assert.deepEqual(replaced, ['chest-2'], 'the skipped barrel keeps its old record (no refresh from a doubtful window)')
  assert.deepEqual(result.unlocated, [])

  const lines = readTraceLines(directory)
  const skips = lines.filter(line => line.event === 'barrel_uncertain_skip')
  assert.equal(skips.length, 1)
  assert.equal(skips[0].chest, 'barrel@1,2,3')
  const plans = lines.filter(line => line.event === 'slot_take_plan')
  assert.equal(plans.length, 3, 'two attempts on the stuck barrel plus one on the healthy barrel')
})

test('unlocated allocation is recorded as an inventory mismatch and reported back', async () => {
  const directory = makeTempDir()
  configureTraceLog({ enabled: true, directory, retentionDays: 14 })

  const { warehouse, mismatchCalls } = createWarehouse(
    [{ chestId: 'chest-1', recorded: 2, reads: [[]] }],
    { noLocation: true }
  )
  warehouse.attachTrace(startTrace({ bot: 'BotA', kind: 'withdraw', actor: 'Steve' }))
  let result
  try {
    result = await warehouse.withdrawAllocationsLocked([
      { ...ITEM, amount: 2, ownerUuid: 'vault:x', ownerUsername: '仓库X' }
    ])
  } finally {
    warehouse.detachTrace()
  }

  assert.deepEqual(result.withdrawn, [])
  assert.deepEqual(result.missing.map(item => item.amount), [2])
  assert.equal(result.unlocated[0]?.amount, 2, 'the item is reported as unlocated')
  assert.equal(mismatchCalls.length, 1)
  assert.equal(mismatchCalls[0][0], 'missing')
  assert.equal(mismatchCalls[0][1], 'vault:x')
  assert.equal(mismatchCalls[0][4], 2)
  assert.ok(String(mismatchCalls[0][5]).includes('!同步'))

  const lines = readTraceLines(directory)
  assert.ok(lines.some(line => line.event === 'unlocated_recorded'))
})

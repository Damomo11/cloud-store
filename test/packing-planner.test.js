'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const ItemCatalog = require('../src/itemCatalog')
const { planPacking, packingStackSize, MAX_PACKING_BOXES } = require('../src/packing/planner')

const ownerUuid = 'owner-a'
const catalog = new ItemCatalog('1.21.11')
const Item = require('prismarine-item')(catalog.mcData)

function row (name, amount, components = []) {
  const item = new Item(catalog.mcData.itemsByName[name].id, 1)
  item.components = components
  return { ...catalog.fromPrismarineItem(item), ownerUuid, amount }
}

function fixture (stock = [row('stone', 4096)], boxes = [row('shulker_box', 3)]) {
  return { ownerUuid, catalog, items: [{ itemKey: stock[0].itemKey, amount: 1 }], availableItems: [...stock, ...boxes], emptyBoxes: boxes }
}

test('empty box planning permits only bounded exact protocol-empty slot padding', () => {
  const box = row('blue_shulker_box', 1, [{ type: 'container', data: { contents: Array.from({ length: 27 }, () => ({ itemCount: 0 })) } }])
  assert.equal(planPacking(fixture([row('stone', 1)], [box])).boxCount, 1)
  for (const contents of [[{ itemCount: 0, itemId: 1 }], [{ itemCount: 0, components: [] }], [{ itemCount: 0, data: {} }],
    [{ itemCount: '0' }], [{}], [null], Array.from({ length: 28 }, () => ({ itemCount: 0 }))]) {
    const invalid = row('blue_shulker_box', 1, [{ type: 'container', data: { contents } }])
    assert.throws(() => planPacking(fixture([row('stone', 1)], [invalid])), /empty|contents|container/i)
  }
})

test('plans exact mixed stacks with aggregated owner allocations and one empty box', () => {
  const stone = row('stone', 64)
  const stick = row('stick', 64)
  const f = fixture([stone, stick])
  f.items = [{ itemKey: stone.itemKey, amount: 64 }, { itemKey: stick.itemKey, amount: 64 }]
  const plan = planPacking(f)
  assert.equal(plan.ownerUuid, ownerUuid)
  assert.equal(plan.itemCount, 128)
  assert.equal(plan.boxCount, 1)
  assert.deepEqual(plan.inputs, [stone, stick])
  assert.deepEqual(plan.allocations, [stone, stick, { ...f.emptyBoxes[0], amount: 1 }])
  assert.deepEqual(plan.boxes, [{
    box: { ...f.emptyBoxes[0], amount: 1 }, inputs: [stone, stick], usedSlots: 2,
    slots: [{ slot: 0, itemKey: stone.itemKey, amount: 64 }, { slot: 1, itemKey: stick.itemKey, amount: 64 }]
  }])
})

test('uses real catalog stack limits of 64, 16 and 1', () => {
  const stone = row('stone', 65)
  const pearl = row('ender_pearl', 17)
  const sword = row('diamond_sword', 2)
  const f = fixture([stone, pearl, sword])
  f.items = [stone, pearl, sword].map(({ itemKey, amount }) => ({ itemKey, amount }))
  const plan = planPacking(f)
  assert.deepEqual(plan.boxes[0].slots, [
    { slot: 0, itemKey: stone.itemKey, amount: 64 }, { slot: 1, itemKey: stone.itemKey, amount: 1 },
    { slot: 2, itemKey: pearl.itemKey, amount: 16 }, { slot: 3, itemKey: pearl.itemKey, amount: 1 },
    { slot: 4, itemKey: sword.itemKey, amount: 1 }, { slot: 5, itemKey: sword.itemKey, amount: 1 }
  ])
  assert.deepEqual([stone, pearl, sword].map(item => packingStackSize(item, catalog)), [64, 16, 1])
})

test('component stack limits reduce slot capacity without exceeding the base server limit', () => {
  const stone = row('stone', 19, [{ type: 'max_stack_size', data: 9 }])
  const pearl = row('ender_pearl', 17, [{ type: 'max_stack_size', data: 99 }])
  const sword = row('diamond_sword', 2, [{ type: 'max_stack_size', data: 64 }])
  const f = fixture([stone, pearl, sword])
  f.items = [stone, pearl, sword]
  assert.deepEqual([stone, pearl, sword].map(item => packingStackSize(item, catalog)), [9, 16, 1])
  assert.deepEqual(planPacking(f).boxes[0].slots.map(slot => slot.amount), [9, 9, 1, 16, 1, 1, 1])
})

test('splits 1728 stone and one stick into two boxes at the 27-slot boundary', () => {
  const stone = row('stone', 1728)
  const stick = row('stick', 1)
  const f = fixture([stone, stick])
  f.items = [stone, stick]
  const plan = planPacking(f)
  assert.equal(plan.boxCount, 2)
  assert.deepEqual(plan.boxes.map(box => box.usedSlots), [27, 1])
  assert.deepEqual(plan.boxes.map(box => box.inputs), [[stone], [stick]])
  assert.deepEqual(plan.boxes[1].slots, [{ slot: 0, itemKey: stick.itemKey, amount: 1 }])
  assert.equal(plan.allocations.at(-1).amount, 2)
})

test('splits one exact input across boxes and preserves its final remainder', () => {
  const stone = row('stone', 1733)
  const f = fixture([stone])
  f.items = [stone]
  const plan = planPacking(f)
  assert.deepEqual(plan.boxes.map(box => box.inputs[0].amount), [1728, 5])
  assert.deepEqual(plan.boxes[1].slots, [{ slot: 0, itemKey: stone.itemKey, amount: 5 }])
})

test('combines duplicate requests in first occurrence order but keeps named variants separate', () => {
  const named = row('stone', 100, [{ type: 'custom_name', data: 'Reserved stone' }])
  const plain = row('stone', 100)
  const f = fixture([plain, named])
  f.items = [{ itemKey: named.itemKey, amount: 5 }, { itemKey: plain.itemKey, amount: 7 }, { itemKey: named.itemKey, amount: 6 }]
  const plan = planPacking(f)
  assert.notEqual(named.itemKey, plain.itemKey)
  assert.deepEqual(plan.inputs.map(item => [item.itemKey, item.amount]), [[named.itemKey, 11], [plain.itemKey, 7]])
  assert.deepEqual(plan.boxes[0].slots, [{ slot: 0, itemKey: named.itemKey, amount: 11 }, { slot: 1, itemKey: plain.itemKey, amount: 7 }])
})

test('selects owned colored named boxes in candidate order and honors an exact box key', () => {
  const blue = row('blue_shulker_box', 1, [{ type: 'custom_name', data: 'Blue crate' }])
  const red = row('red_shulker_box', 2, [{ type: 'custom_name', data: 'Red crate' }])
  const f = fixture([row('stone', 1729)], [blue, red])
  f.items[0].amount = 1729
  const plan = planPacking(f)
  assert.deepEqual(plan.boxes.map(box => box.box), [blue, { ...red, amount: 1 }])
  const selected = planPacking({ ...f, boxItemKey: red.itemKey })
  assert.deepEqual(selected.boxes.map(box => box.box), [{ ...red, amount: 1 }, { ...red, amount: 1 }])
  assert.equal(selected.allocations.at(-1).itemKey, red.itemKey)
  assert.equal(selected.allocations.at(-1).amount, 2)
})

test('uses owner-scoped rows without redundant owner fields and adds owner to every allocation', () => {
  const f = fixture()
  for (const entry of f.availableItems) delete entry.ownerUuid
  const plan = planPacking(f)
  assert.ok(plan.allocations.every(item => item.ownerUuid === ownerUuid))
  assert.ok(plan.boxes.every(box => box.box.ownerUuid === ownerUuid))
})

test('ignores explicitly foreign stock and cannot borrow foreign empty boxes', () => {
  const f = fixture()
  f.availableItems[0].ownerUuid = 'owner-b'
  assert.throws(() => planPacking(f), /stock|available|owner/i)
  const g = fixture()
  g.availableItems[1].ownerUuid = 'owner-b'
  assert.throws(() => planPacking(g), /box|owner|available/i)
})

test('never mutates or aliases request and stock data', () => {
  const f = fixture([row('stone', 64)], [row('purple_shulker_box', 2)])
  f.items[0].amount = 64
  const payload = { items: f.items, availableItems: f.availableItems, emptyBoxes: f.emptyBoxes }
  const before = structuredClone(payload)
  const plan = planPacking(f)
  assert.deepEqual(payload, before)
  plan.inputs[0].nbt = { changed: true }
  plan.boxes[0].box.ownerUuid = 'changed'
  plan.boxes[0].inputs[0].amount = 1
  assert.deepEqual(payload, before)
  assert.equal(plan.inputs[0].amount, 64)
})

for (const owner of [undefined, null, '', '   ', 1, {}, ' owner-a ']) {
  test(`rejects invalid owner ${JSON.stringify(owner)}`, () => {
    assert.throws(() => planPacking({ ...fixture(), ownerUuid: owner }), /owner/i)
  })
}

test('rejects empty or malformed request lists and unknown exact keys', () => {
  for (const items of [undefined, null, {}, [], [null], [{ itemId: 'minecraft:stone', amount: 1 }], [{ itemKey: 'unknown', amount: 1 }]]) {
    assert.throws(() => planPacking({ ...fixture(), items }), /item|request|key|stock/i)
  }
})

for (const amount of [0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`rejects invalid request amount ${String(amount)}`, () => {
    const f = fixture()
    f.items[0].amount = amount
    assert.throws(() => planPacking(f), /amount|integer|quantity/i)
  })
}

test('validates stock and box quantities without unsafe aggregation', () => {
  for (const field of ['availableItems', 'emptyBoxes']) {
    const f = fixture()
    f[field] = f[field].map(item => ({ ...item, amount: '3' }))
    assert.throws(() => planPacking(f), /amount|integer|quantity/i)
  }
  const f = fixture([row('stone', Number.MAX_SAFE_INTEGER)])
  f.availableItems.push({ ...f.availableItems[0], amount: 1 })
  assert.throws(() => planPacking(f), /safe|overflow|amount/i)
  const g = fixture([row('stone', Number.MAX_SAFE_INTEGER)])
  g.items = [{ itemKey: g.items[0].itemKey, amount: Number.MAX_SAFE_INTEGER }, { itemKey: g.items[0].itemKey, amount: 1 }]
  assert.throws(() => planPacking(g), /safe|overflow|amount/i)
})

test('rejects insufficient exact stock despite another variant being available', () => {
  const plain = row('stone', 1)
  const named = row('stone', 64, [{ type: 'custom_name', data: 'Other stone' }])
  const f = fixture([plain, named])
  f.items[0].amount = 2
  assert.throws(() => planPacking(f), /stock|insufficient/i)
})

test('rejects insufficient boxes and duplicate box candidates cannot multiply stock', () => {
  const f = fixture([row('stone', 1729)], [row('shulker_box', 1)])
  f.items[0].amount = 1729
  assert.throws(() => planPacking(f), /box/i)
  assert.throws(() => planPacking({ ...f, emptyBoxes: [...f.emptyBoxes, ...f.emptyBoxes] }), /box/i)
  assert.throws(() => planPacking({ ...fixture(), boxItemKey: 'missing-box' }), /box/i)
})

test('rejects shulker payloads whether the requested box is full or empty', () => {
  for (const components of [[], [{ type: 'container', data: { contents: [{ itemId: catalog.mcData.itemsByName.stone.id, itemCount: 1 }] } }]]) {
    const shulker = row('blue_shulker_box', 1, components)
    assert.throws(() => planPacking(fixture([shulker])), /nested|shulker|payload/i)
  }
})

test('rejects full boxes even when the candidate supplies fake empty metadata', () => {
  const full = row('shulker_box', 1, [{ type: 'container', data: { contents: [{ itemId: catalog.mcData.itemsByName.stone.id, itemCount: 1 }] } }])
  const f = fixture([row('stone', 1)], [full])
  assert.throws(() => planPacking(f), /empty|full|contents/i)
  f.emptyBoxes = [{ ...full, metaJson: JSON.stringify({ components: [] }) }]
  assert.throws(() => planPacking(f), /metadata|empty|full|contents|identity/i)
})

test('rejects legacy NBT contents and non-shulker box candidates', () => {
  const f = fixture()
  f.availableItems[1].nbtJson = JSON.stringify({ type: 'compound', value: { BlockEntityTag: { type: 'compound', value: { Items: { type: 'list', value: { type: 'compound', value: [{ id: { type: 'string', value: 'minecraft:stone' } }] } } } } } })
  assert.throws(() => planPacking(f), /empty|full|contents/i)
  const stone = row('stone', 3)
  assert.throws(() => planPacking(fixture([row('stick', 1)], [stone])), /shulker|box/i)
})

test('rejects malformed metadata instead of treating it as ordinary empty metadata', () => {
  const malformed = ['{', 'null', '[]', '1', '{"components":{}}', '{"components":[null]}', '{"components":[{"data":1}]}', '{"removeComponents":{}}']
  for (const metaJson of malformed) {
    const f = fixture()
    f.availableItems[0].metaJson = metaJson
    assert.throws(() => planPacking(f), /metadata|component/i, metaJson)
  }
  for (const nbtJson of ['{', '[]', '1']) {
    const f = fixture()
    f.availableItems[1].nbtJson = nbtJson
    assert.throws(() => planPacking(f), /metadata|nbt/i, nbtJson)
  }
  const f = fixture()
  f.availableItems[1].metaJson = '{"components":[{"type":"container","data":{}}]}'
  assert.throws(() => planPacking(f), /metadata|container|contents/i)
})

test('rejects malformed, duplicate or removed stack size components', () => {
  for (const data of [0, -1, 100, 1.5, '16', null, { value: 16 }]) {
    const item = row('stone', 1, [{ type: 'max_stack_size', data }])
    assert.throws(() => packingStackSize(item, catalog), /stack|component|metadata/i)
  }
  const duplicate = row('stone', 1, [{ type: 'max_stack_size', data: 16 }, { type: 'max_stack_size', data: 8 }])
  assert.throws(() => packingStackSize(duplicate, catalog), /stack|component|metadata/i)
  const removed = row('stone', 1)
  removed.metaJson = '{"components":null,"removeComponents":["max_stack_size"]}'
  assert.throws(() => packingStackSize(removed, catalog), /stack|component|metadata/i)
})

test('validates stack size metadata on empty box candidates as well as payloads', () => {
  const box = row('shulker_box', 1, [{ type: 'max_stack_size', data: 0 }])
  assert.throws(() => planPacking(fixture([row('stone', 1)], [box])), /stack|component|metadata/i)
})

test('combines split stock rows without allocating more than their aggregate balance', () => {
  const stone = row('stone', 10)
  const f = fixture([stone])
  f.availableItems.push({ ...stone, amount: 7 })
  f.items[0].amount = 17
  const plan = planPacking(f)
  assert.equal(plan.inputs[0].amount, 17)
  assert.deepEqual(plan.boxes[0].slots, [{ slot: 0, itemKey: stone.itemKey, amount: 17 }])
  f.items[0].amount = 18
  assert.throws(() => planPacking(f), /stock|insufficient/i)
})

test('rejects unknown catalog types and conflicting exact stock identities', () => {
  const f = fixture()
  f.availableItems[0].itemId = 'minecraft:missing_type'
  assert.throws(() => planPacking(f), /item|catalog|identity/i)
  const g = fixture()
  g.availableItems.push({ ...g.availableItems[0], metaJson: '{"components":[{"type":"max_stack_size","data":1}]}' })
  assert.throws(() => planPacking(g), /identity|metadata|conflict/i)
})

test('accepts the bounded box budget and rejects excess before expanding slots', () => {
  const f = fixture([row('diamond_sword', 27 * MAX_PACKING_BOXES + 1)], [row('shulker_box', MAX_PACKING_BOXES + 1)])
  f.items[0].amount = 27 * MAX_PACKING_BOXES
  const plan = planPacking(f)
  assert.equal(plan.boxCount, 256)
  assert.equal(plan.boxes.at(-1).usedSlots, 27)
  f.items[0].amount += 1
  assert.throws(() => planPacking(f), /limit|maximum|256|budget/i)
  const huge = fixture([row('stone', Number.MAX_SAFE_INTEGER)], [row('shulker_box', Number.MAX_SAFE_INTEGER)])
  huge.items[0].amount = Number.MAX_SAFE_INTEGER
  assert.throws(() => planPacking(huge), /limit|maximum|256|budget/i)
})

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function extractFunction (source, name) {
  const marker = `function ${name}(`
  const start = source.indexOf(marker)
  assert(start >= 0, `function ${name} not found in webServer.js`)
  let depth = 0
  let end = -1
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  assert(end > start, `unbalanced braces while extracting ${name}`)
  return source.slice(start, end)
}

function loadBulkViewHelpers () {
  const source = fs.readFileSync(path.join(__dirname, '../src/webServer.js'), 'utf8')
  const names = ['isShulkerItem', 'mergeBulkItem', 'flattenBulkItems', 'bulkAmountSuffix']
  const factory = new Function(`
    const num = value => Number(value || 0).toLocaleString('en-US')
    ${names.map(name => extractFunction(source, name)).join('\n')}
    return { isShulkerItem, flattenBulkItems, bulkAmountSuffix }
  `)
  return factory()
}

function loadPruneSelection (state, displayRows) {
  const source = fs.readFileSync(path.join(__dirname, '../src/webServer.js'), 'utf8')
  const factory = new Function('state', 'displayRows', `
    ${extractFunction(source, 'pruneSelection')}
    return pruneSelection
  `)
  return factory(state, displayRows)
}

test('bulk view flattens shulker contents into loose items by itemKey', () => {
  const { isShulkerItem, flattenBulkItems } = loadBulkViewHelpers()
  const items = [
    { itemKey: 'cobble-key', itemId: 'minecraft:cobblestone', displayName: '圆石', amount: 64, shulkerContents: [] },
    {
      itemKey: 'box-blue',
      itemId: 'minecraft:blue_shulker_box',
      displayName: '蓝色潜影盒',
      amount: 2,
      shulkerContents: [
        { itemKey: 'diamond-key', itemId: 'minecraft:diamond', displayName: '钻石', amount: 10, slotCount: 1 },
        { itemKey: 'cobble-key', itemId: 'minecraft:cobblestone', displayName: '圆石', amount: 54, slotCount: 1 }
      ]
    },
    {
      itemKey: 'box-red',
      itemId: 'minecraft:red_shulker_box',
      displayName: '红色潜影盒',
      amount: 1,
      shulkerContents: [
        { itemKey: 'diamond-key', itemId: 'minecraft:diamond', displayName: '钻石', amount: 27, slotCount: 3 }
      ]
    },
    { itemKey: 'box-empty', itemId: 'minecraft:white_shulker_box', displayName: '白色潜影盒', amount: 1, shulkerContents: [] }
  ]

  assert.equal(isShulkerItem(items[1]), true)
  assert.equal(isShulkerItem(items[0]), false)

  const rows = flattenBulkItems(items)
  assert.deepEqual(rows.map(row => row.itemKey), ['cobble-key', 'diamond-key'])

  const cobble = rows[0]
  assert.equal(cobble.looseAmount, 64)
  assert.equal(cobble.boxedAmount, 108)
  assert.equal(cobble.amount, 172)
  assert.deepEqual(cobble.shulkerContents, [])

  const diamond = rows[1]
  assert.equal(diamond.looseAmount, 0)
  assert.equal(diamond.boxedAmount, 47)
  assert.equal(diamond.amount, 47)
})

test('bulk view keeps non-shulker items untouched', () => {
  const { flattenBulkItems } = loadBulkViewHelpers()
  const items = [
    { itemKey: 'stick-key', itemId: 'minecraft:stick', displayName: '木棍', amount: 12, shulkerContents: [] }
  ]
  const rows = flattenBulkItems(items)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].itemKey, 'stick-key')
  assert.equal(rows[0].amount, 12)
  assert.equal(rows[0].boxedAmount, 0)
})

test('bulk amount suffix explains loose and boxed split', () => {
  const { bulkAmountSuffix } = loadBulkViewHelpers()
  assert.equal(bulkAmountSuffix({ amount: 172, looseAmount: 64, boxedAmount: 108 }), '（散装 64 + 盒内 108）')
  assert.equal(bulkAmountSuffix({ amount: 47, looseAmount: 0, boxedAmount: 47 }), '（盒内）')
  assert.equal(bulkAmountSuffix({ amount: 12 }), '')
})

test('switching views drops hidden shulker picks and clamps amounts', () => {
  const { flattenBulkItems } = loadBulkViewHelpers()
  const items = [
    { itemKey: 'cobble-key', itemId: 'minecraft:cobblestone', displayName: '圆石', amount: 64, shulkerContents: [] },
    {
      itemKey: 'box-blue',
      itemId: 'minecraft:blue_shulker_box',
      displayName: '蓝色潜影盒',
      amount: 2,
      shulkerContents: [
        { itemKey: 'diamond-key', itemId: 'minecraft:diamond', displayName: '钻石', amount: 10, slotCount: 1 }
      ]
    }
  ]
  const bulkItems = flattenBulkItems(items)
  const state = { selected: new Map([
    ['cobble-key', { itemKey: 'cobble-key', displayName: '圆石', amount: 999, max: 172 }],
    ['box-blue', { itemKey: 'box-blue', displayName: '蓝色潜影盒', amount: 1, max: 2 }]
  ]) }
  const pruneSelection = loadPruneSelection(state, () => bulkItems)
  pruneSelection()
  assert.equal(state.selected.size, 1)
  const cobble = state.selected.get('cobble-key')
  assert.equal(cobble.amount, 64)
  assert.equal(cobble.max, 64)
})

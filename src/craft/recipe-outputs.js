'use strict'

// Vanilla crafting remainders missing from minecraft-data's recipe snapshots.
// Resolve both sides through the active registry; never carry numeric ids across
// Minecraft versions. Unsupported filled containers fail before any craft click.
const RETURNED_CONTAINERS = new Map([
  ['milk_bucket', 'bucket'],
  ['water_bucket', 'bucket'],
  ['lava_bucket', 'bucket'],
  ['powder_snow_bucket', 'bucket'],
  ['honey_bottle', 'glass_bottle']
])

function recipeItem (registry, value) {
  if (value == null || value === -1 || value.id === -1) return null
  const id = typeof value === 'number' ? value : value.id
  const metadata = typeof value === 'object' ? value.metadata ?? null : null
  if (!Number.isSafeInteger(id) || !registry.items?.[id] ||
    (metadata != null && !Number.isSafeInteger(metadata))) throw new Error('unidentified recipe output or ingredient')
  return { id, metadata, count: 1 }
}

function countItem (registry, value) {
  const item = recipeItem(registry, value)
  const count = typeof value === 'object' ? value.count ?? 1 : 1
  if (!item || !Number.isSafeInteger(count) || count <= 0) throw new Error('invalid recipe output count')
  return { ...item, count }
}

function group (entries) {
  const totals = new Map()
  for (const entry of entries) {
    const key = `${entry.id}:${entry.metadata ?? '*'}`
    const previous = totals.get(key)
    if (previous) previous.count += entry.count
    else totals.set(key, { ...entry })
  }
  return [...totals.values()].filter(item => item.count !== 0)
}

function equal (left, right) {
  const ordered = entries => group(entries).sort((a, b) => a.id - b.id || String(a.metadata).localeCompare(String(b.metadata)))
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right))
}

function remainderDetails (registry, recipe) {
  const inputs = []
  const positions = []
  const size = recipe.requiresTable === true || recipe.inShape?.length > 2 ||
    recipe.inShape?.some(row => row.length > 2) || recipe.ingredients?.length > 4 ? 3 : 2
  const occupied = new Set()
  if (recipe.inShape) {
    for (const [y, row] of recipe.inShape.entries()) for (const [x, value] of row.entries()) {
      const ingredient = recipeItem(registry, value)
      if (ingredient) { inputs.push(ingredient); positions.push({ x, y, ingredient }); occupied.add(`${x},${y}`) }
    }
  }
  if (recipe.ingredients) {
    const free = []
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!occupied.has(`${x},${y}`)) free.push({ x, y })
    for (const value of recipe.ingredients) {
      const ingredient = recipeItem(registry, value)
      const position = free.pop()
      if (!ingredient || !position) throw new Error('invalid shapeless recipe ingredient')
      inputs.push(ingredient)
      positions.push({ ...position, ingredient })
    }
  }
  const inferredShape = Array.from({ length: size }, () => Array.from({ length: size }, () => ({ id: -1, metadata: null, count: 1 })))
  const inferred = []
  for (const { x, y, ingredient } of positions) {
    const name = registry.items[ingredient.id].name
    const returnedName = RETURNED_CONTAINERS.get(name)
    if (!returnedName) {
      if ((/_bucket$/.test(name) && name !== 'bucket') || (/_bottle$/.test(name) && name !== 'glass_bottle') ||
        ['potion', 'splash_potion', 'lingering_potion', 'dragon_breath'].includes(name)) {
        throw new Error(`crafting remainder is not declared for ${name}`)
      }
      continue
    }
    const returned = registry.itemsByName?.[returnedName]
    if (!returned || registry.items[returned.id]?.name !== returnedName) throw new Error(`crafting remainder is unavailable: ${returnedName}`)
    const value = { id: returned.id, metadata: null, count: 1 }
    inferred.push(value)
    inferredShape[y][x] = value
  }
  const declared = recipe.outShape?.flat().filter(value => value != null && value !== -1 && value.id !== -1).map(value => countItem(registry, value))
  if (declared && inferred.length && !equal(declared, inferred)) throw new Error('declared recipe remainders do not match vanilla container returns')
  return { inputs, remainders: declared || inferred, outShape: recipe.outShape || (inferred.length ? inferredShape : null) }
}

function standardRecipeOutputs (registry, recipe) {
  const { remainders } = remainderDetails(registry, recipe)
  return group([countItem(registry, recipe.result), ...remainders])
}

// Mineflayer needs the enriched output grid too: without it its craft plugin
// clears returned-container slots instead of putting their contents away.
function withStandardRecipeOutputs (registry, recipe) {
  const { inputs, outShape } = remainderDetails(registry, recipe)
  const outputs = standardRecipeOutputs(registry, recipe)
  const delta = group([...inputs.map(value => ({ ...value, count: -1 })), ...outputs])
  const originalOutputs = [countItem(registry, recipe.result), ...(recipe.outShape?.flat() || [])
    .filter(value => value != null && value !== -1 && value.id !== -1).map(value => countItem(registry, value))]
  const originalDelta = group([...inputs.map(value => ({ ...value, count: -1 })), ...originalOutputs])
  if (!Array.isArray(recipe.delta) || !equal(recipe.delta, originalDelta)) throw new Error('recipe delta does not match declared ingredients and outputs')
  return { ...recipe, outShape, delta }
}

module.exports = { standardRecipeOutputs, withStandardRecipeOutputs }

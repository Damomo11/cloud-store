'use strict'

function findCraftRecipes (bot, registry, itemType, table) {
  if (registry.version.minecraftVersion !== '26.3') return bot.recipesAll(itemType, null, table) || []

  // Via builds the 26.3 item table but keeps the 26.1 recipe table. Resolve
  // its entries by name and translate the raw 26.1 IDs without changing
  // prismarine-recipe's shared registry for other bots.
  const source = require('minecraft-data')('26.1')
  const sourceItem = source.itemsByName[registry.items[itemType]?.name]
  if (!sourceItem) return []
  const ingredient = (id, count) => {
    const live = registry.itemsByName[source.items[id]?.name]
    return live && { id: live.id, metadata: null, count }
  }
  const recipes = []
  for (const entry of source.recipes[sourceItem.id] || []) {
    if (entry.result.id !== sourceItem.id || entry.outShape) continue
    const result = { id: itemType, metadata: entry.result.metadata ?? null, count: entry.result.count }
    const inShape = entry.inShape?.map(row => row.map(id => id === null
      ? { id: -1, metadata: null, count: 1 }
      : ingredient(id, 1))) || null
    const ingredients = entry.ingredients?.map(id => ingredient(id, -1)) || null
    const cells = inShape?.flat() || []
    if (cells.includes(undefined) || ingredients?.includes(undefined)) continue
    const requiresTable = Boolean(inShape?.length > 2 || inShape?.some(row => row.length > 2) || ingredients?.length > 4)
    if (requiresTable && !table) continue
    const delta = [...cells.filter(cell => cell.id >= 0).map(cell => ({ ...cell, count: -1 })), ...(ingredients || []), result]
    recipes.push({ result, inShape, ingredients, requiresTable, delta })
  }
  return recipes
}

module.exports = { findCraftRecipes }

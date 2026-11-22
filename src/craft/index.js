'use strict'

const { randomUUID } = require('node:crypto')
const { CraftPlanner } = require('./preparation/CraftPlanner')
const { RecipeGraph, getRecipeGraph } = require('./preparation/RecipeGraph')
const DEFAULT_CRAFT_TIMEOUT_MS = 20 * 60 * 1000
const MAX_CRAFT_QUANTITY = 1000000

function getSharedGraph (version = '1.21.11') { return getRecipeGraph(version) }
function normalizeBlockPos (pos) {
  if (!pos || !['x', 'y', 'z'].every(key => Number.isFinite(pos[key]))) return null
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
}
function workstationFromConfig (config) {
  const blockPos = normalizeBlockPos(config?.craft?.table)
  return blockPos ? { blockPos, containerType: 'crafting_table' } : null
}
// Olela supplies planning. Warehouse and CraftLedger own all physical storage
// and accounting; internal movements do not create deposit/withdraw balances.
function planToCraftCommand ({ item, quantity, available, config, forceCraft = false, bot }) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > MAX_CRAFT_QUANTITY) {
    return { ok: false, reason: 'invalid_quantity' }
  }
  // The 26.3 connection uses recipes from the 26.1 snapshot.
  const recipeVersion = bot?.registry?.version?.minecraftVersion === '26.3' ? '26.1' : config?.server?.version
  const graph = getSharedGraph(recipeVersion)
  const cleanName = String(item).replace(/^minecraft:/, '')
  // forceCraft keeps planning when the target is already stocked: the planner
  // would otherwise satisfy the request from available stock and return zero
  // craft steps. Hide finished stock except the minimum reusable seed of a
  // productive self-input recipe, such as template duplication. Request that
  // seed in addition to the full new quantity so stock cannot offset the order.
  let planAvailable = available || {}
  let planQuantity = quantity
  if (forceCraft && graph.getRecipesFor(cleanName).length) {
    planAvailable = { ...planAvailable }
    const seeds = graph.getRecipesFor(cleanName).map(recipe => {
      const seed = recipe.inputs.filter(input => input.names.length === 1 && input.names[0] === cleanName)
        .reduce((count, input) => count + input.count, 0)
      return seed > 0 && recipe.result.count > seed && planAvailable[cleanName] >= seed ? seed : 0
    }).filter(Boolean)
    delete planAvailable[cleanName]
    if (seeds.length) {
      const seed = Math.min(...seeds)
      planAvailable[cleanName] = seed
      planQuantity += seed
    }
  }
  const plan = new CraftPlanner(graph).plan(cleanName, planQuantity, { available: planAvailable })
  if (!plan.ok) return { ok: false, reason: 'plan_unreachable', plan }
  if (plan.collectGaps?.length) return { ok: false, reason: 'needs_collection', plan }
  if (!plan.craftSteps?.length) return { ok: false, reason: 'already_in_warehouse', plan }
  const budgetMs = config?.craft?.timeoutMs ?? DEFAULT_CRAFT_TIMEOUT_MS
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) return { ok: false, reason: 'invalid_timeout', plan }
  return {
    ok: true, plan,
    command: {
      type: 'craft_plan', requestId: `craft:${randomUUID()}`,
      target: { name: cleanName, quantity },
      craftSteps: plan.craftSteps, inventoryUses: plan.inventoryUses, budgetMs
    }
  }
}
function attachCraftingExecutor (bot, { config, catalog, warehouse, debugCraft }) {
  const { createInventoryExecutor } = require('./inventory-executor')
  bot._craftingExecutor = createInventoryExecutor(bot, catalog, config, warehouse, debugCraft)
  return bot._craftingExecutor
}
module.exports = {
  attachCraftingExecutor, getSharedGraph, normalizeBlockPos, planToCraftCommand,
  workstationFromConfig, RecipeGraph, CraftPlanner, DEFAULT_CRAFT_TIMEOUT_MS,
  MAX_CRAFT_QUANTITY
}

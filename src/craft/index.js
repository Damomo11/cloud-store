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
function planToCraftCommand ({ item, quantity, available, config, forceCraft = false }) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > MAX_CRAFT_QUANTITY) {
    return { ok: false, reason: 'invalid_quantity' }
  }
  const graph = getSharedGraph(config?.server?.version)
  const cleanName = String(item).replace(/^minecraft:/, '')
  // forceCraft keeps planning when the target is already stocked: the planner
  // would otherwise satisfy the request from available stock and return zero
  // craft steps. Hiding the target's own stock makes it plan the full request;
  // other items stay withdrawable as chain inputs.
  let planAvailable = available || {}
  if (forceCraft && graph.getRecipesFor(cleanName).length) {
    planAvailable = { ...planAvailable }
    delete planAvailable[cleanName]
  }
  const plan = new CraftPlanner(graph).plan(cleanName, quantity, { available: planAvailable })
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

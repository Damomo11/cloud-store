'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// craft/index.js — cloud-store adapter around the ported olela crafting executor.
//
// Ported from olela-bot (node-bot): the executor, recipe graph, planner and path
// helpers are copied verbatim; only the seams are rewired here:
//   - station HTTP calls -> cloud-store's own chest registry (SQLite `chests`)
//   - olela long-command/station reporting -> local sink (`onEvent`)
//   - buffer/output containers -> the same barrels the cloud-store warehouse uses
//   - the workbench comes from config.craft.table (a single coordinate variable)
//
// Scope (by owner's decision 2026-11-02):
//   - synthesis only; no collection/hauling chain (planner still reports collect gaps
//     for information, but callers will reject plans that need them)
//   - single-bot flow (one craft task at a time per bot; task pool marks it exclusive)
//   - no web/front-end changes; this module is the only public surface.
// ─────────────────────────────────────────────────────────────────────────────

const craftingExecutorFactory = require('./crafting-executor')
const { CraftPlanner } = require('./preparation/CraftPlanner')
const { RecipeGraph, getRecipeGraph } = require('./preparation/RecipeGraph')

const DEFAULT_CRAFT_TIMEOUT_MS = 20 * 60 * 1000

// Build the planner graph once per process. olela does the same via getRecipeGraph().
let sharedGraph = null
function getSharedGraph () {
  if (!sharedGraph) sharedGraph = getRecipeGraph()
  return sharedGraph
}

function normalizeBlockPos (pos) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return null
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
}

// Translate one cloud-store chest row ({ chestId, x, y, z, blockName }) into the
// container shape the ported executor expects ({ containerId, blockPos, ... }).
function toContainerRef (chest, purpose) {
  const blockPos = normalizeBlockPos(chest)
  if (!blockPos) return null
  return {
    containerId: String(chest.chestId || `chest:${blockPos.x},${blockPos.y},${blockPos.z}`),
    blockPos,
    purpose: purpose || null,
    containerType: chest.blockName || null,
    standPos: null,
    secondaryPos: null
  }
}

// Resolve the configured crafting table into a workstation container ref.
function workstationFromConfig (config) {
  const table = config && config.craft && config.craft.table
  const blockPos = normalizeBlockPos(table)
  if (!blockPos) return null
  return {
    containerId: `workstation:${blockPos.x},${blockPos.y},${blockPos.z}`,
    blockPos,
    purpose: 'workstation',
    containerType: 'crafting_table',
    standPos: null,
    secondaryPos: null
  }
}

// Build the sink consumed by the ported executor (cfg.craftSink).
// Every method is optional in the executor; the ones here mirror the olela server
// queries but read from cloud-store's local database instead of HTTP.
function createCraftSink ({ db, config, catalog, onEvent }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {}

  return {
    onEvent (type, payload, opts) {
      emit(type, payload, opts)
    },

    // Same contract as olela's GET /inventory/containers:
    //   [{ id, purpose, containerType, blockPos, standPos, secondaryPos }]
    resolveContainers () {
      const list = []
      for (const chest of db.listChests()) {
        const ref = toContainerRef(chest, 'buffer')
        if (ref) list.push({ ...ref, id: ref.containerId })
      }
      const workstation = workstationFromConfig(config)
      if (workstation) list.push({ ...workstation, id: workstation.containerId })
      return list
    },

    // Same contract as olela's GET /inventory/containers/:id/snapshot.
    // The executor only uses this to rank output containers by free space.
    snapshotContainer (container) {
      const id = container && (container.containerId || container.id)
      if (!id) return null
      const slots = db.listChestSlots()
        .filter(slot => slot.chestId === id || slot.chest_id === id)
      if (!Array.isArray(slots)) return null
      return {
        containerId: id,
        slots: slots.map(slot => ({
          slot: slot.slot,
          itemKey: slot.itemKey || slot.item_key,
          amount: Number(slot.amount) || 0
        }))
      }
    }
  }
}

// Turn a planner result into the executor command. Only synthesis steps survive:
// if the plan needs collection or is unreachable, the caller gets a structured
// rejection instead of a half-valid command (owner's rule: synthesis only).
function planToCraftCommand ({ item, quantity, available, config }) {
  const planner = new CraftPlanner(getSharedGraph())
  const plan = planner.plan(item, quantity, { available: available || {} })

  if (!plan.ok) {
    return { ok: false, reason: 'plan_unreachable', plan }
  }
  if (Array.isArray(plan.collectGaps) && plan.collectGaps.length > 0) {
    // Collection is out of scope for the cloud-store port. Report the gap so the
    // caller can explain which inputs are missing from the warehouse.
    return { ok: false, reason: 'needs_collection', plan }
  }
  if (!Array.isArray(plan.craftSteps) || plan.craftSteps.length === 0) {
    return { ok: false, reason: 'already_in_warehouse', plan }
  }

  const workstation = workstationFromConfig(config)
  if (!workstation && plan.craftSteps.some(step => stepNeedsTable(step))) {
    return { ok: false, reason: 'no_workstation_configured', plan }
  }

  return {
    ok: true,
    command: {
      type: 'craft_plan',
      requestId: `craft:${Date.now().toString(36)}`,
      player: null,
      target: { name: item, quantity },
      craftSteps: plan.craftSteps,
      workstations: workstation ? [workstation] : [],
      budgetMs: DEFAULT_CRAFT_TIMEOUT_MS
    },
    plan
  }
}

// A step needs a 3x3 workbench when the planner's canonical recipe says so.
// The recipe graph keeps the recipe's own `requiresTable` flag (added during the
// port) so this decision matches the executor's stepRequiresTable rule.
function stepNeedsTable (step) {
  if (step && typeof step.requiresTable === 'boolean') return step.requiresTable
  const recipe = getSharedGraph().getRecipesFor(step && step.result && step.result.name)[0]
  return Boolean(recipe && recipe.requiresTable)
}

// Attach the executor to a mineflayer bot the same way olela does — the ported
// module registers itself as bot._craftingExecutor on construction.
function attachCraftingExecutor (bot, { id, db, config, catalog, onEvent }) {
  const sink = createCraftSink({ db, config, catalog, onEvent })
  craftingExecutorFactory(bot, { id, craftSink: sink })
  // Expose the sink so the service can observe terminal events for player feedback.
  bot._craftSink = sink
  return bot._craftingExecutor
}

module.exports = {
  attachCraftingExecutor,
  createCraftSink,
  planToCraftCommand,
  getSharedGraph,
  RecipeGraph,
  CraftPlanner
}

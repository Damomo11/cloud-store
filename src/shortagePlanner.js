'use strict'

const { planToCraftCommand: defaultCraftPlanner } = require('./craft')

function normalizeItemId (value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return ''
  return text.startsWith('minecraft:') ? text : `minecraft:${text}`
}

function itemName (itemId) {
  return String(itemId || '').replace(/^minecraft:/, '')
}

function positiveAmount (value) {
  const amount = Number(value || 0)
  return Number.isFinite(amount) && amount > 0 ? amount : 0
}

function coverageAmount (item) {
  const coverage = positiveAmount(item?.coverageAmount)
  return coverage || positiveAmount(item?.amount)
}

function requestMatchesAllocation (request, requestIndex, allocation) {
  if (Number.isInteger(allocation?.requestIndex)) return allocation.requestIndex === requestIndex
  if (request.itemKey && (allocation?.requestItemKey === request.itemKey || allocation?.itemKey === request.itemKey)) return true
  const allocationItemId = normalizeItemId(allocation?.requestItemId || allocation?.itemId)
  return Boolean(request.itemId && allocationItemId === request.itemId)
}

function aggregateRows (rows) {
  const map = new Map()
  for (const row of rows) {
    const itemId = normalizeItemId(row.itemId)
    const amount = positiveAmount(row.amount)
    if (!itemId || !amount) continue
    const previous = map.get(itemId)
    map.set(itemId, {
      itemId,
      itemKey: previous?.itemKey || row.itemKey || undefined,
      displayName: previous?.displayName || row.displayName || itemId,
      amount: (previous?.amount || 0) + amount
    })
  }
  return [...map.values()]
}

function cloneCraftStock (stock) {
  const result = {}
  for (const [rawName, rawAmount] of Object.entries(stock || {})) {
    const name = itemName(normalizeItemId(rawName))
    const amount = positiveAmount(rawAmount)
    if (!name || !amount) continue
    result[name] = (result[name] || 0) + amount
  }
  return result
}

function subtractCraftUses (stock, uses) {
  for (const use of uses || []) {
    const name = itemName(normalizeItemId(use?.name || use?.itemId))
    const amount = positiveAmount(use?.quantity ?? use?.amount)
    if (!name || !amount) continue
    stock[name] = Math.max(0, Number(stock[name] || 0) - amount)
  }
}

function addCraftOutputs (stock, plan, fallbackItem, fallbackAmount) {
  let added = false
  for (const step of plan?.craftSteps || []) {
    const times = positiveAmount(step?.times) || 1
    const outputs = Array.isArray(step?.outputs) && step.outputs.length
      ? step.outputs
      : (step?.result ? [step.result] : [])
    for (const output of outputs) {
      const name = itemName(normalizeItemId(output?.name || output?.itemId))
      const amount = positiveAmount(output?.count ?? output?.amount) * times
      if (!name || !amount) continue
      stock[name] = (stock[name] || 0) + amount
      added = true
    }
  }

  // Injectable planners used by callers may omit steps; retain the old target
  // fallback for those plans while real CraftPlanner plans use exact outputs.
  if (!added) {
    const name = itemName(normalizeItemId(fallbackItem))
    const amount = positiveAmount(fallbackAmount)
    if (name && amount) stock[name] = (stock[name] || 0) + amount
  }
}

function classifyCraftFailure (reason) {
  return reason === 'needs_collection' ? 'unavailable' : 'unsupported'
}

function planShortages ({ requests = [], allocations = [], availableCraftStock = {}, config, craftPlanner = defaultCraftPlanner } = {}) {
  const normalizedRequests = requests.map((request, requestIndex) => ({
    ...request,
    requestIndex,
    itemId: normalizeItemId(request?.itemId || request?.requestItemId),
    amount: positiveAmount(request?.amount)
  })).filter(request => request.itemId && request.amount > 0)

  const remainingAllocations = allocations.map(allocation => ({
    ...allocation,
    remaining: coverageAmount(allocation)
  }))
  const allocatedRows = []
  const requestedRows = []

  for (const request of normalizedRequests) {
    requestedRows.push({ ...request, amount: request.amount })
    let remainingRequest = request.amount
    for (const allocation of remainingAllocations) {
      if (remainingRequest <= 0 || allocation.remaining <= 0) continue
      if (!requestMatchesAllocation(request, request.requestIndex, allocation)) continue
      const amount = Math.min(remainingRequest, allocation.remaining)
      allocation.remaining -= amount
      remainingRequest -= amount
      allocatedRows.push({
        itemId: request.itemId,
        itemKey: allocation.itemKey,
        displayName: request.displayName || allocation.displayName || request.itemId,
        amount
      })
    }
  }

  const requested = aggregateRows(requestedRows)
  const allocated = aggregateRows(allocatedRows)
  const allocatedById = new Map(allocated.map(row => [row.itemId, row.amount]))
  const shortages = []
  for (const request of requested) {
    const allocatedAmount = Math.min(request.amount, Number(allocatedById.get(request.itemId) || 0))
    const missing = Math.max(0, request.amount - allocatedAmount)
    if (!missing) continue
    shortages.push({
      itemId: request.itemId,
      displayName: request.displayName || request.itemId,
      requested: request.amount,
      allocated: allocatedAmount,
      missing,
      reason: 'short'
    })
  }

  const craftStock = cloneCraftStock(availableCraftStock)
  const craft = []
  for (const shortage of shortages) {
    const target = itemName(shortage.itemId)
    let planned
    try {
      planned = craftPlanner({
        item: target,
        quantity: shortage.missing,
        available: { ...craftStock },
        config,
        forceCraft: true
      })
    } catch (error) {
      planned = { ok: false, reason: 'planner_error', error: error?.message || String(error) }
    }
    if (planned?.ok && planned.plan) {
      subtractCraftUses(craftStock, planned.plan.inventoryUses)
      addCraftOutputs(craftStock, planned.plan, target, shortage.missing)
      craft.push({
        itemId: shortage.itemId,
        displayName: shortage.displayName,
        amount: shortage.missing,
        status: 'planned',
        plan: planned.plan
      })
      continue
    }
    const reason = String(planned?.reason || planned?.error || 'plan_unreachable')
    craft.push({
      itemId: shortage.itemId,
      displayName: shortage.displayName,
      amount: shortage.missing,
      status: classifyCraftFailure(reason),
      reason
    })
  }

  return { requested, allocated, shortages, craft }
}

module.exports = {
  planShortages,
  normalizeItemId,
  cloneCraftStock
}

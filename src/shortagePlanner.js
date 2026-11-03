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
  const steps = Array.isArray(plan?.craftSteps) ? plan.craftSteps : []
  const targetName = itemName(normalizeItemId(fallbackItem))
  const targetAmount = positiveAmount(fallbackAmount)
  if (!steps.length) {
    subtractCraftUses(stock, plan?.inventoryUses)
    if (targetName && targetAmount) stock[targetName] = (stock[targetName] || 0) + targetAmount
    return
  }

  // inventoryUses are the leaves taken from the owner's stock. Intermediate
  // inputs are settled below when their produced batches are consumed.
  subtractCraftUses(stock, plan?.inventoryUses)
  const producedNames = new Set()
  for (const step of steps) {
    const times = positiveAmount(step?.times) || 1
    for (const input of step?.inputs || []) {
      const name = itemName(normalizeItemId(input?.names?.[0] || input?.name || input?.itemId))
      const amount = positiveAmount(input?.count) * times
      if (name && amount && producedNames.has(name)) {
        stock[name] = Math.max(0, Number(stock[name] || 0) - amount)
      }
    }
    const outputs = Array.isArray(step?.outputs) && step.outputs.length
      ? step.outputs
      : (step?.result ? [step.result] : [])
    for (const output of outputs) {
      const name = itemName(normalizeItemId(output?.name || output?.itemId))
      const amount = positiveAmount(output?.count ?? output?.amount) * times
      if (!name || !amount) continue
      stock[name] = (stock[name] || 0) + amount
      producedNames.add(name)
    }
  }
  if (targetName && targetAmount) {
    stock[targetName] = Math.max(0, Number(stock[targetName] || 0) - targetAmount)
  }
}

function classifyCraftFailure (reason) {
  return reason === 'needs_collection' ? 'unavailable' : 'unsupported'
}

function craftTargetVariant (shortage, requests, catalog) {
  if (typeof catalog?.fromItemIdAmount !== 'function') return null
  const canonical = catalog.fromItemIdAmount(shortage.itemId, 1)?.itemKey
  const variants = (requests || [])
    .filter(request => request?.itemId === shortage?.itemId && request?.itemKey)
    .map(request => request.itemKey)
  return canonical && variants.some(itemKey => itemKey !== canonical)
    ? variants.find(itemKey => itemKey !== canonical)
    : null
}

function planShortages ({ requests = [], allocations = [], availableCraftStock = {}, availableCraftStockByOwner = null, config, catalog, craftPlanner = defaultCraftPlanner } = {}) {
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
  const ownerStocks = availableCraftStockByOwner
    ? [...(availableCraftStockByOwner instanceof Map
        ? availableCraftStockByOwner.entries()
        : Object.entries(availableCraftStockByOwner))]
        .map(([ownerUuid, stock]) => ({ ownerUuid, stock: cloneCraftStock(stock) }))
    : null
  const craft = []
  for (const shortage of shortages) {
    const target = itemName(shortage.itemId)
    const nonCraftableVariant = craftTargetVariant(shortage, normalizedRequests, catalog)
    if (nonCraftableVariant) {
      craft.push({
        itemId: shortage.itemId,
        itemKey: nonCraftableVariant,
        displayName: shortage.displayName,
        amount: shortage.missing,
        status: 'unsupported',
        reason: 'item_variant_not_craftable'
      })
      continue
    }
    const candidates = ownerStocks || [{ ownerUuid: undefined, stock: craftStock }]
    let planned = null
    let plannedOwnerUuid
    let lastFailure = null
    for (const candidate of candidates) {
      try {
        planned = craftPlanner({
          item: target,
          quantity: shortage.missing,
          available: { ...candidate.stock },
          config,
          forceCraft: true
        })
      } catch (error) {
        planned = { ok: false, reason: 'planner_error', error: error?.message || String(error) }
      }
      if (planned?.ok && planned.plan) {
        subtractCraftUses(candidate.stock, planned.plan.inventoryUses)
        addCraftOutputs(candidate.stock, planned.plan, target, shortage.missing)
        plannedOwnerUuid = candidate.ownerUuid
        break
      }
      lastFailure = planned
    }
    if (planned?.ok && planned.plan) {
      const entry = {
        itemId: shortage.itemId,
        displayName: shortage.displayName,
        amount: shortage.missing,
        status: 'planned',
        plan: planned.plan
      }
      if (plannedOwnerUuid !== undefined) entry.ownerUuid = plannedOwnerUuid
      craft.push({
        ...entry
      })
      continue
    }
    const reason = String(lastFailure?.reason || lastFailure?.error || 'plan_unreachable')
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

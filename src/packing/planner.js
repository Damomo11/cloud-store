'use strict'

const MAX_PACKING_BOXES = 256
const BOX_SLOTS = 27

function positiveAmount (amount, label) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`Invalid ${label} amount: expected a positive safe integer`)
  return amount
}

function addAmounts (left, right, label) {
  const amount = left + right
  if (!Number.isSafeInteger(amount)) throw new Error(`Unsafe ${label} amount overflow`)
  return amount
}

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function storedJson (text, label, nullable = false) {
  let value
  try {
    if (typeof text !== 'string') throw new Error('not JSON text')
    value = JSON.parse(text)
  } catch {
    throw new Error(`Invalid packing ${label} JSON`)
  }
  if (!isObject(value) && !(nullable && value === null)) throw new Error(`Invalid packing ${label}: expected an object`)
  return value
}

function metadata (item) {
  const meta = storedJson(item?.metaJson, 'metadata')
  if (meta.components !== undefined && meta.components !== null && !Array.isArray(meta.components)) {
    throw new Error('Invalid packing metadata components')
  }
  const components = meta.components || []
  const seen = new Set()
  for (const component of components) {
    if (!isObject(component) || typeof component.type !== 'string' || !component.type || seen.has(component.type)) {
      throw new Error('Invalid or duplicate packing metadata component')
    }
    seen.add(component.type)
  }
  if (meta.removeComponents !== undefined && meta.removeComponents !== null && !Array.isArray(meta.removeComponents)) {
    throw new Error('Invalid packing metadata removed components')
  }
  // A removed component cannot provide a reliable capacity. Numeric removal
  // IDs are protocol-specific, so leave those to authoritative execution too.
  if (meta.removeComponents?.length) throw new Error('Removed packing metadata components are unsupported')
  return meta
}

function catalogItem (item, catalog) {
  if (!item || typeof item.itemId !== 'string' || !item.itemId.startsWith('minecraft:')) {
    throw new Error('Invalid packing item identity')
  }
  const definition = catalog?.mcData?.itemsByName?.[item.itemId.slice('minecraft:'.length)]
  if (!definition || typeof catalog.getStackSize !== 'function' || typeof catalog.isShulkerBox !== 'function') {
    throw new Error(`Unknown packing catalog item: ${item.itemId}`)
  }
  return definition
}

function packingStackSize (item, catalog) {
  catalogItem(item, catalog)
  const base = positiveAmount(catalog.getStackSize(item.itemId), 'catalog stack size')
  if (base > 99) throw new Error('Invalid packing catalog stack size')
  const meta = metadata(item)
  const component = meta.components?.find(entry => entry.type === 'max_stack_size')
  if (!component) return base
  const limit = positiveAmount(component.data, 'max_stack_size component')
  if (limit > 99) throw new Error('Invalid max_stack_size component: maximum is 99')
  // Current physical transfer code uses the catalog's base stack capacity.
  return Math.min(base, limit)
}

function itemKey (item) {
  if (!isObject(item) || typeof item.itemKey !== 'string' || !item.itemKey || item.itemKey.trim() !== item.itemKey) {
    throw new Error('Invalid packing item key')
  }
  return item.itemKey
}

function sameIdentity (left, right) {
  return ['itemId', 'metaJson', 'nbtJson'].every(field => left[field] === right[field])
}

function scopedStock (rows, ownerUuid) {
  if (!Array.isArray(rows)) throw new Error('Invalid packing available items')
  const stock = new Map()
  for (const row of rows) {
    if (row?.ownerUuid !== undefined && row.ownerUuid !== ownerUuid) continue
    const key = itemKey(row)
    positiveAmount(row.amount, 'available stock')
    const existing = stock.get(key)
    if (existing) {
      if (!sameIdentity(existing, row)) throw new Error(`Conflicting packing stock identity: ${key}`)
      existing.amount = addAmounts(existing.amount, row.amount, 'available stock')
    } else {
      stock.set(key, { ...structuredClone(row), ownerUuid })
    }
  }
  return stock
}

function hasLegacyContents (value) {
  if (Array.isArray(value)) return value.some(hasLegacyContents)
  if (!isObject(value)) return false
  for (const [key, child] of Object.entries(value)) {
    if (key === 'Items' || key === 'items') {
      let contents = child
      while (isObject(contents) && Object.hasOwn(contents, 'value')) contents = contents.value
      if (!Array.isArray(contents) || contents.length) return true
    }
    if (hasLegacyContents(child)) return true
  }
  return false
}

function validateEmptyBox (box, catalog) {
  catalogItem(box, catalog)
  if (!catalog.isShulkerBox(box.itemId)) throw new Error('Packing box must be a shulker box')
  packingStackSize(box, catalog)
  const meta = metadata(box)
  const nbt = storedJson(box.nbtJson, 'NBT metadata', true)
  for (const component of meta.components || []) {
    if (component.type !== 'container') continue
    if (!isObject(component.data) || !Array.isArray(component.data.contents)) throw new Error('Invalid packing container contents metadata')
    if (component.data.contents.length) throw new Error('Packing requires empty boxes; box has contents')
  }
  if (hasLegacyContents(nbt) || hasLegacyContents(meta)) throw new Error('Packing requires empty boxes; legacy contents are present or invalid')
}

function boxCandidates (rows, stock, ownerUuid, catalog, selectedKey) {
  if (!Array.isArray(rows)) throw new Error('Invalid packing empty boxes')
  const candidates = new Map()
  for (const row of rows) {
    if (row?.ownerUuid !== undefined && row.ownerUuid !== ownerUuid) continue
    const key = itemKey(row)
    positiveAmount(row.amount, 'empty box')
    const available = stock.get(key)
    if (!available) throw new Error(`Packing box is not available for this owner: ${key}`)
    // The available snapshot supplies the actual metadata, not a caller's
    // assertion that a candidate is empty.
    validateEmptyBox(available, catalog)
    for (const field of ['itemId', 'metaJson', 'nbtJson']) {
      if (row[field] !== undefined && row[field] !== available[field]) throw new Error(`Conflicting packing box identity metadata: ${key}`)
    }
    const previous = candidates.get(key)
    const amount = previous ? addAmounts(previous.amount, row.amount, 'empty box') : row.amount
    candidates.set(key, { ...available, amount: Math.min(amount, available.amount) })
  }
  return [...candidates.values()].filter(box => selectedKey === undefined || box.itemKey === selectedKey)
}

function planPacking ({ ownerUuid, items, availableItems, emptyBoxes, catalog, boxItemKey } = {}) {
  if (typeof ownerUuid !== 'string' || !ownerUuid || ownerUuid.trim() !== ownerUuid) throw new Error('Invalid packing owner UUID')
  if (!Array.isArray(items) || !items.length) throw new Error('Packing items must be a nonempty request list')
  if (boxItemKey !== undefined && (typeof boxItemKey !== 'string' || !boxItemKey || boxItemKey.trim() !== boxItemKey)) {
    throw new Error('Invalid packing box item key')
  }
  const stock = scopedStock(availableItems, ownerUuid)
  const requested = new Map()
  let itemCount = 0
  for (const item of items) {
    const key = itemKey(item)
    positiveAmount(item.amount, 'request')
    if (item.ownerUuid !== undefined && item.ownerUuid !== ownerUuid) throw new Error('Packing request owner does not match')
    requested.set(key, addAmounts(requested.get(key) || 0, item.amount, 'requested'))
    itemCount = addAmounts(itemCount, item.amount, 'total requested')
  }
  const inputs = []
  const sizes = new Map()
  let slotCount = 0
  for (const [key, amount] of requested) {
    const available = stock.get(key)
    if (!available || available.amount < amount) throw new Error(`Insufficient available packing stock: ${key}`)
    catalogItem(available, catalog)
    if (catalog.isShulkerBox(available.itemId)) throw new Error('Nested shulker payloads cannot be packed')
    const size = packingStackSize(available, catalog)
    storedJson(available.nbtJson, 'NBT metadata', true)
    sizes.set(key, size)
    slotCount = addAmounts(slotCount, Math.ceil(amount / size), 'packing slots')
    if (slotCount > BOX_SLOTS * MAX_PACKING_BOXES) throw new Error(`Packing plan exceeds the ${MAX_PACKING_BOXES}-box budget`)
    inputs.push({ ...structuredClone(available), amount })
  }
  const candidates = boxCandidates(emptyBoxes, stock, ownerUuid, catalog, boxItemKey)
  const boxCount = Math.ceil(slotCount / BOX_SLOTS)
  const chosen = []
  for (const candidate of candidates) {
    const amount = Math.min(candidate.amount, boxCount - chosen.length)
    for (let index = 0; index < amount; index++) chosen.push({ ...structuredClone(candidate), amount: 1 })
    if (chosen.length === boxCount) break
  }
  if (chosen.length < boxCount) throw new Error(`Insufficient owned empty packing boxes: need ${boxCount}`)
  const boxes = chosen.map(box => ({ box, inputs: [], slots: [], usedSlots: 0 }))
  let batch = 0
  for (const input of inputs) {
    let remaining = input.amount
    while (remaining > 0) {
      const box = boxes[batch]
      const amount = Math.min(remaining, sizes.get(input.itemKey))
      box.slots.push({ slot: box.usedSlots, itemKey: input.itemKey, amount })
      const previous = box.inputs.at(-1)
      if (previous?.itemKey === input.itemKey) previous.amount = addAmounts(previous.amount, amount, 'box input')
      else box.inputs.push({ ...structuredClone(input), amount })
      box.usedSlots++
      remaining -= amount
      if (box.usedSlots === BOX_SLOTS) batch++
    }
  }
  const allocations = structuredClone(inputs)
  const allocatedBoxes = new Map()
  for (const box of chosen) {
    const previous = allocatedBoxes.get(box.itemKey)
    if (previous) previous.amount++
    else allocatedBoxes.set(box.itemKey, structuredClone(box))
  }
  allocations.push(...allocatedBoxes.values())
  return { ownerUuid, inputs, allocations, boxes, boxCount, itemCount }
}

module.exports = { planPacking, packingStackSize, MAX_PACKING_BOXES }

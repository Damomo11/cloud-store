'use strict'

const { createConfirmedWindowClicker } = require('../craft/confirmed-window')
const { planPacking, packingStackSize } = require('./planner')
const { isEmptySlot } = require('./protocol')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = message => Object.assign(new Error(message), { recoveryRequired: true })
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value)

function legacyContents (value) {
  if (Array.isArray(value)) return value.some(legacyContents)
  if (!object(value)) return false
  return Object.entries(value).some(([key, child]) => {
    if (key === 'Items' || key === 'items') {
      let entries = child
      while (object(entries) && Object.hasOwn(entries, 'value')) entries = entries.value
      if (!Array.isArray(entries) || entries.length) return true
    }
    return legacyContents(child)
  })
}

class PackingExecutor {
  constructor ({ bot, catalog, warehouse, config, debug = () => {} }) {
    Object.assign(this, { bot, catalog, warehouse, config, debug })
    this.active = null
  }

  isBusy () { return this.active !== null }
  cancel (reason = 'Packing cancelled') {
    if (this.active) this.active.cancelled = reason instanceof Error ? reason : new Error(String(reason))
  }

  execute (request) { return this.run(request, false) }
  recover (request) { return this.run(request, true) }

  shell (row) {
    const meta = JSON.parse(row.metaJson)
    return stable({ itemId: row.itemId, meta: { ...meta, metadata: this.catalog.normalizeItemMetadata(meta.metadata),
      components: (meta.components || []).filter(value => value.type !== 'container'), removeComponents: meta.removeComponents || null },
    nbt: this.catalog.normalizeNbtForFingerprint(row.itemId, JSON.parse(row.nbtJson)) })
  }

  // Validate before catalog normalization: it deliberately omits some invalid
  // container entries for display, which is not evidence of physical emptiness.
  contents (meta, nbt) {
    if (!object(meta) || (nbt !== null && !object(nbt)) || legacyContents(meta) || legacyContents(nbt)) throw fail('Unverifiable packing box metadata')
    if (meta.components != null && !Array.isArray(meta.components)) throw fail('Invalid packing box components')
    if (meta.removeComponents?.length) throw fail('Removed packing box components are unsupported')
    const components = meta.components || []
    if (components.some(value => !object(value) || typeof value.type !== 'string') || new Set(components.map(value => value.type)).size !== components.length) throw fail('Invalid packing box components')
    const container = components.find(value => value.type === 'container')
    if (!container) return []
    const entries = container.data?.contents
    if (!Array.isArray(entries) || entries.length > 27) throw fail('Invalid packing box contents')
    return entries.flatMap(entry => {
      if (isEmptySlot(entry)) return []
      if (!object(entry) || !Number.isSafeInteger(entry.itemCount ?? entry.count) || (entry.itemCount ?? entry.count) <= 0 ||
        entry.removeComponents?.length || (entry.components !== undefined && !Array.isArray(entry.components))) throw fail('Invalid packing box entry')
      const value = this.catalog.fromContainerEntry(entry)
      if (!value || this.catalog.isShulkerBox(value.itemId) || value.amount > packingStackSize(value, this.catalog)) throw fail('Invalid or nested packing box entry')
      return [value]
    })
  }

  normalized (value) {
    if (!value || !Number.isSafeInteger(value.count) || value.count <= 0 || !this.catalog.mcData.items[value.type]) throw fail('Invalid packing physical item')
    if (this.catalog.isShulkerBox(`minecraft:${value.name}`)) this.contents({ components: value.components, removeComponents: value.removedComponents }, value.nbt || null)
    const row = this.catalog.fromPrismarineItem(value)
    if (row.amount > packingStackSize(row, this.catalog)) throw fail('Packing physical stack exceeds capacity')
    return row
  }

  totals (rows) {
    const result = new Map()
    for (const row of rows) {
      const amount = (result.get(row.itemKey) || 0) + row.amount
      if (!Number.isSafeInteger(amount) || amount <= 0) throw fail('Invalid packing amount')
      result.set(row.itemKey, amount)
    }
    return result
  }

  sameTotals (left, right) {
    const a = this.totals(left)
    const b = this.totals(right)
    return a.size === b.size && [...a].every(([key, amount]) => b.get(key) === amount)
  }

  playerState (slots, box, inputs) {
    const rows = slots.filter(Boolean).map(value => this.normalized(value))
    const boxes = rows.filter(value => this.catalog.isShulkerBox(value.itemId))
    if (boxes.length !== 1 || boxes[0].amount !== 1 || this.shell(boxes[0]) !== this.shell(box)) throw fail('Packing requires one exact held box shell')
    const loose = rows.filter(value => !this.catalog.isShulkerBox(value.itemId))
    const allowed = this.totals(inputs)
    for (const [key, amount] of this.totals(loose)) if (!allowed.has(key) || amount > allowed.get(key)) throw fail('Unexpected packing player inventory')
    return { product: boxes[0], loose }
  }

  async run ({ box, inputs, signal, check: callerCheck = () => {} } = {}, recovering) {
    if (this.isBusy()) throw fail('Packing executor is busy')
    const lease = { cancelled: null }
    this.active = lease
    const check = () => {
      if (lease.cancelled) throw lease.cancelled
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Packing aborted')
      callerCheck()
    }
    const { bot, catalog, warehouse } = this
    const click = createConfirmedWindowClicker(bot, catalog, this.config, this.debug, { allowPacking: true })
    let window = null
    let opening = false
    let closed = false
    let removeOpeningListeners = () => {}
    try {
      check()
      if (!click) throw fail('Packing requires authoritative stateId window support')
      box = structuredClone(box)
      inputs = structuredClone(inputs)
      if (!Array.isArray(inputs) || !inputs.length || box?.amount !== 1) throw fail('Invalid packing batch')
      if (new Set(inputs.map(row => row.itemKey)).size !== inputs.length) throw fail('Packing inputs must have unique exact identities')
      for (const row of [box, ...inputs]) {
        if (catalog.canonicalizeStoredItem(row).itemKey !== row.itemKey) throw fail('Noncanonical packing input identity')
      }
      const plan = planPacking({ ownerUuid: 'packing-executor', items: inputs.map(({ itemKey, amount }) => ({ itemKey, amount })),
        availableItems: [box, ...inputs].map(row => ({ ...row, ownerUuid: 'packing-executor' })),
        emptyBoxes: [{ ...box, ownerUuid: 'packing-executor' }], catalog })
      if (plan.boxCount !== 1) throw fail('Packing batch exceeds one box')
      if (bot.currentWindow) throw fail('Packing requires a closed player inventory')
      if (bot.inventory.selectedItem) throw fail('Packing requires an empty cursor')
      const outside = bot.inventory.slots.filter((value, slot) => (slot < 9 || slot >= 45) && value)
      if (outside.length) throw fail('Packing requires no foreign inventory slots')
      const local = this.playerState(bot.inventory.slots.slice(9, 45), box, inputs)
      if (!recovering && (local.product.itemKey !== box.itemKey || !this.sameTotals(local.loose, inputs))) throw fail('Packing inventory does not match exact inputs and empty box')

      const Item = require('prismarine-item')(bot.registry || catalog.mcData)
      const timeout = Math.max(1, Number(this.config?.craft?.confirmTimeoutMs) || 5000)
      let opened = null
      let initial = null
      let decodeError = null
      const onOpen = packet => {
        opened = { id: packet.windowId ?? packet.containerId, type: packet.inventoryType ?? packet.type ?? packet.menuType }
        initial = null
      }
      const onContent = packet => {
        if (!opened || (packet.windowId ?? packet.containerId) !== opened.id) return
        try {
          const raw = packet.items ?? packet.slots
          if (!Array.isArray(raw) || raw.length !== 63 || !Object.hasOwn(packet, 'carriedItem')) return
          const decode = raw => {
            if (!object(raw) || (bot.registry.supportFeature('itemsWithComponents')
              ? !Number.isSafeInteger(raw.itemCount) || raw.itemCount < 0 || (raw.itemCount === 0 && !isEmptySlot(raw))
              : typeof raw.present !== 'boolean')) throw fail('Invalid initial packing slot')
            const value = Item.fromNotch(raw)
            if (value) this.normalized(value)
            return value
          }
          initial = { slots: raw.map(decode), carried: decode(packet.carriedItem) }
        } catch (error) { decodeError = error }
      }
      for (const name of ['open_window', 'open_screen']) bot._client.on(name, onOpen)
      for (const name of ['window_items', 'container_set_content']) bot._client.on(name, onContent)
      removeOpeningListeners = () => {
        for (const name of ['open_window', 'open_screen']) bot._client.removeListener(name, onOpen)
        for (const name of ['window_items', 'container_set_content']) bot._client.removeListener(name, onContent)
      }
      check()
      opening = true
      window = await warehouse.openQuickShulkerWindow(local.product.itemKey)
      check()
      if (window !== bot.currentWindow || !warehouse.isQuickShulkerWindow(window) || window.type !== 'minecraft:shulker_box' ||
        window.inventoryStart !== 27 || window.inventoryEnd !== 63 || window.slots.length !== 63) throw fail('Invalid packing shulker window')
      const expires = Date.now() + timeout
      while (!initial) {
        check()
        if (decodeError) throw decodeError
        if (Date.now() >= expires) throw fail('Server did not confirm initial packing window and cursor')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      check()
      if (decodeError) throw decodeError
      const type = require('prismarine-windows')(bot.registry || catalog.mcData).createWindow(opened.id, opened.type, '')?.type
      if (opened.id !== window.id || type !== 'minecraft:shulker_box' || bot.currentWindow !== window) throw fail('Packing menu does not belong to this open')
      removeOpeningListeners()
      if (initial.carried) throw fail('Packing server cursor is not empty')
      const state = this.playerState(initial.slots.slice(27), box, inputs)
      const packed = initial.slots.slice(0, 27).filter(Boolean).map(value => this.normalized(value))
      if (!this.sameTotals([...packed, ...state.loose], inputs)) throw fail('Packing server inventory conservation failed')
      if (!recovering && (packed.length || state.product.itemKey !== box.itemKey)) throw fail('Packing target is not the exact empty box')
      initial.slots.forEach((value, slot) => window.updateSlot(slot, value))
      window.selectedItem = null

      if (!recovering) {
        for (let slot = 27; slot < 63; slot++) {
          check()
          const source = window.slots[slot]
          if (!source || catalog.isShulkerBox(`minecraft:${source.name}`)) continue
          const input = this.normalized(source)
          const before = window.slots.map(value => value ? this.normalized(value) : null)
          const accept = (slots, carried) => {
            if (carried) return false
            const after = slots.map(value => value ? this.normalized(value) : null)
            const rest = after[slot]
            if (rest && rest.itemKey !== input.itemKey) return false
            const moved = input.amount - (rest?.amount || 0)
            if (moved <= 0) return false
            for (let i = 27; i < 63; i++) {
              if (i === slot) continue
              const a = before[i]
              const b = after[i]
              if (a && catalog.isShulkerBox(a.itemId)) {
                if (!b || b.amount !== 1 || this.shell(a) !== this.shell(b)) return false
              } else if (a?.itemKey !== b?.itemKey || a?.amount !== b?.amount) return false
            }
            // Every container slot, including slot zero, must only gain this
            // fingerprint. Moving or mutating other contents is never accepted.
            let increase = 0
            for (let i = 0; i < 27; i++) {
              const a = before[i]
              const b = after[i]
              if (a?.itemKey === b?.itemKey && a?.amount === b?.amount) continue
              if (!b || b.itemKey !== input.itemKey || (a && a.itemKey !== input.itemKey) || b.amount < (a?.amount || 0)) return false
              increase += b.amount - (a?.amount || 0)
            }
            return increase === moved
          }
          await click(window, slot, 0, 1, check, accept)
          check()
          if (window.slots[slot]) throw fail('Server only partially shifted a packing stack')
        }
      }
      const expectedPacked = window.slots.slice(0, 27).filter(Boolean).map(value => this.normalized(value))
      const expectedLoose = this.playerState(window.slots.slice(27), box, inputs).loose
      if (!this.sameTotals([...expectedPacked, ...expectedLoose], inputs) || (!recovering && expectedLoose.length)) throw fail('Packing final menu contents mismatch')
      check()
      const confirmed = await click.close(window)
      closed = true
      check()
      if (!confirmed || bot.currentWindow || bot.inventory.selectedItem) throw fail('Server did not confirm packing close and cursor')
      if (bot.inventory.slots.some((value, slot) => value && (slot < 9 || slot >= 45))) throw fail('Unexpected post-close packing inventory slots')
      const final = this.playerState(bot.inventory.slots.slice(9, 45), box, inputs)
      const actual = this.contents(JSON.parse(final.product.metaJson), JSON.parse(final.product.nbtJson))
      if (!this.sameTotals(actual, expectedPacked) || !this.sameTotals(final.loose, expectedLoose)) throw fail('Post-close packing box metadata or loose inputs mismatch')
      const counts = this.totals(actual)
      const remaining = this.totals(final.loose)
      const packedInputs = inputs.filter(row => counts.has(row.itemKey)).map(row => ({ ...row, amount: counts.get(row.itemKey) }))
      const result = { product: { ...final.product, amount: 1 }, packedInputs }
      if (recovering) result.remainingInputs = inputs.filter(row => remaining.has(row.itemKey)).map(row => ({ ...row, amount: remaining.get(row.itemKey) }))
      return result
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      error.recoveryRequired = true
      if (click && opening && !closed) {
        try { await click.close(window || bot.currentWindow || bot.inventory) } catch { /* Preserve original failure. */ }
      }
      throw error
    } finally {
      removeOpeningListeners()
      this.active = null
    }
  }
}

module.exports = { PackingExecutor }

'use strict'

const { isDeepStrictEqual } = require('node:util')
const { serialize, deserialize } = require('node:v8')
const { shortKey } = require('../traceLog')
const { isEmptySlot } = require('../packing/protocol')

// Scoped to crafting. Modern menu clicks do not acknowledge correctly predicted
// input/cursor changes. A mismatched stateId still applies the click, then makes
// Vanilla/Paper send the complete authoritative menu, including carriedItem.
// Send no speculative changedSlots (1.21.11 uses hashed slots on this packet).
function createConfirmedWindowClicker (bot, catalog, config, emitDebug = () => {}, options = {}) {
  if (!bot.supportFeature?.('stateIdUsed') || typeof bot._client?.write !== 'function') return null
  const registry = bot.registry || catalog.mcData
  const Item = require('prismarine-item')(registry)
  const emptyClickCursor = registry.version['>=']('1.21.5') ? null : Item.toNotch(null)
  const copy = (value, count = value?.count) => {
    if (!value || !count) return null
    const result = new Item(value.type, count, value.metadata, value.nbt)
    if (value.components) result.components = structuredClone(value.components)
    if (value.removedComponents) result.removedComponents = structuredClone(value.removedComponents)
    return result
  }
  const equal = (a, b) => !a || !b
    ? !a && !b
    : a.count === b.count && catalog.fromPrismarineItem(a).itemKey === catalog.fromPrismarineItem(b).itemKey
  const sameItem = (a, b) => a && b && catalog.fromPrismarineItem(a).itemKey === catalog.fromPrismarineItem(b).itemKey
  const failure = message => Object.assign(new Error(message), { recoveryRequired: true })
  const debug = (event, details) => {
    try { emitDebug(event, typeof details === 'function' ? details() : details) } catch { /* Logging cannot affect window confirmation. */ }
  }
  const summarize = item => {
    if (!item) return null
    const value = catalog.fromPrismarineItem(item)
    return { itemId: value.itemId, amount: item.count, fingerprint: shortKey(value.itemKey) }
  }
  // Packing cannot interpret malformed protocol slots as empty. Keep this
  // stricter decode opt-in so ordinary crafting callers retain their contract.
  const decode = raw => {
    if (options.allowPacking && (!raw || typeof raw !== 'object' ||
      (registry.supportFeature('itemsWithComponents')
        ? !Number.isSafeInteger(raw.itemCount) || raw.itemCount < 0 || (raw.itemCount === 0 && !isEmptySlot(raw))
        : typeof raw.present !== 'boolean'))) throw failure('invalid packing protocol slot')
    const value = Item.fromNotch(raw)
    if (options.allowPacking && value && (!registry.items[value.type] || !Number.isSafeInteger(value.count) || value.count <= 0)) {
      throw failure('invalid packing item')
    }
    return value
  }
  const windowId = packet => packet.windowId ?? packet.containerId
  const incrementalListeners = (window, snapshot, invalidate) => {
    // A repeated value does not supersede a complete server snapshot. Changed,
    // malformed or unrepresented values still require a fresh full response.
    const compare = (raw, select) => {
      const current = snapshot()
      if (!current) return
      try {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
          (registry.supportFeature('itemsWithComponents')
            ? !Number.isSafeInteger(raw.itemCount) || raw.itemCount < 0 || (raw.itemCount === 0 && !isEmptySlot(raw))
            : typeof raw.present !== 'boolean')) throw new Error('invalid slot')
        const expected = select(current)
        if (expected === undefined || !isDeepStrictEqual(raw, expected)) invalidate()
      } catch { invalidate() }
    }
    const playerSlot = slot => window === bot.inventory ? slot
      : Number.isInteger(slot) && slot >= 9 && slot < 45 ? window.inventoryStart + slot - 9 : -1
    // Direct inventory packets use vanilla Inventory indices, unlike menu slots.
    const inventorySlot = slot => !Number.isInteger(slot) || slot < 0 || slot > 40 ? -1
      : slot < 9 ? slot + 36 : slot < 36 ? slot : slot < 40 ? 44 - slot : 45
    const compareSlot = (raw, slot) => compare(raw, current =>
      Number.isInteger(slot) && slot >= 0 && slot < current.rawSlots.length ? current.rawSlots[slot] : undefined)
    const onSlot = packet => {
      const id = windowId(packet)
      if (id === -1 || id === 255) {
        if (packet.slot !== -1) invalidate()
        else compare(packet.item, current => current.rawCarried)
      } else if (id === window.id) compareSlot(packet.item, packet.slot)
      else if (id === 0) compareSlot(packet.item, playerSlot(packet.slot))
      else if (id === -2 || id === 254) compareSlot(packet.item, playerSlot(inventorySlot(packet.slot)))
    }
    const onCursor = packet => compare(packet.contents, current => current.rawCarried)
    return [
      ['set_slot', onSlot], ['container_set_slot', onSlot],
      ['set_cursor_item', onCursor], ['container_set_cursor_item', onCursor],
      ['set_player_inventory', packet => compareSlot(packet.contents, playerSlot(inventorySlot(packet.slotId)))]
    ]
  }

  const click = async function (window, slot, mouseButton, mode, check, accept) {
    check()
    const allowed = window.type?.match(/^minecraft:(inventory|crafting)$/) ||
      (options.allowContainer && window.type?.match(/^minecraft:generic_9x[1-6]$/) && mode === 1 &&
        window.inventoryEnd - window.inventoryStart === 36 && window.slots.length === window.inventoryEnd) ||
      (options.allowPacking && window.type === 'minecraft:shulker_box' && mode === 1 &&
        window.inventoryStart === 27 && window.inventoryEnd === 63 && window.slots.length === 63)
    if (![bot.inventory, bot.currentWindow].includes(window) || !allowed) {
      throw failure('confirmed craft click lost its inventory window')
    }
    const expected = window.slots.map(value => copy(value))
    let cursor = copy(window.selectedItem)
    const value = expected[slot]
    if (mode === 0) {
      if (mouseButton === 0) {
        if (sameItem(cursor, value)) {
          const moved = Math.min(value.stackSize - value.count, cursor.count)
          expected[slot] = copy(value, value.count + moved)
          cursor = copy(cursor, cursor.count - moved)
        } else {
          expected[slot] = cursor
          cursor = value
        }
      } else if (!cursor) {
        cursor = copy(value, Math.ceil((value?.count || 0) / 2))
        expected[slot] = copy(value, Math.floor((value?.count || 0) / 2))
      } else if (!value || sameItem(cursor, value)) {
        const moved = !value || value.count < value.stackSize ? 1 : 0
        expected[slot] = copy(cursor, (value?.count || 0) + moved)
        cursor = copy(cursor, cursor.count - moved)
      } else {
        expected[slot] = cursor
        cursor = value
      }
    } else if (mode !== 1 || !accept) {
      throw failure('confirmed craft shift-click requires an expected server state')
    }
    const timeoutMs = Math.max(1, Number(config?.craft?.confirmTimeoutMs) || 5000)
    debug('executor.window_confirmation_start', { windowId: window.id, slot, mouseButton, mode, timeoutMs })
    const startedAt = performance.now()
    let responseCount = 0
    let incompleteResponseCount = 0
    let rejectedResponseCount = 0
    let firstResponseMs = null
    let confirmationMs = null
    let lastRejected = null
    const diagnostics = () => {
      let lastMismatch = null
      if (lastRejected) {
        if (mode === 1) lastMismatch = { reason: 'shift_state', stateId: lastRejected.stateId }
        else if (!equal(cursor, lastRejected.carried)) {
          lastMismatch = { reason: 'cursor', expected: summarize(cursor), observed: summarize(lastRejected.carried) }
        } else {
          const index = expected.findIndex((value, index) => index !== 0 && !equal(value, lastRejected.slots[index]))
          if (index >= 0) lastMismatch = { reason: 'slot', slot: index, expected: summarize(expected[index]), observed: summarize(lastRejected.slots[index]) }
        }
      }
      return { windowId: window.id, slot, mouseButton, mode, timeoutMs,
        elapsedMs: performance.now() - startedAt, firstResponseMs, confirmationMs,
        responseCount, incompleteResponseCount, rejectedResponseCount, lastMismatch }
    }
    let confirmed = null
    let decodeError = null
    let wakeConfirmation = null
    const wake = () => {
      if (!wakeConfirmation) return
      const resolve = wakeConfirmation
      wakeConfirmation = null
      resolve()
    }
    const invalidate = () => { confirmed = null }
    const onContent = packet => {
      if (windowId(packet) !== window.id) {
        if (windowId(packet) === 0) invalidate()
        return
      }
      // Only the latest relevant response may authorize mirroring state. A
      // later rejected/incomplete response must not leave an old acceptance.
      invalidate()
      decodeError = null
      responseCount++
      firstResponseMs ??= performance.now() - startedAt
      const raw = packet.items ?? packet.slots
      if (!Array.isArray(raw) || raw.length !== window.slots.length || !Object.hasOwn(packet, 'carriedItem')) {
        incompleteResponseCount++
        return
      }
      try {
        const slots = raw.map(decode)
        const carried = decode(packet.carriedItem)
        const matches = mode === 1
          ? accept(slots, carried)
          : equal(cursor, carried) && expected.every((value, index) => index === 0 || equal(value, slots[index]))
        if (matches) {
          confirmed = { slots, carried, stateId: packet.stateId,
            rawSlots: deserialize(serialize(raw)), rawCarried: deserialize(serialize(packet.carriedItem)) }
          confirmationMs ??= performance.now() - startedAt
        } else {
          rejectedResponseCount++
          lastRejected = { slots, carried, stateId: packet.stateId }
        }
      } catch (cause) { decodeError = cause }
      if (confirmed || decodeError) wake()
    }
    const listeners = [
      ['window_items', onContent], ['container_set_content', onContent],
      ...incrementalListeners(window, () => confirmed, invalidate)
    ]
    for (const [name, listener] of listeners) bot._client.on(name, listener)
    const expires = Date.now() + timeoutMs
    try {
      bot._client.write('window_click', { windowId: window.id, stateId: -1, slot, mouseButton, mode,
        changedSlots: [], cursorItem: emptyClickCursor })
      while (!confirmed) {
        // Packing cancellation stops the next transfer, but first drains this
        // sent click through its response/timeout before a recovery close.
        if (!options.allowPacking) check()
        if (decodeError) throw failure(`cannot decode confirmed craft window: ${decodeError.message}`)
        if (Date.now() >= expires) {
          debug('executor.window_confirmation_timeout', diagnostics)
          throw failure('server did not confirm the craft window click and cursor')
        }
        await new Promise(resolve => {
          const timer = setTimeout(() => {
            wakeConfirmation = null
            resolve()
          }, Math.min(5, Math.max(1, expires - Date.now())))
          wakeConfirmation = () => {
            clearTimeout(timer)
            wakeConfirmation = null
            resolve()
          }
          if (confirmed || decodeError) wake()
        })
      }
      check()
      if ((bot.currentWindow || bot.inventory) !== window) throw failure('craft window closed before server confirmation')
      // Mineflayer's content listener updates slots, but not carriedItem. Also
      // mirror the table's 36 player slots so final verification sees real data.
      confirmed.slots.forEach((value, index) => window.updateSlot(index, copy(value)))
      window.selectedItem = copy(confirmed.carried)
      if (window !== bot.inventory) {
        for (let index = 0; index < 36; index++) bot.inventory.updateSlot(9 + index, copy(confirmed.slots[window.inventoryStart + index]))
      }
      debug('executor.window_click_confirmed', () => ({ ...diagnostics(), stateId: confirmed.stateId }))
    } catch (cause) {
      debug('executor.window_confirmation_failure', () => ({ ...diagnostics(), message: cause?.message || String(cause) }))
      throw cause
    } finally {
      for (const [name, listener] of listeners) bot._client.removeListener(name, listener)
    }
  }

  // Close does not guarantee a content/cursor packet. A PICKUP at slot -1 is a
  // valid no-op, even with a carried item (-999 is the drop slot). Request a
  // full player menu after close so recovery never parks a stale local cursor.
  click.close = window => new Promise(resolve => {
    const startedAt = performance.now()
    let responseCount = 0
    let finished = false
    let confirmed = false
    let snapshot = null
    let timer
    const invalidate = () => { confirmed = false; snapshot = null }
    const finish = accepted => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      for (const [name, listener] of listeners) bot._client.removeListener(name, listener)
      debug('executor.window_close_confirmed', { windowId: window.id, confirmed: accepted, elapsedMs: performance.now() - startedAt, responseCount })
      resolve(accepted)
    }
    const content = packet => {
      if (windowId(packet) !== 0) return
      invalidate()
      responseCount++
      const slots = packet.items ?? packet.slots
      if (!Array.isArray(slots) || slots.length !== bot.inventory.slots.length || !Object.hasOwn(packet, 'carriedItem')) return
      try {
        const decoded = slots.map(decode)
        const carried = decode(packet.carriedItem)
        decoded.forEach((value, slot) => bot.inventory.updateSlot(slot, copy(value)))
        window.selectedItem = copy(carried)
        bot.inventory.selectedItem = copy(carried)
        confirmed = !carried && !decoded.slice(0, 5).some(Boolean)
        if (confirmed) snapshot = { rawSlots: deserialize(serialize(slots)), rawCarried: deserialize(serialize(packet.carriedItem)) }
        // Keep observing the rest of this response burst before resolving.
        if (confirmed) queueMicrotask(() => { if (confirmed) finish(true) })
      } catch { /* Recovery must reread an undecodable window. */ }
    }
    const listeners = [
      ['window_items', content], ['container_set_content', content],
      ...incrementalListeners(bot.inventory, () => snapshot, invalidate)
    ]
    for (const [name, listener] of listeners) bot._client.on(name, listener)
    timer = setTimeout(() => finish(false), Math.max(1, Number(config?.craft?.confirmTimeoutMs) || 5000))
    try {
      bot.closeWindow(window)
      bot._client.write('window_click', { windowId: 0, stateId: -1, slot: -1, mouseButton: 0, mode: 0,
        changedSlots: [], cursorItem: emptyClickCursor })
    } catch { finish(false) }
  })
  return click
}

module.exports = { createConfirmedWindowClicker }

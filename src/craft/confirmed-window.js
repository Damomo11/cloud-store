'use strict'

const { shortKey } = require('../traceLog')

// Scoped to crafting. Modern menu clicks do not acknowledge correctly predicted
// input/cursor changes. A mismatched stateId still applies the click, then makes
// Vanilla/Paper send the complete authoritative menu, including carriedItem.
// Send no speculative changedSlots (1.21.11 uses hashed slots on this packet).
function createConfirmedWindowClicker (bot, catalog, config, emitDebug = () => {}) {
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

  const click = async function (window, slot, mouseButton, mode, check, accept) {
    check()
    if (![bot.inventory, bot.currentWindow].includes(window) || !window.type?.match(/^minecraft:(inventory|crafting)$/)) {
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
    const onContent = packet => {
      if ((packet.windowId ?? packet.containerId) !== window.id) return
      responseCount++
      firstResponseMs ??= performance.now() - startedAt
      const raw = packet.items ?? packet.slots
      if (!Array.isArray(raw) || raw.length !== window.slots.length || !Object.hasOwn(packet, 'carriedItem')) {
        incompleteResponseCount++
        return
      }
      try {
        const slots = raw.map(value => Item.fromNotch(value))
        const carried = Item.fromNotch(packet.carriedItem)
        const matches = mode === 1
          ? accept(slots, carried)
          : equal(cursor, carried) && expected.every((value, index) => index === 0 || equal(value, slots[index]))
        if (matches) {
          confirmed = { slots, carried, stateId: packet.stateId }
          confirmationMs ??= performance.now() - startedAt
        } else {
          rejectedResponseCount++
          lastRejected = { slots, carried, stateId: packet.stateId }
        }
      } catch (cause) { decodeError = cause }
      if (confirmed || decodeError) wake()
    }
    const listeners = ['window_items', 'container_set_content']
    for (const name of listeners) bot._client.on(name, onContent)
    const expires = Date.now() + timeoutMs
    try {
      bot._client.write('window_click', { windowId: window.id, stateId: -1, slot, mouseButton, mode,
        changedSlots: [], cursorItem: emptyClickCursor })
      while (!confirmed) {
        check()
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
      for (const name of listeners) bot._client.removeListener(name, onContent)
    }
  }

  // Close does not guarantee a content/cursor packet. A PICKUP at slot -1 is a
  // valid no-op, even with a carried item (-999 is the drop slot). Request a
  // full player menu after close so recovery never parks a stale local cursor.
  click.close = window => new Promise(resolve => {
    const startedAt = performance.now()
    let responseCount = 0
    let finished = false
    let timer
    const listeners = ['window_items', 'container_set_content']
    const finish = confirmed => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      for (const name of listeners) bot._client.removeListener(name, content)
      debug('executor.window_close_confirmed', { windowId: window.id, confirmed, elapsedMs: performance.now() - startedAt, responseCount })
      resolve(confirmed)
    }
    const content = packet => {
      if ((packet.windowId ?? packet.containerId) !== 0) return
      responseCount++
      const slots = packet.items ?? packet.slots
      if (!Array.isArray(slots) || slots.length !== bot.inventory.slots.length || !Object.hasOwn(packet, 'carriedItem')) return
      try {
        const decoded = slots.map(value => Item.fromNotch(value))
        const carried = Item.fromNotch(packet.carriedItem)
        decoded.forEach((value, slot) => bot.inventory.updateSlot(slot, copy(value)))
        window.selectedItem = copy(carried)
        bot.inventory.selectedItem = copy(carried)
        if (!carried && !decoded.slice(0, 5).some(Boolean)) finish(true)
      } catch { /* Recovery must reread an undecodable window. */ }
    }
    for (const name of listeners) bot._client.on(name, content)
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

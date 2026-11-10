'use strict'

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
    let confirmed = null
    let decodeError = null
    const onContent = packet => {
      if ((packet.windowId ?? packet.containerId) !== window.id) return
      const raw = packet.items ?? packet.slots
      if (!Array.isArray(raw) || raw.length !== window.slots.length || !Object.hasOwn(packet, 'carriedItem')) return
      try {
        const slots = raw.map(value => Item.fromNotch(value))
        const carried = Item.fromNotch(packet.carriedItem)
        const matches = mode === 1
          ? accept(slots, carried)
          : equal(cursor, carried) && expected.every((value, index) => index === 0 || equal(value, slots[index]))
        if (matches) confirmed = { slots, carried, stateId: packet.stateId }
      } catch (cause) { decodeError = cause }
    }
    const listeners = ['window_items', 'container_set_content']
    for (const name of listeners) bot._client.on(name, onContent)
    const expires = Date.now() + Math.max(1, Number(config?.craft?.confirmTimeoutMs) || 5000)
    try {
      bot._client.write('window_click', { windowId: window.id, stateId: -1, slot, mouseButton, mode,
        changedSlots: [], cursorItem: emptyClickCursor })
      while (!confirmed) {
        check()
        if (decodeError) throw failure(`cannot decode confirmed craft window: ${decodeError.message}`)
        if (Date.now() >= expires) {
          emitDebug('executor.window_confirmation_timeout', { windowId: window.id, slot, mouseButton, mode })
          throw failure('server did not confirm the craft window click and cursor')
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(5, Math.max(1, expires - Date.now()))))
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
      emitDebug('executor.window_click_confirmed', { windowId: window.id, slot, mouseButton, mode, stateId: confirmed.stateId })
    } finally {
      for (const name of listeners) bot._client.removeListener(name, onContent)
    }
  }

  // Close does not guarantee a content/cursor packet. A PICKUP at slot -1 is a
  // valid no-op, even with a carried item (-999 is the drop slot). Request a
  // full player menu after close so recovery never parks a stale local cursor.
  click.close = window => new Promise(resolve => {
    let finished = false
    let timer
    const listeners = ['window_items', 'container_set_content']
    const finish = confirmed => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      for (const name of listeners) bot._client.removeListener(name, content)
      emitDebug('executor.window_close_confirmed', { windowId: window.id, confirmed })
      resolve(confirmed)
    }
    const content = packet => {
      if ((packet.windowId ?? packet.containerId) !== 0) return
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

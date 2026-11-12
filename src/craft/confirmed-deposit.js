'use strict'

const { createConfirmedWindowClicker } = require('./confirmed-window')

// Used only by crafting's strict return-to-storage path. Each shift requests
// its own authoritative menu; ordinary warehouse deposits keep their adapter.
function createConfirmedDepositor (warehouse, check = () => {}, container) {
  if (!container?.type?.match(/^minecraft:generic_9x[1-6]$/) ||
    container.inventoryEnd - container.inventoryStart !== 36 || container.slots?.length !== container.inventoryEnd) return null
  const { bot, catalog, config } = warehouse
  const click = createConfirmedWindowClicker(bot, catalog, config, undefined, { allowContainer: true })
  if (!click) return null
  const normalized = value => value ? { itemKey: catalog.fromPrismarineItem(value).itemKey, amount: value.count } : null
  const equal = (a, b) => a?.itemKey === b?.itemKey && a?.amount === b?.amount
  return async (window, item) => {
    check()
    const key = catalog.fromPrismarineItem(item).itemKey
    const free = warehouse.containerFreeSpaceFor(window, key, item)
    if (free <= 0) return 0
    const slot = item.windowSlot
    const before = window.slots.map(normalized)
    const source = before[slot]
    if (!Number.isInteger(slot) || slot < window.inventoryStart || slot >= window.inventoryEnd || source?.itemKey !== key) return 0
    let moved = 0
    try {
      if (window.selectedItem) throw new Error('craft deposit started with a nonempty cursor')
      await click(window, slot, 0, 1, check, (slots, cursor) => {
        if (cursor) return false
        const after = slots.map(normalized)
        if (after[slot] && after[slot].itemKey !== key) return false
        const decrease = source.amount - (after[slot]?.amount || 0)
        if (decrease <= 0 || decrease > Math.min(free, source.amount)) return false
        for (let index = window.inventoryStart; index < window.inventoryEnd; index++) {
          if (index !== slot && !equal(before[index], after[index])) return false
        }
        let increase = 0
        for (let index = 0; index < window.inventoryStart; index++) {
          const a = before[index]
          const b = after[index]
          if (equal(a, b)) continue
          if ((a && a.itemKey !== key) || !b || b.itemKey !== key || b.amount < (a?.amount || 0)) return false
          increase += b.amount - (a?.amount || 0)
        }
        if (increase !== decrease) return false
        moved = decrease
        return true
      })
      return moved
    } catch (error) {
      error.uncertainTransfer = true
      throw error
    }
  }
}

module.exports = { createConfirmedDepositor }

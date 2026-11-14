'use strict'

function positionOf (group) {
  const slot = (group?.slots || []).find(row =>
    Number.isFinite(Number(row?.x)) && Number.isFinite(Number(row?.y)) && Number.isFinite(Number(row?.z)))
  return slot ? { x: Number(slot.x), y: Number(slot.y), z: Number(slot.z) } : null
}

function distanceSquared (from, to) {
  if (!from || !to) return Number.POSITIVE_INFINITY
  const dx = from.x - to.x
  const dy = from.y - to.y
  const dz = from.z - to.z
  return (dx * dx) + (dy * dy) + (dz * dz)
}

function planCraftChestRoute (entries, origin = null) {
  const byChest = new Map()
  for (const entry of entries || []) {
    const chestId = String(entry?.group?.chestId ?? '')
    if (!chestId) continue
    let group = byChest.get(chestId)
    if (!group) {
      group = {
        chestId,
        recordedAmount: 0,
        slots: [],
        entries: [],
        position: positionOf(entry.group)
      }
      byChest.set(chestId, group)
    }
    group.recordedAmount += Number(entry.group.recordedAmount) || 0
    group.slots.push(...(entry.group.slots || []))
    group.entries.push(entry)
  }

  const pending = [...byChest.values()]
  const route = []
  let current = Number.isFinite(Number(origin?.x)) && Number.isFinite(Number(origin?.y)) && Number.isFinite(Number(origin?.z))
    ? { x: Number(origin.x), y: Number(origin.y), z: Number(origin.z) }
    : null
  while (pending.length) {
    pending.sort((left, right) => {
      const distance = distanceSquared(current, left.position) - distanceSquared(current, right.position)
      return distance || left.chestId.localeCompare(right.chestId)
    })
    const next = pending.shift()
    next.entries.sort((left, right) => {
      const itemKey = String(left.allocation?.itemKey || '').localeCompare(String(right.allocation?.itemKey || ''))
      return itemKey || Number(left.group?.slots?.[0]?.slot ?? 0) - Number(right.group?.slots?.[0]?.slot ?? 0)
    })
    route.push(next)
    current = next.position || current
  }
  return route
}

module.exports = { planCraftChestRoute }

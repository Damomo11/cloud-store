'use strict'

const { serialize, deserialize } = require('node:v8')
const { isDeepStrictEqual } = require('node:util')
const { isEmptySlot } = require('../packing/protocol')

function sameSnapshotSlots (left = [], right = []) {
  const normalize = values => values
    .map(value => [Number(value.slot), String(value.itemKey), Number(value.amount)])
    .sort((a, b) => a[0] - b[0])
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

function sameSnapshotItems (left = [], right = []) {
  const normalize = values => values
    .map(value => [String(value.itemKey), Number(value.amount)])
    .sort((a, b) => a[0].localeCompare(b[0]))
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

// A craft batch may reuse an already opened barrel only when all evidence still
// describes the same server-owned state. Mineflayer mirrors the open window's
// player slots to bot.inventory only on close, so its unchanged opening view is
// also valid while the window itself matches the latest full server snapshot.
function canReuseCraftWindow ({ expectedRevision, currentRevision, bot, container, serverSnapshot, localSnapshot, initialBotPlayerItems }) {
  if (expectedRevision !== currentRevision || !bot || bot.currentWindow !== container) return false
  if (!container || container.selectedItem || bot.inventory?.selectedItem) return false
  if (bot.inventory?.slots?.slice(0, 5).some(Boolean)) return false
  if (!serverSnapshot || serverSnapshot.cursorEmpty !== true || !localSnapshot) return false
  if (!sameSnapshotSlots(serverSnapshot.chestSlots, localSnapshot.chestSlots) ||
      !sameSnapshotItems(serverSnapshot.playerItems, localSnapshot.playerItems)) return false
  if (localSnapshot.botPlayerItems && !sameSnapshotItems(serverSnapshot.playerItems, localSnapshot.botPlayerItems) &&
      (!initialBotPlayerItems || !sameSnapshotItems(initialBotPlayerItems, localSnapshot.botPlayerItems))) return false
  return true
}

function currentRevision (warehouse, chestId) {
  return warehouse?.warehouseState?.chestRevisions?.get(String(chestId)) || 0
}

function containerSnapshot (container, catalog, bot) {
  const start = Number(container?.inventoryStart)
  const end = Number(container?.inventoryEnd)
  if (!Array.isArray(container?.slots) || !Number.isInteger(start) || !Number.isInteger(end)) return null
  const chestSlots = []
  for (let slot = 0; slot < start; slot++) {
    const item = container.slots[slot]
    if (!item) continue
    const normalized = catalog.fromPrismarineItem(item)
    chestSlots.push({ ...normalized, slot, amount: item.count })
  }
  const playerItems = catalog.aggregatePrismarineItems(container.slots.slice(start, end).filter(Boolean))
  return {
    chestSlots,
    playerItems,
    botPlayerItems: typeof bot?.inventory?.items === 'function'
      ? catalog.aggregatePrismarineItems(bot.inventory.items())
      : null,
    cursorEmpty: !container.selectedItem && !bot?.inventory?.selectedItem
  }
}

function repeatsPlayerState (packet, rawSlots, rawCarried, container) {
  const start = container?.inventoryStart
  const end = container?.inventoryEnd
  const items = packet?.items ?? packet?.slots
  if (!Number.isInteger(start) || start <= 0 || end - start !== 36 || rawSlots?.length !== end ||
      !Array.isArray(items) || items.length !== 46 || !sameModernSlot(packet.carriedItem, rawCarried)) return false
  // Window 0 also contains the crafting grid, equipment and offhand. The
  // barrel does not describe those slots, so accept only an empty extra area.
  for (let slot = 0; slot < items.length; slot++) {
    const item = items[slot]
    if (slot < 9 || slot === 45) {
      if (!isEmptySlot(item)) return false
    } else if (!sameModernSlot(item, rawSlots[start + slot - 9])) return false
  }
  return true
}

function validModernSlot (item) {
  return !!item && typeof item === 'object' && !Array.isArray(item) &&
    Number.isSafeInteger(item.itemCount) && item.itemCount >= 0 &&
    (item.itemCount !== 0 || isEmptySlot(item))
}

function sameModernSlot (item, expected) {
  return validModernSlot(item) && isDeepStrictEqual(item, expected)
}

async function openServerContainer (warehouse, chest, catalog, bot, options = {}) {
  const client = bot._client
  if (typeof client?.on !== 'function' || typeof client?.removeListener !== 'function') {
    throw new Error('缺少服务端容器快照观察。')
  }
  const registry = bot.registry || catalog.mcData
  const Item = require('prismarine-item')(registry)
  const opened = new Set()
  const packets = []
  const revision = currentRevision(warehouse, chest.chestId)
  const keepEvidence = options.keepEvidence === true
  const validateOffhand = options.validateOffhand === true
  let openingPackets = keepEvidence ? [] : null
  let lastInvalidation
  let failureReason = 'open_failed'
  let latest = null
  let decodeError = null
  let disposed = false
  let openingOffhand = null
  let offhandMismatch = false
  const windowId = packet => packet?.windowId ?? packet?.containerId
  let inventoryStart = null
  let inventoryEnd = null
  const emptySlot = () => registry.supportFeature('itemsWithComponents') ? { itemCount: 0 } : { present: false }
  const decodePacket = packet => {
    if (!Array.isArray(packet?.items) || !Number.isInteger(inventoryStart) || !Number.isInteger(inventoryEnd) ||
      packet.items.length !== inventoryEnd || !Object.hasOwn(packet, 'carriedItem')) return null
    const carried = Item.fromNotch(packet.carriedItem)
    const chestSlots = packet.items.slice(0, inventoryStart).map((value, slot) => {
      const item = Item.fromNotch(value)
      return item ? { ...catalog.fromPrismarineItem(item), slot, amount: item.count } : null
    }).filter(Boolean)
    const player = packet.items.slice(inventoryStart, inventoryEnd).map(value => Item.fromNotch(value)).filter(Boolean)
    return {
      chestSlots,
      playerItems: catalog.aggregatePrismarineItems(player),
      cursorEmpty: !carried,
      stateId: packet.stateId
    }
  }
  const onOpen = packet => {
    opened.clear()
    packets.length = 0
    latest = null
    decodeError = null
    offhandMismatch = false
    if (validateOffhand) {
      const slots = bot.inventory?.slots
      const current = Array.isArray(slots) && slots.length > 45 ? slots[45] : null
      openingOffhand = Array.isArray(slots) && slots.length > 45
        ? current ? Item.toNotch(current) : emptySlot()
        : null
    } else openingOffhand = null
    if (Number.isInteger(windowId(packet))) opened.add(windowId(packet))
  }
  const invalidate = () => {
    latest = null
    decodeError = null
    packets.length = 0
  }
  const onItems = packet => {
    const id = windowId(packet)
    const items = packet?.items ?? packet?.slots
    if (validateOffhand && id === 0 && Array.isArray(items) && items.length === 46 &&
        (!openingOffhand || !matchesExpected(items[45], openingOffhand))) offhandMismatch = true
    if (keepEvidence && id === 0) {
      const full = packets.at(-1)
      if (inventoryEnd === null && registry.supportFeature('itemsWithComponents') && full &&
          full.windowId === bot.currentWindow?.id && isEmptySlot(full.carriedItem) &&
          repeatsPlayerState(packet, full.items, full.carriedItem, bot.currentWindow)) return
      invalidate()
    }
    if (!opened.has(id)) return
    invalidate()
    if (Array.isArray(items)) {
      const copy = deserialize(serialize({ ...packet, windowId: windowId(packet), items }))
      packets.push(copy)
      try {
        const decoded = decodePacket(copy)
        if (decoded) latest = decoded
      } catch (error) {
        decodeError = error
      }
    }
  }
  // Opening can emit its full packet before openContainerAt resolves. Compare
  // against that saved packet as well as during a retained window's lifetime.
  const validRawSlot = raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    return registry.supportFeature('itemsWithComponents') ? validModernSlot(raw) : typeof raw.present === 'boolean'
  }
  const matchesExpected = (raw, expected) => validRawSlot(raw) && expected !== undefined &&
    isDeepStrictEqual(raw, expected)
  const compare = (raw, select) => {
    const full = packets.at(-1)
    if (!full || !matchesExpected(raw, select(full))) return invalidate()
  }
  const compareOffhand = raw => {
    if (!openingOffhand || !matchesExpected(raw, openingOffhand)) {
      offhandMismatch = true
      invalidate()
    }
  }
  const slotValue = (full, slot) => Number.isInteger(slot) && slot >= 0 && slot < full.items.length ? full.items[slot] : undefined
  const playerSlotValue = (full, slot) => {
    const start = full.items.length - 36
    return start > 0 && Number.isInteger(slot) && slot >= 9 && slot < 45 ? slotValue(full, start + slot - 9) : undefined
  }
  const inventorySlot = slot => !Number.isInteger(slot) || slot < 0 || slot > 40 ? -1
    : slot < 9 ? slot + 36 : slot < 36 ? slot : slot < 40 ? 44 - slot : 45
  const onSlot = packet => {
    const id = windowId(packet)
    if (id === -1 || id === 255) {
      if (packet.slot !== -1) invalidate()
      else compare(packet.item, full => full.carriedItem)
    } else if (opened.has(id)) compare(packet.item, full => slotValue(full, packet.slot))
    else if (id === 0 && packet.slot === 45 && validateOffhand) compareOffhand(packet.item)
    else if (id === 0 && packet.slot === 45 && isEmptySlot(packet.item)) return
    else if (id === 0) compare(packet.item, full => playerSlotValue(full, packet.slot))
    else if (id === -2 || id === 254) {
      const slot = inventorySlot(packet.slot)
      if (slot === 45 && validateOffhand) compareOffhand(packet.item)
      else compare(packet.item, full => playerSlotValue(full, slot))
    }
  }
  const onCursor = packet => compare(packet.contents, full => full.carriedItem)
  const onPlayerInventory = packet => {
    const slot = inventorySlot(packet.slotId)
    if (slot === 45 && validateOffhand) compareOffhand(packet.contents)
    else compare(packet.contents, full => playerSlotValue(full, slot))
  }
  const listeners = [
    ['open_window', onOpen], ['open_screen', onOpen],
    ['window_items', onItems], ['container_set_content', onItems],
    ['set_slot', onSlot], ['container_set_slot', onSlot],
    ['set_cursor_item', onCursor], ['container_set_cursor_item', onCursor],
    ['set_player_inventory', onPlayerInventory]
  ].map(([event, handler]) => [event, packet => {
    if (!openingPackets) return handler(packet)
    const previous = packets.at(-1)
    handler(packet)
    const items = packet?.items ?? packet?.slots
    const metadata = {
      event,
      windowId: windowId(packet),
      stateId: packet?.stateId,
      slot: packet?.slot ?? packet?.slotId,
      slotCount: Array.isArray(items) ? items.length : undefined
    }
    if (previous && !packets.length) {
      metadata.invalidated = true
      lastInvalidation = {
        ...metadata,
        previousContent: { windowId: previous.windowId, stateId: previous.stateId, slotCount: previous.items.length }
      }
    }
    openingPackets.push(metadata)
    if (openingPackets.length > 12) openingPackets.shift()
  }])
  for (const [event, listener] of listeners) client.on(event, listener)
  let container
  let handedOff = false
  try {
    container = await warehouse.openContainerAt(chest)
    const start = container?.inventoryStart
    const end = container?.inventoryEnd
    inventoryStart = start
    inventoryEnd = end
    const packet = packets.findLast(value => value.windowId === container?.id)
    failureReason = !Number.isInteger(start) || !Number.isInteger(end) || end - start !== 36 ? 'invalid_inventory_bounds'
      : !packet ? 'no_current_content'
        : packet.items.length !== end ? 'slot_count_mismatch'
          : bot.currentWindow !== container ? 'window_changed' : null
    if (failureReason) throw new Error('没有收到当前容器完整的服务端快照。')
    failureReason = 'missing_cursor'
    if (!Object.hasOwn(packet, 'carriedItem')) throw new Error('服务端容器快照缺少光标状态。')
    failureReason = 'invalid_snapshot'
    let chestSlots
    let playerItems
    try {
      const decoded = decodePacket(packet)
      if (!decoded) throw new Error('服务端容器快照结构不完整。')
      if (!decoded.cursorEmpty) throw new Error('服务端光标仍持有物品。')
      latest = decoded
      chestSlots = decoded.chestSlots
      playerItems = decoded.playerItems
    } catch (error) {
      throw new Error(`无法解码服务端容器快照：${error.message}`)
    }
    if (decodeError) throw new Error(`无法持续解码服务端容器快照：${decodeError.message}`)
    if (offhandMismatch) {
      failureReason = 'offhand_changed'
      throw new Error('开窗期间副手状态发生变化。')
    }
    if (validateOffhand && !openingOffhand) {
      failureReason = 'offhand_baseline_unavailable'
      throw new Error('开窗时无法确认副手状态。')
    }
    failureReason = 'local_snapshot_failed'
    const initialBotPlayerItems = keepEvidence ? containerSnapshot(container, catalog, bot)?.botPlayerItems : null
    const evidence = {
      revision,
      windowId: container.id,
      current: () => latest,
      isReusable: () => !disposed && canReuseCraftWindow({
        expectedRevision: revision,
        currentRevision: currentRevision(warehouse, chest.chestId),
        bot,
        container,
        serverSnapshot: decodeError ? null : latest,
        localSnapshot: containerSnapshot(container, catalog, bot),
        initialBotPlayerItems
      }) && (!validateOffhand || !offhandMismatch),
      dispose: () => {
        if (disposed) return
        disposed = true
        for (const [event, listener] of listeners) client.removeListener(event, listener)
      }
    }
    if (!keepEvidence) {
      evidence.dispose()
      return { container, chestSlots, playerItems, evidence: null }
    }
    handedOff = true
    openingPackets = null
    lastInvalidation = null
    return { container, chestSlots, playerItems, evidence }
  } catch (error) {
    if (openingPackets && Object.isExtensible(error)) {
      const diagnostics = {
        reason: failureReason,
        chestId: chest.chestId,
        version: client.version ?? bot.version,
        protocolVersion: client.protocolVersion ?? registry.version?.version,
        windowId: container?.id,
        currentWindowId: bot.currentWindow?.id ?? null,
        isCurrentWindow: !!container && bot.currentWindow === container,
        inventoryStart,
        expectedSlotCount: inventoryEnd,
        receivedSlotCount: packets.findLast(value => value.windowId === container?.id)?.items.length,
        offhandValidationEnabled: validateOffhand,
        offhandBaselineAvailable: !validateOffhand || !!openingOffhand,
        offhandMismatch,
        lastInvalidation,
        packets: openingPackets
      }
      try { error.containerSnapshot = diagnostics } catch { /* Keep the original failure and cleanup. */ }
    }
    if (container && bot.currentWindow === container) warehouse.closeContainerQuietly(container)
    throw error
  } finally {
    if (!handedOff) {
      for (const [event, listener] of listeners) client.removeListener(event, listener)
    }
  }
}

async function readServerContainer (warehouse, chest, catalog, bot, options = {}) {
  const snapshot = await openServerContainer(warehouse, chest, catalog, bot, options)
  try {
    warehouse.closeContainerQuietly(snapshot.container)
  } finally {
    snapshot.evidence?.dispose()
  }
  return snapshot
}

module.exports = {
  canReuseCraftWindow,
  repeatsPlayerState,
  snapshotCraftWindow: containerSnapshot,
  openServerContainer,
  readServerContainer
}

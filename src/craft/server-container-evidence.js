'use strict'

const { serialize, deserialize } = require('node:v8')

async function openServerContainer (warehouse, chest, catalog, bot) {
  const client = bot._client
  if (typeof client?.on !== 'function' || typeof client?.removeListener !== 'function') {
    throw new Error('缺少服务端容器快照观察。')
  }
  const Item = require('prismarine-item')(bot.registry || catalog.mcData)
  const opened = new Set()
  const packets = []
  const windowId = packet => packet?.windowId ?? packet?.containerId
  const onOpen = packet => {
    opened.clear()
    packets.length = 0
    if (Number.isInteger(windowId(packet))) opened.add(windowId(packet))
  }
  const onItems = packet => {
    const items = packet?.items ?? packet?.slots
    if (opened.has(windowId(packet)) && Array.isArray(items)) packets.push(deserialize(serialize({ ...packet, windowId: windowId(packet), items })))
  }
  for (const event of ['open_window', 'open_screen']) client.on(event, onOpen)
  for (const event of ['window_items', 'container_set_content']) client.on(event, onItems)
  let container
  try {
    container = await warehouse.openContainerAt(chest)
    const start = container?.inventoryStart
    const end = container?.inventoryEnd
    const packet = packets.findLast(value => value.windowId === container?.id && value.items.length === end)
    if (!Number.isInteger(start) || !Number.isInteger(end) || end - start !== 36 || !packet || bot.currentWindow !== container) {
      throw new Error('没有收到当前容器完整的服务端快照。')
    }
    if (!Object.hasOwn(packet, 'carriedItem')) throw new Error('服务端容器快照缺少光标状态。')
    let chestSlots
    let playerItems
    try {
      if (Item.fromNotch(packet.carriedItem)) throw new Error('服务端光标仍持有物品。')
      chestSlots = packet.items.slice(0, start).map((value, slot) => {
        const item = Item.fromNotch(value)
        return item ? { ...catalog.fromPrismarineItem(item), slot, amount: item.count } : null
      }).filter(Boolean)
      const player = packet.items.slice(start, end).map(value => Item.fromNotch(value))
      playerItems = catalog.aggregatePrismarineItems(player)
    } catch (error) {
      throw new Error(`无法解码服务端容器快照：${error.message}`)
    }
    return { container, chestSlots, playerItems }
  } catch (error) {
    if (container) warehouse.closeContainerQuietly(container)
    throw error
  } finally {
    for (const event of ['open_window', 'open_screen']) client.removeListener(event, onOpen)
    for (const event of ['window_items', 'container_set_content']) client.removeListener(event, onItems)
  }
}

async function readServerContainer (warehouse, chest, catalog, bot) {
  const snapshot = await openServerContainer(warehouse, chest, catalog, bot)
  warehouse.closeContainerQuietly(snapshot.container)
  return snapshot
}

module.exports = { openServerContainer, readServerContainer }

'use strict'
const { openServerContainer } = require('../craft/server-container-evidence')
const { createConfirmedDepositor } = require('../craft/confirmed-deposit')
const { createConfirmedWindowClicker } = require('../craft/confirmed-window')
const { PackingExecutor } = require('./executor')
const { isEmptySlot } = require('./protocol')

function totals (items) {
  const result = new Map()
  for (const item of items) {
    if (!item?.itemKey || !Number.isSafeInteger(item.amount) || item.amount <= 0) throw new Error('Invalid packing snapshot')
    const amount = (result.get(item.itemKey) || 0) + item.amount
    if (!Number.isSafeInteger(amount)) throw new Error('Packing snapshot overflow')
    result.set(item.itemKey, amount)
  }
  return [...result].sort(([a], [b]) => a.localeCompare(b)).map(([itemKey, amount]) => ({ itemKey, amount }))
}
const same = (a, b) => JSON.stringify(totals(a)) === JSON.stringify(totals(b))
function increase (before, after) {
  const a = new Map(totals(before).map(row => [row.itemKey, row.amount]))
  const b = new Map(totals(after).map(row => [row.itemKey, row.amount]))
  return [...new Set([...a.keys(), ...b.keys()])].flatMap(itemKey => {
    const amount = (b.get(itemKey) || 0) - (a.get(itemKey) || 0)
    if (amount < 0) throw new Error('Unexplained packing barrel delta')
    return amount ? [{ itemKey, amount }] : []
  })
}

// This helper never changes owner balances. All receipts concern only named,
// registered barrels and full authoritative player/container snapshots.
class PackingStorage {
  constructor ({ bot, db, catalog, warehouse, config }) {
    Object.assign(this, { bot, db, catalog, warehouse, config })
    this.decoder = new PackingExecutor({ bot, catalog, warehouse, config })
  }

  clicker () {
    const click = createConfirmedWindowClicker(this.bot, this.catalog, this.config, undefined, { allowContainer: true, allowPacking: true })
    if (!click) throw new Error('Packing requires authoritative container support')
    return click
  }

  inventory () {
    const { bot } = this
    if (bot.currentWindow || bot.inventory.selectedItem || bot.inventory.slots.some((value, slot) => value && (slot < 9 || slot >= 45))) {
      throw new Error('Packing requires empty cursor, grid and equipment and a closed window')
    }
    return totals(bot.inventory.slots.slice(9, 45).filter(Boolean).map(value => this.decoder.normalized(value)))
  }

  async player (check) {
    check()
    if (!await this.clicker().close(this.bot.currentWindow || this.bot.inventory)) throw new Error('Packing player inventory close was not confirmed')
    check()
    return this.inventory()
  }

  chest (chestId) {
    const chest = this.db.listChests().find(row => row.chestId === chestId)
    if (!chest) throw new Error(`Packing named barrel is no longer registered: ${chestId}`)
    return chest
  }

  async open (chest, check) {
    check()
    const Item = require('prismarine-item')(this.bot.registry || this.catalog.mcData)
    let raw
    let openedId = null
    const observeOpen = packet => { openedId = packet.windowId ?? packet.containerId; raw = null }
    const observe = packet => {
      if (openedId !== null && (packet.windowId ?? packet.containerId) === openedId) raw = structuredClone(packet)
    }
    const events = ['window_items', 'container_set_content']
    const opens = ['open_window', 'open_screen']
    for (const event of opens) this.bot._client.on(event, observeOpen)
    for (const event of events) this.bot._client.on(event, observe)
    let snapshot
    try {
      snapshot = await openServerContainer(this.warehouse, chest, this.catalog, this.bot)
      check()
      const window = snapshot.container
      if (!/^minecraft:generic_9x[1-6]$/.test(window.type) || (raw?.windowId ?? raw?.containerId) !== window.id) throw new Error('Invalid packing barrel menu')
      const decode = value => {
        if (!value || typeof value !== 'object' || (this.bot.registry.supportFeature('itemsWithComponents')
          ? !Number.isSafeInteger(value.itemCount) || value.itemCount < 0 || (value.itemCount === 0 && !isEmptySlot(value))
          : typeof value.present !== 'boolean')) throw new Error('Invalid packing raw server slot')
        const item = Item.fromNotch(value)
        if (item) this.decoder.normalized(item)
        return item
      }
      const slots = raw.items ?? raw.slots
      if (!Array.isArray(slots) || slots.length !== window.inventoryEnd || !Object.hasOwn(raw, 'carriedItem') || decode(raw.carriedItem)) throw new Error('Invalid packing server cursor or slots')
      slots.map(decode).forEach((value, slot) => window.updateSlot(slot, value))
      window.selectedItem = null
      return { container: window, chestSlots: snapshot.chestSlots, playerItems: totals(snapshot.playerItems) }
    } catch (error) {
      if (snapshot) await this.clicker().close(snapshot.container)
      throw error
    } finally {
      for (const event of events) this.bot._client.removeListener(event, observe)
      for (const event of opens) this.bot._client.removeListener(event, observeOpen)
    }
  }

  async close (snapshot, check) {
    if (!await this.clicker().close(snapshot.container)) throw new Error('Packing barrel close was not confirmed')
    check()
    const player = this.inventory()
    if (!same(player, snapshot.playerItems)) throw new Error('Packing player changed on barrel close')
    return player
  }

  async read (chestId, check, refresh = true) {
    const snapshot = await this.open(this.chest(chestId), check)
    await this.close(snapshot, check)
    if (refresh) this.db.replaceChestSlots(chestId, snapshot.chestSlots)
    return { chestId, items: totals(snapshot.chestSlots), slots: snapshot.chestSlots, player: snapshot.playerItems }
  }

  async withdrawal (operation, check) {
    const chests = []
    let player = null
    const withdrawn = []
    for (const baseline of operation.data.withdrawalIntent.chests) {
      const current = await this.read(baseline.chestId, check)
      if (player && !same(player, current.player)) throw new Error('Packing player changed while proving withdrawal')
      player = current.player
      withdrawn.push(...increase(current.items, baseline.before))
      chests.push({ chestId: baseline.chestId, after: current.items })
    }
    if (!same(withdrawn, player || [])) throw new Error('Packing withdrawal source/player conservation failed')
    return { chests, withdrawn: totals(withdrawn), inventoryAfter: player || [] }
  }

  async observeReturn (operation, check) {
    const chests = []
    const gains = []
    let player = null
    for (const baseline of operation.data.returnIntent.chests) {
      const current = await this.read(baseline.chestId, check)
      if (player && !same(player, current.player)) throw new Error('Packing player changed while proving return')
      player = current.player
      gains.push(...increase(baseline.before, current.items))
      chests.push({ chestId: baseline.chestId, after: current.items })
    }
    if (player === null) player = await this.player(check)
    if (!same([...gains, ...player], operation.data.returnIntent.returned)) throw new Error('Packing named barrels and player do not conserve the return')
    return { chests, player }
  }

  async store (operation, ledger, check) {
    // Initial intent must include a baseline before the first physical click.
    if (!operation.data.returnIntent) {
      const returned = totals(operation.data.held)
      const chests = []
      if (returned.length) {
        const chest = this.warehouse.nextDepositChest(new Set()) || this.db.listChests()[0]
        if (!chest) throw new Error('Packing has no registered destination barrel')
        const before = await this.read(chest.chestId, check)
        if (!same(before.player, returned)) throw new Error('Packing return inventory does not match held materials')
        chests.push({ chestId: chest.chestId, before: before.items })
      }
      operation = ledger.checkpoint(operation.id, 'returning', { ...operation.data, returnIntent: { chests, returned } })
    }
    let observed = await this.observeReturn(operation, check)
    const attempted = new Set()
    // Finite local candidates; no discovery or repeated no-progress barrels.
    for (let attempt = 0; observed.player.length && attempt < 11; attempt++) {
      check()
      let chestId = operation.data.returnIntent.chests.find(row => !attempted.has(row.chestId))?.chestId
      if (!chestId) {
        const chest = this.warehouse.nextDepositChest(attempted) || this.db.listChests().find(row => !attempted.has(row.chestId))
        if (!chest) break
        chestId = chest.chestId
        const before = await this.read(chestId, check)
        if (!same(before.player, observed.player)) throw new Error('Packing return player changed between destinations')
        operation = ledger.checkpoint(operation.id, 'returning', { ...operation.data, returnIntent: {
          ...operation.data.returnIntent, chests: [...operation.data.returnIntent.chests, { chestId, before: before.items }]
        } })
      }
      attempted.add(chestId)
      const snapshot = await this.open(this.chest(chestId), check)
      try {
        const prior = observed.chests.find(row => row.chestId === chestId)?.after || operation.data.returnIntent.chests.find(row => row.chestId === chestId).before
        if (!same(snapshot.chestSlots, prior) || !same(snapshot.playerItems, observed.player)) throw new Error('Packing destination/player changed before return')
        const deposit = createConfirmedDepositor(this.warehouse, check, snapshot.container)
        if (!deposit) throw new Error('Packing authoritative deposit adapter unavailable')
        const window = snapshot.container
        for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++) {
          check()
          const value = window.slots[slot]
          if (!value) continue
          value.windowSlot = slot
          await deposit(window, value)
          check()
        }
        snapshot.playerItems = totals(window.slots.slice(window.inventoryStart).filter(Boolean).map(value => this.decoder.normalized(value)))
        await this.close(snapshot, check)
      } catch (error) {
        if (this.bot.currentWindow) await this.clicker().close(snapshot.container)
        throw error
      }
      observed = await this.observeReturn(operation, check)
    }
    if (observed.player.length) throw new Error('Packing return has insufficient registered storage capacity')
    check()
    return ledger.checkpoint(operation.id, 'stored', { ...operation.data, held: [], storedProof: { chests: observed.chests, inventoryAfter: [] } })
  }
}
module.exports = { PackingStorage, totals, same, increase }

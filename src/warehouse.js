const { GoalBlock, GoalNear } = require('mineflayer-pathfinder').goals
const { Movements } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const { sleep, sumBy } = require('./utils')

class Warehouse {
  constructor (bot, db, catalog, config) {
    this.bot = bot
    this.db = db
    this.catalog = catalog
    this.config = config
    this.chestNames = new Set(config.warehouse.chestBlockNames || ['barrel'])
    this.homePosition = null
  }

  debug (message) {
    if (this.config.debug) console.log(`[warehouse] ${message}`)
  }

  async goHome (options = {}) {
    const command = this.config.commands.home
    const requireWarehouse = Boolean(options.requireWarehouse && this.db.listChests().length)
    this.bot.chat(command)

    if (requireWarehouse) {
      await this.waitUntilNearKnownWarehouse(command)
    } else {
      await sleep(this.config.timing.homeWaitMs)
    }

    this.captureHomePosition()
  }

  async waitUntilNearKnownWarehouse (command) {
    const minWaitMs = Number(this.config.timing.homeWaitMs || 3500)
    const timeoutMs = Number(this.config.timing.homeTimeoutMs || Math.max(30000, minWaitMs))
    const startedAt = Date.now()
    let lastPosition = this.bot.entity?.position ? this.describePosition(this.bot.entity.position) : '?'

    while (Date.now() - startedAt < timeoutMs) {
      if (this.isClientClosed()) {
        throw new Error(`${command} 等待过程中连接已断开，将由重连流程继续处理。`)
      }
      const pos = this.bot.entity?.position
      if (pos) lastPosition = this.describePosition(pos)
      if (Date.now() - startedAt >= minWaitMs && this.isNearKnownWarehouse()) return
      await sleep(250)
    }

    if (this.isNearKnownWarehouse()) return
    throw new Error(`${command} 后 ${timeoutMs}ms 内没有回到仓库附近，当前坐标 ${lastPosition}。请检查 home 点或服务器传送是否失败。`)
  }

  isClientClosed () {
    const client = this.bot._client
    return Boolean(client?.ended || client?.socket?.destroyed || client?.socket?._writableState?.destroyed)
  }

  captureHomePosition () {
    const pos = this.bot.entity?.position
    if (!pos) return
    this.homePosition = pos.clone()
    this.debug(`home position ${this.describePosition(this.homePosition)}`)
  }

  async goHomeIfAway () {
    if (this.isNearKnownWarehouse()) {
      this.debug('already near known warehouse, skip home command')
      return false
    }
    await this.goHome({ requireWarehouse: true })
    return true
  }

  isNearKnownWarehouse () {
    const pos = this.bot.entity?.position
    if (!pos) return false
    const radius = Number(this.config.warehouse?.homeSkipRadius || 8)
    const radiusSq = radius * radius
    for (const chest of this.db.listChests()) {
      const dx = pos.x - chest.x
      const dy = pos.y - chest.y
      const dz = pos.z - chest.z
      if ((dx * dx) + (dy * dy) + (dz * dz) <= radiusSq) return true
    }
    return false
  }

  async settleResidualToMomo () {
    const items = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    if (!items.length) return { deposited: [], leftover: [] }
    return this.depositInventoryForOwner(this.config.momoOwner, 'momo')
  }

  async depositInventoryForOwner (ownerUuid, username) {
    const before = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    if (!before.length) return { deposited: [], leftover: [] }

    const depositResult = await this.depositAllPossible()

    const after = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    this.debug(`deposit inventory result owner=${username} before=${before.reduce((sum, item) => sum + item.amount, 0)} after=${after.reduce((sum, item) => sum + item.amount, 0)}`)
    const afterByKey = new Map(after.map(item => [item.itemKey, item.amount]))
    const deposited = []

    for (const item of before) {
      const left = afterByKey.get(item.itemKey) || 0
      const amount = item.amount - left
      if (amount > 0) deposited.push({ ...item, amount })
    }

    if (deposited.length) {
      this.db.addBalanceItems(ownerUuid, deposited)
      const status = after.length ? 'partial' : 'ok'
      const message = after.length
        ? `leftover_items=${after.length}, leftover_amount=${after.reduce((sum, item) => sum + item.amount, 0)}`
        : ''
      this.db.addTransaction('deposit', status, ownerUuid, username, deposited, message)
    }

    return { deposited, leftover: after, stopReason: depositResult.stopReason || '' }
  }

  async depositInventoryWithoutBalance (type = 'recovery', message = '') {
    const before = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    if (!before.length) return { deposited: [], leftover: [] }

    const depositResult = await this.depositAllPossible()

    const after = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    this.debug(`deposit inventory without balance result type=${type} before=${before.reduce((sum, item) => sum + item.amount, 0)} after=${after.reduce((sum, item) => sum + item.amount, 0)}`)
    const afterByKey = new Map(after.map(item => [item.itemKey, item.amount]))
    const deposited = []

    for (const item of before) {
      const left = afterByKey.get(item.itemKey) || 0
      const amount = item.amount - left
      if (amount > 0) deposited.push({ ...item, amount })
    }

    if (deposited.length) {
      this.db.addTransaction(type, 'ok', this.config.momoOwner, 'recovery', deposited, message)
    }

    return { deposited, leftover: after, stopReason: depositResult.stopReason || '' }
  }

  async depositAllPossible () {
    const chests = this.db.listChests()
    if (!chests.length) {
      throw new Error('没有已登记的箱子，请管理员先执行 !同步仓库 半径')
    }

    const skippedNoProgress = new Set()
    const maxEmptyAttempts = Number.isInteger(this.config.warehouse?.maxEmptyDepositAttempts)
      ? this.config.warehouse.maxEmptyDepositAttempts
      : 3
    const maxFullAttempts = Number.isInteger(this.config.warehouse?.maxFullDepositAttempts)
      ? this.config.warehouse.maxFullDepositAttempts
      : 8
    let emptyAttempts = 0
    let fullAttempts = 0
    let stopReason = ''

    while (this.bot.inventory.items().length) {
      const chest = this.nextDepositChest(skippedNoProgress, {
        allowEmpty: emptyAttempts < maxEmptyAttempts,
        allowFull: fullAttempts < maxFullAttempts
      })
      if (!chest) {
        stopReason = `没有本地记录可用的入库木桶；已尝试空槽木桶 ${emptyAttempts} 个、满记录木桶 ${fullAttempts} 个。请管理员执行 !同步 后再试。`
        this.debug('deposit no local candidate chest left')
        break
      }

      const emptyOnlyCandidate = chest.sameItemFree <= 0
      const fullRecordCandidate = chest.sameItemFree <= 0 && chest.emptySlots <= 0
      const container = await this.openContainerAt(chest)
      let movedInChest = 0
      try {
        let progress = true
        while (progress && this.bot.inventory.items().length) {
          progress = false
          const items = [...this.bot.inventory.items()]
          for (const item of items) {
            const moved = await this.tryDepositInto(container, item)
            if (moved > 0) {
              progress = true
              movedInChest += moved
              this.debug(`deposited ${moved} ${item.name} into ${this.describeChest(chest)}`)
              await sleep(this.config.timing.containerSettleMs)
            }
          }
        }
        this.refreshChestSnapshot(chest, container)
      } finally {
        container.close()
      }

      if (movedInChest <= 0) {
        skippedNoProgress.add(chest.chestId)
        if (fullRecordCandidate) fullAttempts++
        else if (emptyOnlyCandidate) emptyAttempts++
      } else {
        skippedNoProgress.clear()
        emptyAttempts = 0
        fullAttempts = 0
      }
    }

    return { stopReason }
  }

  nextDepositChest (skipped = new Set(), options = {}) {
    const containerSlots = this.config.warehouse?.containerSlots || 27
    const inventorySpace = this.currentDepositSpaceByItemKey()
    if (!inventorySpace.size) return null

    const chestRows = this.db.listChestSlots()
    const chests = new Map()
    for (const row of chestRows) {
      let chest = chests.get(row.chestId)
      if (!chest) {
        chest = {
          chestId: row.chestId,
          x: row.x,
          y: row.y,
          z: row.z,
          blockName: row.blockName,
          usedSlots: new Set(),
          sameItemFree: 0
        }
        chests.set(row.chestId, chest)
      }
      if (row.slot === null || row.slot === undefined || row.slot < 0 || row.slot >= containerSlots) continue
      chest.usedSlots.add(row.slot)
      const info = inventorySpace.get(row.itemKey)
      if (info) {
        chest.sameItemFree += Math.max(0, info.stackSize - Number(row.amount || 0))
      }
    }

    const candidates = [...chests.values()]
      .filter(chest => !skipped.has(chest.chestId))
      .map(chest => {
        const emptySlots = Math.max(0, containerSlots - chest.usedSlots.size)
        return {
          ...chest,
          emptySlots,
          score: chest.sameItemFree > 0 ? 1000000 + chest.sameItemFree : emptySlots
        }
      })
      .filter(chest => chest.sameItemFree > 0 || chest.emptySlots > 0)
    const fullRecordCandidates = [...chests.values()]
      .filter(chest => !skipped.has(chest.chestId))
      .map(chest => {
        const emptySlots = Math.max(0, containerSlots - chest.usedSlots.size)
        return { ...chest, emptySlots, score: 0 }
      })
      .filter(chest => chest.sameItemFree <= 0 && chest.emptySlots <= 0)

    const sameItemCandidates = candidates.filter(chest => chest.sameItemFree > 0)
    const candidatePool = sameItemCandidates.length
      ? sameItemCandidates
      : (options.allowEmpty !== false && candidates.some(chest => chest.emptySlots > 0)
          ? candidates.filter(chest => chest.emptySlots > 0)
          : (options.allowFull ? fullRecordCandidates : []))

    const best = candidatePool
      .sort((a, b) => b.score - a.score || b.sameItemFree - a.sameItemFree || b.emptySlots - a.emptySlots || a.chestId.localeCompare(b.chestId))[0] || null
    if (best) {
      this.debug(`deposit candidate ${this.describeChest(best)} sameFree=${best.sameItemFree} emptySlots=${best.emptySlots}`)
    }
    return best
  }

  currentDepositSpaceByItemKey () {
    const map = new Map()
    for (const item of this.bot.inventory.items()) {
      const normalized = this.catalog.fromPrismarineItem(item)
      const stackSize = item.stackSize || this.catalog.getStackSize(`minecraft:${item.name}`)
      const existing = map.get(normalized.itemKey)
      if (existing) {
        existing.amount += item.count
        existing.stackSize = Math.max(existing.stackSize, stackSize)
      } else {
        map.set(normalized.itemKey, { itemKey: normalized.itemKey, stackSize, amount: item.count })
      }
    }
    return map
  }

  async tryDepositInto (container, item) {
    const normalized = this.catalog.fromPrismarineItem(item)
    const free = this.containerFreeSpaceFor(container, normalized.itemKey, item)
    if (free <= 0) {
      this.debug(`deposit no actual space for ${item.name} key=${normalized.itemKey}`)
      return 0
    }

    const before = this.inventoryCountByItemKey(normalized.itemKey)
    const windowSlot = this.windowSlotFromBotInventorySlot(container, item.slot)
    if (windowSlot === null) return 0

    try {
      await this.bot.clickWindow(windowSlot, 0, 1)
      await sleep(this.config.timing.containerSettleMs)
      const after = this.inventoryCountByItemKey(normalized.itemKey)
      return Math.max(0, before - after)
    } catch (error) {
      this.debug(`deposit exact slot ${item.name}@${item.slot} failed: ${error.message}`)
      return 0
    }
  }

  inventoryCountByItemKey (itemKey) {
    let total = 0
    for (const item of this.bot.inventory.items()) {
      const normalized = this.catalog.fromPrismarineItem(item)
      if (normalized.itemKey === itemKey) total += item.count
    }
    return total
  }

  containerFreeSpaceFor (container, itemKey, inventoryItem) {
    const stackSize = inventoryItem.stackSize || this.catalog.getStackSize(`minecraft:${inventoryItem.name}`)
    let free = 0

    for (let slot = 0; slot < this.expectedContainerSlots(); slot++) {
      const item = container.slots[slot]
      if (!item) {
        free += stackSize
        continue
      }
      const normalized = this.catalog.fromPrismarineItem(item)
      if (normalized.itemKey === itemKey) {
        free += Math.max(0, (item.stackSize || stackSize) - item.count)
      }
    }

    return free
  }

  windowSlotFromBotInventorySlot (window, botInventorySlot) {
    if (!Number.isInteger(botInventorySlot)) return null
    const offset = window.inventoryStart - this.bot.inventory.inventoryStart
    const slot = botInventorySlot + offset
    if (slot < window.inventoryStart || slot >= window.inventoryEnd) return null
    return slot
  }

  firstEmptyWindowInventorySlot (window) {
    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++) {
      if (!window.slots[slot]) return slot
    }
    return null
  }

  async withdrawAllocations (allocations) {
    const withdrawn = []
    const missing = []

    for (const allocation of allocations) {
      let remaining = allocation.amount
      const itemInfo = this.db.getItemByKey(allocation.itemKey)
      if (!itemInfo) {
        missing.push({ ...allocation })
        continue
      }

      const slots = this.db.listSlotsForItemKey(allocation.itemKey)
      const chestGroups = this.groupSlotsForWithdrawal(slots)
      this.debug(`withdraw plan ${itemInfo.displayName || allocation.itemKey} need=${allocation.amount} chests=${chestGroups.map(group => `${group.chestId}:${group.recordedAmount}`).join(' | ') || 'none'}`)

      for (const group of chestGroups) {
        if (remaining <= 0) break
        const slot = group.slots[0]
        const chestId = group.chestId
        const chest = { chestId, x: slot.x, y: slot.y, z: slot.z, blockName: slot.blockName }
        const container = await this.openContainerAt(chest)
        try {
          this.debug(`window slots container=0..${container.inventoryStart - 1} inventory=${container.inventoryStart}..${container.inventoryEnd - 1}`)
          const available = this.countContainerItem(container, allocation.itemKey)
          const toTake = Math.min(remaining, available)
          this.debug(`withdraw open ${this.describeChest(chest)} recorded=${group.recordedAmount} actual=${available} need=${remaining}`)
          const moved = await this.tryWithdrawExactFrom(container, allocation.itemKey, toTake, group.slots.map(row => row.slot))
          if (moved > 0) {
            withdrawn.push({ ...itemInfo, amount: moved })
            remaining -= moved
            await sleep(this.config.timing.containerSettleMs)
            this.debug(`withdraw moved ${moved} ${itemInfo.displayName || allocation.itemKey} from ${this.describeChest(chest)} remaining=${remaining}`)
          }
          this.refreshChestSnapshot(chest, container)
        } finally {
          container.close()
        }
      }

      if (remaining > 0) {
        missing.push({ ...itemInfo, amount: remaining })
      }
    }

    return {
      withdrawn: this.mergeItems(withdrawn),
      missing: this.mergeItems(missing)
    }
  }

  groupSlotsForWithdrawal (slots) {
    const groups = new Map()
    for (const slot of slots) {
      let group = groups.get(slot.chestId)
      if (!group) {
        group = { chestId: slot.chestId, recordedAmount: 0, slots: [] }
        groups.set(slot.chestId, group)
      }
      group.recordedAmount += slot.amount
      group.slots.push(slot)
    }
    return [...groups.values()]
      .map(group => ({
        ...group,
        slots: group.slots.sort((a, b) => b.amount - a.amount || a.slot - b.slot)
      }))
      .sort((a, b) => b.recordedAmount - a.recordedAmount || a.chestId.localeCompare(b.chestId))
  }

  async tryWithdrawExactFrom (container, itemKey, amount, preferredSlots = []) {
    let remaining = amount
    let moved = 0
    const preferredOrder = new Map(preferredSlots.map((slot, index) => [slot, index]))

    while (remaining > 0) {
      const item = this.containerContentItems(container)
        .filter(entry => {
          const normalized = this.catalog.fromPrismarineItem(entry)
          return normalized.itemKey === itemKey
        })
        .sort((a, b) => {
          const ao = preferredOrder.has(a.slot) ? preferredOrder.get(a.slot) : Number.MAX_SAFE_INTEGER
          const bo = preferredOrder.has(b.slot) ? preferredOrder.get(b.slot) : Number.MAX_SAFE_INTEGER
          return ao - bo || b.count - a.count || a.slot - b.slot
        })[0]
      if (!item) break

      const before = this.windowInventoryCountByItemKey(container, itemKey)
      try {
        if (item.count <= remaining) {
          await this.moveContainerSlotToInventory(container, item.slot)
        } else {
          await this.movePartialContainerSlotToInventory(container, item.slot, remaining)
        }
        await this.waitForWindowInventoryIncrease(container, itemKey, before)
      } catch (error) {
        this.debug(`withdraw exact slot ${item.slot} failed: ${error.message}`)
        break
      }

      const after = this.windowInventoryCountByItemKey(container, itemKey)
      const delta = Math.max(0, after - before)
      if (delta <= 0) {
        this.debug(`withdraw no movement slot=${item.slot} count=${item.count} before=${before} after=${after} mode=${item.count <= remaining ? 'move' : 'partial'}`)
        break
      }
      moved += delta
      remaining -= delta
    }

    return moved
  }

  windowInventoryCountByItemKey (window, itemKey) {
    let total = 0
    for (const item of window.items()) {
      const normalized = this.catalog.fromPrismarineItem(item)
      if (normalized.itemKey === itemKey) total += item.count
    }
    return total
  }

  async waitForWindowInventoryIncrease (window, itemKey, before) {
    const timeoutMs = this.config.timing.inventoryUpdateTimeoutMs || 2000
    const intervalMs = 50
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(intervalMs)
      if (this.windowInventoryCountByItemKey(window, itemKey) > before) return
    }
  }

  async moveContainerSlotToInventory (container, sourceSlot) {
    const destSlot = this.firstEmptyWindowInventorySlot(container)
    if (destSlot === null) throw new Error('机器人背包没有空槽，无法取物')

    await this.bot.clickWindow(sourceSlot, 0, 0)
    await sleep(this.config.timing.containerSettleMs)
    await this.bot.clickWindow(destSlot, 0, 0)
  }

  async movePartialContainerSlotToInventory (container, sourceSlot, count) {
    const destSlot = this.firstEmptyWindowInventorySlot(container)
    if (destSlot === null) throw new Error('机器人背包没有空槽，无法拆分取物')

    await this.bot.clickWindow(sourceSlot, 0, 0)
    for (let i = 0; i < count; i++) {
      await this.bot.clickWindow(destSlot, 1, 0)
    }
    await this.bot.clickWindow(sourceSlot, 0, 0)
  }

  countContainerItem (container, itemKey) {
    let total = 0
    for (const item of this.containerContentItems(container)) {
      const normalized = this.catalog.fromPrismarineItem(item)
      if (normalized.itemKey === itemKey) total += item.count
    }
    return total
  }

  refreshChestSnapshot (chest, container) {
    this.db.upsertChest(chest)
    const slots = this.containerContentItems(container).map(item => ({
      ...this.catalog.fromPrismarineItem(item),
      slot: item.slot,
      amount: item.count
    }))
    this.db.replaceChestSlots(chest.chestId, slots)
  }

  async syncWarehouse (radius) {
    this.debug(`sync start radius=${radius}`)
    await this.goHome({ requireWarehouse: this.db.listChests().length > 0 })
    const blocks = this.findContainerBlocks(radius)
    this.debug(`found ${blocks.length} openable container blocks: ${blocks.map(block => this.describeBlock(block)).join(' | ')}`)

    const actualItems = []
    const snapshots = []
    const failures = []
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]
      const chest = this.blockToChest(block)
      this.debug(`sync open ${index + 1}/${blocks.length} ${this.describeChest(chest)}`)
      let container
      try {
        container = await this.openContainerAt(chest)
        const slots = this.containerContentItems(container).map(item => ({
          ...this.catalog.fromPrismarineItem(item),
          slot: item.slot,
          amount: item.count
        }))
        snapshots.push({ chest, slots })
        actualItems.push(...slots)
        this.debug(`sync read ${this.describeChest(chest)} slots=${slots.length} items=${slots.reduce((sum, item) => sum + item.amount, 0)}`)
      } catch (error) {
        const failure = `${this.describeChest(chest)} ${error.message}`
        failures.push(failure)
        console.error(`[warehouse] sync failed: ${failure}`)
      } finally {
        if (container) container.close()
      }
    }

    if (blocks.length > 0 && snapshots.length === 0) {
      throw new Error(`同步失败：找到 ${blocks.length} 个木桶，但没有成功读取任何木桶；已保留旧本地记录。请检查 home 点、权限或服务器插件 GUI。`)
    }

    this.db.clearChests()
    for (const snapshot of snapshots) {
      this.db.upsertChest(snapshot.chest)
      this.db.replaceChestSlots(snapshot.chest.chestId, snapshot.slots)
    }

    const totals = this.mergeItems(actualItems)
    const reconcile = this.db.reconcileTotalsToMomo(totals)
    this.db.addTransaction('sync', 'ok', this.config.momoOwner, 'momo', totals, `radius=${radius}, chests=${blocks.length}`)

    return {
      chestCount: blocks.length,
      openedChestCount: snapshots.length,
      failures,
      totals,
      ...reconcile
    }
  }

  findContainerBlocks (radius) {
    const positions = this.bot.findBlocks({
      matching: block => block && this.chestNames.has(block.name),
      maxDistance: radius,
      count: 4096
    })
    return positions
      .map(pos => this.bot.blockAt(pos))
      .filter(Boolean)
      .filter(block => this.shouldScanContainerBlock(block))
      .sort((a, b) => this.compareContainerScanOrder(a, b))
  }

  compareContainerScanOrder (a, b) {
    if (!this.isCylinderMode()) {
      return b.position.y - a.position.y || a.position.x - b.position.x || a.position.z - b.position.z
    }

    const axis = this.cylinderAxis()
    const home = this.homePosition || this.bot.entity?.position
    const homeAxis = home ? Math.floor(axis === 'x' ? home.x : home.z) : 0
    const aAxis = axis === 'x' ? a.position.x : a.position.z
    const bAxis = axis === 'x' ? b.position.x : b.position.z
    const axisDistance = Math.abs(aAxis - homeAxis) - Math.abs(bAxis - homeAxis)

    if (axisDistance !== 0) return axisDistance
    if (aAxis !== bAxis) return aAxis - bAxis

    const aCross = axis === 'x' ? a.position.z : a.position.x
    const bCross = axis === 'x' ? b.position.z : b.position.x
    return b.position.y - a.position.y || aCross - bCross || a.position.x - b.position.x || a.position.z - b.position.z
  }

  shouldScanContainerBlock (block) {
    if (block.name !== 'chest' && block.name !== 'trapped_chest') return true
    try {
      const type = block.getProperties?.().type
      return type !== 'right'
    } catch {
      return true
    }
  }

  blockToChest (block) {
    const { x, y, z } = block.position
    return {
      chestId: `${x},${y},${z}`,
      x,
      y,
      z,
      blockName: block.name
    }
  }

  async openContainerAt (chest) {
    this.debug(`goto ${this.describeChest(chest)} from ${this.describePosition(this.bot.entity.position)}`)
    await this.gotoForContainer(chest)
    const block = this.bot.blockAt(new Vec3(chest.x, chest.y, chest.z))
    if (!block || !this.chestNames.has(block.name)) {
      throw new Error(`找不到箱子：${chest.x},${chest.y},${chest.z}`)
    }
    const container = await this.openContainerBlock(block)
    this.warnUnexpectedContainerWindow(container, chest)
    return container
  }

  async gotoForContainer (chest) {
    if (this.isCylinderMode()) {
      const moved = await this.gotoCylinderContainerStand(chest)
      if (moved) return
    }
    await this.gotoNear(chest.x, chest.y, chest.z)
  }

  isCylinderMode () {
    const mode = String(this.config.warehouse?.layoutMode || this.config.warehouse?.mode || 'normal').toLowerCase()
    return mode === 'cylinder'
  }

  cylinderConfig () {
    return this.config.warehouse?.cylinder || {}
  }

  cylinderAxis () {
    const axis = String(this.cylinderConfig().axis || 'x').toLowerCase()
    return axis === 'z' ? 'z' : 'x'
  }

  cylinderTunnelCenter () {
    const cylinder = this.cylinderConfig()
    const configured = cylinder.tunnelCenter || cylinder.center || {}
    const home = this.homePosition || this.bot.entity?.position

    const fallback = {
      x: home ? Math.floor(home.x) : 0,
      y: home ? Math.floor(home.y) : 0,
      z: home ? Math.floor(home.z) : 0
    }

    return {
      x: this.optionalInteger(configured.x, fallback.x),
      y: this.optionalInteger(configured.y, fallback.y),
      z: this.optionalInteger(configured.z, fallback.z)
    }
  }

  optionalInteger (value, fallback) {
    if (value === undefined || value === null || value === '') return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.floor(parsed) : fallback
  }

  async gotoCylinderContainerStand (chest) {
    if (!this.bot.pathfinder) return false

    const axis = this.cylinderAxis()
    const tunnel = this.cylinderTunnelCenter()
    const stand = axis === 'x'
      ? new Vec3(chest.x, tunnel.y, tunnel.z)
      : new Vec3(tunnel.x, tunnel.y, chest.z)

    const candidates = this.getCylinderStandCandidates(stand)
    this.debug(`cylinder stand candidates for ${this.describeChest(chest)} axis=${axis}: ${candidates.map(pos => this.describeGridPosition(pos)).join(' | ') || 'none'}`)

    for (const pos of candidates) {
      try {
        await this.gotoWithMovements(new GoalBlock(pos.x, pos.y, pos.z), `cylinder stand ${this.describeGridPosition(pos)} for ${this.describeChest(chest)}`)
        return true
      } catch (error) {
        this.debug(`cylinder stand failed ${this.describeGridPosition(pos)}: ${error.message}`)
      }
    }

    return false
  }

  getCylinderStandCandidates (stand) {
    const yOffsets = this.cylinderConfig().yOffsets
    const configuredOffsets = Array.isArray(yOffsets) && yOffsets.length
      ? yOffsets.map(value => Number.parseInt(value, 10)).filter(Number.isFinite)
      : [0, -1, 1]
    const positions = []
    const seen = new Set()

    for (const dy of configuredOffsets) {
      const pos = stand.offset(0, dy, 0)
      const key = `${pos.x},${pos.y},${pos.z}`
      if (seen.has(key)) continue
      seen.add(key)
      if (this.isStandable(pos)) positions.push(pos)
    }

    const botPos = this.bot.entity.position
    return positions.sort((a, b) => {
      const da = a.offset(0.5, 0, 0.5).distanceTo(botPos)
      const db = b.offset(0.5, 0, 0.5).distanceTo(botPos)
      return da - db
    })
  }

  expectedContainerSlots () {
    return this.config.warehouse?.containerSlots || 27
  }

  containerContentItems (container) {
    const maxSlot = this.expectedContainerSlots()
    const items = typeof container.containerItems === 'function'
      ? container.containerItems()
      : container.items()
    return items.filter(item => Number.isInteger(item.slot) && item.slot >= 0 && item.slot < maxSlot)
  }

  warnUnexpectedContainerWindow (container, chest) {
    if (Number.isInteger(container.inventoryStart) && container.inventoryStart !== this.expectedContainerSlots()) {
      this.debug(`container window size ${container.inventoryStart} for ${this.describeChest(chest)}; using first ${this.expectedContainerSlots()} slots as barrel contents`)
    }
  }

  ensureSafeHandForContainerOpen () {
    if (!this.isUnsafeContainerOpenHeldItem(this.bot.heldItem)) return

    const safeSlot = this.findSafeContainerOpenHotbarSlot()
    if (safeSlot === null) {
      this.debug(`held item ${this.bot.heldItem.name} may open a server GUI, but no safe hotbar slot is available`)
      return
    }

    this.debug(`switch hotbar ${this.bot.quickBarSlot} -> ${safeSlot} before opening container; held=${this.bot.heldItem.name}`)
    this.bot.setQuickBarSlot(safeSlot)
  }

  isUnsafeContainerOpenHeldItem (item) {
    if (!item) return false
    const unsafeNames = this.config.warehouse?.containerOpenUnsafeHeldItems || ['flint']
    const itemName = String(item.name || '').replace(/^minecraft:/, '').toLowerCase()
    return unsafeNames.some(name => String(name || '').replace(/^minecraft:/, '').toLowerCase() === itemName)
  }

  findSafeContainerOpenHotbarSlot () {
    const start = this.bot.QUICK_BAR_START || 36
    let firstNonFlint = null

    for (let slot = 0; slot < 9; slot++) {
      if (slot === this.bot.quickBarSlot) continue
      const item = this.bot.inventory.slots[start + slot]
      if (!item) return slot
      if (firstNonFlint === null && !this.isUnsafeContainerOpenHeldItem(item)) {
        firstNonFlint = slot
      }
    }

    return firstNonFlint
  }

  async openContainerBlock (block) {
    const candidates = this.getContainerOpenCandidates(block)
    const errors = []

    for (const candidate of candidates) {
      const distance = this.bot.entity.position.distanceTo(candidate.position)
      const direction = this.getInteractionDirection(candidate)
      this.debug(`opening ${this.describeBlock(candidate)} distance=${distance.toFixed(2)} face=${this.describeVector(direction)}`)
      try {
        await this.lookAtBlock(candidate)
        this.ensureSafeHandForContainerOpen()
        return await this.withTimeout(
          this.bot.openContainer(candidate, direction, new Vec3(0.5, 0.5, 0.5)),
          this.config.timing.openContainerTimeoutMs || 8000,
          `打开箱子超时 ${this.describeBlock(candidate)} face=${this.describeVector(direction)}`
        )
      } catch (error) {
        errors.push(`${this.describeBlock(candidate)} face=${this.describeVector(direction)} ${error.message}`)
        this.debug(`open attempt failed: ${errors.at(-1)}`)
      }
    }

    throw new Error(errors.join(' ; '))
  }

  getContainerOpenCandidates (block) {
    const candidates = [block]
    const offsets = [
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1)
    ]

    for (const offset of offsets) {
      const other = this.bot.blockAt(block.position.plus(offset))
      if (other && other.name === block.name && this.isSameDoubleContainer(block, other)) {
        candidates.push(other)
      }
    }

    return candidates
  }

  isSameDoubleContainer (a, b) {
    try {
      const ap = a.getProperties?.() || {}
      const bp = b.getProperties?.() || {}
      return ap.facing === bp.facing && ap.type !== bp.type && ap.type !== 'single' && bp.type !== 'single'
    } catch {
      return false
    }
  }

  getInteractionDirection (block) {
    const botPos = this.bot.entity.position
    const center = block.position.offset(0.5, 0.5, 0.5)
    const dx = botPos.x - center.x
    const dz = botPos.z - center.z

    if (Math.abs(dx) >= Math.abs(dz)) {
      return new Vec3(dx >= 0 ? 1 : -1, 0, 0)
    }
    return new Vec3(0, 0, dz >= 0 ? 1 : -1)
  }

  async gotoNear (x, y, z) {
    if (!this.bot.pathfinder) return
    this.setupMovements()
    const candidates = this.getStandPositionsAround(x, y, z)
    this.debug(`stand candidates for ${x},${y},${z}: ${candidates.map(pos => this.describeGridPosition(pos)).join(' | ') || 'none'}`)

    for (const pos of candidates) {
      try {
        this.debug(`path try stand ${this.describeGridPosition(pos)} for target ${x},${y},${z}`)
        await this.gotoGoalWithRecovery(new GoalBlock(pos.x, pos.y, pos.z), `stand ${this.describeGridPosition(pos)}`)
        return
      } catch (error) {
        this.debug(`path candidate failed ${this.describeGridPosition(pos)}: ${error.message}`)
      }
    }

    this.debug(`path fallback GoalNear for ${x},${y},${z}`)
    await this.gotoGoalWithRecovery(new GoalNear(x, y, z, 2), `near ${x},${y},${z}`)
  }

  setupMovements () {
    if (!this.bot.pathfinder) return
    const movements = new Movements(this.bot)
    movements.canDig = false
    movements.allow1by1towers = false
    movements.allowParkour = false
    movements.scafoldingBlocks = []
    movements.countScaffoldingItems = () => 0
    movements.getScaffoldingItem = () => null
    this.bot.pathfinder.setMovements(movements)
  }

  async gotoWithMovements (goal, label) {
    this.setupMovements()
    await this.gotoGoalWithRecovery(goal, label)
  }

  getStandPositionsAround (x, y, z) {
    const offsets = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
      [2, 0], [-2, 0], [0, 2], [0, -2],
      [2, 1], [2, -1], [-2, 1], [-2, -1],
      [1, 2], [-1, 2], [1, -2], [-1, -2]
    ]
    const yCandidates = [y, y - 1, y + 1]
    const positions = []
    const seen = new Set()

    for (const standY of yCandidates) {
      for (const [dx, dz] of offsets) {
        const pos = new Vec3(x + dx, standY, z + dz)
        const key = `${pos.x},${pos.y},${pos.z}`
        if (seen.has(key)) continue
        seen.add(key)
        if (this.isStandable(pos)) positions.push(pos)
      }
    }

    const botPos = this.bot.entity.position
    return positions.sort((a, b) => {
      const da = a.offset(0.5, 0, 0.5).distanceTo(botPos)
      const db = b.offset(0.5, 0, 0.5).distanceTo(botPos)
      return da - db
    })
  }

  isStandable (pos) {
    const feet = this.bot.blockAt(pos)
    const head = this.bot.blockAt(pos.offset(0, 1, 0))
    const below = this.bot.blockAt(pos.offset(0, -1, 0))
    return this.isPassable(feet) && this.isPassable(head) && this.isSupportBlock(below)
  }

  isPassable (block) {
    return !block || block.boundingBox === 'empty'
  }

  isSupportBlock (block) {
    return Boolean(block && block.boundingBox !== 'empty')
  }

  async gotoGoalWithRecovery (goal, label) {
    const timeoutMs = this.config.timing.pathTimeoutMs || 15000
    const noProgressMs = this.config.timing.pathNoProgressMs || 4000
    let timeout
    let progressTimer
    let lastPos = this.bot.entity.position.clone()
    let lastProgressAt = Date.now()

    const progressPromise = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`寻路超时 ${label}`)), timeoutMs)
      progressTimer = setInterval(() => {
        const current = this.bot.entity.position
        const moved = current.distanceTo(lastPos)
        if (moved > 0.25) {
          lastPos = current.clone()
          lastProgressAt = Date.now()
          return
        }
        if (Date.now() - lastProgressAt > noProgressMs) {
          reject(new Error(`寻路卡住 ${label} at ${this.describePosition(current)}`))
        }
      }, 500)
    })

    try {
      await Promise.race([
        this.bot.pathfinder.goto(goal),
        progressPromise
      ])
    } catch (error) {
      this.bot.pathfinder.stop()
      this.bot.clearControlStates()
      await this.unstuckStep()
      throw error
    } finally {
      clearTimeout(timeout)
      clearInterval(progressTimer)
      this.bot.clearControlStates()
    }
  }

  async unstuckStep () {
    this.debug(`unstuck step from ${this.describePosition(this.bot.entity.position)}`)
    this.bot.setControlState('back', true)
    this.bot.setControlState('jump', true)
    await sleep(350)
    this.bot.clearControlStates()
    await sleep(150)
  }

  async lookAtBlock (block) {
    const center = block.position.offset(0.5, 0.5, 0.5)
    await this.bot.lookAt(center, true)
    await sleep(100)
  }

  async withTimeout (promise, ms, message) {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  describeChest (chest) {
    return `${chest.blockName}@${chest.x},${chest.y},${chest.z}`
  }

  describeBlock (block) {
    let props = ''
    try {
      props = JSON.stringify(block.getProperties?.() || {})
    } catch {
      props = '{}'
    }
    return `${block.name}@${block.position.x},${block.position.y},${block.position.z}${props}`
  }

  describePosition (pos) {
    return `${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}`
  }

  describeGridPosition (pos) {
    return `${pos.x},${pos.y},${pos.z}`
  }

  describeVector (vec) {
    return `${vec.x},${vec.y},${vec.z}`
  }

  async collectNearbyDropsUntil (deadlineMs, shouldStop) {
    const radius = this.config.warehouse.pickupRadius || 2
    this.debug(`collect drops start radius=${radius} until=${new Date(deadlineMs).toISOString()}`)
    this.setupMovements()
    while (Date.now() < deadlineMs && !shouldStop()) {
      const entity = this.nearestDroppedItem()
      if (entity) {
        try {
          await this.gotoGoalWithRecovery(
            new GoalNear(entity.position.x, entity.position.y, entity.position.z, 1),
            `drop ${this.describePosition(entity.position)}`
          )
        } catch (error) {
          this.debug(`drop path failed: ${error.message}`)
          await sleep(250)
        }
      } else {
        await sleep(250)
      }
    }
    this.debug('collect drops end')
  }

  async waitForPickupSettle (options = {}) {
    const maxMs = Number(options.maxMs ?? this.config.timing.pickupSettleMs ?? 3500)
    const stableMs = Number(options.stableMs ?? this.config.timing.pickupStableMs ?? 700)
    const intervalMs = 100
    const startedAt = Date.now()
    let stableSince = Date.now()
    let lastSignature = this.inventorySignature()

    while (Date.now() - startedAt < maxMs) {
      await sleep(intervalMs)
      const signature = this.inventorySignature()
      const hasNearbyDrop = Boolean(this.nearestDroppedItem())
      if (signature !== lastSignature || hasNearbyDrop) {
        lastSignature = signature
        stableSince = Date.now()
        continue
      }
      if (Date.now() - stableSince >= stableMs) break
    }

    this.debug(`pickup settled inventory=${this.inventorySummaryForDebug()} nearbyDrop=${Boolean(this.nearestDroppedItem())}`)
  }

  inventorySignature () {
    return this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
      .map(item => `${item.itemKey}:${item.amount}`)
      .sort()
      .join('|')
  }

  inventorySummaryForDebug () {
    const items = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
    const total = items.reduce((sum, item) => sum + item.amount, 0)
    const held = this.bot.heldItem ? `${this.bot.heldItem.name} x${this.bot.heldItem.count}` : 'empty'
    return `${items.length} types/${total} items held=${held}`
  }

  nearestDroppedItem () {
    const botPos = this.bot.entity.position
    let best = null
    let bestDistance = Infinity
    for (const entity of Object.values(this.bot.entities)) {
      if (entity.name !== 'item') continue
      const distance = entity.position.distanceTo(botPos)
      if (distance < bestDistance && distance <= (this.config.warehouse.pickupRadius || 2)) {
        best = entity
        bestDistance = distance
      }
    }
    return best
  }

  async dropInventoryToPlayer (username) {
    const dropped = []
    if (this.bot.currentWindow) {
      this.debug(`closing open window before dropping: ${this.bot.currentWindow.type || this.bot.currentWindow.id}`)
      this.bot.closeWindow(this.bot.currentWindow)
      await sleep(150)
    }

    while (this.bot.inventory.items().length) {
      const item = this.bot.inventory.items()[0]
      const normalized = this.catalog.fromPrismarineItem(item)
      const before = this.inventoryCountByItemKey(normalized.itemKey)
      const startedAt = Date.now()
      this.debug(`drop start ${normalized.displayName} x${item.count} slot=${item.slot} to ${username}`)
      await this.lookAtPlayer(username)
      await this.dropStackFast(item)
      const moved = await this.waitForInventoryDecrease(normalized.itemKey, before)
      if (moved <= 0) {
        throw new Error(`丢出 ${normalized.displayName} 超时，背包数量没有减少。`)
      }
      dropped.push({ ...normalized, amount: moved })
      this.debug(`drop done ${normalized.displayName} x${moved} in ${Date.now() - startedAt}ms`)
      await sleep(this.config.timing.dropIntervalMs)
    }
    return this.mergeItems(dropped)
  }

  async dropStackFast (item) {
    const timeoutMs = Number(this.config.timing.dropConfirmTimeoutMs || 5000)
    try {
      // Mode 4, button 1 is the vanilla "drop entire stack from slot" action.
      await this.withTimeout(
        this.bot.clickWindow(item.slot, 1, 4),
        timeoutMs,
        `丢出物品点击超时 slot=${item.slot}`
      )
    } catch (error) {
      this.debug(`fast drop failed for ${item.name}@${item.slot}: ${error.message}; fallback tossStack`)
      await this.withTimeout(
        this.bot.tossStack(item),
        timeoutMs,
        `丢出物品超时 ${item.name} x${item.count}`
      )
    }
  }

  async waitForInventoryDecrease (itemKey, before) {
    const timeoutMs = Number(this.config.timing.dropConfirmTimeoutMs || 5000)
    const intervalMs = 100
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const after = this.inventoryCountByItemKey(itemKey)
      if (after < before) return before - after
      await sleep(intervalMs)
    }
    return Math.max(0, before - this.inventoryCountByItemKey(itemKey))
  }

  async lookAtPlayer (username) {
    const entity = this.bot.players[username]?.entity
    if (!entity) {
      this.debug(`cannot look at player ${username}: entity not found`)
      return
    }
    const target = entity.position.offset(0, 1.4, 0)
    await this.bot.lookAt(target, true)
    await sleep(100)
  }

  mergeItems (items) {
    const amounts = sumBy(items, item => item.itemKey)
    const firstByKey = new Map(items.map(item => [item.itemKey, item]))
    return [...amounts.entries()].map(([itemKey, amount]) => ({ ...firstByKey.get(itemKey), amount }))
  }
}

module.exports = Warehouse

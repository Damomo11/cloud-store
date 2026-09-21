const { GoalBlock, GoalNear } = require('mineflayer-pathfinder').goals
const { Movements } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const { sleep, sumBy } = require('./utils')
const { logLocalError } = require('./localErrorLog')
const { isFatalProtocolReadError } = require('./botConnection')

class Warehouse {
  constructor (bot, db, catalog, config, warehouseMutex = null) {
    this.bot = bot
    this.db = db
    this.catalog = catalog
    this.config = config
    this.warehouseMutex = warehouseMutex
    this.botId = String(config.server?.botName || config.server?.username || bot.username || 'bot').toLowerCase()
    this.chestNames = new Set(config.warehouse.chestBlockNames || ['barrel'])
    this.homePosition = null
    this.openingChest = null
    this.connectionAbortController = new AbortController()
    this.mutationSeq = 0
    this.chestMutationSeqs = new Map()
  }

  withWarehouseLock (fn) {
    return this.warehouseMutex ? this.warehouseMutex.run(fn) : fn()
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
    return this.withWarehouseLock(() => this.depositInventoryForOwnerLocked(ownerUuid, username))
  }

  async depositInventoryForOwnerLocked (ownerUuid, username) {
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
    return this.withWarehouseLock(() => this.depositInventoryWithoutBalanceLocked(type, message))
  }

  async depositInventoryWithoutBalanceLocked (type = 'recovery', message = '') {
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
        this.closeContainerQuietly(container)
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

    const windowSlot = this.windowSlotFromBotInventorySlot(container, item.slot)
    if (windowSlot === null) return 0
    const sourceWindowItem = container.slots?.[windowSlot] || null
    if (!sourceWindowItem) {
      this.debug(`deposit skip stale inventory slot ${item.name}@${item.slot}: window slot ${windowSlot} is empty`)
      return 0
    }
    const sourceCount = Math.max(0, Number(sourceWindowItem.count || item.count || 0))

    try {
      await this.bot.clickWindow(windowSlot, 0, 1)
      const timeoutMs = Math.max(
        Number(this.config.timing?.containerSettleMs || 0),
        Number(this.config.timing?.inventoryUpdateTimeoutMs || 2000),
        500
      )
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const currentSlotItem = container.slots?.[windowSlot] || null
        if (!currentSlotItem) return Math.min(sourceCount, free)
        const currentCount = Math.max(0, Number(currentSlotItem.count || 0))
        if (currentCount < sourceCount) return Math.min(sourceCount - currentCount, free)
        await sleep(50)
      }
      return 0
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
    return this.withWarehouseLock(() => this.withdrawAllocationsLocked(allocations))
  }

  async withdrawAllocationsLocked (allocations) {
    const withdrawn = []
    const missing = []

    for (const allocation of allocations) {
      if (allocation.withdrawMode === 'shulker_extract') {
        const result = await this.withdrawFromShulkerBoxes(allocation)
        withdrawn.push(...result.withdrawn)
        missing.push(...result.missing)
        continue
      }

      let remaining = allocation.amount
      const itemInfo = this.db.getItemByKey(allocation.itemKey)
      if (!itemInfo) {
        missing.push({ ...allocation })
        continue
      }

      const slots = this.db.listSlotsForItemKey(allocation.itemKey)
      const chestGroups = this.groupSlotsForWithdrawal(slots)
      this.debug(`withdraw plan ${itemInfo.displayName || allocation.itemKey} need=${allocation.amount} chests=${chestGroups.map(group => `${group.chestId}:${group.recordedAmount}`).join(' | ') || 'none'}`)

      // 记录说这个桶有货、实际却没取到（含整桶读空疑似卡顿）时，就地同步这一个桶的记录，
      // 然后换下一个有记录的桶接着找；这样的“缺货换桶”最多 maxMissingBarrels 次（可配置），
      // 账实相符的桶不计数。
      let missingBarrelHops = 0
      const maxMissingBarrels = Math.max(1, Number(this.config.timing?.withdrawMaxMissingBarrels ?? 5))
      for (const group of chestGroups) {
        if (remaining <= 0) break
        if (missingBarrelHops >= maxMissingBarrels) {
          this.debug(`withdraw ${itemInfo.displayName || allocation.itemKey} 缺货换桶已达上限 ${missingBarrelHops}/${maxMissingBarrels}，停止继续找桶，剩余计入缺失`)
          break
        }
        const slot = group.slots[0]
        const chestId = group.chestId
        const chest = { chestId, x: slot.x, y: slot.y, z: slot.z, blockName: slot.blockName }
        const maxReadAttempts = Math.max(1, Number(this.config.timing?.barrelEmptyRereadAttempts ?? 3))
        let container = await this.openContainerAt(chest)
        try {
          // 木桶整个读出来一个物品都没有，多半是服务器卡顿返回了空窗口，而不是真实缺货：
          // 关窗重开重读确认；重读仍为空就保留原记录并跳过该木桶，与真实缺货区分开。
          let available = 0
          let trustedRead = false
          for (let readAttempt = 1; readAttempt <= maxReadAttempts; readAttempt++) {
            available = this.countContainerItem(container, allocation.itemKey)
            const totalInChest = this.containerContentItems(container).reduce((sum, item) => sum + Number(item.count || 0), 0)
            if (totalInChest > 0) {
              trustedRead = true
              break
            }
            this.debug(`withdraw empty window read attempt=${readAttempt}/${maxReadAttempts} ${this.describeChest(chest)} recorded=${group.recordedAmount} item=${allocation.itemKey}`)
            if (readAttempt === maxReadAttempts) break
            this.closeContainerQuietly(container)
            await sleep(Math.max(0, Number(this.config.timing.containerSettleMs ?? 250)))
            container = await this.openContainerAt(chest)
          }
          if (!trustedRead) {
            console.warn(`[withdraw] ${this.describeChest(chest)} 连续 ${maxReadAttempts} 次读到空木桶，疑似服务器卡顿；跳过该木桶并保留原记录 item=${allocation.itemKey} recorded=${group.recordedAmount}`)
            missingBarrelHops++
            continue
          }
          this.debug(`window slots container=0..${container.inventoryStart - 1} inventory=${container.inventoryStart}..${container.inventoryEnd - 1}`)
          const toTake = Math.min(remaining, available)
          this.debug(`withdraw open ${this.describeChest(chest)} recorded=${group.recordedAmount} actual=${available} need=${remaining}`)
          const moved = await this.tryWithdrawExactFrom(container, allocation.itemKey, toTake, group.slots.map(row => row.slot))
          if (moved > 0) {
            withdrawn.push({ ...itemInfo, amount: moved })
            remaining -= moved
            await sleep(this.config.timing.containerSettleMs)
            this.debug(`withdraw moved ${moved} ${itemInfo.displayName || allocation.itemKey} from ${this.describeChest(chest)} remaining=${remaining}`)
          }
          // 实物比记录少（含物品被换成别的东西）时，当场把这一个木桶的记录刷新成实际内容
          this.refreshChestSnapshot(chest, container)
          if (available < group.recordedAmount) {
            missingBarrelHops++
            this.debug(`withdraw ${this.describeChest(chest)} 实际少于记录 recorded=${group.recordedAmount} actual=${available} 缺货换桶 ${missingBarrelHops}/${maxMissingBarrels}`)
          }
        } finally {
          this.closeContainerQuietly(container)
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

  resolveStuckShulkerRepackSelfHeal (pending, sourceKey) {
    if (pending?.state !== 'physical_changed' || typeof this.db.resolveStuckShulkerRepack !== 'function') return false
    try {
      const held = this.catalog.aggregatePrismarineItems(this.bot.inventory.items())
      const resolved = this.db.resolveStuckShulkerRepack(this.botId, held, `extraction self-heal, old_box=${sourceKey}`)
      if (!resolved) return false
      console.warn(`[shulker-repack-recovery] auto-resolved stuck physical_changed record before extraction: bot=${this.botId} old=${pending.oldBoxItemKey} committed=${resolved.committed}${resolved.committed ? '' : `, cleared with mismatch (${resolved.error})`}`)
      return true
    } catch (error) {
      logLocalError('shulker-repack-self-heal', error, {
        botId: this.botId,
        oldBoxItemKey: pending.oldBoxItemKey
      }, { directory: this.config.localLogDirectory })
      return false
    }
  }

  async withdrawFromShulkerBoxes (allocation) {
    const targetItem = this.db.getItemByKey(allocation.itemKey)
    if (!targetItem) return { withdrawn: [], missing: [{ ...allocation }] }
    if (!allocation.ownerUuid) throw new Error('拆潜影盒取货缺少库存所有者。')

    const sourceKey = String(allocation.sourceShulkerItemKey || '')
    const sourceItem = this.db.getItemByKey(sourceKey)
    if (!sourceKey || !sourceItem) {
      return { withdrawn: [], missing: [{ ...targetItem, amount: Number(allocation.amount || 0) }] }
    }

    let remaining = Number(allocation.amount || 0)
    let boxesRemaining = Math.max(0, Number(allocation.sourceBoxCount || 0))
    const withdrawn = []

    // 同一个取盒流程可能换源盒 key 执行多次：计划源盒在木桶记录里没有实物时，
    // 会回退到其他"账本有、木桶也有记录"的同内容盒子，避免账实漂移直接导致取货失败。
    const extractFromSource = async (sourceKey, sourceItem) => {
      const slots = this.db.listSlotsForItemKey(sourceKey)
      const chestGroups = this.groupSlotsForWithdrawal(slots)

      this.debug(`shulker extract ${targetItem.displayName || allocation.itemKey} need=${remaining} boxes=${boxesRemaining} source=${sourceItem.displayName || sourceKey}`)

      for (const group of chestGroups) {
        if (remaining <= 0 || boxesRemaining <= 0) break
        const slot = group.slots[0]
        const chest = { chestId: group.chestId, x: slot.x, y: slot.y, z: slot.z, blockName: slot.blockName }

        while (remaining > 0 && boxesRemaining > 0) {
          const sourceBox = await this.takeOneShulkerFromChest(chest, sourceKey, group.slots.map(row => row.slot))
          if (!sourceBox) break
          boxesRemaining--

          let quickWindow = null
          let boxToReturn = sourceBox
          let returned = false
          let repackState = ''
          try {
            await this.equipItemInHand(sourceBox)
            // 服务器偶尔会在快捷开盒后返回空窗口（数量 0），与盒内应有物品对不上；
            // 关窗重开最多 quickShulkerOpenAttempts 次，仍为 0 才跳过该盒。
            let available = 0
            const maxOpenAttempts = Math.max(1, Number(this.config.timing?.quickShulkerOpenAttempts ?? 3))
            for (let openAttempt = 1; openAttempt <= maxOpenAttempts; openAttempt++) {
              quickWindow = await this.openQuickShulkerWindow(sourceKey)
              available = await this.waitForContainerItemCount(quickWindow, allocation.itemKey)
              if (available > 0) break
              this.debug(`quick shulker window empty (attempt ${openAttempt}/${maxOpenAttempts}) source=${sourceKey} target=${allocation.itemKey}`)
              quickWindow.close()
              quickWindow = null
              if (openAttempt < maxOpenAttempts) await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
            }
            if (available <= 0) {
              console.warn(`[shulker-extract] 快捷开盒连续 ${maxOpenAttempts} 次读取数量为 0：source=${sourceKey}，本次跳过该盒。`)
            }
            const toTake = Math.min(remaining, available)
            if (toTake > 0) {
              const pending = this.db.getShulkerRepackRecovery?.(this.botId)
              if (pending) {
                if (pending.state === 'prepared' && pending.oldBoxItemKey === sourceKey) {
                  this.db.clearShulkerRepackRecovery(this.botId)
                  console.warn(`[shulker-repack-recovery] cleared unchanged stale prepared record before retry: bot=${this.botId} old=${sourceKey}`)
                } else if (this.resolveStuckShulkerRepackSelfHeal(pending, sourceKey)) {
                  // 上次换盒已实际完成，这里补账后继续本次拆盒
                } else {
                  const conflict = new Error(`bot ${this.botId} has an unresolved shulker repack recovery`)
                  logLocalError('shulker-repack-conflict', conflict, {
                    botId: this.botId,
                    sourceChestId: chest.chestId,
                    sourceKey,
                    pendingState: pending.state,
                    pendingOldBoxItemKey: pending.oldBoxItemKey,
                    ownerUuid: allocation.ownerUuid
                  }, { directory: this.config.localLogDirectory })
                  console.error(`[shulker-repack-recovery] unresolved record blocks extraction; returning box and continuing: bot=${this.botId} state=${pending.state} old=${pending.oldBoxItemKey}`)
                  quickWindow.close()
                  quickWindow = null
                  boxToReturn = this.findInventoryItemByKey(sourceKey) || sourceBox
                  await this.returnShulkerToChest(chest, boxToReturn)
                  returned = true
                  continue
                }
              }
              this.db.beginShulkerRepackRecovery(this.botId, {
                ownerUuid: allocation.ownerUuid,
                ownerUsername: allocation.ownerUsername || '',
                oldBoxItemKey: sourceKey,
                sourceChestId: chest.chestId,
                targetItem,
                beforeAmount: available,
                requestedAmount: toTake,
                message: `source_chest=${chest.chestId}, old_box=${sourceKey}`
              })
              repackState = 'prepared'
            }
            const moved = await this.tryWithdrawExactFrom(quickWindow, allocation.itemKey, toTake)
            this.debug(`shulker extract open source=${sourceKey} available=${available} moved=${moved} remaining=${remaining}`)

            // 连续开盒读到 0 时 quickWindow 已在上面重开循环里关掉置空，这里不能再重复关
            if (quickWindow) {
              quickWindow.close()
              quickWindow = null
            }
            await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))

            if (moved <= 0) {
              if (repackState) this.db.clearShulkerRepackRecovery(this.botId)
              repackState = ''
              boxToReturn = this.findInventoryItemByKey(sourceKey) || sourceBox
              // 盒里实际取不到目标物品：用手上盒子的真实 NBT 重建这个盒的内容记录，
              // 让记录与实物对齐，后续任务不再按旧记录扑空；
              // 若只是卡顿误读（盒里其实有），NBT 同样能还原正确记录，不会误清。
              this.syncShulkerBoxContents(boxToReturn)
              await this.returnShulkerToChest(chest, boxToReturn)
              returned = true
              continue
            }

            boxToReturn = await this.waitForChangedShulkerItem(sourceKey, sourceItem.itemId)
            const newBox = this.catalog.fromPrismarineItem(boxToReturn)
            this.verifyShulkerExtraction(newBox, allocation.itemKey, available, moved)

            this.db.markShulkerRepackPhysicalChange(
              this.botId,
              { ...newBox, amount: 1 },
              [{ ...targetItem, amount: moved }],
              `source_chest=${chest.chestId}, old_box=${sourceKey}, new_box=${newBox.itemKey}`
            )
            repackState = 'physical_changed'

            await this.returnShulkerToChest(chest, boxToReturn)
            returned = true
            this.db.commitShulkerRepackRecovery(this.botId)
            repackState = ''

            withdrawn.push({ ...targetItem, amount: moved })
            remaining -= moved
          } catch (error) {
            if (repackState || /shulker repack recovery/i.test(String(error?.message || ''))) {
              logLocalError('shulker-repack-error', error, {
                botId: this.botId,
                sourceChestId: chest.chestId,
                sourceKey,
                targetKey: allocation.itemKey,
                recoveryState: repackState
              }, { directory: this.config.localLogDirectory })
            }
            if (quickWindow) {
              try { quickWindow.close() } catch {}
              quickWindow = null
            }
            if (/already has a pending shulker repack recovery|unresolved shulker repack recovery/i.test(String(error?.message || ''))) {
              const recoverableBox = this.findInventoryShulker(sourceItem.itemId, sourceKey) || boxToReturn
              try {
                await this.returnShulkerToChest(chest, recoverableBox)
                returned = true
                continue
              } catch (returnError) {
                error.message += `；潜影盒冲突后放回失败：${returnError.message}`
              }
            }
            if (repackState === 'prepared') {
              const changedBox = this.findInventoryShulker(sourceItem.itemId, sourceKey) || boxToReturn
              try {
                const recovery = this.db.getShulkerRepackRecovery(this.botId)
                if (recovery) {
                  this.resolvePreparedShulkerRepackFromItem(recovery, changedBox)
                  repackState = this.db.getShulkerRepackRecovery(this.botId)?.state || ''
                }
              } catch (recoveryError) {
                error.message += `；潜影盒重打包状态记录失败：${recoveryError.message}`
              }
            }
            if (!returned) {
              const recoverableBox = this.findInventoryShulker(sourceItem.itemId, sourceKey) || boxToReturn
              try {
                await this.returnShulkerToChest(chest, recoverableBox)
              } catch (returnError) {
                error.message += `；潜影盒放回失败：${returnError.message}`
              }
            }
            throw error
          }
        }
      }

      return chestGroups.length
    }

    const plannedGroupCount = await extractFromSource(sourceKey, sourceItem)

    if (remaining > 0) {
      // 计划源盒没取够：按账本内容索引找同属该所有者、含目标物品的其他盒子，
      // 且必须真的有木桶位置记录，逐个回退直至取够或用尽。
      const fallbackRows = (typeof this.db.getOwnerShulkersContainingItemKey === 'function'
        ? this.db.getOwnerShulkersContainingItemKey(allocation.ownerUuid, allocation.itemKey)
        : []) || []
      for (const row of fallbackRows) {
        if (remaining <= 0) break
        const fallbackKey = String(row.shulkerItemKey || '')
        if (!fallbackKey || fallbackKey === sourceKey) continue
        if (!this.db.listSlotsForItemKey(fallbackKey).length) continue
        const fallbackItem = this.db.getItemByKey(fallbackKey)
        if (!fallbackItem) continue
        const perBox = Math.max(1, Number(row.containedAmount || 0))
        const extraBoxes = Math.min(Math.max(0, Number(row.shulkerAmount || 0)), Math.ceil(remaining / perBox))
        if (extraBoxes <= 0) continue
        boxesRemaining += extraBoxes
        console.warn(`[shulker-extract] 计划源盒 ${sourceKey}（${sourceItem.displayName || sourceKey}）在木桶记录中无实物，回退改用 ${fallbackKey}（${fallbackItem.displayName || fallbackKey}）`)
        await extractFromSource(fallbackKey, fallbackItem)
      }
      if (plannedGroupCount === 0) this.reportMissingSourceBoxRecord(allocation, sourceItem)
    }

    return {
      withdrawn: this.mergeItems(withdrawn),
      missing: remaining > 0 ? [{ ...targetItem, amount: remaining }] : []
    }
  }

  syncShulkerBoxContents (item) {
    try {
      const normalized = this.catalog.fromPrismarineItem(item)
      if (!this.catalog.isShulkerBox(normalized.itemId)) return
      this.db.upsertItem(normalized)
    } catch (error) {
      this.debug(`sync shulker contents failed: ${error?.message || error}`)
    }
  }

  // 账本显示所有者拥有某 key 的潜影盒，但木桶位置记录里一个都没有（典型：盒子被人工移动）。
  // 记一条库存异常（同一所有者+盒子 key 只记一条 open），供管理员在 Web 管理页看到并择机 !同步 对账。
  reportMissingSourceBoxRecord (allocation, sourceItem) {
    try {
      if (typeof this.db.addInventoryMismatch !== 'function' || typeof this.db.getBalance !== 'function') return
      const balance = Number(this.db.getBalance(allocation.ownerUuid, sourceItem.itemKey) || 0)
      if (balance <= 0) return
      if (typeof this.db.hasOpenInventoryMismatch === 'function' &&
          this.db.hasOpenInventoryMismatch(allocation.ownerUuid, sourceItem.itemKey)) return
      this.db.addInventoryMismatch(
        'missing',
        allocation.ownerUuid,
        allocation.ownerUsername || '',
        sourceItem,
        balance,
        '取货时发现：账本显示该潜影盒有库存，但木桶位置记录中没有任何实物（可能被人工移动或记录漂移）；系统已自动改用其他盒子取货。请择机执行 !同步 对账。'
      )
      console.warn(`[shulker-extract] 账本有 ${balance} 个 ${sourceItem.displayName || sourceItem.itemKey}（${sourceItem.itemKey}）但木桶记录中无实物，已记入库存异常。`)
    } catch (error) {
      this.debug(`report missing source box failed: ${error?.message || error}`)
    }
  }

  async takeOneShulkerFromChest (chest, itemKey, preferredSlots = []) {
    const container = await this.openContainerAt(chest)
    let moved = 0
    try {
      const available = this.countContainerItem(container, itemKey)
      if (available <= 0) {
        this.refreshChestSnapshot(chest, container)
        return null
      }
      moved = await this.tryWithdrawExactFrom(container, itemKey, 1, preferredSlots)
      await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
      this.refreshChestSnapshot(chest, container)
    } finally {
      this.closeContainerQuietly(container)
      await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
    }

    if (moved !== 1) throw new Error(`从 ${this.describeChest(chest)} 取潜影盒失败，实际取出 ${moved} 个。`)
    const item = await this.waitForInventoryItemByKey(itemKey)
    if (!item) throw new Error(`已从 ${this.describeChest(chest)} 取出潜影盒，但客户端背包没有收到该物品。`)
    return item
  }

  async returnShulkerToChest (chest, item) {
    if (!item) throw new Error('机器人背包中找不到待放回的潜影盒。')
    const normalized = this.catalog.fromPrismarineItem(item)
    if (!this.catalog.isShulkerBox(normalized.itemId)) throw new Error(`待放回物品不是潜影盒：${normalized.displayName}`)

    const container = await this.openContainerAt(chest)
    try {
      let moved = await this.tryDepositInto(container, item)
      if (moved <= 0) {
        moved = await this.waitForInventorySlotDecrease(item.slot, normalized.itemId, item.count, {
          intervalMs: 50,
          timeoutMs: Math.max(500, Number(this.config.timing?.inventoryUpdateTimeoutMs || 2000))
        })
      }
      await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
      this.refreshChestSnapshot(chest, container)
      if (moved !== 1) throw new Error(`放回 ${this.describeChest(chest)} 失败，实际放入 ${moved} 个潜影盒。`)
      return normalized
    } finally {
      this.closeContainerQuietly(container)
      await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
    }
  }

  findInventoryItemByKey (itemKey) {
    return this.bot.inventory.items().find(item => this.catalog.fromPrismarineItem(item).itemKey === itemKey) || null
  }

  async waitForInventoryItemByKey (itemKey, timeoutMs = null) {
    const timeout = Math.max(500, Number(timeoutMs ?? this.config.timing?.inventoryUpdateTimeoutMs ?? 2000))
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const item = this.findInventoryItemByKey(itemKey)
      if (item) return item
      await sleep(50)
    }
    return this.findInventoryItemByKey(itemKey)
  }

  async waitForInventorySlotDecrease (slot, itemId, before, options = {}) {
    if (!Number.isInteger(slot)) return 0
    const timeoutMs = Math.max(0, Number(options.timeoutMs ?? this.config.timing?.inventoryUpdateTimeoutMs ?? 2000))
    const intervalMs = Math.max(10, Number(options.intervalMs ?? 50))
    const startingCount = Math.max(0, Number(before || 0))
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const current = this.bot.inventory.items().find(entry => entry.slot === slot) || null
      if (!current) return startingCount
      const normalized = this.catalog.fromPrismarineItem(current)
      if (normalized.itemId !== itemId) return startingCount
      const moved = Math.max(0, startingCount - Number(current.count || 0))
      if (moved > 0) return moved
      await sleep(intervalMs)
    }
    return 0
  }

  findInventoryShulker (itemId, preferredItemKey = '') {
    const candidates = this.bot.inventory.items().filter(item => {
      const normalized = this.catalog.fromPrismarineItem(item)
      return normalized.itemId === itemId && this.catalog.isShulkerBox(normalized.itemId)
    })
    return candidates.find(item => this.catalog.fromPrismarineItem(item).itemKey !== preferredItemKey) ||
      candidates.find(item => this.catalog.fromPrismarineItem(item).itemKey === preferredItemKey) || null
  }

  async waitForChangedShulkerItem (oldItemKey, itemId) {
    const timeoutMs = Math.max(500, Number(this.config.timing?.inventoryUpdateTimeoutMs || 2000))
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const item = this.findInventoryShulker(itemId, oldItemKey)
      if (item && this.catalog.fromPrismarineItem(item).itemKey !== oldItemKey) return item
      await sleep(50)
    }
    throw new Error('快捷潜影盒内容已取出，但客户端没有收到盒子内容更新。')
  }

  verifyShulkerExtraction (newBox, targetItemKey, before, moved) {
    if (!newBox?.itemKey) throw new Error('无法读取变化后的潜影盒指纹。')
    const after = this.catalog.extractShulkerContents(newBox)
      .filter(entry => entry.item.itemKey === targetItemKey)
      .reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
    const expected = Math.max(0, Number(before || 0) - Number(moved || 0))
    if (after !== expected) {
      throw new Error(`潜影盒内容校验失败：目标物品应剩 ${expected} 个，实际索引为 ${after} 个。`)
    }
  }

  async aimAtAir (maxDistance = 6) {
    const startYaw = Number(this.bot.entity?.yaw || 0)
    const candidates = []
    const seen = new Set()
    const addCandidate = (yaw, pitch) => {
      const normalizedYaw = Math.atan2(Math.sin(yaw), Math.cos(yaw))
      const key = `${normalizedYaw.toFixed(6)},${pitch.toFixed(6)}`
      if (seen.has(key)) return
      seen.add(key)
      candidates.push({ yaw: normalizedYaw, pitch })
    }

    // A 1x2 warehouse tunnel has floor and ceiling blocks close to the bot, so
    // horizontal cardinal directions must be checked before looking up or down.
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) addCandidate(yaw, 0)
    for (const offset of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) addCandidate(startYaw + offset, 0)
    addCandidate(startYaw, Math.PI / 2)
    for (const offset of [Math.PI / 2, Math.PI, -Math.PI / 2]) addCandidate(startYaw + offset, Math.PI / 3)

    for (const candidate of candidates) {
      await this.bot.look(candidate.yaw, candidate.pitch, true)
      await sleep(100)
      const block = this.bot.blockAtCursor(maxDistance)
      if (!block) {
        this.debug(`air target confirmed yaw=${candidate.yaw.toFixed(3)} pitch=${candidate.pitch.toFixed(3)} distance=${maxDistance}`)
        return
      }
      this.debug(`air target blocked yaw=${candidate.yaw.toFixed(3)} pitch=${candidate.pitch.toFixed(3)} by ${this.describeBlock(block)}`)
    }
    throw new Error(`无法找到前方 ${maxDistance} 格内没有方块的方向，已取消快捷打开潜影盒。`)
  }

  async openQuickShulkerWindow (expectedItemKey = '') {
    if (this.bot.currentWindow) {
      this.bot.closeWindow(this.bot.currentWindow)
      await sleep(150)
    }
    this.assertHeldShulker(expectedItemKey)
    await this.aimAtAir(6)

    const timeoutMs = Math.max(500, Number(this.config.timing?.openContainerTimeoutMs || 8000))
    for (let attempt = 1; attempt <= 2; attempt++) {
      const windowPromise = this.waitForWindowOpen(timeoutMs)
      this.bot.activateItem(false)
      const window = await windowPromise
      if (window) {
        if (!this.isQuickShulkerWindow(window)) {
          try { window.close() } catch {}
          throw new Error(`快捷开盒返回了非潜影盒窗口：type=${window.type || 'unknown'} slots=${window.inventoryStart}`)
        }
        return window
      }
      if (attempt < 2) await sleep(250)
    }
    throw new Error('拿着潜影盒对空气右键后，没有收到潜影盒窗口。')
  }

  resolvePreparedShulkerRepackFromItem (recovery, item) {
    if (!recovery || recovery.state !== 'prepared') return recovery || null
    if (!item) throw new Error('找不到待恢复的潜影盒。')
    const normalized = this.catalog.fromPrismarineItem(item)
    if (!this.catalog.isShulkerBox(normalized.itemId)) throw new Error('待恢复物品不是潜影盒。')
    if (normalized.itemKey === recovery.oldBoxItemKey) {
      this.db.clearShulkerRepackRecovery(this.botId)
      return null
    }
    const targetItem = recovery.targetItem
    if (!targetItem?.itemKey) throw new Error('重打包恢复记录缺少目标物品。')
    const oldBox = this.db.getItemByKey(recovery.oldBoxItemKey)
    if (!oldBox) throw new Error(`找不到重打包恢复记录中的原潜影盒：${recovery.oldBoxItemKey}`)
    const moved = this.inferPreparedShulkerRepackAmount(recovery, oldBox, normalized)
    return this.db.markShulkerRepackPhysicalChange(
      this.botId,
      { ...normalized, amount: 1 },
      [{ ...targetItem, amount: moved }],
      `${recovery.message || ''}, recovery=inferred, new_box=${normalized.itemKey}`
    )
  }

  inferPreparedShulkerRepackAmount (recovery, oldBox, candidateBox) {
    const targetKey = recovery.targetItem?.itemKey
    const before = Number(recovery.beforeAmount || 0)
    const requested = Number(recovery.requestedAmount || 0)
    if (!targetKey || before <= 0 || requested <= 0) throw new Error('重打包恢复记录不完整。')

    const contentAmounts = box => new Map(this.catalog.extractShulkerContents(box)
      .map(entry => [entry.item.itemKey, Number(entry.amount || 0)]))
    const oldContents = contentAmounts(oldBox)
    const candidateContents = contentAmounts(candidateBox)
    const recordedBefore = Number(oldContents.get(targetKey) || 0)
    if (recordedBefore !== before) {
      throw new Error(`原潜影盒内容与恢复记录不一致：记录 ${before}，物品档案 ${recordedBefore}。`)
    }

    const after = Number(candidateContents.get(targetKey) || 0)
    const moved = before - after
    if (moved <= 0 || moved > requested) {
      throw new Error(`无法从盒内数量推断已取出物品：变化前 ${before}，当前 ${after}，计划最多 ${requested}。`)
    }

    const keys = new Set([...oldContents.keys(), ...candidateContents.keys()])
    keys.delete(targetKey)
    for (const key of keys) {
      if (Number(oldContents.get(key) || 0) !== Number(candidateContents.get(key) || 0)) {
        throw new Error('候选潜影盒除目标物品外还有其他内容变化。')
      }
    }
    return moved
  }

  resolvePreparedShulkerRepackFromInventory () {
    const recovery = this.db.getShulkerRepackRecovery(this.botId)
    if (!recovery || recovery.state !== 'prepared') return recovery || null
    const oldBox = this.db.getItemByKey(recovery.oldBoxItemKey)
    if (!oldBox) throw new Error(`找不到重打包恢复记录中的原潜影盒：${recovery.oldBoxItemKey}`)
    const candidates = this.bot.inventory.items().filter(item => {
      const normalized = this.catalog.fromPrismarineItem(item)
      return normalized.itemId === oldBox.itemId && this.catalog.isShulkerBox(normalized.itemId)
    })
    const unchanged = []
    const validChangedByKey = new Map()
    const rejected = []
    for (const candidate of candidates) {
      const normalized = this.catalog.fromPrismarineItem(candidate)
      if (normalized.itemKey === recovery.oldBoxItemKey) {
        unchanged.push(candidate)
        continue
      }
      try {
        this.inferPreparedShulkerRepackAmount(recovery, oldBox, normalized)
        if (!validChangedByKey.has(normalized.itemKey)) validChangedByKey.set(normalized.itemKey, candidate)
      } catch (error) {
        rejected.push(error.message)
      }
    }

    if (validChangedByKey.size === 1) {
      return this.resolvePreparedShulkerRepackFromItem(recovery, [...validChangedByKey.values()][0])
    }
    if (validChangedByKey.size > 1) {
      throw new Error('机器人背包中有多个可能的重打包潜影盒，无法安全判断；已保留恢复记录并停止后续任务。')
    }
    if (rejected.length) {
      throw new Error(`机器人背包中的同色潜影盒均不符合重打包记录；已保留恢复记录并停止后续任务。${rejected[0]}`)
    }
    if (unchanged.length) return this.resolvePreparedShulkerRepackFromItem(recovery, unchanged[0])
    console.warn(`[shulker-repack-recovery] prepared record is still pending; matching box is not currently in inventory, keeping the record and continuing bot tasks: bot=${this.botId} old=${recovery.oldBoxItemKey}`)
    return null
  }

  assertHeldShulker (expectedItemKey = '') {
    const held = this.bot.heldItem
    if (!held) throw new Error('快捷打开潜影盒前主手为空。')
    const normalized = this.catalog.fromPrismarineItem(held)
    if (!this.catalog.isShulkerBox(normalized.itemId)) {
      throw new Error(`快捷打开潜影盒前主手物品不是潜影盒：${normalized.displayName || normalized.itemId}`)
    }
    if (expectedItemKey && normalized.itemKey !== expectedItemKey) {
      throw new Error(`快捷打开潜影盒前主手拿错物品：期望 ${expectedItemKey.slice(-6)}，实际 ${normalized.itemKey.slice(-6)}`)
    }
    this.debug(`quick shulker held ${normalized.displayName || normalized.itemId} key=${normalized.itemKey.slice(-6)} slot=${held.slot}`)
    return held
  }

  waitForWindowOpen (timeoutMs) {
    if (this.bot.currentWindow) return Promise.resolve(this.bot.currentWindow)
    return new Promise(resolve => {
      let timer
      const onOpen = window => {
        clearTimeout(timer)
        resolve(window)
      }
      this.bot.once('windowOpen', onOpen)
      timer = setTimeout(() => {
        this.bot.removeListener('windowOpen', onOpen)
        resolve(null)
      }, timeoutMs)
    })
  }

  isQuickShulkerWindow (window) {
    const type = String(window?.type || '')
    return Number(window?.inventoryStart) === 27 && /(?:^|:)shulker_box$/.test(type)
  }

  async waitForContainerItemCount (container, itemKey, timeoutMs = null) {
    const timeout = Math.max(500, Number(timeoutMs ?? this.config.timing?.inventoryUpdateTimeoutMs ?? 2000))
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const count = this.countContainerItem(container, itemKey)
      if (count > 0) return count
      await sleep(50)
    }
    const count = this.countContainerItem(container, itemKey)
    if (count <= 0) this.debug(`quick shulker target missing key=${itemKey.slice(-6)} contents=${this.containerContentsForDebug(container)}`)
    return count
  }

  containerContentsForDebug (container) {
    const contents = this.containerContentItems(container)
    if (!contents.length) return 'empty'
    return contents.map(item => {
      const normalized = this.catalog.fromPrismarineItem(item)
      return `${normalized.displayName || normalized.itemId} x${item.count} key=${normalized.itemKey.slice(-6)} slot=${item.slot}`
    }).join(', ')
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
    let movedTotal = 0
    let remaining = amount
    const preferredOrder = new Map(preferredSlots.map((slot, index) => [slot, index]))
    const maxPasses = Math.max(1, Number(this.config.timing?.withdrawConfirmPasses ?? 2))

    // 整批点击、末端一次确认：点击期间不等服务器逐条确认，
    // 少拿的数量在下一轮补取，避免逐次等待拖慢整批取货。
    for (let pass = 0; pass < maxPasses && remaining > 0; pass++) {
      const containerBefore = this.countContainerItem(container, itemKey)
      const expectedTake = Math.min(remaining, containerBefore)
      if (expectedTake <= 0) break

      let planned = 0
      while (planned < expectedTake) {
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

        const take = Math.min(item.count, expectedTake - planned)
        try {
          if (take >= item.count) {
            await this.moveContainerSlotToInventory(container, item.slot)
          } else {
            await this.movePartialContainerSlotToInventory(container, item.slot, take)
          }
        } catch (error) {
          this.debug(`withdraw exact slot ${item.slot} failed: ${error.message}`)
          await this.ensureWindowCursorCleared(container)
          break
        }
        if (!(await this.ensureWindowCursorCleared(container))) break
        planned += take
      }

      await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
      const moved = Math.max(0, containerBefore - this.countContainerItem(container, itemKey))
      if (moved <= 0) {
        this.debug(`withdraw batch pass ${pass + 1} moved nothing for ${itemKey}`)
        break
      }
      movedTotal += moved
      remaining -= moved
    }

    return movedTotal
  }

  async ensureWindowCursorCleared (container) {
    if (!container.selectedItem) return true
    const destSlot = this.firstEmptyWindowInventorySlot(container)
    if (destSlot === null) return false
    try {
      await this.bot.clickWindow(destSlot, 0, 0)
    } catch {
      return false
    }
    await sleep(Math.max(0, Number(this.config.timing?.containerClickIntervalMs ?? 50)))
    return !container.selectedItem
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
    await sleep(Math.max(0, Number(this.config.timing?.containerClickIntervalMs ?? 50)))
    await this.bot.clickWindow(destSlot, 0, 0)
  }

  async movePartialContainerSlotToInventory (container, sourceSlot, count) {
    const destSlot = this.firstEmptyWindowInventorySlot(container)
    if (destSlot === null) throw new Error('机器人背包没有空槽，无法拆分取物')
    const intervalMs = Math.max(0, Number(this.config.timing?.containerClickIntervalMs ?? 50))

    await this.bot.clickWindow(sourceSlot, 0, 0)
    await sleep(intervalMs)
    for (let i = 0; i < count; i++) {
      await this.bot.clickWindow(destSlot, 1, 0)
      if (intervalMs > 0) await sleep(intervalMs)
    }
    await this.bot.clickWindow(sourceSlot, 0, 0)
    await sleep(intervalMs)
    if (container.selectedItem) {
      throw new Error(`拆分取物后鼠标仍持有 ${container.selectedItem.name || '物品'} x${container.selectedItem.count || 0}`)
    }
  }

  countContainerItem (container, itemKey) {
    let total = 0
    for (const item of this.containerContentItems(container)) {
      const normalized = this.catalog.fromPrismarineItem(item)
      if (normalized.itemKey === itemKey) total += item.count
    }
    return total
  }

  noteChestMutation (chestId) {
    if (!chestId) return
    this.chestMutationSeqs.set(String(chestId), ++this.mutationSeq)
  }

  refreshChestSnapshot (chest, container) {
    this.noteChestMutation(chest.chestId)
    this.db.upsertChest(chest)
    const slots = this.containerContentItems(container).map(item => ({
      ...this.catalog.fromPrismarineItem(item),
      slot: item.slot,
      amount: item.count
    }))
    this.db.replaceChestSlots(chest.chestId, slots)
  }

  async syncWarehouse (radius) {
    // 阶段一：不持仓库锁扫描，业务存取照常进行；
    // 阶段二：短暂持锁，重读扫描期间被业务改动过的木桶后换入新库存并对账。
    const scan = await this.scanWarehouseContainers(radius)
    return this.withWarehouseLock(() => this.applyWarehouseScan(scan, radius))
  }

  async scanWarehouseContainers (radius) {
    this.debug(`sync start radius=${radius}`)
    await this.goHome({ requireWarehouse: this.db.listChests().length > 0 })
    const blocks = this.findContainerBlocks(radius)
    this.debug(`found ${blocks.length} openable container blocks: ${blocks.map(block => this.describeBlock(block)).join(' | ')}`)

    const actualItems = []
    const snapshots = []
    const failures = []
    for (let index = 0; index < blocks.length; index++) {
      this.assertConnectionHealthy()
      const block = blocks[index]
      const chest = this.blockToChest(block)
      this.debug(`sync open ${index + 1}/${blocks.length} ${this.describeChest(chest)}`)
      const preReadSeq = ++this.mutationSeq
      let container
      try {
        container = await this.openContainerAt(chest)
        const slots = this.containerContentItems(container).map(item => ({
          ...this.catalog.fromPrismarineItem(item),
          slot: item.slot,
          amount: item.count
        }))
        snapshots.push({ chest, slots, preReadSeq })
        actualItems.push(...slots)
        this.debug(`sync read ${this.describeChest(chest)} slots=${slots.length} items=${slots.reduce((sum, item) => sum + item.amount, 0)}`)
      } catch (error) {
        if (error?.code === 'FATAL_PROTOCOL_READ' || this.connectionAbortController.signal.aborted) throw error
        const failure = `${this.describeChest(chest)} ${error.message}`
        failures.push(failure)
        console.error(`[warehouse] sync failed: ${failure}`)
      } finally {
        this.closeContainerQuietly(container)
      }
    }

    if (!blocks.length) {
      throw new Error('同步失败：没有找到可读取的仓库容器；已保留旧本地记录，不会生成库存异常。请检查同步半径、home 点和仓库布局。')
    }
    if (failures.length) {
      const examples = failures.slice(0, 3).join('；')
      throw new Error(`同步失败：${blocks.length} 个容器中有 ${failures.length} 个读取失败；已保留全部旧记录，不会生成库存异常。${examples ? `失败示例：${examples}` : ''}`)
    }

    return { radius, blocks, snapshots, actualItems }
  }

  async applyWarehouseScan (scan, radius) {
    const { blocks, snapshots } = scan

    // 重读同步扫描期间被业务存取改动过的木桶，避免用过期快照覆盖业务变更。
    // 任一重读失败都直接抛错：此时还没有写入任何新记录，旧库存原样保留。
    let rescanCount = 0
    for (const snapshot of snapshots) {
      if ((this.chestMutationSeqs.get(snapshot.chest.chestId) || 0) <= snapshot.preReadSeq) continue
      this.debug(`sync rescan mutated chest ${this.describeChest(snapshot.chest)}`)
      const container = await this.openContainerAt(snapshot.chest)
      try {
        snapshot.slots = this.containerContentItems(container).map(item => ({
          ...this.catalog.fromPrismarineItem(item),
          slot: item.slot,
          amount: item.count
        }))
        rescanCount++
      } finally {
        this.closeContainerQuietly(container)
      }
    }

    const actualItems = snapshots.flatMap(snapshot => snapshot.slots)
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
      rescanCount,
      failures: [],
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
    this.assertConnectionHealthy()
    this.debug(`goto ${this.describeChest(chest)} from ${this.describePosition(this.bot.entity.position)}`)
    await this.gotoForContainer(chest)
    const block = this.bot.blockAt(new Vec3(chest.x, chest.y, chest.z))
    if (!block || !this.chestNames.has(block.name)) {
      throw new Error(`找不到箱子：${chest.x},${chest.y},${chest.z}`)
    }
    this.openingChest = chest
    try {
      // 服务器偶尔会弄丢开箱请求，等满超时也没有窗口；总共最多 openContainerAttempts 次，
      // 每次超时按 openContainerTimeoutsMs 递增（默认 2s/4s/8s）。
      const maxAttempts = Math.max(1, Number(this.config.timing?.openContainerAttempts ?? 3))
      for (let attempt = 0; ; attempt++) {
        try {
          const container = await this.openContainerBlock(block, this.timeoutForOpenAttempt(attempt))
          this.warnUnexpectedContainerWindow(container, chest)
          return container
        } catch (error) {
          if (!error?.allOpenTimeouts || attempt + 1 >= maxAttempts) throw error
          this.debug(`open ${this.describeChest(chest)} timed out (attempt ${attempt + 1}/${maxAttempts}), retrying with timeout ${this.timeoutForOpenAttempt(attempt + 1)}ms`)
          await sleep(Math.max(0, Number(this.config.timing?.containerSettleMs ?? 250)))
        }
      }
    } finally {
      this.openingChest = null
    }
  }

  abortForProtocolReadError (error) {
    if (!isFatalProtocolReadError(error)) return error
    if (this.connectionAbortController.signal.aborted) return this.connectionAbortController.signal.reason

    const target = this.openingChest ? this.describeChest(this.openingChest) : '未知容器'
    const version = this.config.server?.version || '配置版本'
    const wrapped = new Error(
      `读取 ${target} 时发生 Slot/NBT 协议解析错误。` +
      `该木桶内可能有当前协议无法解析的嵌套物品；请先不要移动物品，程序会保存失败包并仅用 ${version} 重连。原始错误：${error.message}`,
      { cause: error }
    )
    wrapped.code = 'FATAL_PROTOCOL_READ'
    wrapped.chest = this.openingChest ? { ...this.openingChest } : null
    this.connectionAbortController.abort(wrapped)
    console.error(`[warehouse] fatal protocol read error: ${wrapped.message}`)
    return wrapped
  }

  assertConnectionHealthy () {
    if (this.connectionAbortController.signal.aborted) throw this.connectionAbortController.signal.reason
    if (this.isClientClosed()) {
      const error = new Error('Minecraft 连接已断开，当前仓库操作已终止。')
      error.code = 'CONNECTION_CLOSED'
      throw error
    }
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
    const itemName = String(item.name || '').replace(/^minecraft:/, '').toLowerCase()
    // 刷怪蛋右键会生成生物而不是开箱；服务器特殊物品也常用刷怪蛋 id 做皮肤，一律视为不安全。
    if (itemName.endsWith('_spawn_egg')) return true
    const unsafeNames = this.config.warehouse?.containerOpenUnsafeHeldItems || ['flint']
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

  closeLingeringWindow () {
    const window = this.bot.currentWindow
    if (!window) return
    // 超时后服务器仍可能迟到下发窗口；不清掉会在下一次开箱时干扰交互。
    this.debug('closing lingering window before opening container')
    try { this.bot.closeWindow(window) } catch {}
  }

  closeContainerQuietly (container) {
    if (!container) return
    try {
      container.close()
    } catch (error) {
      // 关窗只是收尾动作；失败时静默记日志，避免 finally 里抛错掩盖真实业务异常。
      this.debug(`close container failed: ${error?.message || error}`)
    }
  }

  timeoutForOpenAttempt (attempt) {
    const raw = this.config.timing?.openContainerTimeoutsMs
    const schedule = Array.isArray(raw)
      ? raw.map(value => Number(value)).filter(value => Number.isFinite(value) && value > 0)
      : []
    if (!schedule.length) return Number(this.config.timing?.openContainerTimeoutMs) || 8000
    // 次数超出配置表时沿用最后一档超时。
    return schedule[Math.min(attempt, schedule.length - 1)]
  }

  async openContainerBlock (block, timeoutMs = this.timeoutForOpenAttempt(0)) {
    const candidates = this.getContainerOpenCandidates(block)
    const errors = []

    for (const candidate of candidates) {
      const distance = this.bot.entity.position.distanceTo(candidate.position)
      const direction = this.getInteractionDirection(candidate)
      this.debug(`opening ${this.describeBlock(candidate)} distance=${distance.toFixed(2)} face=${this.describeVector(direction)}`)
      try {
        this.closeLingeringWindow()
        await this.lookAtBlock(candidate)
        this.ensureSafeHandForContainerOpen()
        const container = await this.withTimeout(
          this.bot.openContainer(candidate, direction, new Vec3(0.5, 0.5, 0.5)),
          timeoutMs,
          `打开箱子超时 ${this.describeBlock(candidate)} face=${this.describeVector(direction)}`
        )
        // 服务器偶尔会在开箱瞬间又立即关窗（卡顿/反作弊），bot.openContainer 会 resolve 出空窗口；
        // 这里不能把空窗口当成功返回，否则下游 countContainerItem(null) 与 finally 里的
        // container.close() 会连环报 "Cannot read properties of null (reading 'close')" 并掩盖真实错误。
        if (!container) {
          throw new Error(`打开箱子后没有收到窗口 ${this.describeBlock(candidate)} face=${this.describeVector(direction)}`)
        }
        this.warnUnexpectedContainerWindow(container, {
          blockName: candidate.name,
          x: candidate.position.x,
          y: candidate.position.y,
          z: candidate.position.z
        })
        return container
      } catch (error) {
        if (error?.code === 'FATAL_PROTOCOL_READ' || this.connectionAbortController.signal.aborted) throw error
        errors.push(`${this.describeBlock(candidate)} face=${this.describeVector(direction)} ${error.message}`)
        this.debug(`open attempt failed: ${errors.at(-1)}`)
      }
    }

    const failure = new Error(errors.join(' ; '))
    // 全部候选方块都只是超时或空窗口（而非协议错误等）时，允许上层关窗后重试。
    failure.allOpenTimeouts = errors.every(message => message.includes('打开箱子超时') || message.includes('没有收到窗口'))
    throw failure
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
    this.assertConnectionHealthy()
    const signal = this.connectionAbortController.signal
    let timer
    let onAbort
    try {
      return await Promise.race([
        promise,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms)
        }),
        new Promise((resolve, reject) => {
          onAbort = () => reject(signal.reason || new Error('Minecraft 连接已断开。'))
          signal.addEventListener('abort', onAbort, { once: true })
        })
      ])
    } finally {
      clearTimeout(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
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
      this.debug(`drop done ${normalized.displayName} x${moved} confirm=${Date.now() - startedAt}ms cooldown=${this.dropIntervalMs()}ms`)
      await this.waitDropCooldown(startedAt)
    }
    return this.mergeItems(dropped)
  }

  async dropItemsToPlayer (username, requestedItems) {
    const requested = this.mergeItems(requestedItems || [])
    if (this.bot.currentWindow) {
      this.debug(`closing open window before dropping selected items: ${this.bot.currentWindow.type || this.bot.currentWindow.id}`)
      this.bot.closeWindow(this.bot.currentWindow)
      await sleep(150)
    }

    const beforeByKey = new Map(requested.map(request => [request.itemKey, this.inventoryCountByItemKey(request.itemKey)]))
    const maxRounds = Math.max(1, Number(this.config.timing?.dropConfirmRounds ?? 3))

    // 整批丢出、末端一次确认：全部丢完后统一对账背包减少量，
    // 没有离开背包的部分在下一轮补丢，而不是逐组等待确认。
    for (let round = 0; round < maxRounds; round++) {
      const pending = requested
        .map(request => ({
          request,
          amount: Number(request.amount || 0) - (beforeByKey.get(request.itemKey) - this.inventoryCountByItemKey(request.itemKey))
        }))
        .filter(entry => entry.amount > 0)
      if (!pending.length) break

      await this.lookAtPlayer(username)
      let plannedThisRound = 0
      for (const entry of pending) {
        let remaining = entry.amount
        while (remaining > 0) {
          const item = this.bot.inventory.items().find(slot => {
            const normalized = this.catalog.fromPrismarineItem(slot)
            return normalized.itemKey === entry.request.itemKey
          })
          if (!item) break
          const normalized = this.catalog.fromPrismarineItem(item)
          const amount = Math.min(remaining, item.count)
          const startedAt = Date.now()
          this.debug(`drop batch ${normalized.displayName} x${amount} slot=${item.slot} round=${round + 1}/${maxRounds}`)
          await this.dropSlotAmountFast(item, amount)
          remaining -= amount
          plannedThisRound += amount
          await this.waitDropCooldown(startedAt)
        }
      }
      if (!plannedThisRound) break
      await this.waitForInventoryIdle(beforeByKey.keys())
    }

    const dropped = []
    for (const request of requested) {
      const before = beforeByKey.get(request.itemKey) || 0
      const moved = Math.min(Number(request.amount || 0), Math.max(0, before - this.inventoryCountByItemKey(request.itemKey)))
      if (moved > 0) dropped.push({ ...request, amount: moved })
    }
    return this.mergeItems(dropped)
  }

  async waitForInventoryIdle (itemKeys) {
    const keys = [...itemKeys]
    if (!keys.length) return
    const pollMs = this.inventoryConfirmPollMs()
    const timeoutMs = Number(this.config.timing.dropConfirmTimeoutMs || 5000)
    const idleMs = Math.max(2 * pollMs, 150)
    const startedAt = Date.now()
    let last = keys.map(key => this.inventoryCountByItemKey(key))
    let idleSince = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      await sleep(pollMs)
      const current = keys.map(key => this.inventoryCountByItemKey(key))
      if (current.some((count, index) => count !== last[index])) {
        last = current
        idleSince = Date.now()
        continue
      }
      if (Date.now() - idleSince >= idleMs) return
    }
  }

  async repairPlayerWithExperienceBottles (username, options = {}) {
    const itemId = String(options.itemId || 'minecraft:experience_bottle')
    const maxDistance = Number(options.maxDistance ?? 4)
    const used = []
    if (this.bot.currentWindow) {
      this.debug(`closing open window before repairing: ${this.bot.currentWindow.type || this.bot.currentWindow.id}`)
      this.bot.closeWindow(this.bot.currentWindow)
      await sleep(150)
    }

    while (true) {
      const target = this.bot.players[username]?.entity
      const botPos = this.bot.entity?.position
      if (!target?.position || !botPos) {
        this.debug(`repair stop ${username}: player entity unavailable`)
        break
      }
      const distance = target.position.distanceTo(botPos)
      if (distance > maxDistance) {
        this.debug(`repair stop ${username}: distance=${distance.toFixed(2)} > ${maxDistance}`)
        break
      }

      const item = this.bot.inventory.items().find(entry => this.catalog.fromPrismarineItem(entry).itemId === itemId)
      if (!item) break

      const normalized = this.catalog.fromPrismarineItem(item)
      const before = this.inventoryCountByItemKey(normalized.itemKey)
      const startedAt = Date.now()
      await this.equipItemInHand(item)
      await this.lookAtPlayer(username, 0.35)
      await this.useHeldItemOnce()
      const moved = await this.waitForInventoryDecrease(normalized.itemKey, before, { intervalMs: this.inventoryConfirmPollMs() })
      if (moved <= 0) throw new Error(`repair item use timed out: ${normalized.displayName}`)
      used.push({ ...normalized, amount: moved })
      this.debug(`repair throw ${normalized.displayName} x${moved} at ${username} confirm=${Date.now() - startedAt}ms cooldown=${this.dropIntervalMs()}ms`)
      await this.waitDropCooldown(startedAt)
    }

    return this.mergeItems(used)
  }

  async dropSlotAmountFast (item, amount) {
    const count = Math.max(0, Math.min(Number(amount || 0), Number(item.count || 0)))
    if (count <= 0) return
    if (count >= item.count) {
      await this.dropStackFast(item)
      return
    }

    const timeoutMs = Number(this.config.timing.dropConfirmTimeoutMs || 5000)
    for (let index = 0; index < count; index++) {
      await this.withTimeout(
        this.bot.clickWindow(item.slot, 0, 4),
        timeoutMs,
        `逐个丢出物品超时 slot=${item.slot}`
      )
    }
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

  async waitForInventoryDecrease (itemKey, before, options = {}) {
    const timeoutMs = Number(options.timeoutMs ?? this.config.timing.dropConfirmTimeoutMs ?? 5000)
    const intervalMs = Math.max(10, Number(options.intervalMs ?? this.inventoryConfirmPollMs()))
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const after = this.inventoryCountByItemKey(itemKey)
      if (after < before) return before - after
      await sleep(intervalMs)
    }
    return Math.max(0, before - this.inventoryCountByItemKey(itemKey))
  }

  async lookAtPlayer (username, yOffset = 1.4) {
    const entity = this.bot.players[username]?.entity
    if (!entity) {
      this.debug(`cannot look at player ${username}: entity not found`)
      return
    }
    const target = entity.position.offset(0, yOffset, 0)
    await this.bot.lookAt(target, true)
    await sleep(100)
  }

  async equipItemInHand (item) {
    if (!item) return
    const expected = this.catalog.fromPrismarineItem(item)
    const heldMatches = () => {
      if (!this.bot.heldItem) return false
      return this.catalog.fromPrismarineItem(this.bot.heldItem).itemKey === expected.itemKey
    }
    if (heldMatches()) return
    if (typeof this.bot.equip === 'function') {
      await this.bot.equip(item, 'hand')
    } else {
      const quickBarStart = this.bot.QUICK_BAR_START || 36
      if (typeof this.bot.setQuickBarSlot !== 'function' || item.slot < quickBarStart || item.slot >= quickBarStart + 9) {
        throw new Error(`cannot equip item in hand: ${item.name || item.itemId || 'item'}`)
      }
      this.bot.setQuickBarSlot(item.slot - quickBarStart)
    }

    const deadline = Date.now() + Math.max(500, Number(this.config.timing?.inventoryUpdateTimeoutMs || 2000))
    while (Date.now() < deadline) {
      if (heldMatches()) {
        this.debug(`equipped ${expected.displayName || expected.itemId} key=${expected.itemKey.slice(-6)} in main hand`)
        return
      }
      await sleep(50)
    }
    throw new Error(`装备潜影盒到主手失败：${expected.displayName || expected.itemId}`)
  }

  async useHeldItemOnce () {
    await this.withTimeout(Promise.resolve().then(async () => {
      this.bot.activateItem(false)
      await sleep(75)
      this.bot.deactivateItem?.()
    }), Number(this.config.timing.useItemTimeoutMs || 3000), 'held item use timed out')
  }

  dropIntervalMs () {
    return Math.max(0, Number(this.config.timing?.dropIntervalMs ?? 250))
  }

  inventoryConfirmPollMs () {
    return Math.max(10, Math.min(25, this.dropIntervalMs() || 25))
  }

  async waitDropCooldown (startedAt) {
    const remaining = this.dropIntervalMs() - (Date.now() - startedAt)
    if (remaining > 0) await sleep(remaining)
  }

  mergeItems (items) {
    const amounts = sumBy(items, item => item.itemKey)
    const firstByKey = new Map(items.map(item => [item.itemKey, item]))
    return [...amounts.entries()].map(([itemKey, amount]) => ({ ...firstByKey.get(itemKey), amount }))
  }
}

module.exports = Warehouse

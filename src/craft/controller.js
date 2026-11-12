'use strict'

const { randomUUID } = require('node:crypto')
const CraftLedger = require('./ledger')
const { planToCraftCommand } = require('./index')
const { shortKey } = require('../traceLog')

function merge (items) {
  const totals = new Map()
  for (const item of items || []) {
    if (!item?.itemKey || !Number.isSafeInteger(item.amount) || item.amount < 0) throw new Error('invalid craft inventory snapshot')
    if (!item.amount) continue
    const previous = totals.get(item.itemKey)
    const amount = (previous?.amount || 0) + item.amount
    if (!Number.isSafeInteger(amount)) throw new Error('invalid craft inventory snapshot total')
    totals.set(item.itemKey, { ...item, amount })
  }
  return [...totals.values()]
}

function same (left, right) {
  const a = new Map(merge(left).map(item => [item.itemKey, item.amount]))
  const b = new Map(merge(right).map(item => [item.itemKey, item.amount]))
  return a.size === b.size && [...a].every(([key, amount]) => b.get(key) === amount)
}

function converted (before, consumed, produced) {
  const result = new Map(merge(before).map(item => [item.itemKey, { ...item }]))
  for (const item of consumed) {
    const previous = result.get(item.itemKey)
    if (!previous || previous.amount < item.amount) throw new Error('craft physical baseline lacks input')
    previous.amount -= item.amount
    if (!previous.amount) result.delete(item.itemKey)
  }
  return merge([...result.values(), ...produced])
}

function scaledProducedItems (values, totalTriggers, completedTriggers) {
  if (!Number.isSafeInteger(totalTriggers) || totalTriggers <= 0 ||
    !Number.isSafeInteger(completedTriggers) || completedTriggers < 0 || completedTriggers > totalTriggers) return null
  const result = []
  for (const value of values || []) {
    if (!value?.itemKey || !value.itemId || !Number.isSafeInteger(value.amount) || value.amount <= 0 || value.amount % totalTriggers !== 0) return null
    const amount = (value.amount / totalTriggers) * completedTriggers
    if (amount > 0) result.push({ ...value, amount })
  }
  return result
}

// Input variants are allocated by concrete itemKey, so their counts do not
// necessarily divide evenly across a batch. Derive gross consumption from the
// observed inventory equation instead of inventing a proportional split.
function deriveObservedConsumption (before, observed, produced, expectedConsumed, totalTriggers, completedTriggers) {
  if (!Number.isSafeInteger(totalTriggers) || totalTriggers <= 0 ||
    !Number.isSafeInteger(completedTriggers) || completedTriggers < 0 || completedTriggers > totalTriggers) return null
  const beforeByKey = new Map(merge(before).map(item => [item.itemKey, item]))
  const observedByKey = new Map(merge(observed).map(item => [item.itemKey, item]))
  const producedByKey = new Map(merge(produced).map(item => [item.itemKey, item]))
  const expectedByKey = new Map(merge(expectedConsumed).map(item => [item.itemKey, item]))
  const consumed = []
  const keys = new Set([...beforeByKey.keys(), ...observedByKey.keys(), ...producedByKey.keys()])
  for (const itemKey of keys) {
    const baseline = beforeByKey.get(itemKey)
    const output = producedByKey.get(itemKey)
    const current = observedByKey.get(itemKey)
    const amount = (baseline?.amount || 0) + (output?.amount || 0) - (current?.amount || 0)
    if (!Number.isSafeInteger(amount) || amount < 0) return null
    if (!amount) continue
    const expected = expectedByKey.get(itemKey)
    if (!baseline || !expected || amount > baseline.amount || amount > expected.amount ||
      (expected.itemId && baseline.itemId && expected.itemId !== baseline.itemId)) return null
    consumed.push({ ...baseline, amount })
  }

  const expectedById = new Map()
  for (const item of expectedConsumed || []) {
    if (!item?.itemKey || !item.itemId || !Number.isSafeInteger(item.amount) || item.amount <= 0) return null
    const total = (expectedById.get(item.itemId) || 0) + item.amount
    if (!Number.isSafeInteger(total)) return null
    expectedById.set(item.itemId, total)
  }
  const consumedById = new Map()
  for (const item of consumed) {
    const total = (consumedById.get(item.itemId) || 0) + item.amount
    if (!Number.isSafeInteger(total)) return null
    consumedById.set(item.itemId, total)
  }
  for (const [itemId, total] of expectedById) {
    if (total % totalTriggers !== 0 || (consumedById.get(itemId) || 0) !== (total / totalTriggers) * completedTriggers) return null
  }
  for (const itemId of consumedById.keys()) if (!expectedById.has(itemId)) return null
  return consumed
}

// 合成失败自动恢复的兜底时限：断线后底层网络调用可能不再返回，与其无限
// 挂住合成任务（死亡钩子也在等它 drain），不如放弃本轮，把恢复记录留给
// 重连/spawn 钩子或人工。放弃后后台的 recover 若最终跑完，同样是一笔经
// 对账核对的状态落库，没有账目风险。
const AUTO_RECOVER_TIMEOUT_MS = 120000
// 恢复对账失败后的自愈重试次数与间隔：单次失败（服务器包竞速、卡顿窗口读数漂移
// 等）不应把全库锁到人工介入；重试无果才降级为记异常销账（settleRecoveryDiff）。
const RECOVER_RETRY_ATTEMPTS = 3
const RECOVER_RETRY_DELAY_MS = 500
function withTimeout (promise, ms) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`自动恢复超时（${Math.round(ms / 1000)} 秒）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

class CraftController {
  constructor ({ bot, db, catalog, config, warehouse, executor, botId, ledger, validateOwner, quota, debugCraft = () => {} }) {
    Object.assign(this, { bot, db, catalog, config, warehouse, executor, botId, validateOwner, quota, debugCraft })
    this.ledger = ledger || new CraftLedger(db)
    this.active = null
  }

  debug (event, details = {}) {
    try { this.debugCraft(event, details) } catch { /* Diagnostics must not change craft behavior. */ }
  }

  async measurePhase (phase, details, action) {
    this.debug('controller.phase_start', { ...details, phase })
    const startedAt = performance.now()
    try {
      const result = await action()
      this.debug('controller.phase_complete', { ...details, phase, elapsedMs: performance.now() - startedAt })
      return result
    } catch (cause) {
      this.debug('controller.phase_failure', { ...details, phase, elapsedMs: performance.now() - startedAt, message: cause?.message || String(cause) })
      throw cause
    }
  }

  summarizeItems (items) {
    return (items || []).map(item => ({
      itemId: item.itemId,
      amount: item.amount,
      fingerprint: shortKey(item.itemKey)
    }))
  }

  summarizeAmounts (items) {
    return (items || []).map(item => [item.itemId, item.amount]).sort((a, b) => a[0].localeCompare(b[0]))
  }

  inventory () { return merge(this.catalog.aggregatePrismarineItems(this.bot.inventory.items())) }
  isBusy () { return Boolean(this.active) }
  cancel (reason = '合成已取消') {
    this.active?.abort.abort(new Error(reason))
    this.executor?.cancel(reason)
  }

  hasInventoryResidue () {
    return Boolean(this.inventory().length || this.bot.currentWindow || this.bot.inventory.selectedItem ||
      this.bot.inventory.slots?.slice(0, 5).some(Boolean))
  }

  residueDescription () {
    const parts = []
    const backpack = this.inventory()
    if (backpack.length) {
      parts.push(`背包 ${backpack.map(item => `${item.displayName || item.itemId}×${item.amount}`).join('、')}`)
    }
    if (this.bot.currentWindow) parts.push(`窗口 type=${this.bot.currentWindow.type || 'unknown'}`)
    if (this.bot.inventory.selectedItem) {
      const cursor = this.catalog.fromPrismarineItem(this.bot.inventory.selectedItem)
      parts.push(`光标 ${cursor.displayName || cursor.itemId}`)
    }
    const grid = this.bot.inventory.slots?.slice(0, 5)
    if (Array.isArray(grid)) {
      for (const [slot, value] of grid.entries()) {
        if (!value) continue
        const item = this.catalog.fromPrismarineItem(value)
        parts.push(`合成格${slot} ${item.displayName || item.itemId}×${value.count}`)
      }
    }
    return parts.join('；') || '未知残留'
  }

  // Recovery self-heal: an interrupted bot.craft() may leave the cursor holding
  // a picked-up stack or a mid-click window open. Closing the window returns
  // grid items to the server-side inventory; parking the cursor merges it back
  // into backpack slots. Both moves relocate existing items without creating or
  // destroying any, so the operation's physicalTotals baseline stays valid.
  async settleResidue (check = () => {}) {
    check()
    if (this.bot.currentWindow) {
      try { this.bot.closeWindow(this.bot.currentWindow) } catch {}
      await new Promise(resolve => setTimeout(resolve, 150))
      check()
    }
    const selectedItem = this.bot.inventory.selectedItem
    if (!selectedItem) return
    const cursor = this.catalog.fromPrismarineItem(selectedItem)
    const slots = this.bot.inventory.slots
    if (!Array.isArray(slots)) throw new Error(`无法自愈光标残留：${cursor.displayName || cursor.itemId}（背包槽位数据不可用）。`)
    let target = -1
    for (let slot = 9; slot < 45; slot++) {
      const value = slots[slot]
      if (value && value.count < value.stackSize && this.catalog.fromPrismarineItem(value).itemKey === cursor.itemKey) { target = slot; break }
    }
    if (target < 0) {
      for (let slot = 9; slot < 45; slot++) {
        if (!slots[slot]) { target = slot; break }
      }
    }
    if (target < 0) throw new Error(`无法自愈光标残留：${cursor.displayName || cursor.itemId}（背包没有可合并或空置的槽位）。`)
    check()
    await this.bot.clickWindow(target, 0, 0)
    check()
  }

  // One settle attempt must clear window + cursor; crafting-grid phantoms are
  // server-side-packet staleness and get corrected by the container re-read.
  async assertSettledResidue (check) {
    await this.settleResidue(check)
    if (this.bot.currentWindow || this.bot.inventory.selectedItem) {
      throw new Error(`自愈后仍存在光标/窗口残留：${this.residueDescription()}；需要人工核对。`)
    }
  }

  assertCleanInventory () {
    // 报错带具体残留描述：笼统的"背包、窗口、光标或合成格"排查不了，
    // 玩家/维护需要知道到底卡了什么才能处理。
    if (this.hasInventoryResidue()) throw new Error(`需先处理机器人背包、窗口、光标或合成格残留物品。当前残留：${this.residueDescription()}`)
  }

  availableItems (ownerUuid) { return this.ledger.getCraftAvailableItems(ownerUuid) }
  availableStock (ownerUuid) {
    const totals = {}
    for (const item of this.availableItems(ownerUuid)) {
      const name = item.itemId.replace(/^minecraft:/, '')
      totals[name] = (totals[name] || 0) + item.amount
    }
    return totals
  }

  allocate (uses, rows) {
    const pool = rows.map(item => ({ ...item }))
    const allocations = []
    for (const use of uses) {
      let remaining = use.quantity
      for (const row of pool) {
        if (row.itemId !== `minecraft:${use.name}` || !row.amount || !remaining) continue
        const amount = Math.min(row.amount, remaining)
        allocations.push({ ...row, amount })
        row.amount -= amount
        remaining -= amount
      }
      if (remaining) throw new Error(`仓库原料不足或已被预留：${use.name} ×${remaining}`)
    }
    return merge(allocations)
  }

  physicalTotals () {
    // Aggregate registered storage by exact identity before loading metadata.
    // Read afresh at each checkpoint; recovery must never use cached amounts.
    const slots = typeof this.db.db?.prepare === 'function'
      ? this.db.db.prepare(`
          SELECT totals.itemKey, totals.amount, totals.invalid, i.item_id AS itemId,
                 i.display_name AS displayName, i.nbt_json AS nbtJson, i.meta_json AS metaJson
          FROM (
            SELECT cs.item_key AS itemKey, SUM(cs.amount) AS amount,
                   MAX(typeof(cs.amount) <> 'integer' OR cs.amount > 9007199254740991) AS invalid
            FROM chest_slots cs JOIN chests c ON c.chest_id = cs.chest_id
            WHERE cs.amount > 0 GROUP BY cs.item_key
          ) totals LEFT JOIN items i ON i.item_key = totals.itemKey
        `).all().map(({ invalid, ...row }) => {
          if (invalid) throw new Error('invalid craft inventory snapshot')
          return row
        })
      : this.db.listChestSlots().filter(row => Number(row.amount) > 0).map(row => ({
          ...this.db.getItemByKey(row.itemKey), itemKey: row.itemKey, amount: Number(row.amount)
        }))
    return merge([...slots, ...this.inventory()])
  }

  checkQuota (owner, plan) {
    const quota = this.quota?.(owner)
    if (this.quota && (!Number.isSafeInteger(quota?.quotaSlots) || quota.quotaSlots < 0)) throw new Error('仓库额度配置无效。')
    const Item = require('prismarine-item')(this.catalog.mcData)
    const amount = new Map(this.db.getOwnerBalances(owner.uuid).map(row => [row.itemKey, { ...row }]))
    // Simulate the same concrete reservations and item-key order used at runtime.
    // A final-only estimate misses peaks while some inputs still occupy slots.
    const reserved = new Map(this.allocate(plan.inventoryUses, this.availableItems(owner.uuid)).map(row => [row.itemKey, { ...row }]))
    for (const step of plan.craftSteps) {
      // Batch granularity mirrors execution: each batch deducts its full input
      // set at once, then credits outputs after the batch's triggers complete.
      for (let start = 0; start < step.times;) {
        const remaining = step.times - start
        const pool = [...reserved.values()].filter(item => item.amount > 0).sort((a, b) => a.itemKey.localeCompare(b.itemKey))
        const triggers = Math.min(this.maxTriggersPerBatch(step, pool, remaining), remaining)
        const inputs = this.allocate(step.inputs.map(input => ({ name: input.names[0], quantity: input.count * triggers })), pool)
        for (const input of inputs) {
          amount.get(input.itemKey).amount -= input.amount
          reserved.get(input.itemKey).amount -= input.amount
        }
        for (const output of step.outputs?.length ? step.outputs : [step.result]) {
          const resolved = this.catalog.resolveName(output.name)
          const item = this.catalog.fromPrismarineItem(new Item(resolved.type, output.count * triggers, output.metadata))
          for (const pool of [amount, reserved]) {
            const previous = pool.get(item.itemKey)
            pool.set(item.itemKey, { ...item, amount: (previous?.amount || 0) + output.count * triggers })
          }
        }
        const used = [...amount.values()].reduce((sum, item) => sum + Math.ceil(item.amount / Math.max(1, this.catalog.getStackSize(item.itemId))), 0)
        if (quota && used > quota.quotaSlots) throw new Error(`合成过程中的仓库占用超出额度（${used}/${quota.quotaSlots} 槽）。`)
        start += triggers
      }
    }
  }

  batchBudget (step, sourceRows, limit = 64) {
    const inventorySlots = 36
    const reserveSlots = 1
    const maxUsedSlots = inventorySlots - reserveSlots
    const inputTotals = new Map()
    let gridStackLimit = 64
    for (const input of step.inputs || []) {
      const resolved = this.catalog.resolveName(input.names[0])
      const itemId = `minecraft:${resolved.name}`
      const stackSize = Math.max(1, this.catalog.getStackSize(itemId))
      inputTotals.set(itemId, (inputTotals.get(itemId) || 0) + input.count)
      gridStackLimit = Math.min(gridStackLimit, stackSize)
    }

    const requirements = [...inputTotals].map(([itemId, count]) => ({
      name: itemId.replace(/^minecraft:/, ''),
      itemId,
      count
    }))
    const requestedLimit = Math.max(1, Math.floor(Number(limit) || 1))
    const pool = (sourceRows || requirements.map(input => ({
      ...this.catalog.fromItemIdAmount(input.itemId, input.count * requestedLimit),
      amount: input.count * requestedLimit
    }))).filter(item => item.amount > 0).sort((a, b) => a.itemKey.localeCompare(b.itemKey))
    const availableByItemId = new Map()
    for (const item of pool) availableByItemId.set(item.itemId, (availableByItemId.get(item.itemId) || 0) + item.amount)
    let supplyLimit = requestedLimit
    for (const input of requirements) {
      const stackSize = Math.max(1, this.catalog.getStackSize(input.itemId))
      supplyLimit = Math.min(
        supplyLimit,
        Math.floor((availableByItemId.get(input.itemId) || 0) / input.count),
        Math.floor((maxUsedSlots * stackSize) / input.count)
      )
    }

    const outputPerTrigger = new Map()
    const Item = require('prismarine-item')(this.catalog.mcData)
    for (const output of step.outputs?.length ? step.outputs : [step.result]) {
      const resolved = this.catalog.resolveName(output.name)
      const item = this.catalog.fromPrismarineItem(new Item(resolved.type, output.count, output.metadata))
      const previous = outputPerTrigger.get(item.itemKey)
      outputPerTrigger.set(item.itemKey, { ...item, amount: (previous?.amount || 0) + output.count })
      const stackSize = Math.max(1, this.catalog.getStackSize(item.itemId))
      supplyLimit = Math.min(supplyLimit, Math.floor((maxUsedSlots * stackSize) / (outputPerTrigger.get(item.itemKey).amount)))
    }

    const layoutSlots = entries => {
      const slots = Array(inventorySlots).fill(null)
      for (const entry of entries) {
        const stackSize = Math.max(1, this.catalog.getStackSize(entry.itemId))
        const key = entry.itemKey || `${entry.itemId}|${entry.metadata ?? ''}`
        let remaining = entry.amount
        for (let slot = 0; slot < maxUsedSlots && remaining > 0; slot++) {
          const occupied = slots[slot]
          if (!occupied || occupied.key !== key || occupied.amount >= stackSize) continue
          const moved = Math.min(stackSize - occupied.amount, remaining)
          occupied.amount += moved
          remaining -= moved
        }
        while (remaining > 0) {
          const slot = slots.findIndex((occupied, index) => index < maxUsedSlots && !occupied)
          if (slot < 0) return null
          const moved = Math.min(stackSize, remaining)
          slots[slot] = { key, itemId: entry.itemId, amount: moved }
          remaining -= moved
        }
      }
      return slots.filter(Boolean).length
    }

    for (let triggers = supplyLimit; triggers >= 1; triggers--) {
      let allocatedInputs
      try {
        allocatedInputs = this.allocate(requirements.map(input => ({ name: input.name, quantity: input.count * triggers })), pool)
      } catch { continue }
      const inputSlots = layoutSlots(allocatedInputs)
      const remainingInputs = new Map(allocatedInputs.map(item => [item.itemKey, { ...item }]))
      const produced = new Map()
      let usedSlots = inputSlots
      let fits = inputSlots !== null

      // The grid holds at most one stack per recipe cell. Simulate complete
      // grid waves, releasing confirmed inputs before reserving their outputs.
      for (let completed = 0; fits && completed < triggers;) {
        const wave = Math.min(gridStackLimit, triggers - completed)
        for (const input of requirements) {
          let needed = input.count * wave
          for (const item of allocatedInputs) {
            if (item.itemId !== input.itemId || needed <= 0) continue
            const remaining = remainingInputs.get(item.itemKey)
            if (!remaining?.amount) continue
            const consumed = Math.min(needed, remaining.amount)
            remaining.amount -= consumed
            needed -= consumed
            if (!remaining.amount) remainingInputs.delete(item.itemKey)
          }
          if (needed) {
            fits = false
            break
          }
        }
        if (!fits) break

        const afterPlacement = layoutSlots([...remainingInputs.values(), ...produced.values()])
        if (afterPlacement === null) {
          fits = false
          break
        }
        usedSlots = Math.max(usedSlots, afterPlacement)

        for (const output of outputPerTrigger.values()) {
          const previous = produced.get(output.itemKey)
          produced.set(output.itemKey, { ...output, amount: (previous?.amount || 0) + output.amount * wave })
        }
        const afterOutput = layoutSlots([...remainingInputs.values(), ...produced.values()])
        if (afterOutput === null) {
          fits = false
          break
        }
        usedSlots = Math.max(usedSlots, afterOutput)
        completed += wave
      }

      const outputSlots = layoutSlots([...produced.values()])
      if (!fits || outputSlots === null) continue
      if (usedSlots <= maxUsedSlots) {
        return {
          triggers,
          inputSlots,
          outputSlots,
          usedSlots,
          reserveSlots,
          freeSlots: inventorySlots - usedSlots - reserveSlots,
          gridStackLimit
        }
      }
    }

    return { triggers: 0, inputSlots: 0, outputSlots: 0, usedSlots: 0, reserveSlots, freeSlots: maxUsedSlots, gridStackLimit }
  }

  maxTriggersPerBatch (step, sourceRows, limit) {
    const budget = this.batchBudget(step, sourceRows, limit)
    if (budget.triggers < 1) throw new Error('无法在保留 1 个保险槽位时装入单次合成材料和产物。')
    return budget.triggers
  }

  async run (request) {
    if (this.active) throw new Error('合成任务尚未结束。')
    const requestStartedAt = performance.now()
    this.debug('controller.request_start', {
      target: { name: request.item, quantity: request.quantity },
      ownerScope: request.owner?.scope || null
    })
    // Recover before taking the new order's non-reentrant warehouse lock.
    if (this.ledger.pending(this.botId).length) {
      this.debug('controller.pending_recovery_start', { pendingCount: this.ledger.pending(this.botId).length })
      const recovered = await withTimeout(this.recover(), AUTO_RECOVER_TIMEOUT_MS)
      this.debug('controller.pending_recovery_complete', { status: recovered.status, operationId: recovered.operationId || null })
      if (this.ledger.pending(this.botId).length) throw new Error('本机器人存在未恢复的合成任务，请先执行 !合成恢复。')
    }
    const abort = new AbortController()
    const lease = { abort }
    this.active = lease
    try {
      this.debug('controller.lock_wait_start')
      const lockRequestedAt = performance.now()
      return await this.warehouse.withWarehouseLock(async () => {
        this.debug('controller.lock_acquired', { waitMs: performance.now() - lockRequestedAt })
        const pendingOthers = this.ledger.pending().filter(operation => operation.botId !== this.botId)
        if (pendingOthers.length) throw new Error('存在其他机器人未恢复的合成任务，请先执行 !合成恢复。')
        await this.validateOwner?.(request.owner, request.actor)
        // 开工先自愈窗口/光标残留：多为上次取货/拆盒操作遗留的窗口未关或光标
        // 未归位（服务器包 staleness 的幻影），关窗重读即可纠正。之前直接断言
        // 会把幻影当真残留拒绝开工（2026-11-05 金苹果合成即被此路径打挂）。
        // 真背包物品残留 settle 后依然 fail-fast，不会误开工。
        await this.measurePhase('preflight', {}, () => this.settleResidue())
        this.assertCleanInventory()
        this.debug('controller.preflight_complete', { inventory: this.summarizeItems(this.inventory()) })
        const rows = this.availableItems(request.owner.uuid)
        const planningStartedAt = performance.now()
        const planned = planToCraftCommand({ item: request.item, quantity: request.quantity, available: this.availableStock(request.owner.uuid), config: this.config, forceCraft: true })
        this.debug('controller.planning_complete', { elapsedMs: performance.now() - planningStartedAt, ok: planned.ok })
        if (!planned.ok) {
          this.debug('controller.plan_rejected', { target: { name: request.item, quantity: request.quantity }, reason: planned.reason || 'unknown' })
          // A stocked target is not a failure: the planner already reported
          // already_in_warehouse for zero-craft-step plans, but any other
          // rejection (missing inputs, unreachable recipe) stops the order.
          if (planned.reason === 'already_in_warehouse') return { status: 'already_sufficient' }
          const failure = new Error('仓库原料不足或配方不可达；合成仅使用散装库存。')
          failure.reason = planned.reason
          throw failure
        }
        this.debug('controller.plan_ready', {
          target: planned.command.target,
          steps: planned.command.craftSteps.map((step, index) => ({
            index,
            result: `minecraft:${step.result.name}`,
            resultPerTrigger: step.result.count,
            triggers: step.times,
            requiresTable: step.requiresTable,
            inputs: step.inputs.map(input => ({ itemId: `minecraft:${input.names[0]}`, amountPerTrigger: input.count })),
            outputs: (step.outputs?.length ? step.outputs : [step.result]).map(output => ({
              itemId: `minecraft:${output.name}`,
              amountPerTrigger: output.count
            }))
          }))
        })
        this.checkQuota(request.owner, planned.plan)
        const allocations = this.allocate(planned.plan.inventoryUses, rows)
        const id = `craft:${randomUUID()}`
        let operation = this.ledger.begin({ id, botId: this.botId, owner: request.owner, actor: request.actor, target: planned.command.target, allocations,
          data: { held: [], pending: null, physicalTotals: this.physicalTotals(), stepIndex: 0,
            progress: { stepIndex: 0, nextTrigger: 0 }, plan: planned.command } })
        this.debug('controller.operation_started', {
          operationId: id,
          target: planned.command.target,
          reserved: this.summarizeItems(allocations),
          stepCount: planned.command.craftSteps.length
        })
        const batchTimeoutMs = planned.command.budgetMs
        let deadline = Date.now() + batchTimeoutMs
        const check = () => {
          if (abort.signal.aborted) throw abort.signal.reason
          if (Date.now() >= deadline) throw new Error('合成任务超时。')
        }
        try {
          await this.measurePhase('home', { operationId: id }, () => this.warehouse.goHomeIfAway())
          for (const [index, step] of planned.command.craftSteps.entries()) {
            let trigger = 0
            while (trigger < step.times) {
              check()
              this.assertCleanInventory()
              const remaining = step.times - trigger
              const heldAllocations = this.ledger.listCraftReservations(id)
                .map(row => ({ ...this.db.getItemByKey(row.itemKey), amount: row.amount }))
                .sort((a, b) => a.itemKey.localeCompare(b.itemKey))
              const triggers = Math.min(this.maxTriggersPerBatch(step, heldAllocations, remaining), remaining)
              const budget = this.batchBudget(step, heldAllocations, triggers)
              this.warehouse.debug?.(`craft batch budget item=${step.result.name} triggers=${triggers} inputSlots=${budget.inputSlots} outputSlots=${budget.outputSlots} usedSlots=${budget.usedSlots}/36 reserve=1 freeSlots=${budget.freeSlots} gridStackLimit=${budget.gridStackLimit}`)
              const inputs = this.allocate(step.inputs.map(input => ({ name: input.names[0], quantity: input.count * triggers })), heldAllocations)
              const stepId = `${index}:${trigger}+${triggers}`
              this.debug('controller.batch_budget', {
                operationId: id,
                stepId,
                result: `minecraft:${step.result.name}`,
                triggers,
                remainingTriggers: remaining,
                inputSlots: budget.inputSlots,
                outputSlots: budget.outputSlots,
                usedSlots: budget.usedSlots,
                freeSlots: budget.freeSlots,
                reserveSlots: 1,
                gridStackLimit: budget.gridStackLimit,
                inputs: this.summarizeItems(inputs)
              })
              const progressBefore = { stepIndex: index, nextTrigger: trigger }
              const progressAfter = trigger + triggers >= step.times
                ? { stepIndex: index + 1, nextTrigger: 0 }
                : { stepIndex: index, nextTrigger: trigger + triggers }
              const data = { ...operation.data, held: [], pending: null, physicalTotals: this.physicalTotals(), inputs,
                stepIndex: index, trigger, progress: progressBefore }
              operation = this.ledger.checkpoint(id, 'withdrawing', data)
              this.debug('controller.withdraw_start', { operationId: id, stepId, items: this.summarizeItems(inputs) })
              const withdrawal = await this.measurePhase('withdraw', { operationId: id, stepId },
                () => this.warehouse.withdrawAllocationsLocked(inputs, { requireServerEvidence: true }))
              const before = this.inventory()
              this.debug('controller.withdraw_confirmed', {
                operationId: id,
                stepId,
                items: this.summarizeItems(before),
                requested: this.summarizeItems(inputs),
                withdrawn: this.summarizeItems(withdrawal?.withdrawn || [])
              })
              if (!same(before, inputs)) throw new Error('仓库原料取出失败或不足。')
              check()
              const intent = this.executor.preview ? this.executor.preview(step, triggers) : {
                expectedConsumed: before,
                expectedProduced: [{ itemId: `minecraft:${step.result.name}`, amount: step.result.count * triggers }]
              }
              operation = this.ledger.checkpoint(id, 'crafting', { ...data, held: before,
                physicalTotals: this.physicalTotals(), pending: { stepId, before, ...intent, triggers,
                  progressBefore, progressAfter } })
              this.debug('controller.batch_start', {
                operationId: id,
                stepId,
                triggers,
                inputs: this.summarizeAmounts(before),
                expected: this.summarizeAmounts(intent.expectedProduced)
              })
              const result = await this.measurePhase('execute', { operationId: id, stepId },
                () => this.executor.execute({ step, triggers, signal: abort.signal, deadline, operationId: id, stepId }))
              check()
              if (!same(result.before, before) || !same(result.after, this.inventory())) throw new Error('合成前后物品证据不一致。')
              this.debug('controller.batch_confirmed', {
                operationId: id,
                stepId,
                triggers,
                consumed: this.summarizeAmounts(result.consumed),
                produced: this.summarizeAmounts(result.produced),
                inventory: this.summarizeItems(result.after)
              })
              const ledgerStartedAt = performance.now()
              operation = this.ledger.confirm(id, stepId, result.consumed, result.produced, {
                ...operation.data, before: result.before, after: result.after, held: result.after, pending: null,
                progress: progressAfter, physicalTotals: this.physicalTotals()
              })
              this.debug('controller.ledger_confirmed', { operationId: id, stepId, elapsedMs: performance.now() - ledgerStartedAt })
              operation = await this.store(operation, check, stepId)
              deadline = Date.now() + batchTimeoutMs
              request.onProgress?.({ index, trigger: trigger + triggers, steps: planned.command.craftSteps.length })
              trigger += triggers
            }
          }
          this.assertCleanInventory()
          const targetId = `minecraft:${planned.command.target.name}`
          const ownerTarget = this.db.getOwnerBalances(request.owner.uuid).filter(item => item.itemId === targetId).reduce((sum, item) => sum + item.amount, 0)
          const physicalTarget = this.physicalTotals().filter(item => item.itemId === targetId).reduce((sum, item) => sum + item.amount, 0)
          if (ownerTarget < request.quantity || physicalTarget < request.quantity) throw new Error('合成结束时目标库存未达到请求数量。')
          operation = this.ledger.finish(id, 'complete')
          this.debug('controller.operation_complete', {
            operationId: id,
            elapsedMs: performance.now() - requestStartedAt,
            target: planned.command.target,
            ownerTarget,
            physicalTarget
          })
          return { status: 'complete', operationId: id, target: operation.target }
        } catch (error) {
          this.debug('controller.operation_failure', {
            operationId: id,
            elapsedMs: performance.now() - requestStartedAt,
            phase: this.ledger.get(id)?.phase || null,
            message: error.message,
            partial: Boolean(error.partial),
            consumed: this.summarizeAmounts(error.consumed),
            produced: this.summarizeAmounts(error.produced),
            inventory: this.summarizeItems(this.inventory())
          })
          operation = this.ledger.get(id)
          const interrupted = abort.signal.aborted &&
            (error === abort.signal.reason || error?.message === abort.signal.reason?.message)
          // Only a provably unchanged transfer can be cleaned up automatically.
          // A prepared craft may already have consumed items: retain its journal.
          try {
            if (operation.phase === 'withdrawing' && !interrupted && !error.uncertainTransfer &&
              same(this.physicalTotals(), operation.data.physicalTotals)) {
              operation = this.ledger.checkpoint(id, 'storing', { ...operation.data, held: this.inventory(), pending: null, physicalTotals: this.physicalTotals() })
              operation = await this.store(operation, check)
              this.ledger.finish(id, 'failed', error.message)
              this.debug('controller.failed_operation_returned', { operationId: id, status: 'unchanged_inputs_returned' })
            } else if (error.partial && operation.data.pending && !interrupted) {
              // Keep the concrete pending journal until recovery can return
              // the live backpack and prove the exact trigger delta. Settling
              // here before store() is durable would leave a stale cursor if
              // the return fails after the partial conversion was booked.
              this.ledger.markRecovery(id, error.message, {
                ...operation.data, recoveryPhase: operation.phase, held: this.inventory()
              })
              this.debug('controller.partial_batch_pending_recovery', {
                operationId: id,
                stepId: operation.data.pending.stepId,
                consumed: this.summarizeAmounts(error.consumed),
                produced: this.summarizeAmounts(error.produced),
                progressBefore: operation.data.pending.progressBefore,
                progressAfter: operation.data.pending.progressAfter
              })
            } else if (!interrupted && operation.phase === 'ready' && !this.hasInventoryResidue()) {
              this.ledger.finish(id, 'failed', error.message)
            } else this.ledger.markRecovery(id, error.message, {
              ...operation.data, recoveryPhase: operation.phase, held: this.inventory()
            })
          } catch (cleanupError) {
            this.debug('controller.failure_cleanup_error', { operationId: id, message: cleanupError.message })
            const current = this.ledger.get(id)
            this.ledger.markRecovery(id, `${error.message}; ${cleanupError.message}`, {
              ...current.data, recoveryPhase: current.data.recoveryPhase || current.phase
            })
          }
          throw error
        }
      })
    } catch (error) {
      // 合成失败若已留下恢复记录（markRecovery），趁本机器人仍在线立即自动
      // 恢复，不再等掉线重连/进程重启/人工 !合成恢复——恢复记录挂着期间
      // assertNoPendingCraft 锁着全库，取货、回存、同步全部停摆（2026-11-05
      // 生产即此路径：活塞合成失败后自动恢复对账又失败，锁库 19 分钟靠掉线
      // 重连才解开）。recover() 自带回存+对账护栏+对账失败差异登记销账：
      // 正常情况当场闭环；主动取消（死亡/断线 invalidate 触发 cancel）除外，
      // 那类恢复由 service 层钩子在新连接上重做，这里不抢。
      const cancelled = abort.signal.aborted &&
        (error === abort.signal.reason || error?.message === abort.signal.reason?.message)
      this.active = null
      if (!cancelled && this.ledger.pending(this.botId).length) {
        this.debug('controller.auto_recovery_start', { pendingCount: this.ledger.pending(this.botId).length })
        try {
          const recovered = await this.measurePhase('auto_recovery', {}, () => withTimeout(this.recover(), AUTO_RECOVER_TIMEOUT_MS))
          this.debug('controller.auto_recovery_complete', {
            status: recovered.status,
            operationId: recovered.operationId || null,
            diffRegistered: Boolean(recovered.diffRegistered)
          })
            // A normal craft error is terminal for this request. Recovery has
            // already reconciled the physical items, so release the old
            // reservation instead of leaving a resumable journal that blocks
            // the warehouse. Death/disconnect cancellations bypass this branch
            // and are resumed by the service lifecycle hooks.
            if (recovered.status === 'resumable' && recovered.operationId) {
              const reconciled = this.ledger.get(recovered.operationId)
              if (reconciled && !['completed', 'complete', 'failed'].includes(reconciled.state)) {
                this.ledger.finish(recovered.operationId, 'failed', `合成失败后已完成实物恢复：${error.message}`)
              }
            }
        } catch (recoverError) {
          this.debug('controller.auto_recovery_failure', { message: recoverError.message })
          if (recoverError?.cancelled || abort.signal.aborted) {
            // 外层任务本身也被取消了（死亡/断线）：把记录留给新连接的钩子。
            error.message = `${error.message}；自动恢复未完成（留待重连或人工执行 !合成恢复）：${recoverError.message}`
          } else {
            // 重试+差异销账后仍然留有记录（如木桶登记为空、恢复自身网络失败）：
            // 记录保留但恢复已尽力，spawn/重连钩子会再试。给调用方完整链路。
            error.message = `${error.message}；自动恢复未完成（留待重连或人工执行 !合成恢复）：${recoverError.message}`
          }
        }
      }
      throw error
    } finally {
      if (this.active === lease) this.active = null
    }
  }

  // Continue a journal that recovery proved safe to resume. The operation id
  // and its reservations are reused; no new planning or warehouse reservation
  // is created, so a confirmed batch cannot be charged twice.
  async resume (operationId, onProgress) {
    if (this.active) throw new Error('合成任务尚未结束。')
    const requestStartedAt = performance.now()
    const id = String(operationId || '')
    let operation = this.ledger.get(id)
    if (!operation || operation.botId !== this.botId) throw new Error('找不到可续跑的原合成订单。')
    if (operation.state === 'completed' || operation.state === 'complete') return { status: 'complete', operationId: id, target: operation.target }
    const plan = operation.data?.plan
    if (!plan || !Array.isArray(plan.craftSteps)) throw new Error('原合成订单缺少可续跑的合成计划。')
    const saved = operation.data.progress
    if (operation.phase !== 'ready' || operation.data.pending || operation.data.held?.length) {
      throw new Error('原合成订单尚未完成安全恢复，不能继续执行。')
    }
    if (!saved || !Number.isSafeInteger(saved.stepIndex) || !Number.isSafeInteger(saved.nextTrigger) ||
      saved.stepIndex > plan.craftSteps.length ||
      (saved.stepIndex < plan.craftSteps.length && saved.nextTrigger > plan.craftSteps[saved.stepIndex].times)) {
      throw new Error('原合成订单缺少有效的续跑位置，不能继续执行。')
    }
    const start = saved
    const abort = new AbortController()
    const lease = { abort }
    this.active = lease
    const batchTimeoutMs = Number(plan.budgetMs) || Number(this.config?.craft?.timeoutMs) || 1200000
    let deadline = Date.now() + batchTimeoutMs
    const check = () => {
      if (abort.signal.aborted) throw abort.signal.reason
      if (Date.now() >= deadline) throw new Error('合成任务超时。')
    }
    const request = { owner: operation.owner, actor: operation.actor, onProgress }
    try {
      this.debug('controller.lock_wait_start', { operationId: id, resumed: true })
      const lockRequestedAt = performance.now()
      return await this.warehouse.withWarehouseLock(async () => {
        this.debug('controller.lock_acquired', { operationId: id, resumed: true, waitMs: performance.now() - lockRequestedAt })
        const resumeData = { ...operation.data }
        delete resumeData.recoveryIntent
        delete resumeData.recoveryBaseline
        delete resumeData.recoveryPhase
        delete resumeData.recoveryReconciled
        operation = this.ledger.checkpoint(id, 'ready', resumeData)
        await this.validateOwner?.(operation.owner, operation.actor)
        await this.measurePhase('preflight', { operationId: id, resumed: true }, () => this.settleResidue(check))
        this.assertCleanInventory()
        await this.measurePhase('home', { operationId: id, resumed: true }, () => this.warehouse.goHomeIfAway())
        for (let index = start.stepIndex; index < plan.craftSteps.length; index++) {
          const step = plan.craftSteps[index]
          let trigger = index === start.stepIndex ? start.nextTrigger : 0
          while (trigger < step.times) {
            check()
            this.assertCleanInventory()
            const remaining = step.times - trigger
            const heldAllocations = this.ledger.listCraftReservations(id)
              .map(row => ({ ...this.db.getItemByKey(row.itemKey), amount: row.amount }))
              .sort((a, b) => a.itemKey.localeCompare(b.itemKey))
            const triggers = Math.min(this.maxTriggersPerBatch(step, heldAllocations, remaining), remaining)
            const inputs = this.allocate(step.inputs.map(input => ({ name: input.names[0], quantity: input.count * triggers })), heldAllocations)
            const stepId = `${index}:${trigger}+${triggers}`
            const progressBefore = { stepIndex: index, nextTrigger: trigger }
            const progressAfter = trigger + triggers >= step.times
              ? { stepIndex: index + 1, nextTrigger: 0 }
              : { stepIndex: index, nextTrigger: trigger + triggers }
            const data = { ...operation.data, held: [], pending: null, physicalTotals: this.physicalTotals(), inputs,
              stepIndex: index, trigger, progress: progressBefore }
            operation = this.ledger.checkpoint(id, 'withdrawing', data)
            await this.measurePhase('withdraw', { operationId: id, stepId, resumed: true },
              () => this.warehouse.withdrawAllocationsLocked(inputs, { requireServerEvidence: true }))
            const before = this.inventory()
            if (!same(before, inputs)) throw new Error('仓库原料取出失败或不足。')
            check()
            const intent = this.executor.preview ? this.executor.preview(step, triggers) : {
              expectedConsumed: before,
              expectedProduced: [{ itemId: `minecraft:${step.result.name}`, amount: step.result.count * triggers }]
            }
            operation = this.ledger.checkpoint(id, 'crafting', { ...data, held: before,
              physicalTotals: this.physicalTotals(), pending: { stepId, before, ...intent, triggers, progressBefore, progressAfter } })
            try {
              const result = await this.measurePhase('execute', { operationId: id, stepId, resumed: true },
                () => this.executor.execute({ step, triggers, signal: abort.signal, deadline, operationId: id, stepId }))
              check()
              if (!same(result.before, before) || !same(result.after, this.inventory())) throw new Error('合成前后物品证据不一致。')
              const ledgerStartedAt = performance.now()
              operation = this.ledger.confirm(id, stepId, result.consumed, result.produced, {
                ...operation.data, before: result.before, after: result.after, held: result.after, pending: null,
                progress: progressAfter, physicalTotals: this.physicalTotals()
              })
              this.debug('controller.ledger_confirmed', { operationId: id, stepId, resumed: true, elapsedMs: performance.now() - ledgerStartedAt })
              operation = await this.store(operation, check, stepId)
              deadline = Date.now() + batchTimeoutMs
              onProgress?.({ index, trigger: trigger + triggers, steps: plan.craftSteps.length })
              trigger += triggers
            } catch (error) {
              operation = this.ledger.get(id)
              const interrupted = abort.signal.aborted &&
                (error === abort.signal.reason || error?.message === abort.signal.reason?.message)
              if (error.partial && operation?.data?.pending && !interrupted) {
                this.debug('controller.resume_partial_pending_reconciliation', {
                  operationId: id,
                  stepId: operation.data.pending.stepId,
                  consumed: this.summarizeAmounts(error.consumed),
                  produced: this.summarizeAmounts(error.produced),
                  progressBefore: operation.data.pending.progressBefore,
                  progressAfter: operation.data.pending.progressAfter
                })
              }
              this.ledger.markRecovery(id, error.message, {
                ...operation.data, recoveryPhase: operation.phase, held: this.inventory()
              })
              throw error
            }
          }
        }
        this.assertCleanInventory()
        const targetId = `minecraft:${plan.target.name}`
        const ownerTarget = this.db.getOwnerBalances(operation.owner.uuid).filter(item => item.itemId === targetId).reduce((sum, item) => sum + item.amount, 0)
        const physicalTarget = this.physicalTotals().filter(item => item.itemId === targetId).reduce((sum, item) => sum + item.amount, 0)
        if (ownerTarget < plan.target.quantity || physicalTarget < plan.target.quantity) throw new Error('合成结束时目标库存未达到请求数量。')
        operation = this.ledger.finish(id, 'complete')
        this.debug('controller.operation_complete', { operationId: id, resumed: true, elapsedMs: performance.now() - requestStartedAt, target: plan.target })
        return { status: 'complete', operationId: id, target: operation.target }
      })
    } catch (error) {
      // Resume has already passed recovery's evidence checks, but navigation,
      // withdrawal, preview or the final return can still fail transiently.
      // Keep the original reservation and cursor durable so the next spawn or
      // explicit recovery can retry from the last confirmed batch.
      this.debug('controller.operation_failure', { operationId: id, resumed: true, elapsedMs: performance.now() - requestStartedAt, message: error.message })
      const current = this.ledger.get(id)
      if (current && !['completed', 'complete', 'failed'].includes(current.state)) {
        try {
          this.ledger.markRecovery(id, error.message, {
            ...current.data,
            recoveryPhase: current.data.recoveryPhase || current.phase,
            held: this.inventory()
          })
        } catch (journalError) {
          this.debug('controller.resume_recovery_journal_failure', {
            operationId: id,
            message: journalError.message
          })
        }
      }
      throw error
    } finally {
      if (this.active === lease) this.active = null
    }
  }

  async store (operation, check = () => {}, stepId = null) {
    return this.measurePhase('return', { operationId: operation.id, stepId }, async () => {
      check()
      const before = this.inventory()
      if (!same(before, operation.data.held)) throw new Error('回库前背包与合成记录不一致。')
      this.debug('controller.return_start', {
        operationId: operation.id,
        phase: operation.phase,
        items: this.summarizeItems(before)
      })
      const baseline = this.physicalTotals()
      operation = this.ledger.checkpoint(operation.id, 'storing', { ...operation.data, held: before, physicalTotals: baseline })
      const deposited = await this.warehouse.depositAllPossible({ requireServerEvidence: true, check })
      check()
      if (!same(this.physicalTotals(), baseline)) throw new Error('合成回库实物总量校验失败。')
      const held = this.inventory()
      operation = this.ledger.checkpoint(operation.id, 'storing', { ...operation.data, held, physicalTotals: baseline })
      if (held.length) throw new Error('仓库空间不足，合成物品保留在机器人背包并等待恢复。')
      this.assertCleanInventory()
      check()
      this.debug('controller.return_complete', {
        operationId: operation.id,
        deposited: this.summarizeItems(deposited?.deposited || before),
        remaining: this.summarizeItems(held),
        physicalTotalsConfirmed: true
      })
      return this.ledger.checkpoint(operation.id, 'ready', { ...operation.data, held: [], pending: null })
    })
  }

  async recover () {
    if (this.active || this.executor?.isBusy()) throw new Error('旧合成操作尚未结束，不能开始恢复。')
    this.debug('controller.recovery_start', { botId: this.botId, pendingCount: this.ledger.pending(this.botId).length })
    const lease = { abort: new AbortController() }
    this.active = lease
    const check = () => {
      if (lease.abort.signal.aborted) {
        const reason = lease.abort.signal.reason
        if (reason instanceof Error) reason.cancelled = true
        throw reason
      }
      this.warehouse.assertConnectionHealthy?.()
    }
    try {
      // All retries and the fallback share one lease/lock. A gap between them
      // would invalidate the warehouse baseline used by the final reconciliation.
      return await this.warehouse.withWarehouseLock(async () => {
        let lastError
        for (let attempt = 0; attempt < RECOVER_RETRY_ATTEMPTS; attempt++) {
          try {
            check()
            this.debug('controller.recovery_attempt', { attempt: attempt + 1, maxAttempts: RECOVER_RETRY_ATTEMPTS })
            const result = await this.recoverLocked(check)
            this.debug('controller.recovery_complete', { status: result.status, operationId: result.operationId || null, diffRegistered: Boolean(result.diffRegistered) })
            return result
          } catch (error) {
            lastError = error
            this.debug('controller.recovery_attempt_failure', {
              attempt: attempt + 1,
              maxAttempts: RECOVER_RETRY_ATTEMPTS,
              message: error.message,
              recoveryMismatch: Boolean(error.recoveryMismatch),
              inventory: this.summarizeItems(this.inventory())
            })
            if (error?.cancelled || lease.abort.signal.aborted) throw error
            if (!this.ledger.pending(this.botId).length) throw error
            if (attempt + 1 < RECOVER_RETRY_ATTEMPTS) await sleep(RECOVER_RETRY_DELAY_MS)
          }
        }
        check()
        if (!this.canSettleRecoveryFailure(lastError)) throw lastError
        // Reconcile only net changes since this journal's baseline. Unvisited
        // barrels retain their cached slots and must not create false shortages.
        const actual = this.physicalTotals()
        check()
        this.assertCleanInventory()
        this.debug('controller.recovery_diff_settlement', {
          message: lastError.message,
          actual: this.summarizeItems(actual)
        })
        const result = this.settleRecoveryDiff(lastError, actual, check)
        this.debug('controller.recovery_complete', { status: result.status, operationId: result.operationId, diffRegistered: Boolean(result.diffRegistered) })
        return result
      })
    } finally {
      if (this.active === lease) this.active = null
    }
  }

  canSettleRecoveryFailure (error) {
    return Boolean(error?.recoveryMismatch && this.ledger.pending(this.botId).length === 1 &&
      !this.hasInventoryResidue() && this.db.listChests().length)
  }

  settleRecoveryDiff (error, actual, check) {
    const operation = this.ledger.pending(this.botId)[0]
    if (!operation || !Array.isArray(actual)) throw new Error('恢复差异结算缺少本轮实物账本。')
    const baseline = operation.data.recoveryIntent?.baseline || operation.data.recoveryBaseline || operation.data.physicalTotals
    if (!Array.isArray(baseline)) throw new Error('恢复差异结算缺少原始实物基线。')
    return this.ledger.transaction(() => {
      check()
      const result = this.db.reconcileRecoveryDeltaToMomo(baseline, actual, operation.id)
      this.ledger.checkpoint(operation.id, 'ready', { ...operation.data, held: [], pending: null,
        physicalTotals: actual, recoveryBaseline: baseline, recoveryReconciled: true })
      this.ledger.finish(operation.id, 'failed', `恢复对账重试 ${RECOVER_RETRY_ATTEMPTS} 次未通过，已同步实物账目并登记差异：${error.message}`)
      return { status: 'recovered', operationId: operation.id,
        diffRegistered: Boolean(result.addedToMomo.length || result.removedFromMomo.length || result.unresolved.length) }
    })
  }

  async recoverLocked (check) {
    check()
    const operations = this.ledger.pending(this.botId)
    if (!operations.length) {
      this.debug('controller.recovery_empty', { botId: this.botId })
      return { status: 'empty' }
    }
    if (operations.length !== 1) throw new Error('同一机器人存在多个合成恢复记录，需要人工核对。')
    let operation = operations[0]
    this.debug('controller.recovery_journal', {
      operationId: operation.id,
      phase: operation.phase,
      held: this.summarizeItems(this.inventory()),
      stepId: operation.data.pending?.stepId || null
    })
    this.db.assertNoPendingCraft(operation.id)
    const saved = operation.data.recoveryIntent
    const baseline = saved?.baseline || operation.data.recoveryBaseline || operation.data.physicalTotals
    if (!baseline) throw new Error('恢复记录缺少实物基线，需要人工核对。')
    await this.assertSettledResidue(check)
    check()
    await this.warehouse.goHomeIfAway()
    check()
    if (!this.db.listChests().length) throw new Error('恢复没有可用的入库木桶；请先登记可用容器。')
    if (!saved) {
      operation = this.ledger.checkpoint(operation.id, operation.phase, { ...operation.data, recoveryIntent: {
        phase: operation.data.recoveryPhase || operation.phase,
        baseline, pending: operation.data.pending || null, observed: this.inventory(),
        progress: operation.data.progress || null
      } })
    }
    const intent = operation.data.recoveryIntent
    const depositBaseline = this.physicalTotals()
    operation = this.ledger.checkpoint(operation.id, 'storing', {
      ...operation.data, held: this.inventory(), pending: null, physicalTotals: depositBaseline,
      recoveryBaseline: baseline
    })
    this.debug('controller.recovery_return_start', { operationId: operation.id, items: this.summarizeItems(this.inventory()) })
    const deposited = await this.warehouse.depositAllPossible({ requireServerEvidence: true })
    check()
    if (this.inventory().length) throw new Error('仓库空间不足，恢复的物品保留在机器人背包并等待恢复。')
    this.assertCleanInventory()
    const actual = this.physicalTotals()
    this.debug('controller.recovery_return_complete', {
      operationId: operation.id,
      deposited: this.summarizeItems(deposited?.deposited || []),
      actual: this.summarizeItems(actual),
      physicalTotalsConfirmed: same(actual, depositBaseline)
    })
    const mismatch = message => Object.assign(new Error(message), { recoveryMismatch: true })
    if (!same(actual, depositBaseline)) throw mismatch('合成回库实物总量校验失败。')
    const pending = intent.pending
    let conversion = false
    let partialConversion = false
    let completedTriggers = 0
    if (intent.phase === 'crafting' || pending) {
      if (!pending) throw new Error('恢复记录缺少合成意图。')
      const triggers = Number(pending.triggers)
      let provenProgress = null
      let stateProven = false
      const canScale = Number.isSafeInteger(triggers) && triggers > 0 &&
        Array.isArray(pending.expectedConsumed) && Array.isArray(pending.expectedProduced) &&
        pending.expectedConsumed.every(item => item?.itemKey && item.itemId && Number.isSafeInteger(item.amount) && item.amount > 0) &&
        pending.expectedProduced.every(item => item?.itemKey && item.itemId && Number.isSafeInteger(item.amount) && item.amount > 0 && item.amount % triggers === 0) &&
        pending.progressBefore && Number.isSafeInteger(pending.progressBefore.stepIndex) &&
        Number.isSafeInteger(pending.progressBefore.nextTrigger)
      if (canScale) {
        const matches = []
        for (let done = 0; done <= triggers; done++) {
          const produced = scaledProducedItems(pending.expectedProduced, triggers, done)
          const consumed = deriveObservedConsumption(pending.before, intent.observed, produced,
            pending.expectedConsumed, triggers, done)
          if (!consumed || !produced) continue
          const expectedInventory = converted(pending.before, consumed, produced)
          if (!same(actual, converted(baseline, consumed, produced)) || !same(intent.observed, expectedInventory)) continue
          const absoluteTrigger = pending.progressBefore.nextTrigger + done
          const step = operation.data.plan?.craftSteps?.[pending.progressBefore.stepIndex]
          const progress = step && absoluteTrigger >= step.times
            ? { stepIndex: pending.progressBefore.stepIndex + 1, nextTrigger: 0 }
            : { stepIndex: pending.progressBefore.stepIndex, nextTrigger: absoluteTrigger }
          matches.push({ done, consumed, produced, progress })
        }
        if (matches.length === 1) {
          const match = matches[0]
          stateProven = true
          completedTriggers = match.done
          provenProgress = match.progress
          conversion = match.done === triggers
          partialConversion = match.done > 0 && match.done < triggers
          pending.recoveryConsumed = match.consumed
          pending.recoveryProduced = match.produced
        }
        this.debug('controller.recovery_progress_match', {
          operationId: operation.id,
          candidateCount: matches.length,
          completedTriggers: matches.length === 1 ? matches[0].done : null
        })
      } else {
        this.debug('controller.recovery_candidate_rejected', {
          operationId: operation.id,
          triggers,
          expectedConsumed: this.summarizeItems(pending.expectedConsumed || []),
          expectedProduced: this.summarizeItems(pending.expectedProduced || [])
        })
      }
      if (!stateProven && same(actual, baseline) && same(intent.observed, pending.before)) {
        stateProven = true
        completedTriggers = 0
        provenProgress = pending.progressBefore || intent.progress || operation.data.progress || null
      }
      if (!stateProven && same(actual, converted(baseline, pending.expectedConsumed, pending.expectedProduced)) &&
        same(intent.observed, pending.expectedProduced)) {
        stateProven = true
        conversion = true
        completedTriggers = Number.isSafeInteger(triggers) ? triggers : 0
        provenProgress = pending.progressAfter || intent.progress || operation.data.progress || null
      }
      if (!stateProven) {
        this.debug('controller.recovery_mismatch', {
          operationId: operation.id,
          baseline: this.summarizeItems(baseline),
          actual: this.summarizeItems(actual),
          observed: this.summarizeItems(intent.observed || []),
          expectedConsumed: this.summarizeItems(pending.expectedConsumed || []),
          expectedProduced: this.summarizeItems(pending.expectedProduced || [])
        })
        throw mismatch('无法确认中断合成的实际消耗和产出；已回库，需要同步核对。')
      }
      pending.recoveryProgress = provenProgress
    } else if (!same(actual, baseline)) throw mismatch('中断取存的实物与记录不一致，需要同步核对。')
    check()
    const resumable = Array.isArray(operation.data.plan?.craftSteps) &&
      operation.data.progress && Number.isSafeInteger(operation.data.progress.stepIndex) &&
      Number.isSafeInteger(operation.data.progress.nextTrigger)
    if (resumable && (intent.phase === 'withdrawing' || intent.phase === 'crafting' || !pending)) {
      // Keep the journal open. A safe unchanged withdrawal is retried from its
      // original cursor; a proven conversion is committed above and resumes
      // from the cursor after that batch. Unknown deltas never reach here.
      const nextProgress = pending?.recoveryProgress ||
        (conversion ? (pending.progressAfter || operation.data.progress) : (pending?.progressBefore || operation.data.progress))
      this.ledger.transaction(() => {
        if (conversion || partialConversion) {
          operation = this.ledger.checkpoint(operation.id, 'crafting', { ...operation.data, held: pending.before, pending })
          if (partialConversion) {
            operation = this.ledger.confirmPartial(operation.id, pending.stepId,
              pending.recoveryConsumed, pending.recoveryProduced, {
                ...operation.data, before: pending.before, after: intent.observed, held: intent.observed,
                pending: null, progress: nextProgress, physicalTotals: actual
              })
          } else {
            operation = this.ledger.confirm(operation.id, pending.stepId, pending.expectedConsumed, intent.observed, {
              ...operation.data, before: pending.before, after: intent.observed, held: [], pending: null,
              progress: nextProgress, physicalTotals: actual, recovery: true
            })
          }
        }
        operation = this.ledger.checkpoint(operation.id, 'ready', { ...operation.data, held: [], pending: null,
          progress: nextProgress, physicalTotals: actual, recoveryReconciled: true })
      })
      this.debug('controller.recovery_resumable', {
        operationId: operation.id,
        conversionConfirmed: conversion,
        partialConversion,
        completedTriggers,
        progress: nextProgress
      })
      return { status: 'resumable', operationId: operation.id, ...nextProgress, conversionConfirmed: conversion }
    }
    // A crash/finish failure must not leave a committed conversion with the old
    // pre-conversion recovery intent. Roll back all ledger changes together.
    this.ledger.transaction(() => {
      if (conversion) {
        operation = this.ledger.checkpoint(operation.id, 'crafting', { ...operation.data, held: pending.before, pending })
        operation = this.ledger.confirm(operation.id, pending.stepId, pending.expectedConsumed, intent.observed, {
          ...operation.data, before: pending.before, after: intent.observed, held: [], pending: null,
          physicalTotals: actual, recovery: true
        })
      }
      operation = this.ledger.checkpoint(operation.id, 'ready', { ...operation.data, held: [], pending: null, physicalTotals: actual })
      this.ledger.finish(operation.id, 'failed', 'interrupted craft safely returned; request may be submitted again')
    })
    this.debug('controller.recovery_reconciled', {
      operationId: operation.id,
      conversionConfirmed: conversion,
      observed: this.summarizeItems(intent.observed || []),
      expected: this.summarizeItems(pending?.expectedProduced || [])
    })
    return { status: 'recovered', operationId: operation.id }
  }
}

module.exports = { CraftController, merge, same, converted }

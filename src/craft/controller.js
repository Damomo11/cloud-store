'use strict'

const { randomUUID } = require('node:crypto')
const CraftLedger = require('./ledger')
const { planToCraftCommand } = require('./index')
const { readServerContainer } = require('./server-container-evidence')

function merge (items) {
  const totals = new Map()
  for (const item of items || []) {
    if (!item?.itemKey || !Number.isSafeInteger(item.amount) || item.amount < 0) throw new Error('invalid craft inventory snapshot')
    if (!item.amount) continue
    const previous = totals.get(item.itemKey)
    totals.set(item.itemKey, { ...item, amount: (previous?.amount || 0) + item.amount })
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

class CraftController {
  constructor ({ bot, db, catalog, config, warehouse, executor, botId, ledger, validateOwner, quota }) {
    Object.assign(this, { bot, db, catalog, config, warehouse, executor, botId, validateOwner, quota })
    this.ledger = ledger || new CraftLedger(db)
    this.active = null
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
  async settleResidue () {
    if (this.bot.currentWindow) {
      try { this.bot.closeWindow(this.bot.currentWindow) } catch {}
      await new Promise(resolve => setTimeout(resolve, 150))
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
    await this.bot.clickWindow(target, 0, 0)
  }

  // One settle attempt must clear window + cursor; crafting-grid phantoms are
  // server-side-packet staleness and get corrected by the container re-read.
  async assertSettledResidue () {
    await this.settleResidue()
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
    const slots = this.db.listChestSlots().filter(row => Number(row.amount) > 0).map(row => ({
      ...this.db.getItemByKey(row.itemKey), itemKey: row.itemKey, amount: Number(row.amount)
    }))
    return merge([...slots, ...this.inventory()])
  }

  checkQuota (owner, plan) {
    if (!this.quota) return
    const quota = this.quota(owner)
    if (!Number.isSafeInteger(quota.quotaSlots) || quota.quotaSlots < 0) throw new Error('仓库额度配置无效。')
    const Item = require('prismarine-item')(this.catalog.mcData)
    const amount = new Map(this.db.getOwnerBalances(owner.uuid).map(row => [row.itemKey, { ...row }]))
    // Simulate the same concrete reservations and item-key order used at runtime.
    // A final-only estimate misses peaks while some inputs still occupy slots.
    const reserved = new Map(this.allocate(plan.inventoryUses, this.availableItems(owner.uuid)).map(row => [row.itemKey, { ...row }]))
    for (const step of plan.craftSteps) {
      // Batch granularity mirrors execution: each batch deducts its full input
      // set at once, then credits outputs after the batch's triggers complete.
      for (let start = 0; start < step.times; start += this.maxTriggersPerBatch(step)) {
        const triggers = Math.min(this.maxTriggersPerBatch(step), step.times - start)
        const inputs = this.allocate(step.inputs.map(input => ({ name: input.names[0], quantity: input.count * triggers })),
          [...reserved.values()].sort((a, b) => a.itemKey.localeCompare(b.itemKey)))
        for (const input of inputs) {
          amount.get(input.itemKey).amount -= input.amount
          reserved.get(input.itemKey).amount -= input.amount
        }
        for (const output of step.outputs || [step.result]) {
          const resolved = this.catalog.resolveName(output.name)
          const item = this.catalog.fromPrismarineItem(new Item(resolved.type, output.count * triggers, output.metadata))
          for (const pool of [amount, reserved]) {
            const previous = pool.get(item.itemKey)
            pool.set(item.itemKey, { ...item, amount: (previous?.amount || 0) + output.count * triggers })
          }
        }
        const used = [...amount.values()].reduce((sum, item) => sum + Math.ceil(item.amount / Math.max(1, this.catalog.getStackSize(item.itemId))), 0)
        if (used > quota.quotaSlots) throw new Error(`合成过程中的仓库占用超出额度（${used}/${quota.quotaSlots} 槽）。`)
      }
    }
  }

  // Backpack-window capacity: 36 usable slots (9..45). One batch withdraws all
  // of its inputs at once and carries produced outputs alongside them before
  // the final store, so inputs+outputs must fit together at peak.
  maxTriggersPerBatch (step) {
    const INVENTORY_SLOTS = 36
    const slotsFor = (items) => items.reduce((sum, entry) =>
      sum + Math.ceil(entry.amount / Math.max(1, this.catalog.getStackSize(entry.itemId))), 0)
    const inputTotals = new Map()
    for (const input of step.inputs) {
      const resolved = this.catalog.resolveName(input.names[0])
      const previous = inputTotals.get(resolved.name)
      inputTotals.set(resolved.name, { itemId: `minecraft:${resolved.name}`, amount: (previous?.amount || 0) + input.count })
    }
    const outputTotals = new Map()
    for (const output of step.outputs || [step.result]) {
      const previous = outputTotals.get(output.name)
      outputTotals.set(output.name, { itemId: `minecraft:${output.name}`, amount: (previous?.amount || 0) + output.count })
    }
    const perTriggerSlots = slotsFor([...inputTotals.values()]) + slotsFor([...outputTotals.values()])
    // A recipe never exceeds 9 input slots + 9 output slots per trigger, so
    // one trigger always fits; scale until inputs+outputs would overflow.
    if (perTriggerSlots > INVENTORY_SLOTS) return 1
    return Math.max(1, Math.floor(INVENTORY_SLOTS / perTriggerSlots))
  }

  async run (request) {
    if (this.active) throw new Error('合成任务尚未结束。')
    const abort = new AbortController()
    const lease = { abort }
    this.active = lease
    try {
      return await this.warehouse.withWarehouseLock(async () => {
        if (this.ledger.pending().length) throw new Error('存在未恢复的合成任务，请先执行 !合成恢复。')
        await this.validateOwner?.(request.owner, request.actor)
        // 开工先自愈窗口/光标残留：多为上次取货/拆盒操作遗留的窗口未关或光标
        // 未归位（服务器包 staleness 的幻影），关窗重读即可纠正。之前直接断言
        // 会把幻影当真残留拒绝开工（2026-11-05 金苹果合成即被此路径打挂）。
        // 真背包物品残留 settle 后依然 fail-fast，不会误开工。
        await this.settleResidue()
        this.assertCleanInventory()
        const rows = this.availableItems(request.owner.uuid)
        const planned = planToCraftCommand({ item: request.item, quantity: request.quantity, available: this.availableStock(request.owner.uuid), config: this.config, forceCraft: true })
        if (!planned.ok) {
          // A stocked target is not a failure: the planner already reported
          // already_in_warehouse for zero-craft-step plans, but any other
          // rejection (missing inputs, unreachable recipe) stops the order.
          if (planned.reason === 'already_in_warehouse') return { status: 'already_sufficient' }
          const failure = new Error('仓库原料不足或配方不可达；合成仅使用散装库存。')
          failure.reason = planned.reason
          throw failure
        }
        this.checkQuota(request.owner, planned.plan)
        const allocations = this.allocate(planned.plan.inventoryUses, rows)
        const id = `craft:${randomUUID()}`
        let operation = this.ledger.begin({ id, botId: this.botId, owner: request.owner, actor: request.actor, target: planned.command.target, allocations,
          data: { held: [], pending: null, physicalTotals: this.physicalTotals(), stepIndex: 0, plan: planned.command } })
        const deadline = Date.now() + planned.command.budgetMs
        const check = () => {
          if (abort.signal.aborted) throw abort.signal.reason
          if (Date.now() >= deadline) throw new Error('合成任务超时。')
        }
        try {
          await this.warehouse.goHomeIfAway()
          for (const [index, step] of planned.command.craftSteps.entries()) {
            let trigger = 0
            while (trigger < step.times) {
              const triggers = Math.min(this.maxTriggersPerBatch(step), step.times - trigger)
              check()
              this.assertCleanInventory()
              const heldAllocations = this.ledger.listCraftReservations(id).map(row => ({ ...this.db.getItemByKey(row.itemKey), amount: row.amount }))
              const inputs = this.allocate(step.inputs.map(input => ({ name: input.names[0], quantity: input.count * triggers })), heldAllocations)
              const data = { ...operation.data, held: [], pending: null, physicalTotals: this.physicalTotals(), inputs, stepIndex: index, trigger }
              operation = this.ledger.checkpoint(id, 'withdrawing', data)
              await this.warehouse.withdrawAllocationsLocked(inputs, { requireServerEvidence: true })
              const before = this.inventory()
              if (!same(before, inputs)) throw new Error('仓库原料取出失败或不足。')
              check()
              const intent = this.executor.preview ? this.executor.preview(step, triggers) : {
                expectedConsumed: before,
                expectedProduced: [{ itemId: `minecraft:${step.result.name}`, amount: step.result.count * triggers }]
              }
              const stepId = `${index}:${trigger}+${triggers}`
              operation = this.ledger.checkpoint(id, 'crafting', { ...data, held: before,
                physicalTotals: this.physicalTotals(), pending: { stepId, before, ...intent } })
              const result = await this.executor.execute({ step, triggers, signal: abort.signal, deadline })
              if (!same(result.before, before) || !same(result.after, this.inventory())) throw new Error('合成前后物品证据不一致。')
              operation = this.ledger.confirm(id, stepId, result.consumed, result.produced, {
                ...operation.data, before: result.before, after: result.after, held: result.after, pending: null,
                physicalTotals: this.physicalTotals()
              })
              operation = await this.store(operation)
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
          return { status: 'complete', operationId: id, target: operation.target }
        } catch (error) {
          operation = this.ledger.get(id)
          // Only a provably unchanged transfer can be cleaned up automatically.
          // A prepared craft may already have consumed items: retain its journal.
          try {
            if (operation.phase === 'withdrawing' && !error.uncertainTransfer && same(this.physicalTotals(), operation.data.physicalTotals)) {
              operation = this.ledger.checkpoint(id, 'storing', { ...operation.data, held: this.inventory(), pending: null, physicalTotals: this.physicalTotals() })
              operation = await this.store(operation)
              this.ledger.finish(id, 'failed', error.message)
            } else if (error.partial && operation.data.pending) {
              // Batched craft failed midway but the executor captured concrete
              // before/after inventories: settle what actually happened right
              // now instead of leaving a recovery journal behind.
              const pending = operation.data.pending
              const consumed = error.consumed
              // The executor's after snapshot IS the live backpack (it stopped
              // right before rethrowing), so physicalTotals already includes
              // these items; store() then deposits them into the warehouse.
              operation = this.ledger.confirmPartial(id, pending.stepId, consumed, error.produced, {
                ...operation.data, before: pending.before, after: error.after, held: error.after, pending: null,
                physicalTotals: this.physicalTotals()
              })
              operation = await this.store(operation)
              this.ledger.finish(id, 'failed', `部分批次已按实际消耗产出销账：${error.message}`)
            } else if (operation.phase === 'ready' && !this.hasInventoryResidue()) {
              this.ledger.finish(id, 'failed', error.message)
            } else this.ledger.markRecovery(id, error.message, { ...operation.data, held: this.inventory() })
          } catch (cleanupError) {
            this.ledger.markRecovery(id, `${error.message}; ${cleanupError.message}`, this.ledger.get(id).data)
          }
          throw error
        }
      })
    } finally {
      if (this.active === lease) this.active = null
    }
  }

  async store (operation) {
    const before = this.inventory()
    if (!same(before, operation.data.held)) throw new Error('回库前背包与合成记录不一致。')
    const baseline = this.physicalTotals()
    operation = this.ledger.checkpoint(operation.id, 'storing', { ...operation.data, held: before, physicalTotals: baseline })
    await this.warehouse.depositAllPossible({ requireServerEvidence: true })
    if (!same(this.physicalTotals(), baseline)) throw new Error('合成回库实物总量校验失败。')
    const held = this.inventory()
    operation = this.ledger.checkpoint(operation.id, 'storing', { ...operation.data, held, physicalTotals: baseline })
    if (held.length) throw new Error('仓库空间不足，合成物品保留在机器人背包并等待恢复。')
    this.assertCleanInventory()
    return this.ledger.checkpoint(operation.id, 'ready', { ...operation.data, held: [], pending: null })
  }

  async recover () {
    if (this.active || this.executor?.isBusy()) throw new Error('旧合成操作尚未结束，不能开始恢复。')
    const lease = { abort: new AbortController() }
    this.active = lease
    const check = () => { if (lease.abort.signal.aborted) throw lease.abort.signal.reason }
    try {
      return await this.warehouse.withWarehouseLock(() => this.recoverLocked(check))
    } finally {
      if (this.active === lease) this.active = null
    }
  }

  async recoverLocked (check) {
    check()
    const operations = this.ledger.pending(this.botId)
    if (!operations.length) return { status: 'empty' }
    if (operations.length !== 1) throw new Error('同一机器人存在多个合成恢复记录，需要人工核对。')
    let operation = operations[0]
    const phase = operation.data.recoveryPhase || operation.phase
    const baseline = operation.data.physicalTotals
    if (!baseline) throw new Error('恢复记录缺少实物基线，需要人工核对。')
    await this.assertSettledResidue()
    await this.warehouse.goHomeIfAway()
    check()
    const heldBeforeDeposit = this.inventory()
    // Keep a copy of the interrupted intent: the checkpoints below clear
    // data.pending so the store/finish path never sees a live conversion.
    const pendingIntent = operation.data.pending || null
    // Mirrors withdraw interruption recovery (depositInventoryWithoutBalance):
    // park the interrupted backpack into the warehouse FIRST, then reconcile
    // the ledger against the combined totals. The old flow instead walked
    // around opening every chest for server snapshots before deciding; the
    // deposit path already verifies each chest server-side as it stores, so
    // recovery cost is bounded by what the backpack actually holds.
    if (!this.db.listChests().length) throw new Error('恢复没有可用的入库木桶；请先登记可用容器。')
    const depositBaseline = this.physicalTotals()
    operation = this.ledger.checkpoint(operation.id, 'storing', {
      ...operation.data, held: heldBeforeDeposit, pending: null, physicalTotals: depositBaseline
    })
    await this.warehouse.depositAllPossible({ requireServerEvidence: true })
    if (!same(this.physicalTotals(), depositBaseline)) throw new Error('合成回库实物总量校验失败。')
    const leftover = this.inventory()
    if (leftover.length) throw new Error('仓库空间不足，恢复的物品保留在机器人背包并等待恢复。')
    this.assertCleanInventory()
    operation = this.ledger.checkpoint(operation.id, 'ready', { ...operation.data, held: [], pending: null })
    check()
    // Reconcile the journal now that every interrupted item is back in the
    // warehouse ledger. physicalTotals reads the same DB slots the deposit
    // updated, so totals still include everything the bot was holding.
    const actual = this.physicalTotals()
    if (phase === 'crafting' || pendingIntent) {
      const pending = pendingIntent
      if (!pending) throw new Error('恢复记录缺少合成意图。')
      if (same(actual, baseline)) {
        // Nothing was consumed: the withdrawal had not reached the table.
      } else if (pending.expectedProduced.every(item => item.itemKey) &&
        same(actual, converted(baseline, pending.expectedConsumed, pending.expectedProduced)) &&
        same(heldBeforeDeposit, pending.expectedProduced)) {
        // confirm validates against the crafting journal, so re-enter that
        // phase with the pre-deposit backpack before settling the conversion.
        operation = this.ledger.checkpoint(operation.id, 'crafting', {
          ...operation.data, held: pending.before, pending, physicalTotals: depositBaseline
        })
        operation = this.ledger.confirm(operation.id, pending.stepId, pending.expectedConsumed, heldBeforeDeposit, {
          ...operation.data, before: pending.before, after: heldBeforeDeposit, held: [], pending: null, physicalTotals: actual, recovery: true
        })
        // confirm left phase 'storing' with a pre-deposit held snapshot; the
        // items are physically back in the warehouse already, so re-mark the
        // journal ready (empty held) before finishing.
        operation = this.ledger.checkpoint(operation.id, 'ready', { ...operation.data, held: [], pending: null, physicalTotals: actual })
      } else throw new Error('无法确认中断合成的实际消耗和产出；已回库并保留归属及预留，需要人工核对。')
    } else if (!same(actual, baseline)) throw new Error('中断取存的实物与记录不一致，需要人工核对。')
    this.ledger.finish(operation.id, 'failed', 'interrupted craft safely returned; request may be submitted again')
    return { status: 'recovered', operationId: operation.id }
  }
}

module.exports = { CraftController, merge, same, converted }

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

  assertCleanInventory () {
    if (this.hasInventoryResidue()) throw new Error('需先处理机器人背包、窗口、光标或合成格残留物品。')
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
      for (let trigger = 0; trigger < step.times; trigger++) {
        const inputs = this.allocate(step.inputs.map(input => ({ name: input.names[0], quantity: input.count })),
          [...reserved.values()].sort((a, b) => a.itemKey.localeCompare(b.itemKey)))
        for (const input of inputs) {
          amount.get(input.itemKey).amount -= input.amount
          reserved.get(input.itemKey).amount -= input.amount
        }
        for (const output of step.outputs || [step.result]) {
          const resolved = this.catalog.resolveName(output.name)
          const item = this.catalog.fromPrismarineItem(new Item(resolved.type, output.count, output.metadata))
          for (const pool of [amount, reserved]) {
            const previous = pool.get(item.itemKey)
            pool.set(item.itemKey, { ...item, amount: (previous?.amount || 0) + output.count })
          }
        }
        const used = [...amount.values()].reduce((sum, item) => sum + Math.ceil(item.amount / Math.max(1, this.catalog.getStackSize(item.itemId))), 0)
        if (used > quota.quotaSlots) throw new Error(`合成过程中的仓库占用超出额度（${used}/${quota.quotaSlots} 槽）。`)
      }
    }
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
        this.assertCleanInventory()
        const rows = this.availableItems(request.owner.uuid)
        const planned = planToCraftCommand({ item: request.item, quantity: request.quantity, available: this.availableStock(request.owner.uuid), config: this.config })
        if (!planned.ok) {
          if (planned.reason === 'already_in_warehouse') return { status: 'already_sufficient' }
          const failure = new Error(planned.reason === 'no_workstation_configured' ? '该配方需要配置工作台。' : '仓库原料不足或配方不可达；合成仅使用散装库存。')
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
            for (let trigger = 0; trigger < step.times; trigger++) {
              check()
              this.assertCleanInventory()
              const heldAllocations = this.ledger.listCraftReservations(id).map(row => ({ ...this.db.getItemByKey(row.itemKey), amount: row.amount }))
              const inputs = this.allocate(step.inputs.map(input => ({ name: input.names[0], quantity: input.count })), heldAllocations)
              const data = { ...operation.data, held: [], pending: null, physicalTotals: this.physicalTotals(), inputs, stepIndex: index, trigger }
              operation = this.ledger.checkpoint(id, 'withdrawing', data)
              await this.warehouse.withdrawAllocationsLocked(inputs, { requireServerEvidence: true })
              const before = this.inventory()
              if (!same(before, inputs)) throw new Error('仓库原料取出失败或不足。')
              check()
              const intent = this.executor.preview ? this.executor.preview(step) : {
                expectedConsumed: before, expectedProduced: [{ itemId: `minecraft:${step.result.name}`, amount: step.result.count }]
              }
              const stepId = `${index}:${trigger}`
              operation = this.ledger.checkpoint(id, 'crafting', { ...data, held: before,
                physicalTotals: this.physicalTotals(), pending: { stepId, before, ...intent } })
              const result = await this.executor.execute({ step, signal: abort.signal, deadline })
              if (!same(result.before, before) || !same(result.after, this.inventory())) throw new Error('合成前后物品证据不一致。')
              operation = this.ledger.confirm(id, stepId, result.consumed, result.produced, {
                ...operation.data, before: result.before, after: result.after, held: result.after, pending: null,
                physicalTotals: this.physicalTotals()
              })
              operation = await this.store(operation)
              request.onProgress?.({ index, trigger, steps: planned.command.craftSteps.length })
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
    if (this.bot.currentWindow || this.bot.inventory.selectedItem || this.bot.inventory.slots?.slice(0, 5).some(Boolean)) throw new Error('恢复前需核对光标和合成格残留物。')
    await this.warehouse.goHomeIfAway()
    // Refresh registered container observations without calling sync's
    // unexplained-loss reconciliation or changing any owner balances.
    let serverPlayerSnapshot = null
    for (const chest of this.db.listChests()) {
      check()
      const snapshot = await readServerContainer(this.warehouse, chest, this.catalog, this.bot)
      check()
      this.db.replaceChestSlots(chest.chestId, snapshot.chestSlots)
      serverPlayerSnapshot = merge(snapshot.playerItems)
      if (!same(this.inventory(), serverPlayerSnapshot) || this.bot.currentWindow || this.bot.inventory.selectedItem ||
        this.bot.inventory.slots?.slice(0, 5).some(Boolean)) throw new Error('恢复时背包、光标或窗口与服务端快照不一致。')
    }
    if (!serverPlayerSnapshot) throw new Error('恢复没有取得可核对的服务端背包快照；请先登记可用容器。')
    check()
    const actual = this.physicalTotals()
    const baseline = operation.data.physicalTotals
    if (!baseline) throw new Error('恢复记录缺少实物基线，需要人工核对。')
    if (phase === 'crafting' || operation.data.pending) {
      const pending = operation.data.pending
      if (!pending) throw new Error('恢复记录缺少合成意图。')
      if (same(actual, baseline)) {
        operation = this.ledger.checkpoint(operation.id, 'storing', { ...operation.data, pending: null, held: this.inventory() })
      } else if (pending.expectedProduced.every(item => item.itemKey) &&
        same(actual, converted(baseline, pending.expectedConsumed, pending.expectedProduced)) && same(this.inventory(), pending.expectedProduced)) {
        operation = this.ledger.checkpoint(operation.id, 'crafting', { ...operation.data, held: pending.before })
        operation = this.ledger.confirm(operation.id, pending.stepId, pending.expectedConsumed, this.inventory(), {
          ...operation.data, before: pending.before, after: this.inventory(), held: this.inventory(), pending: null, physicalTotals: actual
        })
      } else throw new Error('无法确认中断合成的实际消耗和产出；已保留归属及预留，需要人工核对。')
    } else if (!same(actual, baseline)) throw new Error('中断取存的实物与记录不一致，需要人工核对。')
    operation = this.ledger.checkpoint(operation.id, 'storing', { ...operation.data, held: this.inventory(), pending: null, physicalTotals: actual })
    operation = await this.store(operation)
    check()
    this.ledger.finish(operation.id, 'failed', 'interrupted craft safely returned; request may be submitted again')
    return { status: 'recovered', operationId: operation.id }
  }
}

module.exports = { CraftController, merge, same, converted }

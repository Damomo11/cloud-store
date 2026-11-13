'use strict'
const { randomUUID } = require('node:crypto')
const PackingLedger = require('./ledger')
const { planPacking } = require('./planner')
const { PackingExecutor } = require('./executor')
const { PackingStorage, same } = require('./storage')
const DEADLINE_MS = 120000
const terminal = operation => ['completed', 'failed'].includes(operation.state)

class PackingController {
  constructor ({ bot, db, catalog, warehouse, config, botId, ledger, executor, validateOwner }) {
    Object.assign(this, { bot, db, catalog, warehouse, config, botId, validateOwner })
    this.ledger = ledger || new PackingLedger(db)
    this.executor = executor || new PackingExecutor({ bot, catalog, warehouse, config })
    this.storage = new PackingStorage({ bot, db, catalog, warehouse, config })
    this.active = null
  }
  isBusy () { return Boolean(this.active || this.executor.isBusy()) }
  cancel (reason = 'Packing cancelled') {
    if (this.active) this.active.cancelled = reason instanceof Error ? reason : new Error(String(reason))
    this.executor.cancel(reason)
  }
  acquire () {
    if (this.isBusy()) throw new Error('Packing controller is busy; previous calls must drain')
    const lease = { cancelled: null }
    this.active = lease
    return lease
  }
  check (lease) {
    const expires = Date.now() + DEADLINE_MS
    return () => {
      if (lease.cancelled) throw lease.cancelled
      this.warehouse.assertConnectionHealthy?.()
      if (Date.now() >= expires) throw new Error('Packing work deadline exceeded')
    }
  }
  result (operation) {
    const batches = this.db.db.prepare('SELECT batch_index AS batchIndex,product_json AS productJson,inputs_json AS inputsJson,full FROM packing_batches WHERE operation_id=? ORDER BY batch_index').all(operation.id)
      .map(row => ({ batchIndex: row.batchIndex, product: JSON.parse(row.productJson), packedInputs: JSON.parse(row.inputsJson), full: Boolean(row.full) }))
    return { status: operation.state, operationId: operation.id, batches, boxCount: batches.length,
      itemCount: batches.reduce((sum, batch) => sum + batch.packedInputs.reduce((count, row) => count + row.amount, 0), 0) }
  }
  allNormalBatches (operation) {
    const batches = this.db.db.prepare('SELECT full,proof_json AS proofJson FROM packing_batches WHERE operation_id=?').all(operation.id)
    return batches.length === operation.plan.boxes.length && batches.every(row => row.full && JSON.parse(row.proofJson).normalBatch === true)
  }
  mark (id, error) {
    try {
      const op = this.ledger.get(id)
      if (!op || terminal(op)) return
      const observation = { message: error.message, at: new Date().toISOString() }
      try { observation.inventory = this.catalog.aggregatePrismarineItems(this.bot.inventory.items()) } catch (diagnosticError) {
        observation.inventoryError = diagnosticError.message
      }
      this.ledger.markRecovery(id, error.message, { ...op.data, observation })
    } catch (journalError) { error.journalError = journalError }
  }
  async run ({ owner, actor, items, boxItemKey } = {}) {
    const lease = this.acquire()
    let id
    let op
    let plan
    // Each batch owns one mutex interval; all failure cleanup stays inside that
    // same interval. The controller lease spans the entire order and every call.
    const locked = fn => this.warehouse.withWarehouseLock(async () => {
      try { return await fn() } catch (error) {
        if (id) {
          error.operationId = id
          this.mark(id, error)
          if (!lease.cancelled) {
            try { error.recovery = await this.recoverLocked(this.check(lease)) } catch (recoveryError) { error.recoveryError = recoveryError; this.mark(id, recoveryError) }
          }
          error.recoveryRequired = this.ledger.pending(this.botId).some(op => op.id === id)
        }
        throw error
      }
    })
    try {
      await locked(async () => {
        const check = this.check(lease)
        check()
        if (typeof this.validateOwner !== 'function') throw new Error('Packing owner validator is required')
        if (!owner?.uuid || typeof actor !== 'string' || !actor) throw new Error('Invalid packing owner/actor')
        if (await this.validateOwner(owner, actor) === false) throw new Error('Packing owner authorization refused')
        check()
        if (this.ledger.pending(this.botId).length) await this.recoverLocked(check)
        check()
        if (this.bot.currentWindow) throw new Error('Packing requires a closed initial window')
        if (this.storage.inventory().length) throw new Error('Packing requires empty local inventory before authoritative preflight')
        await this.warehouse.goHomeIfAway()
        check()
        if ((await this.storage.player(check)).length) throw new Error('Packing requires clean authoritative player inventory')
        const availableItems = this.db.getCraftAvailableItems(owner.uuid)
        const emptyBoxes = availableItems.filter(row => {
          if (!this.catalog.isShulkerBox(row.itemId)) return false
          try { return this.storage.decoder.contents(JSON.parse(row.metaJson), JSON.parse(row.nbtJson)).length === 0 } catch { return false }
        })
        plan = planPacking({ ownerUuid: owner.uuid, items, boxItemKey, availableItems, emptyBoxes, catalog: this.catalog })
        for (const row of plan.allocations) if (!this.db.listSlotsForItemKey(row.itemKey).some(slot => Number.isInteger(slot.slot))) throw new Error('Packing requires registered exact loose item locations')
        id = 'packing:' + randomUUID()
        op = this.ledger.begin({ id, botId: this.botId, owner, actor, plan })
      })
      for (const batch of plan.boxes) await locked(async () => {
        const check = this.check(lease)
        check()
        const sources = new Set()
        for (const row of [...batch.inputs, batch.box]) {
          let needed = row.amount
          const groups = this.warehouse.groupSlotsForWithdrawal(this.db.listSlotsForItemKey(row.itemKey).filter(slot => Number.isInteger(slot.slot)))
          for (const group of groups) {
            sources.add(group.chestId)
            needed -= group.recordedAmount
            if (needed <= 0) break
          }
          if (needed > 0) throw new Error('Packing batch lacks enough registered source stock')
        }
        const chests = []
        for (const chestId of sources) {
          const recorded = this.db.listChestSlots().filter(row => row.chestId === chestId && Number.isInteger(row.slot))
          const snapshot = await this.storage.read(chestId, check, false)
          if (!this.warehouse.sameCraftChestSlots(snapshot.slots, recorded)) throw new Error('Packing source snapshot differs from registered slots')
          if (snapshot.player.length) throw new Error('Packing batch must start physically clean')
          chests.push({ chestId, before: snapshot.items })
        }
        op = this.ledger.checkpoint(id, 'withdrawing', { ...op.data, withdrawalIntent: { chests }, normalBatch: true })
        await this.warehouse.withdrawAllocationsLocked([...batch.inputs, batch.box], { requireServerEvidence: true, packingSourceChestIds: [...sources], check })
        check()
        const withdrawalProof = await this.storage.withdrawal(op, check)
        op = this.ledger.checkpoint(id, 'withdrawn', { ...op.data, held: withdrawalProof.withdrawn, withdrawalProof })
        if (!same(withdrawalProof.withdrawn, [...batch.inputs, batch.box])) throw new Error('Packing withdrawal did not obtain exact full batch')
        op = this.ledger.checkpoint(id, 'packing', op.data)
        const result = await this.executor.execute({ ...batch, check })
        check()
        if (!same(result.packedInputs, batch.inputs)) throw new Error('Packing execution did not produce the complete requested batch')
        op = this.ledger.checkpoint(id, 'packing', { ...op.data, held: [result.product], product: result.product, packedInputs: result.packedInputs })
        op = await this.storage.store(op, this.ledger, check)
        check()
        this.ledger.settleBatch(id, op.data.batchIndex, op.data.product, op.data.packedInputs)
        op = this.ledger.get(id)
        if (op.data.batchIndex === plan.boxes.length) return this.ledger.finish(id, 'completed')
      })
      return this.result(this.ledger.get(id))
    } finally { if (this.active === lease) this.active = null }
  }
  async recover () {
    const lease = this.acquire()
    try {
      return await this.warehouse.withWarehouseLock(async () => {
        try { return await this.recoverLocked(this.check(lease)) } catch (error) {
          const op = this.ledger.pending(this.botId)[0]
          if (op) { this.mark(op.id, error); error.operationId = op.id; error.recoveryRequired = true }
          throw error
        }
      })
    } finally { if (this.active === lease) this.active = null }
  }
  async recoverLocked (check) {
    check()
    const pending = this.ledger.pending(this.botId)
    if (!pending.length) return { status: 'empty' }
    if (pending.length !== 1) throw new Error('Packing journal has multiple owning-bot operations')
    let op = pending[0]
    if (op.phase !== 'stored') { await this.warehouse.goHomeIfAway(); check() }
    const finish = status => this.result(this.ledger.finish(op.id, status, 'Packing recovery'))
    if (op.phase === 'ready') {
      if ((await this.storage.player(check)).length) throw new Error('Untouched packing journal has unexplained player inventory')
      return finish(this.allNormalBatches(op) ? 'completed' : 'failed')
    }
    if (op.phase === 'withdrawing' || op.phase === 'withdrawn') {
      const proof = op.data.withdrawalProof || await this.storage.withdrawal(op, check)
      if (!same(await this.storage.player(check), proof.withdrawn)) throw new Error('Interrupted packing withdrawal inventory is missing or foreign')
      op = this.ledger.checkpoint(op.id, op.phase, { ...op.data, held: proof.withdrawn, withdrawalProof: proof, normalBatch: false })
    } else if (op.phase === 'packing' && !op.data.product) {
      const batch = op.plan.boxes[op.data.batchIndex]
      const result = await this.executor.recover({ ...batch, check })
      check()
      const changed = result.packedInputs.length > 0
      if (!changed && result.product.itemKey !== batch.box.itemKey) throw new Error('Unchanged recovery shell fingerprint differs')
      op = this.ledger.checkpoint(op.id, 'packing', { ...op.data, normalBatch: false,
        held: changed ? [result.product, ...result.remainingInputs] : op.data.held,
        product: changed ? result.product : null, packedInputs: result.packedInputs })
    } else if (!['packing', 'returning', 'stored'].includes(op.phase)) throw new Error('Unknown packing recovery phase')
    const wasStored = op.phase === 'stored'
    if (!wasStored) {
      op = this.ledger.checkpoint(op.id, op.phase, { ...op.data, normalBatch: false })
      op = await this.storage.store(op, this.ledger, check)
    } else if ((await this.storage.player(check)).length) throw new Error('Stored packing recovery requires clean authoritative inventory')
    check()
    if (!op.data.product) return finish('failed')
    const normal = wasStored && op.data.normalBatch === true
    this.ledger.settleBatch(op.id, op.data.batchIndex, op.data.product, op.data.packedInputs)
    op = this.ledger.get(op.id)
    return finish(normal && this.allNormalBatches(op) ? 'completed' : 'failed')
  }
}
module.exports = { PackingController }

'use strict'

const TERMINAL = new Set(['completed', 'complete', 'failed'])

function integer (value, label) {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label} must be a positive integer`)
  return n
}

function clone (value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function item (value, label = 'item') {
  const source = value || {}
  const itemKey = String(source.itemKey || '').trim()
  if (!itemKey) throw new Error(`${label} is missing itemKey`)
  const amount = integer(source.amount, `${label}.amount`)
  return {
    ...source,
    itemKey,
    amount,
    itemId: String(source.itemId || ''),
    displayName: String(source.displayName || source.itemId || itemKey),
    nbtJson: source.nbtJson ?? '',
    metaJson: source.metaJson ?? ''
  }
}

function items (values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`)
  const grouped = new Map()
  for (const value of values || []) {
    const next = item(value, label)
    const current = grouped.get(next.itemKey)
    grouped.set(next.itemKey, current ? { ...current, amount: integer(current.amount + next.amount, `${label}.amount`) } : next)
  }
  return [...grouped.values()]
}

function byIdAmount (values) {
  if (!Array.isArray(values)) throw new Error('expected produced items must be an array')
  const totals = new Map()
  for (const value of values) {
    if (!value.itemId) throw new Error('produced item is missing itemId')
    totals.set(value.itemId, integer((totals.get(value.itemId) || 0) + integer(value.amount, 'produced.amount'), 'produced.amount'))
  }
  return totals
}

function equalItems (left, right) {
  const a = items(left || [], 'item').map(({ itemKey, amount }) => ({ itemKey, amount })).sort((x, y) => x.itemKey.localeCompare(y.itemKey))
  const b = items(right || [], 'item').map(({ itemKey, amount }) => ({ itemKey, amount })).sort((x, y) => x.itemKey.localeCompare(y.itemKey))
  return JSON.stringify(a) === JSON.stringify(b)
}

class CraftLedger {
  constructor (storeDb) {
    if (!storeDb?.db) throw new TypeError('CraftLedger requires a StoreDb instance')
    this.db = storeDb
    this.ensureSchema()
  }

  ensureSchema () {
    this.db.db.exec(`
      CREATE TABLE IF NOT EXISTS craft_operations (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        owner_json TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT '',
        target_json TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL DEFAULT 'running',
        phase TEXT NOT NULL DEFAULT 'ready',
        data_json TEXT NOT NULL DEFAULT '{}',
        reservations_json TEXT NOT NULL DEFAULT '[]',
        message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS craft_batches (
        operation_id TEXT NOT NULL,
        batch_key TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        consumed_json TEXT NOT NULL,
        produced_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (operation_id, batch_key),
        FOREIGN KEY (operation_id) REFERENCES craft_operations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_craft_operations_pending
        ON craft_operations (state, bot_id, updated_at);
    `)
  }

  transaction (fn) {
    return this.db.db.transaction(fn)()
  }

  normalizeOwner (owner) {
    const normalized = owner || {}
    const uuid = String(normalized.uuid || '').trim()
    if (!uuid) throw new Error('craft owner is missing uuid')
    return {
      uuid,
      username: String(normalized.username || ''),
      scope: String(normalized.scope || (uuid.startsWith('vault:') ? 'custom' : 'personal')),
      vaultName: String(normalized.vaultName || '')
    }
  }

  normalizeData (data, defaults = {}, strict = false) {
    const validObject = data && typeof data === 'object' && !Array.isArray(data)
    if (strict && !validObject) throw new Error('craft operation data must be an object')
    const source = validObject ? clone(data) : {}
    const next = { ...defaults, ...source }
    if (strict && !Array.isArray(next.held)) throw new Error('craft operation held data must be an array')
    next.held = Array.isArray(next.held) ? items(next.held, 'held item') : []
    if (strict && next.pending !== null && (!next.pending || typeof next.pending !== 'object' || Array.isArray(next.pending))) {
      throw new Error('craft operation pending data must be an object or null')
    }
    next.pending = next.pending == null ? null : clone(next.pending)
    const stepIndex = Number(next.stepIndex)
    if (strict && (!Number.isSafeInteger(stepIndex) || stepIndex < 0)) throw new Error('craft operation stepIndex must be a nonnegative safe integer')
    next.stepIndex = Number.isSafeInteger(stepIndex) && stepIndex >= 0 ? stepIndex : 0
    if (Object.hasOwn(next, 'progress') && next.progress != null) {
      if (!next.progress || typeof next.progress !== 'object' || Array.isArray(next.progress)) {
        throw new Error('craft operation progress must be an object or null')
      }
      const progressStep = Number(next.progress.stepIndex)
      const nextTrigger = Number(next.progress.nextTrigger)
      if (!Number.isSafeInteger(progressStep) || progressStep < 0 ||
        !Number.isSafeInteger(nextTrigger) || nextTrigger < 0) {
        throw new Error('craft operation progress must contain nonnegative safe integers')
      }
      next.progress = { ...next.progress, stepIndex: progressStep, nextTrigger }
    }
    return next
  }

  begin (input = {}) {
    const id = String(input.id || input.operationId || '').trim()
    if (!id) throw new Error('craft operation is missing id')
    if (!id.startsWith('craft:')) throw new Error('craft operation id must start with craft:')
    const botId = String(input.botId || '').trim()
    if (!botId) throw new Error('craft operation is missing botId')
    const owner = this.normalizeOwner(input.owner)
    const actor = String(input.actor || input.actorUsername || '')
    const target = clone(input.target || {})
    const allocations = items(input.allocations || [], 'allocation')
    for (const allocation of allocations) {
      if (allocation.ownerUuid && allocation.ownerUuid !== owner.uuid) throw new Error('craft allocation owner does not match operation owner')
    }
    const data = this.normalizeData(input.data || input.plan, { plan: clone(input.plan || {}) })

    return this.transaction(() => {
      const existing = this.db.db.prepare('SELECT id FROM craft_operations WHERE id = ?').get(id)
      if (existing) return this.getCraftOperation(id)
      this.db.db.prepare(`
        INSERT INTO craft_operations
          (id, bot_id, owner_json, actor, target_json, state, phase, data_json, reservations_json)
        VALUES (?, ?, ?, ?, ?, 'running', 'ready', ?, ?)
      `).run(id, botId, JSON.stringify(owner), actor, JSON.stringify(target), JSON.stringify(data), JSON.stringify(allocations))
      this.reserveRaw(id, owner.uuid, allocations)
      return this.getCraftOperation(id)
    })
  }

  reserveRaw (reservationId, ownerUuid, values) {
    this.db.reserveInventory(reservationId, items(values, 'reservation').map(value => ({
      ...value,
      ownerUuid,
      reservationItemKey: value.itemKey,
      reservationAmount: value.amount
    })))
  }

  decodeOperation (row) {
    if (!row) return null
    const parse = (value, field) => {
      try { return JSON.parse(value || '') } catch (error) {
        throw new Error(`craft operation ${row.id} has invalid persisted ${field}: ${error.message}`)
      }
    }
    const reservations = parse(row.reservationsJson, 'reservation data')
    if (!Array.isArray(reservations)) throw new Error(`craft operation ${row.id} has invalid persisted reservation data`)
    return {
      id: row.id,
      botId: row.botId,
      owner: parse(row.ownerJson, 'owner data'),
      actor: row.actor,
      actorUsername: row.actor,
      target: parse(row.targetJson, 'target data'),
      state: row.state,
      phase: row.phase,
      data: this.normalizeData(parse(row.dataJson, 'operation data'), {}, true),
      reservations,
      message: row.message || '',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }

  getCraftOperation (id) {
    const row = this.db.db.prepare(`
      SELECT id, bot_id AS botId, owner_json AS ownerJson, actor,
             target_json AS targetJson, state, phase, data_json AS dataJson,
             reservations_json AS reservationsJson, message,
             created_at AS createdAt, updated_at AS updatedAt
      FROM craft_operations WHERE id = ?
    `).get(String(id || ''))
    return this.decodeOperation(row)
  }

  listPendingCraftOperations (botId = '') {
    const rows = botId
      ? this.db.db.prepare(`SELECT id, bot_id AS botId, owner_json AS ownerJson, actor, target_json AS targetJson,
          state, phase, data_json AS dataJson, reservations_json AS reservationsJson, message,
          created_at AS createdAt, updated_at AS updatedAt FROM craft_operations
          WHERE bot_id = ? AND state NOT IN ('completed', 'complete', 'failed') ORDER BY updated_at, id`).all(String(botId))
      : this.db.db.prepare(`SELECT id, bot_id AS botId, owner_json AS ownerJson, actor, target_json AS targetJson,
          state, phase, data_json AS dataJson, reservations_json AS reservationsJson, message,
          created_at AS createdAt, updated_at AS updatedAt FROM craft_operations
          WHERE state NOT IN ('completed', 'complete', 'failed') ORDER BY updated_at, id`).all()
    return rows.map(row => this.decodeOperation(row))
  }

  getCraftAvailableItems (ownerUuid) {
    return this.db.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid, b.item_key AS itemKey,
             b.amount - COALESCE((SELECT SUM(r.amount) FROM inventory_reservations r
               WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) AS amount,
             i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM balances b JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ? AND b.amount - COALESCE((SELECT SUM(r.amount)
        FROM inventory_reservations r WHERE r.owner_uuid = b.owner_uuid AND r.item_key = b.item_key), 0) > 0
      ORDER BY i.item_id, i.created_at
    `).all(String(ownerUuid || ''))
  }

  getCraftProgress (id) {
    return clone(this.getCraftOperation(id)?.data?.progress || null)
  }

  checkpointCraftOperation (id, phase, data) {
    const operationId = String(id || '')
    return this.transaction(() => {
      const operation = this.getCraftOperation(operationId)
      if (!operation) throw new Error(`craft operation not found: ${operationId}`)
      if (TERMINAL.has(operation.state)) throw new Error(`craft operation is already ${operation.state}`)
      const nextData = this.normalizeData(data)
      this.db.db.prepare(`UPDATE craft_operations SET phase = ?, data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(String(phase || ''), JSON.stringify(nextData), operationId)
      return this.getCraftOperation(operationId)
    })
  }

  validatePending (operation, stepId, before, consumed, produced) {
    if (operation.phase !== 'crafting') throw new Error('craft operation is not in crafting phase')
    const pending = operation.data.pending
    if (!pending || String(pending.stepId || '') !== stepId) throw new Error('craft step does not match prepared pending step')
    if (!Array.isArray(pending.before) || !Array.isArray(pending.expectedConsumed) || !Array.isArray(pending.expectedProduced)) {
      throw new Error('craft pending step is missing prepared snapshots or recipe deltas')
    }
    const expectedBefore = pending.before
    if (!equalItems(expectedBefore, operation.data.held)) throw new Error('craft before snapshot does not match held state')
    if (!equalItems(before, expectedBefore)) throw new Error('craft step before snapshot does not match pending state')
    if (pending.expectedConsumed && !equalItems(consumed, pending.expectedConsumed)) throw new Error('craft consumed items do not match pending state')
    if (pending.expectedProduced) {
      const expectedHasItemKeys = pending.expectedProduced.some(value => value && Object.hasOwn(value, 'itemKey'))
      if (expectedHasItemKeys) {
        if (pending.expectedProduced.some(value => !value || !Object.hasOwn(value, 'itemKey'))) {
          throw new Error('craft expected produced items must all include itemKey')
        }
        if (!equalItems(produced, pending.expectedProduced)) throw new Error('craft produced items do not match pending state')
      } else {
        const actual = byIdAmount(produced)
        const expected = byIdAmount(pending.expectedProduced)
        if (JSON.stringify([...actual.entries()].sort()) !== JSON.stringify([...expected.entries()].sort())) throw new Error('craft produced items do not match pending state')
      }
    }
  }

  // Recovery settlement: the backpack was already parked into the warehouse
  // before this confirm runs, so data.held is empty by design. The full
  // validatePending rails otherwise apply unchanged.
  validateRecoverySettlement (operation, stepId, before, consumed, produced) {
    const savedHeld = operation.data.held
    operation.data.held = operation.data.pending?.before || before
    try {
      this.validatePending(operation, stepId, before, consumed, produced)
    } finally {
      operation.data.held = savedHeld
    }
  }

  // Partial settlement keeps only the integrity rails: the step must match the
  // prepared pending journal, consumption must stay within what the batch
  // withdrew, and after must equal the real conversion. The full expected
  // consumed/produced equality is dropped — a mid-batch failure means exactly
  // those deltas diverged from the plan.
  validatePartialSettlement (operation, stepId, before, consumed, produced) {
    if (operation.phase !== 'crafting') throw new Error('craft operation is not in crafting phase')
    const pending = operation.data.pending
    if (!pending || String(pending.stepId || '') !== stepId) throw new Error('craft step does not match prepared pending step')
    if (!Array.isArray(pending.before)) throw new Error('craft pending step is missing prepared snapshots')
    if (!equalItems(before, pending.before)) throw new Error('craft partial settlement before snapshot does not match pending state')
    const consumedTotals = new Map()
    for (const item of consumed) consumedTotals.set(item.itemKey, (consumedTotals.get(item.itemKey) || 0) + item.amount)
    for (const [itemKey, amount] of consumedTotals) {
      const expectedInput = pending.expectedConsumed?.find(item => item.itemKey === itemKey)
      if (!expectedInput || amount > expectedInput.amount) {
        throw new Error(`craft partial settlement consumed more than the batch withdrew: ${itemKey}`)
      }
    }
  }

  confirm (id, batchKey, consumed, produced, data = {}) {
    const operationId = String(id || '')
    const operation = this.getCraftOperation(operationId)
    const before = data.before || operation?.data?.pending?.before || operation?.data?.held || []
    // Recovery settlements pass after = the pre-deposit backpack while held is
    // legitimately empty (the items are already back in the warehouse).
    const recovery = Boolean(data.recovery)
    if (!recovery && Array.isArray(data.after) && Array.isArray(data.held) && !equalItems(data.after, data.held)) {
      throw new Error('craft after snapshot does not match held state')
    }
    const after = data.after || data.held || []
    return this._confirm(operationId, String(batchKey || ''), items(consumed || [], 'consumed item'), items(produced || [], 'produced item'), {
      ...clone(data),
      held: items(after, 'after item'),
      pending: null,
      stepIndex: data.stepIndex ?? ((operation?.data?.stepIndex || 0) + 1)
    }, before, after, { recovery })
  }

  // Mid-batch failure settlement: the executor captured concrete before/after
  // snapshots, so we book the real consumption/production instead of matching
  // the full expected trigger deltas. Everything else (reservation coverage,
  // balance updates, batch journal, phase transition) follows the same rules
  // as a normal confirm.
  confirmPartial (id, batchKey, consumed, produced, data = {}) {
    const operationId = String(id || '')
    const operation = this.getCraftOperation(operationId)
    const before = data.before || operation?.data?.pending?.before || operation?.data?.held || []
    if (Array.isArray(data.after) && Array.isArray(data.held) && !equalItems(data.after, data.held)) {
      throw new Error('craft after snapshot does not match held state')
    }
    const after = data.after || data.held || []
    return this._confirm(operationId, String(batchKey || ''), items(consumed || [], 'consumed item'), items(produced || [], 'produced item'), {
      ...clone(data),
      held: items(after, 'after item'),
      pending: null,
      stepIndex: data.stepIndex ?? ((operation?.data?.stepIndex || 0) + 1)
    }, before, after, { partial: true })
  }

  _confirm (operationId, batchKey, consumed, produced, nextData, before, after, options = {}) {
    if (!String(batchKey || '').trim()) throw new Error('craft step is missing stepId')
    const commit = () => this.transaction(() => {
      const operation = this.getCraftOperation(operationId)
      if (!operation) throw new Error(`craft operation not found: ${operationId}`)
      const existing = this.db.db.prepare(`SELECT before_json AS beforeJson, after_json AS afterJson,
          consumed_json AS consumedJson, produced_json AS producedJson FROM craft_batches
          WHERE operation_id = ? AND batch_key = ?`).get(operationId, batchKey)
      if (existing) {
        const same = equalItems(after, JSON.parse(existing.afterJson)) && equalItems(consumed, JSON.parse(existing.consumedJson)) && equalItems(produced, JSON.parse(existing.producedJson))
        if (!same) throw new Error('craft step idempotency key payload mismatch')
        return this.getCraftOperation(operationId)
      }
      if (TERMINAL.has(operation.state)) throw new Error(`craft operation is already ${operation.state}`)
      if (options.partial) {
        this.validatePartialSettlement(operation, batchKey, before, consumed, produced)
      } else if (options.recovery) {
        this.validateRecoverySettlement(operation, batchKey, before, consumed, produced)
      } else {
        this.validatePending(operation, batchKey, before, consumed, produced)
      }
      const expectedAfter = this.computeAfter(before, consumed, produced)
      if (!equalItems(after, expectedAfter)) throw new Error('craft after snapshot does not match conversion')
      const reservation = new Map(this.listCraftReservations(operationId).map(row => [row.itemKey, row.amount]))
      for (const next of consumed) {
        if ((reservation.get(next.itemKey) || 0) < next.amount) throw new Error(`craft consumption exceeds reservation: ${next.itemKey}`)
        if (this.db.getBalance(operation.owner.uuid, next.itemKey) < next.amount) throw new Error(`craft consumption exceeds balance: ${next.itemKey}`)
      }
      for (const next of consumed) {
        this.db.upsertItem(next)
        this.db.adjustBalance(operation.owner.uuid, next.itemKey, -next.amount)
        this.adjustReservation(operationId, operation.owner.uuid, next.itemKey, -next.amount)
        this.recordCraftTransaction(operation, 'craft_consume', `${operationId}:${batchKey}:consume`, next)
      }
      for (const next of produced) {
        this.db.upsertItem(next)
        this.db.adjustBalance(operation.owner.uuid, next.itemKey, next.amount)
        this.adjustReservation(operationId, operation.owner.uuid, next.itemKey, next.amount)
        this.recordCraftTransaction(operation, 'craft_produce', `${operationId}:${batchKey}:produce`, next)
      }
      this.db.db.prepare(`INSERT INTO craft_batches
        (operation_id, batch_key, before_json, after_json, consumed_json, produced_json)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(operationId, batchKey, JSON.stringify(before), JSON.stringify(after), JSON.stringify(consumed), JSON.stringify(produced))
      this.db.db.prepare(`UPDATE craft_operations SET phase = 'storing', data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(JSON.stringify(this.normalizeData(nextData)), operationId)
      this.db.db.prepare('UPDATE craft_operations SET reservations_json = ? WHERE id = ?')
        .run(JSON.stringify(this.listCraftReservations(operationId)), operationId)
      return this.getCraftOperation(operationId)
    })
    const current = this.db.transactionContext?.getStore?.() || {}
    return this.db.transactionContext?.run
      ? this.db.transactionContext.run({ ...current, craftOperationId: operationId }, commit)
      : commit()
  }

  computeAfter (before, consumed, produced) {
    const map = new Map(items(before, 'before item').map(next => [next.itemKey, next]))
    for (const next of consumed) {
      const current = map.get(next.itemKey)
      if (!current || current.amount < next.amount) throw new Error(`craft before snapshot lacks consumed item: ${next.itemKey}`)
      if (current.amount === next.amount) map.delete(next.itemKey)
      else map.set(next.itemKey, { ...current, amount: current.amount - next.amount })
    }
    for (const next of produced) {
      const current = map.get(next.itemKey)
      map.set(next.itemKey, current ? { ...current, amount: integer(current.amount + next.amount, 'after.amount') } : next)
    }
    return [...map.values()]
  }

  adjustReservation (operationId, ownerUuid, itemKey, delta) {
    const row = this.db.db.prepare('SELECT amount FROM inventory_reservations WHERE reservation_id = ? AND owner_uuid = ? AND item_key = ?')
      .get(operationId, ownerUuid, itemKey)
    const next = Number(row?.amount || 0) + Number(delta)
    if (next < 0) throw new Error(`craft reservation would become negative: ${itemKey}`)
    if (!Number.isSafeInteger(next)) throw new Error(`craft reservation amount must be a safe integer: ${itemKey}`)
    if (next === 0) this.db.db.prepare('DELETE FROM inventory_reservations WHERE reservation_id = ? AND owner_uuid = ? AND item_key = ?').run(operationId, ownerUuid, itemKey)
    else if (row) this.db.db.prepare('UPDATE inventory_reservations SET amount = ? WHERE reservation_id = ? AND owner_uuid = ? AND item_key = ?').run(next, operationId, ownerUuid, itemKey)
    else this.db.db.prepare('INSERT INTO inventory_reservations (reservation_id, owner_uuid, item_key, amount) VALUES (?, ?, ?, ?)').run(operationId, ownerUuid, itemKey, next)
  }

  listCraftReservations (id) {
    return this.db.db.prepare(`SELECT reservation_id AS reservationId, owner_uuid AS ownerUuid,
      item_key AS itemKey, amount FROM inventory_reservations WHERE reservation_id = ? ORDER BY item_key`).all(String(id || ''))
  }

  recordCraftTransaction (operation, type, key, value) {
    const context = this.db.transactionContext?.getStore?.() || {}
    this.db.db.prepare(`INSERT INTO transactions
      (type, status, player_uuid, username, items_json, message, deduction_key, bot_id, bot_name)
      VALUES (?, 'ok', ?, ?, ?, ?, ?, ?, ?)`)
      .run(type, operation.owner.uuid, operation.owner.username || operation.owner.uuid, JSON.stringify([value]),
        `operation=${operation.id}`, key, operation.botId, String(context.botName || ''))
  }

  finishCraftOperation (id, state = 'completed', message = '') {
    const operationId = String(id || '')
    if (state === 'complete') state = 'completed'
    if (!TERMINAL.has(state)) throw new Error('craft terminal state must be completed or failed')
    const result = this.transaction(() => {
      const operation = this.getCraftOperation(operationId)
      if (!operation) throw new Error(`craft operation not found: ${operationId}`)
      if (TERMINAL.has(operation.state)) return operation
      if (operation.data.held.length || operation.data.pending) throw new Error('cannot finish craft operation while held or pending items remain')
      this.db.db.prepare('DELETE FROM inventory_reservations WHERE reservation_id = ?').run(operationId)
      this.db.db.prepare('UPDATE craft_operations SET state = ?, phase = ?, message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(state, state, String(message || ''), operationId)
      this.db.addTransaction('craft', state === 'completed' ? 'ok' : 'failed', operation.owner.uuid,
        operation.owner.username || operation.owner.uuid, [], `operation=${operationId}; ${message || ''}`)
      return this.getCraftOperation(operationId)
    })
    this.db.runDeferredMigrations?.()
    return result
  }

  markCraftRecoveryRequired (id, message = '') {
    const operationId = String(id || '')
    return this.transaction(() => {
      const operation = this.getCraftOperation(operationId)
      if (!operation) throw new Error(`craft operation not found: ${operationId}`)
      if (TERMINAL.has(operation.state)) return operation
      this.db.db.prepare('UPDATE craft_operations SET phase = ?, message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('recovery_required', String(message || ''), operationId)
      return this.getCraftOperation(operationId)
    })
  }

  get (...args) { return this.getCraftOperation(...args) }
  pending (...args) { return this.listPendingCraftOperations(...args) }
  checkpoint (...args) { return this.checkpointCraftOperation(...args) }
  finish (id, state = 'complete', message = '') {
    return this.finishCraftOperation(id, state === 'complete' ? 'completed' : state, message)
  }
  markRecovery (id, message = '', data) {
    return this.transaction(() => {
      if (data !== undefined) this.checkpointCraftOperation(id, 'recovery_required', data)
      return this.markCraftRecoveryRequired(id, message)
    })
  }
}

module.exports = CraftLedger

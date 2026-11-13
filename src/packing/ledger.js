'use strict'

const { planPacking, packingStackSize } = require('./planner')
const TERMINAL = new Set(['completed', 'failed'])
const PHASES = new Set(['ready', 'withdrawing', 'withdrawn', 'packing', 'returning', 'stored', 'recovery_required'])
const clone = value => JSON.parse(JSON.stringify(value))
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function stable (value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function positive (value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}: expected positive safe integer`)
  return value
}
function totals (values, label = 'items') {
  if (!Array.isArray(values)) throw new Error(`Invalid ${label} array`)
  const result = new Map()
  for (const item of values) {
    if (!object(item) || typeof item.itemKey !== 'string' || !item.itemKey) throw new Error(`Invalid ${label} identity`)
    result.set(item.itemKey, positive((result.get(item.itemKey) || 0) + positive(item.amount, label), label))
  }
  return [...result].sort(([a], [b]) => a.localeCompare(b)).map(([itemKey, amount]) => ({ itemKey, amount }))
}
const equal = (a, b) => stable(a) === stable(b)
const sameItems = (a, b) => equal(totals(a), totals(b))

function hasLegacyContents (value) {
  if (Array.isArray(value)) return value.some(hasLegacyContents)
  if (!object(value)) return false
  for (const [key, child] of Object.entries(value)) {
    if (key === 'Items' || key === 'items') {
      let entries = child
      while (object(entries) && Object.hasOwn(entries, 'value')) entries = entries.value
      if (!Array.isArray(entries) || entries.length) return true
    }
    if (hasLegacyContents(child)) return true
  }
  return false
}

class PackingLedger {
  constructor (db) {
    if (!db?.db) throw new TypeError('PackingLedger requires StoreDb')
    this.db = db
    db.db.exec(`
      CREATE TABLE IF NOT EXISTS packing_operations (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, owner_json TEXT NOT NULL,
        actor TEXT NOT NULL, plan_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'running',
        phase TEXT NOT NULL DEFAULT 'ready', data_json TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_packing_pending_bot ON packing_operations(bot_id)
        WHERE state NOT IN ('completed','failed');
      CREATE TABLE IF NOT EXISTS packing_batches (
        operation_id TEXT NOT NULL, batch_index INTEGER NOT NULL,
        product_json TEXT NOT NULL, inputs_json TEXT NOT NULL, proof_json TEXT NOT NULL,
        full INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(operation_id,batch_index),
        FOREIGN KEY(operation_id) REFERENCES packing_operations(id)
      );
    `)
  }

  transaction (fn) { return this.db.db.transaction(fn)() }

  catalog () {
    if (!this.db.catalog) throw new Error('Packing content verification requires configured catalog')
    return this.db.catalog
  }

  get (id) {
    const row = this.db.db.prepare(`SELECT id,bot_id AS botId,owner_json AS ownerJson,actor,
      plan_json AS planJson,state,phase,data_json AS dataJson,message,
      created_at AS createdAt,updated_at AS updatedAt FROM packing_operations WHERE id=?`).get(id)
    if (!row) return null
    const { ownerJson, planJson, dataJson, ...record } = row
    return { ...record, owner: JSON.parse(ownerJson), plan: JSON.parse(planJson), data: JSON.parse(dataJson) }
  }

  pending (botId = '') {
    const rows = botId
      ? this.db.db.prepare("SELECT id FROM packing_operations WHERE state NOT IN ('completed','failed') AND bot_id=? ORDER BY created_at,id").all(botId)
      : this.db.db.prepare("SELECT id FROM packing_operations WHERE state NOT IN ('completed','failed') ORDER BY created_at,id").all()
    return rows.map(row => this.get(row.id))
  }

  requireOperation (id) {
    const op = this.get(id)
    if (!op) throw new Error('Unknown packing operation')
    return op
  }

  validatePlan (plan, owner) {
    const catalog = this.catalog()
    if (!object(plan) || plan.ownerUuid !== owner.uuid) throw new Error('Packing plan owner mismatch')
    if (!Array.isArray(plan.allocations) || !Array.isArray(plan.boxes) || !plan.boxes.length) throw new Error('Invalid packing plan')
    const available = plan.allocations.map(row => {
      if (row.ownerUuid !== owner.uuid) throw new Error('Packing allocation owner mismatch')
      const stored = this.db.getItemByKey(row.itemKey)
      if (!stored || ['itemId', 'metaJson', 'nbtJson'].some(key => row[key] !== stored[key])) throw new Error('Packing plan identity mismatch')
      positive(row.amount, 'allocation')
      return { ...stored, ownerUuid: owner.uuid, amount: this.db.getBalance(owner.uuid, row.itemKey) }
    })
    const boxes = new Map()
    for (const batch of plan.boxes) {
      if (batch.box?.ownerUuid !== owner.uuid || batch.box.amount !== 1 || batch.inputs?.some(row => row.ownerUuid !== owner.uuid)) throw new Error('Packing batch owner or box mismatch')
      const previous = boxes.get(batch.box.itemKey)
      boxes.set(batch.box.itemKey, { ...batch.box, amount: (previous?.amount || 0) + 1 })
    }
    const rebuilt = planPacking({ ownerUuid: owner.uuid, items: plan.inputs, availableItems: available, emptyBoxes: [...boxes.values()], catalog })
    const identity = row => ({ itemKey: row.itemKey, itemId: row.itemId, metaJson: row.metaJson, nbtJson: row.nbtJson, ownerUuid: row.ownerUuid, amount: row.amount })
    const shape = value => ({ ownerUuid: value.ownerUuid, inputs: value.inputs.map(identity), allocations: value.allocations.map(identity),
      boxes: value.boxes.map(batch => ({ box: identity(batch.box), inputs: batch.inputs.map(identity), slots: batch.slots, usedSlots: batch.usedSlots })),
      boxCount: value.boxCount, itemCount: value.itemCount })
    if (!equal(shape(plan), shape(rebuilt))) throw new Error('Packing plan allocations or batch layout mismatch')
  }

  begin ({ id, botId, owner, actor = '', plan } = {}) {
    if (typeof id !== 'string' || !id.startsWith('packing:') || id.length <= 8) throw new Error('Packing id must start with packing:')
    if (typeof botId !== 'string' || !botId.trim() || botId.trim() !== botId) throw new Error('Invalid packing botId')
    if (!object(owner) || typeof owner.uuid !== 'string' || !owner.uuid || owner.uuid.trim() !== owner.uuid || typeof owner.username !== 'string' || typeof owner.scope !== 'string' || !owner.scope) throw new Error('Invalid packing owner')
    if (typeof actor !== 'string') throw new Error('Invalid packing actor')
    owner = { uuid: owner.uuid, username: owner.username, scope: owner.scope, vaultName: owner.vaultName || '' }
    plan = clone(plan)
    return this.transaction(() => {
      const previous = this.get(id)
      if (previous) {
        if (previous.botId !== botId || previous.actor !== actor || !equal(previous.owner, owner) || !equal(previous.plan, plan)) throw new Error('Conflicting packing operation id')
        return previous
      }
      if (this.pending(botId).length) throw new Error('Packing bot already has a pending operation')
      this.validatePlan(plan, owner)
      const data = { batchIndex: 0, held: [], product: null, packedInputs: [] }
      this.db.db.prepare('INSERT INTO packing_operations(id,bot_id,owner_json,actor,plan_json,data_json) VALUES(?,?,?,?,?,?)')
        .run(id, botId, JSON.stringify(owner), actor, JSON.stringify(plan), JSON.stringify(data))
      this.db.reserveInventory(id, plan.allocations.map(row => ({ ownerUuid: owner.uuid, itemKey: row.itemKey, amount: row.amount })))
      return this.get(id)
    })
  }

  validateProduct (op, product, packedInputs) {
    const catalog = this.catalog()
    const batch = op.plan.boxes[op.data.batchIndex]
    if (!batch) throw new Error('Invalid current packing batch')
    const actual = totals(packedInputs, 'packed inputs')
    if (!actual.length) throw new Error('Packed inputs must be a positive subset')
    const planned = new Map(totals(batch.inputs).map(row => [row.itemKey, row.amount]))
    for (const row of packedInputs) {
      const original = batch.inputs.find(input => input.itemKey === row.itemKey)
      if (!original || (row.ownerUuid !== undefined && row.ownerUuid !== op.owner.uuid) || ['itemId', 'metaJson', 'nbtJson'].some(key => row[key] !== undefined && row[key] !== original[key])) throw new Error('Packed input identity or owner mismatch')
    }
    for (const row of actual) if (!planned.has(row.itemKey) || planned.get(row.itemKey) < row.amount) throw new Error('Packed inputs exceed planned subset')
    if (!object(product) || product.amount !== 1 || (product.count !== undefined && product.count !== 1) || product.itemId !== batch.box.itemId) throw new Error('Invalid packing product box identity/count')
    const meta = JSON.parse(product.metaJson)
    const nbt = JSON.parse(product.nbtJson)
    if (!object(meta) || (nbt !== null && !object(nbt))) throw new Error('Invalid packing product metadata')
    if (hasLegacyContents(nbt) || hasLegacyContents(meta)) throw new Error('Packing product has unverifiable legacy contents')
    packingStackSize(product, catalog)
    const canonical = catalog.canonicalizeStoredItem(product)
    if (canonical.itemKey !== product.itemKey) throw new Error('Noncanonical packing product fingerprint')
    const strip = row => {
      const value = JSON.parse(row.metaJson)
      return { ...value, metadata: catalog.normalizeItemMetadata(value.metadata),
        components: (value.components || []).filter(component => component.type !== 'container'),
        removeComponents: value.removeComponents || null }
    }
    if (!equal(strip(product), strip(batch.box)) || !equal(catalog.normalizeNbtForFingerprint(product.itemId, nbt), catalog.normalizeNbtForFingerprint(batch.box.itemId, JSON.parse(batch.box.nbtJson)))) throw new Error('Packing product empty-box fingerprint changed')
    const containers = meta.components.filter(component => component.type === 'container')
    if (containers.length !== 1 || !Array.isArray(containers[0].data?.contents) || containers[0].data.contents.length > 27) throw new Error('Invalid packing product container')
    const contents = containers[0].data.contents.map(entry => {
      positive(entry.itemCount ?? entry.count, 'container count')
      if ((entry.removeComponents || []).length || (entry.components !== undefined && !Array.isArray(entry.components))) throw new Error('Invalid packing container components')
      const item = catalog.fromContainerEntry(entry)
      if (!item || catalog.isShulkerBox(item.itemId)) throw new Error('Invalid or nested shulker packing contents')
      if (item.amount > packingStackSize(item, catalog)) throw new Error('Packing contents exceed stack size')
      return item
    })
    if (!sameItems(contents, actual)) throw new Error('Packing product contents do not equal packed inputs')
    return canonical
  }

  validateReturn (op, data, stored) {
    const batch = op.plan.boxes[data.batchIndex]
    if (!batch || !object(data.returnIntent) || !Array.isArray(data.returnIntent.chests)) throw new Error('Packing return intent requires named barrel baselines')
    const withdrawn = data.withdrawalProof?.withdrawn || [...batch.inputs, batch.box]
    const required = new Map(totals(withdrawn).map(row => [row.itemKey, row.amount]))
    if (data.product) {
      if (required.get(batch.box.itemKey) !== 1) throw new Error('Packing product requires withdrawn box proof')
      required.delete(batch.box.itemKey)
      for (const row of totals(data.packedInputs)) {
        if ((required.get(row.itemKey) || 0) < row.amount) throw new Error('Packing product exceeds proven withdrawal')
        required.set(row.itemKey, required.get(row.itemKey) - row.amount)
      }
      required.set(data.product.itemKey, 1)
    }
    const returned = [...required].filter(([, amount]) => amount > 0).map(([itemKey, amount]) => ({ itemKey, amount }))
    if (!sameItems(data.returnIntent.returned, returned)) throw new Error('Packing return must include product and all loose remainder or unchanged materials')
    if (returned.length && !data.returnIntent.chests.length) throw new Error('Packing return requires named barrel baselines')
    const names = new Set()
    for (const chest of data.returnIntent.chests) {
      if (typeof chest.chestId !== 'string' || names.has(chest.chestId) || !this.db.db.prepare('SELECT 1 FROM chests WHERE chest_id=?').get(chest.chestId)) throw new Error('Packing return requires unique registered chest')
      names.add(chest.chestId)
      totals(chest.before, 'chest baseline')
    }
    if (op.data.returnIntent) {
      if (!sameItems(op.data.returnIntent.returned, data.returnIntent.returned)) throw new Error('Packing return intent changed')
      for (const prior of op.data.returnIntent.chests) {
        const next = data.returnIntent.chests.find(chest => chest.chestId === prior.chestId)
        if (!next || !sameItems(prior.before, next.before)) throw new Error('Packing return baseline changed')
      }
    }
    if (!stored) return
    if (!['returning', 'stored', 'recovery_required'].includes(op.phase) || !op.data.returnIntent || !equal(op.data.product, data.product) || !sameItems(op.data.packedInputs, data.packedInputs)) throw new Error('Stored packing proof requires prior durable return intent')
    if (data.returnIntent.chests.length !== op.data.returnIntent.chests.length) throw new Error('Stored packing destinations require prior durable baselines')
    if (data.held.length || !object(data.storedProof) || !Array.isArray(data.storedProof.inventoryAfter) || data.storedProof.inventoryAfter.length || !Array.isArray(data.storedProof.chests) || data.storedProof.chests.length !== names.size) throw new Error('Stored packing proof requires empty held/inventory and complete chest receipts')
    const deltas = []
    for (const before of data.returnIntent.chests) {
      const matches = data.storedProof.chests.filter(chest => chest.chestId === before.chestId)
      if (matches.length !== 1) throw new Error('Missing or duplicate stored chest receipt')
      const old = new Map(totals(before.before).map(row => [row.itemKey, row.amount]))
      const after = new Map(totals(matches[0].after).map(row => [row.itemKey, row.amount]))
      for (const key of new Set([...old.keys(), ...after.keys()])) {
        const amount = (after.get(key) || 0) - (old.get(key) || 0)
        if (amount < 0) throw new Error('Stored packing chest has unexplained loss')
        if (amount > 0) deltas.push({ itemKey: key, amount })
      }
    }
    if (!sameItems(deltas, returned)) throw new Error('Stored packing barrel deltas do not prove exact return')
  }

  validateWithdrawal (op, data) {
    if (op.data.withdrawalProof && !equal(op.data.withdrawalProof, data.withdrawalProof)) throw new Error('Durable packing withdrawal proof cannot change or disappear')
    if (op.data.withdrawalIntent && !data.withdrawalIntent) throw new Error('Durable packing withdrawal intent cannot disappear')
    if (!data.withdrawalIntent) {
      if (data.withdrawalProof) throw new Error('Packing withdrawal proof requires prior durable withdrawal intent')
      return
    }
    const intent = data.withdrawalIntent
    if (!object(intent) || !Array.isArray(intent.chests) || !intent.chests.length) throw new Error('Invalid packing withdrawal intent')
    const names = new Set()
    for (const chest of intent.chests) {
      if (names.has(chest.chestId) || !this.db.db.prepare('SELECT 1 FROM chests WHERE chest_id=?').get(chest.chestId)) throw new Error('Packing withdrawal requires unique registered chest')
      names.add(chest.chestId)
      totals(chest.before)
    }
    if (op.data.withdrawalIntent && !equal(op.data.withdrawalIntent, intent)) throw new Error('Packing withdrawal baseline changed')
    if (!data.withdrawalProof) return
    if (!op.data.withdrawalIntent || !equal(op.data.withdrawalIntent, intent)) throw new Error('Packing withdrawal proof requires prior durable withdrawal intent')
    const proof = data.withdrawalProof
    if (!object(proof) || !Array.isArray(proof.chests) || proof.chests.length !== names.size || !sameItems(proof.withdrawn, proof.inventoryAfter)) throw new Error('Invalid packing withdrawal proof inventory')
    const planned = new Map(totals([...op.plan.boxes[data.batchIndex].inputs, op.plan.boxes[data.batchIndex].box]).map(row => [row.itemKey, row.amount]))
    for (const row of totals(proof.withdrawn)) if ((planned.get(row.itemKey) || 0) < row.amount) throw new Error('Packing withdrawal exceeds planned batch')
    const decreases = []
    for (const chest of intent.chests) {
      const matches = proof.chests.filter(row => row.chestId === chest.chestId)
      if (matches.length !== 1) throw new Error('Invalid packing withdrawal chest receipt')
      const before = new Map(totals(chest.before).map(row => [row.itemKey, row.amount]))
      const after = new Map(totals(matches[0].after).map(row => [row.itemKey, row.amount]))
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        const amount = (before.get(key) || 0) - (after.get(key) || 0)
        if (amount < 0) throw new Error('Packing withdrawal has unexplained source gain')
        if (amount > 0) decreases.push({ itemKey: key, amount })
      }
    }
    if (!sameItems(decreases, proof.withdrawn)) throw new Error('Packing withdrawal source decreases mismatch')
  }

  checkpoint (id, phase, data) {
    return this.transaction(() => {
      const op = this.requireOperation(id)
      if (TERMINAL.has(op.state)) throw new Error('Packing operation is terminal')
      if (!PHASES.has(phase) || !object(data)) throw new Error('Invalid packing checkpoint phase/data')
      data = clone(data)
      if (!Number.isSafeInteger(data.batchIndex) || data.batchIndex !== op.data.batchIndex) throw new Error('Packing checkpoint batch index cannot advance')
      totals(data.held, 'held')
      totals(data.packedInputs, 'packed inputs')
      this.validateWithdrawal(op, data)
      if (op.data.storedProof && !equal(op.data.storedProof, data.storedProof)) throw new Error('Durable stored packing receipt cannot change or disappear')
      if (!data.product && phase !== 'stored') {
        const held = new Map(totals(data.held).map(row => [row.itemKey, row.amount]))
        if (totals(op.data.held).some(row => (held.get(row.itemKey) || 0) < row.amount)) throw new Error('Raw packing held stock cannot disappear without stored proof')
      }
      if (data.product !== null) this.validateProduct(op, data.product, data.packedInputs)
      else if (data.packedInputs.length) throw new Error('Packed inputs require verified product')
      if (op.data.product && (!equal(op.data.product, data.product) || !sameItems(op.data.packedInputs, data.packedInputs))) throw new Error('Unresolved packing product cannot be cleared or changed')
      if (op.data.returnIntent && !['returning', 'stored', 'recovery_required'].includes(phase)) throw new Error('Unresolved packing return intent cannot be cleared')
      if (phase === 'ready' && (op.phase !== 'ready' || data.held.length || data.product || data.withdrawalIntent || data.returnIntent)) throw new Error('Packing ready cannot clear physical progress')
      if (phase === 'returning' || phase === 'stored' || data.returnIntent) this.validateReturn(op, data, phase === 'stored')
      this.db.db.prepare('UPDATE packing_operations SET phase=?,data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(phase, JSON.stringify(data), id)
      return this.get(id)
    })
  }

  settleBatch (id, batchIndex, product, packedInputs) {
    return this.transaction(() => {
      const op = this.requireOperation(id)
      if (!Number.isSafeInteger(batchIndex) || batchIndex < 0 || batchIndex >= op.plan.boxes.length) throw new Error('Invalid packing batch index')
      const previous = this.db.db.prepare('SELECT product_json AS productJson,inputs_json AS inputsJson,full FROM packing_batches WHERE operation_id=? AND batch_index=?').get(id, batchIndex)
      if (previous) {
        if (!equal(JSON.parse(previous.productJson), product) || !equal(JSON.parse(previous.inputsJson), packedInputs)) throw new Error('Conflicting packing batch settlement')
        return { operationId: id, batchIndex, product: JSON.parse(previous.productJson), packedInputs: JSON.parse(previous.inputsJson), full: Boolean(previous.full) }
      }
      if (TERMINAL.has(op.state) || batchIndex !== op.data.batchIndex) throw new Error('Invalid current packing batch')
      if (op.phase !== 'stored' || !op.data.storedProof || op.data.held.length || !equal(op.data.product, product) || !sameItems(op.data.packedInputs, packedInputs)) throw new Error('Packing settlement requires durable stored proof')
      this.validateWithdrawal(op, op.data)
      this.validateReturn(op, op.data, true)
      const canonical = this.validateProduct(op, product, packedInputs)
      const batch = op.plan.boxes[batchIndex]
      const consume = [...totals(packedInputs), { itemKey: batch.box.itemKey, amount: 1 }]
      for (const row of consume) {
        const reservation = this.db.db.prepare('SELECT amount FROM inventory_reservations WHERE reservation_id=? AND owner_uuid=? AND item_key=?').get(id, op.owner.uuid, row.itemKey)
        if (!reservation || reservation.amount < row.amount || this.db.getBalance(op.owner.uuid, row.itemKey) < row.amount) throw new Error('Packing owner stock/reservation shortage')
      }
      this.db.upsertItem(canonical)
      for (const row of consume) {
        this.db.adjustBalance(op.owner.uuid, row.itemKey, -row.amount)
        this.db.db.prepare('DELETE FROM inventory_reservations WHERE reservation_id=? AND owner_uuid=? AND item_key=? AND amount=?').run(id, op.owner.uuid, row.itemKey, row.amount)
        this.db.db.prepare('UPDATE inventory_reservations SET amount=amount-? WHERE reservation_id=? AND owner_uuid=? AND item_key=?').run(row.amount, id, op.owner.uuid, row.itemKey)
      }
      this.db.adjustBalance(op.owner.uuid, canonical.itemKey, 1)
      const full = sameItems(packedInputs, batch.inputs)
      this.db.db.prepare('INSERT INTO packing_batches(operation_id,batch_index,product_json,inputs_json,proof_json,full) VALUES(?,?,?,?,?,?)')
        .run(id, batchIndex, JSON.stringify(product), JSON.stringify(packedInputs), JSON.stringify(op.data), full ? 1 : 0)
      this.db.addTransaction('packing_batch', full ? 'ok' : 'partial', op.owner.uuid, op.owner.username, [canonical], `${id};batch=${batchIndex}`)
      const data = { batchIndex: batchIndex + 1, held: [], product: null, packedInputs: [] }
      this.db.db.prepare("UPDATE packing_operations SET phase='ready',data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(data), id)
      return { operationId: id, batchIndex, product: clone(product), packedInputs: clone(packedInputs), full }
    })
  }

  finish (id, status, message = '') {
    if (!TERMINAL.has(status)) throw new Error('Invalid packing terminal status')
    const result = this.transaction(() => {
      const op = this.requireOperation(id)
      if (TERMINAL.has(op.state)) {
        if (op.state !== status) throw new Error('Conflicting packing terminal status')
        return op
      }
      if (op.data.held.length || op.data.product || op.data.packedInputs.length || !['ready', 'stored'].includes(op.phase)) throw new Error('Packing has held items or unresolved conversion/return')
      if (op.phase === 'stored') {
        this.validateWithdrawal(op, op.data)
        this.validateReturn(op, op.data, true)
      }
      const batches = this.db.db.prepare('SELECT full FROM packing_batches WHERE operation_id=?').all(id)
      if (status === 'completed' && (batches.length !== op.plan.boxes.length || batches.some(batch => !batch.full))) throw new Error('Packing completed requires every full batch; partial conversion cannot succeed')
      this.db.releaseInventoryReservation(id)
      this.db.addTransaction('packing', status, op.owner.uuid, op.owner.username, [], `${id};${message}`)
      this.db.db.prepare('UPDATE packing_operations SET state=?,message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, String(message), id)
      return this.get(id)
    })
    this.db.runDeferredMigrations()
    return result
  }

  markRecovery (id, message, data) {
    return this.transaction(() => {
      const op = this.requireOperation(id)
      if (TERMINAL.has(op.state)) throw new Error('Packing operation is terminal')
      if (data !== undefined) this.checkpoint(id, op.phase, data)
      this.db.db.prepare("UPDATE packing_operations SET state='recovery_required',message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(String(message || ''), id)
      return this.get(id)
    })
  }
}

module.exports = PackingLedger

'use strict'

const Vec3 = require('vec3')
const { standardRecipeOutputs, withStandardRecipeOutputs } = require('./recipe-outputs')
const { readServerContainer } = require('./server-container-evidence')
const { shortKey } = require('../traceLog')

// This boundary performs no warehouse accounting or material withdrawal. The
// controller supplies the batch's concrete inputs in an empty bag.
function createInventoryExecutor (bot, catalog, config, warehouse, debugCraft = () => {}) {
  let active = null
  const registry = bot.registry || catalog.mcData
  const Item = require('prismarine-item')(registry)
  const snapshot = () => catalog.aggregatePrismarineItems(bot.inventory.items())

  function error (message, recoveryRequired = false, cause) {
    const result = new Error(message, cause ? { cause } : undefined)
    result.recoveryRequired = recoveryRequired
    return result
  }

  function itemSummary (item) {
    if (!item) return null
    const normalized = item.itemId ? item : catalog.fromPrismarineItem(item)
    return {
      itemId: normalized.itemId,
      amount: normalized.amount ?? item.count,
      fingerprint: shortKey(normalized.itemKey)
    }
  }

  function amountSummary (items) {
    return (items || []).map(item => [item.itemId, item.amount]).sort((a, b) => a[0].localeCompare(b[0]))
  }

  function emitDebug (event, details = {}) {
    try {
      debugCraft(event, {
        ...(active?.operationId ? { operationId: active.operationId } : {}),
        ...(active?.stepId ? { stepId: active.stepId } : {}),
        ...details
      })
    } catch { /* Diagnostics must never interrupt a live craft operation. */ }
  }

  function stop (window = bot.currentWindow) {
    try { bot.pathfinder?.stop() } catch {}
    try { bot.clearControlStates?.() } catch {}
    try { if (window) bot.closeWindow(window) } catch {}
  }

  function cancel (reason = 'craft cancelled') {
    if (!active) return false
    if (!active.reason) active.reason = error(String(reason?.message || reason))
    stop()
    return true
  }

  function sameAmounts (left, right, key) {
    const totals = entries => {
      const result = new Map()
      for (const entry of entries) {
        const id = key(entry)
        result.set(id, (result.get(id) || 0) + entry.amount)
      }
      for (const [id, amount] of result) if (amount === 0) result.delete(id)
      return result
    }
    const a = totals(left)
    const b = totals(right)
    return a.size === b.size && [...a].every(([id, amount]) => b.get(id) === amount)
  }

  function declaration (step) {
    if (!step || !Array.isArray(step.inputs) || !step.inputs.length || typeof step.requiresTable !== 'boolean') {
      throw error('craft step must declare concrete inputs and requiresTable')
    }
    if (step.type && !['shaped', 'shapeless'].includes(step.type)) throw error('unsupported craft recipe type')
    const resolve = name => catalog.resolveName(name)
    const inputs = step.inputs.map(input => {
      if (!Array.isArray(input.names) || input.names.length !== 1 || !Number.isSafeInteger(input.count) || input.count <= 0) {
        throw error('craft input must have one concrete name and a positive trigger count')
      }
      return { ...resolve(input.names[0]), amount: input.count }
    })
    if (!Number.isSafeInteger(step.result?.count) || step.result.count <= 0) throw error('invalid craft result count')
    return { inputs, result: { ...resolve(step.result.name), count: step.result.count } }
  }

  // Batched execution scales every declared single-trigger amount by the
  // trigger count: ensureBaseline then requires the backpack to hold exactly
  // the whole batch, and bot.craft(recipe, count, table) works the same window
  // count times without reopening it.
  function batchDeclaration (step, triggers) {
    const count = Number(triggers)
    if (!Number.isSafeInteger(count) || count <= 0) throw error('craft batch trigger count must be a positive integer')
    const declared = declaration(step)
    const inputs = declared.inputs.map(input => ({ ...input, amount: input.amount * count }))
    return { ...declared, inputs, triggers: count }
  }

  function recipeMaterials (recipe) {
    if (!recipe || (recipe.type && !['shaped', 'shapeless'].includes(recipe.type))) return null
    const inputs = []
    let slots = 0
    if (recipe.inShape) {
      if (!Array.isArray(recipe.inShape) || !recipe.inShape.length || recipe.inShape.length > 3) return null
      for (const row of recipe.inShape) {
        if (!Array.isArray(row) || !row.length || row.length > 3) return null
        for (const ingredient of row) {
          if (ingredient?.id === -1) continue
          if (!validItem(ingredient) || ingredient.count !== 1) return null
          inputs.push({ ...ingredient, amount: 1 })
          slots++
        }
      }
    }
    if (recipe.ingredients) {
      if (!Array.isArray(recipe.ingredients) || !recipe.ingredients.length) return null
      for (const ingredient of recipe.ingredients) {
        if (!validItem(ingredient) || Math.abs(ingredient.count) !== 1) return null
        inputs.push({ ...ingredient, amount: 1 })
        slots++
      }
    }
    if (!slots || slots > (recipe.requiresTable ? 9 : 4)) return null
    const outputs = [recipe.result]
    if (recipe.outShape) {
      if (!Array.isArray(recipe.outShape) || recipe.outShape.length > 3) return null
      for (const row of recipe.outShape) {
        if (!Array.isArray(row) || row.length > 3) return null
        for (const remainder of row) if (remainder?.id !== -1) outputs.push(remainder)
      }
    }
    if (!outputs.every(entry => validItem(entry) && Number.isSafeInteger(entry.count) && entry.count > 0)) return null
    if (!Array.isArray(recipe.delta) || !recipe.delta.every(entry => validItem(entry) && Number.isSafeInteger(entry.count))) return null
    const net = [...inputs.map(entry => ({ ...entry, amount: -entry.amount })), ...outputs.map(entry => ({ ...entry, amount: entry.count }))]
    if (!sameAmounts(net, recipe.delta.map(entry => ({ ...entry, amount: entry.count })), entry => entry.id)) return null
    return { inputs, outputs }
  }

  function validItem (entry) {
    return Number.isSafeInteger(entry?.id) && entry.id >= 0 && Boolean(registry.items[entry.id]) &&
      (entry.metadata == null || Number.isSafeInteger(entry.metadata))
  }

  function matchesMetadata (requirements, items, triggers) {
    const remaining = items.map(entry => ({ ...entry, remaining: entry.count }))
    // Satisfy specific metadata before wildcards so a wildcard cannot consume
    // the only item satisfying a later, more specific recipe slot.
    for (const input of [...requirements].sort((a, b) => Number(a.metadata == null) - Number(b.metadata == null))) {
      for (let index = 0; index < triggers; index++) {
        const source = remaining.find(entry => entry.remaining > 0 && entry.type === input.id &&
          (input.metadata == null || entry.metadata === input.metadata))
        if (!source) return false
        source.remaining--
      }
    }
    return remaining.every(entry => entry.remaining === 0)
  }

  function selectRecipe (step, declared, table, items) {
    const recipes = bot.recipesAll(declared.result.type, null, table) || []
    for (const recipe of recipes) {
      if (recipe?.result?.id !== declared.result.type || recipe.result.count !== declared.result.count ||
        recipe.requiresTable !== step.requiresTable) continue
      let executable
      try { executable = withStandardRecipeOutputs(registry, recipe) } catch { continue }
      const materials = recipeMaterials(executable)
      if (!materials || !sameAmounts(materials.inputs.map(input => ({ ...input, amount: input.amount * declared.triggers })),
        declared.inputs, entry => entry.id ?? entry.type) ||
        !matchesMetadata(materials.inputs, items, declared.triggers)) continue
      const expected = catalog.aggregatePrismarineItems(standardRecipeOutputs(registry, executable).map(entry => new Item(entry.id, entry.count, entry.metadata)))
      return { recipe: executable, expected }
    }
    throw error('no standard recipe matches the concrete input ids, counts, result and table requirement')
  }

  function proportionalCells (recipe) {
    const width = recipe.requiresTable ? 3 : 2
    const cells = []
    if (recipe.inShape) {
      if (!Array.isArray(recipe.inShape) || recipe.inShape.length > width) return null
      for (let y = 0; y < recipe.inShape.length; y++) {
        const row = recipe.inShape[y]
        if (!Array.isArray(row) || row.length > width) return null
        for (let x = 0; x < row.length; x++) {
          const ingredient = row[x]
          if (ingredient?.id === -1) continue
          if (!validItem(ingredient) || ingredient.count !== 1) return null
          cells.push({ slot: 1 + x + width * y, ingredient })
        }
      }
    } else if (Array.isArray(recipe.ingredients)) {
      if (!recipe.ingredients.length || recipe.ingredients.length > width * width) return null
      recipe.ingredients.forEach((ingredient, index) => {
        if (!validItem(ingredient) || Math.abs(ingredient.count) !== 1) return
        cells.push({ slot: 1 + index, ingredient })
      })
      if (cells.length !== recipe.ingredients.length) return null
    } else {
      return null
    }
    return cells.length ? cells : null
  }

  function proportionalPlacementPlan (window, cells, triggers) {
    const remaining = new Map()
    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++) {
      const value = window.slots[slot]
      if (value) remaining.set(slot, { count: Number(value.count) || 0, itemKey: catalog.fromPrismarineItem(value).itemKey })
    }
    const plan = []
    for (const cell of cells) {
      const groups = new Map()
      for (const [slot, source] of remaining) {
        const value = window.slots[slot]
        if (!value || source.count <= 0 || value.type !== cell.ingredient.id ||
          (cell.ingredient.metadata != null && value.metadata !== cell.ingredient.metadata)) continue
        const entries = groups.get(source.itemKey) || []
        entries.push({ slot, count: source.count, stackSize: value.stackSize })
        groups.set(source.itemKey, entries)
      }
      const matching = [...groups.values()].find(entries => entries[0].stackSize >= triggers &&
        entries.reduce((sum, entry) => sum + entry.count, 0) >= triggers)
      if (!matching) return null
      let needed = triggers
      const sources = []
      for (const source of matching) {
        if (needed <= 0) break
        const count = Math.min(needed, source.count)
        sources.push({ slot: source.slot, count, sourceCount: source.count, itemKey: source.itemKey })
        remaining.set(source.slot, { ...remaining.get(source.slot), count: source.count - count })
        needed -= count
      }
      plan.push({ ...cell, sources })
    }
    return plan
  }

  async function openCraftingWindow (table, check) {
    if (bot.currentWindow) return bot.currentWindow
    if (typeof bot.activateBlock !== 'function') return null
    let resolveWindow
    const pending = new Promise(resolve => { resolveWindow = resolve })
    const onOpen = window => resolveWindow(window)
    bot.once?.('windowOpen', onOpen)
    try {
      await bot.activateBlock(table)
    } catch (cause) {
      bot.removeListener?.('windowOpen', onOpen)
      throw error('crafting table window could not be opened', true, cause)
    }
    let window = bot.currentWindow
    const windowDeadline = Date.now() + 5_000
    try {
      while (!window && Date.now() < windowDeadline) {
        check()
        window = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(null), 25))])
      }
      check()
    } finally {
      bot.removeListener?.('windowOpen', onOpen)
    }
    if (!window) throw error('crafting table window did not open', true)
    if (!window.type?.startsWith('minecraft:crafting')) throw error('opened window is not a crafting table', true)
    return window
  }

  function proportionalOutputsFit (recipe, triggers, slots) {
    const outputs = standardRecipeOutputs(registry, recipe)
    const required = outputs.reduce((sum, output) => {
      const name = registry.items[output.id]?.name
      const stackSize = Math.max(1, Number(catalog.getStackSize(`minecraft:${name}`) || 64))
      return sum + Math.ceil((output.count * triggers) / stackSize)
    }, 0)
    return required <= slots
  }

  async function craftProportionally (recipe, triggers, table, check, evidence) {
    if (triggers <= 1) return false
    const window = table ? await openCraftingWindow(table, check) : bot.inventory
    if (!window || !Array.isArray(window.slots) || !Number.isInteger(window.inventoryStart) || !Number.isInteger(window.inventoryEnd)) return false
    const fallback = () => {
      if (table && bot.currentWindow === window) bot.closeWindow(window)
      return false
    }
    // The proportional path needs Mineflayer's real inventory/window model so
    // every source stack can be planned before the first click. Lightweight
    // callers and legacy adapters continue through bot.craft unchanged.
    if (typeof window.findInventoryItem !== 'function') return fallback()
    if (!proportionalOutputsFit(recipe, triggers, window.inventoryEnd - window.inventoryStart)) return fallback()
    const cells = proportionalCells(recipe)
    const plan = cells && proportionalPlacementPlan(window, cells, triggers)
    if (!plan) return fallback()
    const gridSize = recipe.requiresTable ? 9 : 4
    const describeItem = item => item ? {
      name: item.name || registry.items[item.type]?.name || `item:${item.type}`,
      metadata: item.metadata ?? null,
      count: item.count
    } : null
    const describeWindow = () => {
      const current = evidence.current()
      return {
        windowId: window.id,
        windowType: window.type,
        cursor: describeItem(window.selectedItem),
        result: describeItem(window.slots[0]),
        grid: window.slots.slice(1, gridSize + 1).flatMap((item, index) => item ? [{ slot: index + 1, ...describeItem(item) }] : []),
        server: {
          resultObserved: current.resultObserved,
          resultPresent: current.resultPresent,
          cursorKnown: current.cursorKnown,
          cursor: describeItem(current.cursor),
          slots: Array.from({ length: gridSize + 1 }, (_, slot) => {
            const item = current.windowSlot(window.id, slot)
            return { slot, version: current.slotVersion(window.id, slot), item: item && {
              itemKey: item.itemKey,
              itemId: item.itemId,
              amount: item.amount
            } }
          })
        }
      }
    }
    const placementSlots = plan.map(placement => placement.slot)
    emitDebug('executor.grid_placement_plan', {
      windowId: window.id,
      windowType: window.type,
      gridSize,
      triggers,
      placements: plan.map(placement => ({
        slot: placement.slot,
        item: itemSummary(window.slots[placement.sources[0]?.slot]),
        amount: placement.count,
        sources: placement.sources.map(source => ({
          slot: source.slot,
          amount: source.count,
          availableBefore: source.sourceCount
        }))
      }))
    })
    const placementBaselines = new Map(placementSlots.map(slot => [slot, evidence.current().slotVersion(window.id, slot)]))
    for (const placement of plan) {
      for (const source of placement.sources) {
        check()
        await bot.clickWindow(source.slot, 0, 0)
        if (source.count === source.sourceCount) {
          await bot.clickWindow(placement.slot, 0, 0)
        } else {
          for (let count = 0; count < source.count; count++) await bot.clickWindow(placement.slot, 1, 0)
          await bot.clickWindow(source.slot, 0, 0)
        }
      }
    }
    check()
    const expectedPlacement = new Map(plan.map(placement => {
      const item = window.slots[placement.slot]
      return [placement.slot, item ? catalog.fromPrismarineItem(item) : null]
    }))
    try {
      await evidence.waitForSlots(window.id, placementSlots, placementBaselines, check,
        'server did not confirm the proportional crafting grid', expectedPlacement)
    } catch (cause) {
      warehouse?.debug?.(`craft window placement update timeout item=${registry.items[recipe.result.id]?.name || recipe.result.id} triggers=${triggers} ${JSON.stringify(describeWindow())}`)
      throw cause
    }
    const activeGridSlots = window.slots.slice(1, gridSize + 1)
      .flatMap((item, index) => item ? [index + 1] : [])
    const watchedSlots = [0, ...activeGridSlots]
    const updateBaselines = new Map(watchedSlots.map(slot => [slot, evidence.current().slotVersion(window.id, slot)]))
    warehouse?.debug?.(`craft window shift-click start item=${registry.items[recipe.result.id]?.name || recipe.result.id} triggers=${triggers} ${JSON.stringify(describeWindow())}`)
    await bot.clickWindow(0, 0, 1)
    try {
      await evidence.waitForSlots(window.id, watchedSlots, updateBaselines, check, 'server did not confirm the crafting window after shift-click')
    } catch (cause) {
      warehouse?.debug?.(`craft window shift-click update timeout item=${registry.items[recipe.result.id]?.name || recipe.result.id} triggers=${triggers} ${JSON.stringify(describeWindow())}`)
      throw cause
    }
    warehouse?.debug?.(`craft window shift-click confirmed item=${registry.items[recipe.result.id]?.name || recipe.result.id} triggers=${triggers} ${JSON.stringify(describeWindow())}`)
    const collectResultResidual = async () => {
      if (!evidence.current().resultPresent) return false
      if (!window.slots[0]) throw error('server result slot disagrees with the crafting window', true)
      const baselines = new Map([[0, evidence.current().slotVersion(window.id, 0)]])
      await bot.clickWindow(0, 0, 0)
      await evidence.waitForSlots(window.id, [0], baselines, check, 'server did not confirm collection of the residual crafting result')
      await bot.putSelectedItemRange(window.inventoryStart, window.inventoryEnd, window)
      return true
    }
    // Some servers leave the last result in slot 0 when the shift-click stops
    // early. Collect that concrete item before closing; exact output evidence
    // below decides whether the batch completed or needs recovery.
    await collectResultResidual()
    // Recipe container returns can remain in input cells after shift-click.
    for (let slot = 1; slot <= gridSize; slot++) {
      if (!window.slots[slot]) continue
      const baselines = new Map([[slot, evidence.current().slotVersion(window.id, slot)]])
      await bot.clickWindow(slot, 0, 0)
      await evidence.waitForSlots(window.id, [slot], baselines, check, `server did not confirm clearing crafting grid slot ${slot}`)
      await bot.putSelectedItemRange(window.inventoryStart, window.inventoryEnd, window)
    }
    if (window.selectedItem || window.slots.slice(0, gridSize + 1).some(Boolean)) {
      const current = describeWindow()
      const residual = [
        window.slots[0] && 'result slot',
        current.grid.length && 'crafting grid',
        window.selectedItem && 'cursor'
      ].filter(Boolean)
      warehouse?.debug?.(`craft window cleanup residual item=${registry.items[recipe.result.id]?.name || recipe.result.id} triggers=${triggers} residual=${residual.join('+')} ${JSON.stringify(current)}`)
      throw error(`proportional craft left ${residual.join(', ') || 'unknown'} residual`, true)
    }
    return { window, collectResultResidual }
  }

  // Read-only intent used by the controller's durable pre-mutation journal.
  // Supplying the configured coordinate to recipesAll includes 3x3 candidates;
  // execute still navigates and validates the actual block before calling craft.
  function preview (step, triggers = 1) {
    if (active) throw error('inventory executor is busy')
    const declared = batchDeclaration(step, triggers)
    const before = ensureBaseline(declared)
    // Planning preview only needs recipe candidates for expected outputs; the
    // concrete table block is discovered and validated at execution time.
    const table = step.requiresTable ? { position: tableSearchOrigin() } : undefined
    const { expected } = selectRecipe(step, declared, table, bot.inventory.items())
    return {
      expectedConsumed: before,
      expectedProduced: expected.map(item => ({ ...item, amount: item.amount * triggers }))
    }
  }

  function installMovementFence (check) {
    const pathfinder = bot.pathfinder
    const originalGoto = pathfinder?.goto
    const originalControl = bot.setControlState
    const goto = function (...args) { check(); return originalGoto.apply(pathfinder, args) }
    const control = function (name, enabled) { if (enabled) check(); return originalControl.call(bot, name, enabled) }
    if (typeof originalGoto === 'function') pathfinder.goto = goto
    if (typeof originalControl === 'function') bot.setControlState = control
    return () => {
      if (pathfinder?.goto === goto) pathfinder.goto = originalGoto
      if (bot.setControlState === control) bot.setControlState = originalControl
    }
  }

  function installCraftFence (operation, check) {
    if (typeof bot.clickWindow !== 'function') throw error('craft click API is unavailable')
    const original = {
      clickWindow: bot.clickWindow,
      putAway: bot.putAway,
      putSelectedItemRange: bot.putSelectedItemRange
    }
    const clickWindow = async function (slot, ...args) {
      check()
      const window = bot.currentWindow || bot.inventory
      const mouseButton = args[0]
      const mode = args[1]
      const supportedClick = (mode === 0 && [0, 1].includes(mouseButton)) ||
        (mode === 1 && slot === 0 && mouseButton === 0)
      if (!Number.isInteger(slot) || slot < 0 || slot >= window.slots.length || !supportedClick) {
        throw error('craft cannot drop items or use an unsupported click', true)
      }
      operation.clickEpoch++
      const click = { windowId: window.id, slot, mouseButton, mode, epoch: operation.clickEpoch }
      emitDebug('executor.window_click_start', click)
      try {
        const result = await original.clickWindow.call(bot, slot, ...args)
        emitDebug('executor.window_click_complete', click)
        return result
      } catch (cause) {
        emitDebug('executor.window_click_failure', { ...click, message: cause?.message || String(cause) })
        throw cause
      }
    }
    const park = async window => {
      const start = window.inventoryStart
      const end = window.inventoryEnd
      if (!Number.isInteger(start) || !Number.isInteger(end) || !Array.isArray(window.slots)) throw error('invalid cursor parking range', true)
      let attempts = 0
      while (window.selectedItem) {
        check()
        const cursor = catalog.fromPrismarineItem(window.selectedItem)
        let target = -1
        for (let slot = start; slot < end; slot++) {
          const value = window.slots[slot]
          if (value && value.count < value.stackSize && catalog.fromPrismarineItem(value).itemKey === cursor.itemKey) { target = slot; break }
        }
        if (target < 0) {
          for (let slot = start; slot < end; slot++) if (!window.slots[slot]) { target = slot; break }
        }
        if (target < 0 || attempts++ > end - start) throw error('no safe inventory space for craft cursor', true)
        await clickWindow(target, 0, 0)
      }
    }
    const putSelectedItemRange = async (start, end, window) => park(window || bot.currentWindow || bot.inventory)
    const putAway = async slot => {
      const window = bot.currentWindow || bot.inventory
      await clickWindow(slot, 0, 0)
      await park(window)
    }
    bot.clickWindow = clickWindow
    bot.putSelectedItemRange = putSelectedItemRange
    bot.putAway = putAway
    return () => {
      if (bot.clickWindow === clickWindow) bot.clickWindow = original.clickWindow
      if (bot.putSelectedItemRange === putSelectedItemRange) bot.putSelectedItemRange = original.putSelectedItemRange
      if (bot.putAway === putAway) bot.putAway = original.putAway
    }
  }

  function observeServerInventory (operation, recipe, table) {
    if (typeof bot._client?.on !== 'function') throw error('authoritative craft server updates are unavailable')
    const ranges = new Map([[0, { start: 9, end: 45 }]])
    const shadow = new Map()
    for (let slot = 9; slot < 45; slot++) {
      const value = bot.inventory.slots[slot]
      if (value) shadow.set(slot - 9, catalog.fromPrismarineItem(value))
    }
    let resultObserved = false
    let resultPresent = false
    let updateEpoch = -1
    let version = 0
    let invalid = false
    let cursorKnown = false
    let cursor = null
    let cursorEpoch = -1
    const slotVersions = new Map()
    const windowSlots = new Map()
    const resultWindows = new Set(table ? [] : [0])
    const expectedResult = catalog.fromPrismarineItem(new Item(recipe.result.id, recipe.result.count, recipe.result.metadata))
    const open = window => {
      // The final warehouse read also needs a player-slot range. Only actual
      // crafting windows may contribute independent result-slot evidence.
      if (Number.isInteger(window?.id) && Number.isInteger(window.inventoryStart) && Number.isInteger(window.inventoryEnd)) {
        ranges.set(window.id, { start: window.inventoryStart ?? 10, end: window.inventoryEnd ?? 46 })
        if (table && window.type?.startsWith('minecraft:crafting')) resultWindows.add(window.id)
        emitDebug('executor.window_opened', {
          windowId: window.id,
          windowType: window.type,
          inventoryStart: window.inventoryStart,
          inventoryEnd: window.inventoryEnd,
          craftingTable: Boolean(table)
        })
      }
    }
    const slot = (windowId, index, raw) => {
      const range = ranges.get(windowId)
      if (!range) return
      let value
      try { value = Item.fromNotch(raw) } catch { invalid = true; return }
      const slotKey = `${windowId}:${index}`
      const craftSlot = resultWindows.has(windowId) && index >= 0 && index < range.start
      const previous = craftSlot
        ? windowSlots.get(windowId)?.get(index)
        : (index >= range.start && index < range.end ? shadow.get(index - range.start) : null)
      const normalized = value && catalog.fromPrismarineItem(value)
      const changed = (!previous && normalized) || (previous && !normalized) ||
        (previous && normalized && (previous.itemKey !== normalized.itemKey || previous.amount !== normalized.amount))
      slotVersions.set(slotKey, (slotVersions.get(slotKey) || 0) + 1)
      if (craftSlot) {
        const slots = windowSlots.get(windowId) || new Map()
        if (normalized) slots.set(index, normalized)
        else slots.delete(index)
        windowSlots.set(windowId, slots)
      }
      if (index === 0 && resultWindows.has(windowId) && value) {
        resultPresent = true
        const normalized = catalog.fromPrismarineItem(value)
        if (normalized.itemKey === expectedResult.itemKey && value.count === recipe.result.count) resultObserved = true
      } else if (index === 0 && resultWindows.has(windowId)) {
        resultPresent = false
      }
      const inventorySlot = index >= range.start && index < range.end
      if (inventorySlot) {
        if (normalized) shadow.set(index - range.start, normalized)
        else shadow.delete(index - range.start)
        updateEpoch = operation.clickEpoch
        version++
      }
      if (changed && (craftSlot || inventorySlot)) {
        emitDebug('executor.server_slot_update', {
          windowId,
          slot: index,
          area: craftSlot ? 'crafting' : 'inventory',
          item: itemSummary(normalized)
        })
      }
    }
    const onSlot = packet => slot(packet.windowId, packet.slot, packet.item)
    const markResultObserved = () => {
      // After bot.craft resolves, the loop's clicks have placed every trigger;
      // the server's last result-slot packet may have raced the final putAway
      // epoch, so post-loop confirmation trusts the completed call instead.
      resultObserved = true
      updateEpoch = operation.clickEpoch
    }
    const onContent = packet => {
      const values = packet.items ?? packet.slots
      if (Array.isArray(values)) values.forEach((value, index) => slot(packet.windowId ?? packet.containerId, index, value))
      const rawCursor = Object.hasOwn(packet, 'carriedItem') ? packet.carriedItem : packet.cursorItem
      if (Object.hasOwn(packet, 'carriedItem') || Object.hasOwn(packet, 'cursorItem')) setCursor(rawCursor)
    }
    const onPlayer = packet => slot(0, packet.slotId, packet.contents)
    const setCursor = raw => {
      if (raw === undefined) { invalid = true; return }
      try {
        cursor = Item.fromNotch(raw)
        cursorKnown = true
        cursorEpoch = operation.clickEpoch
        version++
        emitDebug('executor.server_cursor_update', { item: itemSummary(cursor && catalog.fromPrismarineItem(cursor)) })
      } catch { invalid = true }
    }
    const onCursor = packet => setCursor(Object.hasOwn(packet, 'contents') ? packet.contents :
      (Object.hasOwn(packet, 'item') ? packet.item : packet.carriedItem))
    const onLegacyCursor = packet => {
      if ((packet.windowId === -1 || packet.windowId === 255) && (packet.slot === -1 || packet.slot === 255)) setCursor(packet.item)
      else onSlot(packet)
    }
    const listeners = [['set_slot', onLegacyCursor], ['container_set_slot', onLegacyCursor], ['window_items', onContent],
      ['container_set_content', onContent], ['set_player_inventory', onPlayer], ['set_cursor_item', onCursor], ['container_set_cursor_item', onCursor]]
    bot.on('windowOpen', open)
    for (const [name, listener] of listeners) bot._client.on(name, listener)
    return {
      current: () => {
        const byKey = new Map()
        for (const entry of shadow.values()) {
          const previous = byKey.get(entry.itemKey)
          if (previous) previous.amount += entry.amount
          else byKey.set(entry.itemKey, { ...entry })
        }
        return {
          items: [...byKey.values()], resultObserved, resultPresent, updateEpoch, version, invalid,
          cursorKnown, cursor, cursorEpoch,
          slotVersion: (windowId, slot) => slotVersions.get(`${windowId}:${slot}`) || 0,
          windowSlot: (windowId, slot) => {
            const item = windowSlots.get(windowId)?.get(slot)
            return item ? { ...item } : null
          }
        }
      },
      waitForSlots: async (windowId, slots, baselines, check, message, expectedSlots = null) => {
        const expires = Date.now() + Math.max(1, Number(config?.craft?.confirmTimeoutMs) || 5000)
        while (true) {
          check()
          const ready = slots.every(slot => {
            if ((slotVersions.get(`${windowId}:${slot}`) || 0) <= (baselines.get(slot) || 0)) return false
            if (!expectedSlots) return true
            const expected = expectedSlots.get(slot)
            const current = windowSlots.get(windowId)?.get(slot)
            if (!expected) return !current
            return current?.itemKey === expected.itemKey && current.amount === expected.amount
          })
          if (ready) return
          if (Date.now() >= expires) throw error(message, true)
          await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, expires - Date.now()))))
        }
      },
      markResultObserved,
      acceptSnapshot: serverSnapshot => {
        const window = serverSnapshot.container
        shadow.clear()
        for (let index = window.inventoryStart; index < window.inventoryEnd; index++) {
          const value = window.slots[index]
          if (value) shadow.set(index - window.inventoryStart, catalog.fromPrismarineItem(value))
        }
        updateEpoch = operation.clickEpoch
        setCursor(Item.toNotch(null))
      },
      close: () => {
        bot.removeListener('windowOpen', open)
        for (const [name, listener] of listeners) bot._client.removeListener(name, listener)
      }
    }
  }

  async function confirmServerInventory (operation, evidence, expected, check, { requireEmptyResult = false, collectResultResidual } = {}) {
    const confirmationMs = Math.max(1, Number(config?.craft?.confirmTimeoutMs) || 5000)
    const settleMs = Math.max(1, Number(config?.craft?.settleMs) || 150)
    const expires = Date.now() + confirmationMs
    let stableSince = null
    let lastVersion = -1
    while (true) {
      check()
      let current = evidence.current()
      if (requireEmptyResult && current.resultPresent && collectResultResidual) {
        await collectResultResidual()
        stableSince = null
        lastVersion = -1
        current = evidence.current()
      }
      const confirmed = !current.invalid && current.resultObserved && current.updateEpoch === operation.clickEpoch &&
        (!requireEmptyResult || !current.resultPresent) &&
        current.cursorKnown && !current.cursor && current.cursorEpoch === operation.clickEpoch &&
        sameAmounts(current.items, expected, entry => entry.itemKey) && sameAmounts(snapshot(), expected, entry => entry.itemKey)
      if (!confirmed || lastVersion !== current.version) stableSince = confirmed ? Date.now() : null
      lastVersion = current.version
      if (stableSince != null && Date.now() - stableSince >= settleMs) {
        current = evidence.current()
        emitDebug('executor.inventory_confirmed', {
          expected: amountSummary(expected),
          observed: amountSummary(snapshot()),
          serverObserved: amountSummary(current.items),
          resultPresent: current.resultPresent,
          cursor: itemSummary(current.cursor && catalog.fromPrismarineItem(current.cursor))
        })
        return
      }
      if (Date.now() >= expires) break
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, expires - Date.now()), settleMs)))
    }

    const current = evidence.current()
    if (!current.resultObserved) throw error('authoritative crafting result slot was not confirmed', true)
    if (requireEmptyResult && current.resultPresent) throw error('proportional craft result slot still contains an item', true)
    if (current.cursorKnown && current.cursor) throw error('server craft cursor still holds an item', true)
    const chests = warehouse?.db?.listChests?.() || []
    if (!chests.length) throw error('authoritative server craft inventory and cursor were not confirmed', true)
    if (bot.currentWindow) {
      try { bot.closeWindow(bot.currentWindow) } catch {}
    }
    let serverSnapshot
    try {
      serverSnapshot = await readServerContainer(warehouse, chests[0], catalog, bot)
    } catch (cause) {
      throw error('authoritative server craft inventory and cursor snapshot was not confirmed', true, cause)
    }
    check()
    const matched = sameAmounts(serverSnapshot.playerItems, expected, entry => entry.itemKey) &&
      sameAmounts(snapshot(), expected, entry => entry.itemKey)
    if (!matched) {
      emitDebug('executor.inventory_mismatch', {
        expected: amountSummary(expected),
        observed: amountSummary(snapshot()),
        serverObserved: amountSummary(serverSnapshot.playerItems),
        serverCursor: itemSummary(evidence.current().cursor && catalog.fromPrismarineItem(evidence.current().cursor)),
        resultPresent: evidence.current().resultPresent
      })
      throw error('authoritative server craft inventory snapshot does not match the expected output', true)
    }
    evidence.acceptSnapshot(serverSnapshot)
    emitDebug('executor.inventory_confirmed', {
      expected: amountSummary(expected),
      observed: amountSummary(snapshot()),
      serverObserved: amountSummary(serverSnapshot.playerItems),
      resultPresent: evidence.current().resultPresent,
      cursor: itemSummary(evidence.current().cursor && catalog.fromPrismarineItem(evidence.current().cursor))
    })

    const fallbackExpires = Date.now() + settleMs
    while (true) {
      check()
      const latest = evidence.current()
      if (latest.invalid || !latest.resultObserved || !latest.cursorKnown || latest.cursor ||
        (requireEmptyResult && latest.resultPresent) ||
        !sameAmounts(latest.items, expected, entry => entry.itemKey) ||
        !sameAmounts(snapshot(), expected, entry => entry.itemKey)) {
        throw error('server craft inventory or cursor changed after the final snapshot', true)
      }
      if (Date.now() >= fallbackExpires) return
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, fallbackExpires - Date.now()))))
    }
  }

  function ensureBaseline (declared) {
    if (bot.currentWindow || bot.inventory.selectedItem || bot.inventory.slots?.slice(0, 5).some(Boolean)) {
      throw error('craft requires a closed window, empty cursor and empty crafting grid', true)
    }
    const before = snapshot()
    if (!sameAmounts(before, declared.inputs, entry => entry.itemId)) {
      throw error('craft inventory must contain exactly the one-trigger inputs; historical inventory is not allowed', true)
    }
    return before
  }

  function configuredTable () {
    const position = config?.craft?.table
    if (!position || !['x', 'y', 'z'].every(axis => Number.isFinite(position[axis]))) throw error('crafting table is not configured')
    return new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
  }

  function tableSearchOrigin () {
    if (configuredTable) {
      try { return configuredTable() } catch { /* fall through to auto discovery */ }
    }
    const position = warehouse?.homePosition || bot.entity?.position
    if (!position || !['x', 'y', 'z'].every(axis => Number.isFinite(position[axis]))) {
      throw error('crafting table autodiscovery has no scan origin (no bot position)')
    }
    return new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
  }

  // Automatic discovery: scan loaded chunks around the warehouse for crafting
  // tables, then walk to the nearest reachable one. A configured coordinate
  // (if any) is tried first and autodiscovery is the fallback; the recovery
  // journal never depends on which table was used — every craft step re-reads
  // server container evidence before settling accounts.
  function discoverTablePositions (origin, radius) {
    if (typeof bot.findBlocks !== 'function') {
      throw error('crafting table autodiscovery is unavailable (no findBlocks)')
    }
    const positions = bot.findBlocks({
      matching: block => block?.name === 'crafting_table',
      maxDistance: Math.max(1, radius || 64),
      count: 64
    })
    const unique = []
    const seen = new Set()
    for (const position of positions) {
      const key = `${position.x},${position.y},${position.z}`
      if (seen.has(key)) continue
      seen.add(key)
      const block = bot.blockAt(position)
      if (block?.name === 'crafting_table') unique.push(new Vec3(position.x, position.y, position.z))
    }
    unique.sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin))
    return unique
  }

  async function resolveTable (check) {
    if (typeof warehouse?.gotoNear !== 'function') throw error('Warehouse.gotoNear is required for table navigation')
    const candidates = []
    if (config?.craft?.table && ['x', 'y', 'z'].every(axis => Number.isFinite(config.craft.table[axis]))) {
      candidates.push(configuredTable())
    }
    const origin = tableSearchOrigin()
    for (const position of discoverTablePositions(origin, config?.craft?.tableSearchRadius)) {
      if (!candidates.some(candidate => candidate.equals(position))) candidates.push(position)
    }
    if (!candidates.length) {
      throw error('no reachable crafting table: none configured and none discovered nearby', true)
    }
    let lastError = null
    for (const position of candidates) {
      check()
      try {
        // Await the original navigation promise even after abort. Releasing the
        // lock early would allow a late path operation to overlap the next task.
        await warehouse.gotoNear(position.x, position.y, position.z)
        check()
        return validateArrival(position)
      } catch (navigationError) {
        lastError = navigationError
      }
    }
    throw error(`no reachable crafting table among ${candidates.length} candidate(s): ${lastError?.message || 'navigation failed'}`, true)
  }

  function validateArrival (position) {
    const block = bot.blockAt(position)
    if (block?.name !== 'crafting_table' || !block.position || !['x', 'y', 'z'].every(axis => block.position[axis] === position[axis])) {
      throw error('configured crafting table block is missing or changed')
    }
    const feet = bot.entity?.position
    if (!feet || !['x', 'y', 'z'].every(axis => Number.isFinite(feet[axis]))) throw error('cannot confirm crafting table arrival')
    const eye = new Vec3(feet.x, feet.y + Number(bot.entity.height || 1.8) * 0.9, feet.z)
    if (eye.distanceTo(position.offset(0.5, 0.5, 0.5)) > 4.5) throw error('crafting table remains out of reach after navigation')
    return block
  }

  async function execute ({ step, triggers = 1, signal, deadline, operationId, stepId } = {}) {
    if (active) throw error('inventory executor is busy')
    const operation = { reason: null, craftStarted: false, before: null, clickEpoch: 0, operationId, stepId }
    active = operation
    let timer
    let restoreFence
    let restoreMovement
    let evidence
    const onAbort = () => cancel(signal.reason || 'craft cancelled')
    const onWindow = window => { if (operation.reason) stop(window) }
    const expires = deadline ?? (Date.now() + (Number(config?.craft?.timeoutMs) || 1200000))
    const check = () => {
      if (!operation.reason && Date.now() >= expires) operation.reason = error('craft deadline timeout')
      if (operation.reason) throw operation.reason
    }
    try {
      if (!Number.isFinite(expires)) throw error('invalid craft deadline')
      if (signal?.aborted) throw error(String(signal.reason?.message || signal.reason || 'craft cancelled'))
      check()
      signal?.addEventListener('abort', onAbort, { once: true })
      bot.on?.('windowOpen', onWindow)
      timer = setTimeout(() => cancel('craft deadline timeout'), Math.min(expires - Date.now(), 2147483647))
      const declared = batchDeclaration(step, triggers)
      operation.before = ensureBaseline(declared)
      restoreMovement = installMovementFence(check)
      let table
      if (step.requiresTable) {
        table = await resolveTable(check)
      }
      const before = ensureBaseline(declared)
      if (!sameAmounts(before, operation.before, entry => entry.itemKey)) throw error('inventory changed before crafting', true)
      const { recipe, expected } = selectRecipe(step, declared, table, bot.inventory.items())
      const batchExpected = expected.map(item => ({ ...item, amount: item.amount * triggers }))
      operation.expected = batchExpected
      emitDebug('executor.start', {
        result: `minecraft:${step.result.name}`,
        triggers,
        requiresTable: step.requiresTable,
        recipeType: recipe.type || null,
        inputs: amountSummary(before),
        expected: amountSummary(batchExpected)
      })
      check()
      evidence = observeServerInventory(operation, recipe, table)
      restoreFence = installCraftFence(operation, check)
      operation.craftStarted = true
      // Mineflayer has no abortable craft API. Cancellation requests stop/close
      // immediately, but this await must drain before finally releases busy.
      // A permanently pending craft intentionally keeps this executor busy.
      // Fill the 2x2 or 3x3 grid proportionally and take the result once when
      // the concrete input stacks can satisfy every grid cell. If a batch is
      // split across undersized stacks, retain Mineflayer's safe fallback.
      const proportional = await craftProportionally(recipe, triggers, table, check, evidence)
      if (!proportional) await bot.craft(recipe, triggers, table)
      check()
      // The proportional path must receive a real result-slot packet. The
      // native fallback uses Mineflayer's completed call as its existing
      // compatibility signal.
      if (!proportional) evidence.markResultObserved()
      await confirmServerInventory(operation, evidence, batchExpected, check, {
        requireEmptyResult: Boolean(proportional),
        collectResultResidual: proportional?.collectResultResidual
      })
      if (proportional?.window && bot.currentWindow === proportional.window) bot.closeWindow(proportional.window)
      const after = snapshot()
      if (!sameAmounts(after, batchExpected, entry => entry.itemKey)) throw error('unexpected physical craft inventory delta', true)
      if (bot.currentWindow || bot.inventory.selectedItem || bot.inventory.slots?.slice(0, 5).some(Boolean)) {
        throw error('craft left an open window, cursor item or crafting-grid residue', true)
      }
      emitDebug('executor.complete', {
        consumed: amountSummary(before),
        produced: amountSummary(after),
        triggers
      })
      // These are gross input/output movements, including returned containers.
      // Every item in before was an input and every item in after is an output.
      return { before, after, consumed: before, produced: after }
    } catch (cause) {
      const rejection = operation.reason || cause
      const failure = rejection instanceof Error ? rejection : error(String(rejection || 'craft failed'))
      const serverEvidence = evidence?.current()
      let snapshotError = null
      if (operation.craftStarted || failure.recoveryRequired) {
        stop()
        failure.recoveryRequired = true
        failure.before = operation.before
        try {
          failure.after = snapshot()
          // A mid-batch failure with both boundary snapshots captured is a
          // provable partial conversion: consumed = before minus what remains,
          // produced = what the batch actually created. The controller settles
          // it immediately instead of leaving a recovery journal.
          const consumedTotals = new Map()
          for (const item of operation.before || []) {
            const remains = (failure.after || []).find(entry => entry.itemKey === item.itemKey)
            const remaining = Math.max(0, item.amount - (remains?.amount || 0))
            if (remaining > 0) consumedTotals.set(item.itemKey, { ...item, amount: remaining })
          }
          const producedTotals = new Map()
          for (const item of failure.after || []) {
            const preExisting = (operation.before || []).find(entry => entry.itemKey === item.itemKey)
            const net = item.amount - (preExisting?.amount || 0)
            if (net > 0) producedTotals.set(item.itemKey, { ...item, amount: net })
          }
          failure.consumed = [...consumedTotals.values()]
          failure.produced = [...producedTotals.values()]
          if (failure.consumed.length || failure.produced.length) failure.partial = true
        } catch (cause) { snapshotError = cause }
      }
      emitDebug('executor.failure', {
        message: failure.message,
        recoveryRequired: Boolean(failure.recoveryRequired),
        partial: Boolean(failure.partial),
        expected: amountSummary(operation.expected),
        before: amountSummary(operation.before),
        observedInventory: amountSummary(failure.after || serverEvidence?.items || []),
        consumed: amountSummary(failure.consumed),
        produced: amountSummary(failure.produced),
        serverCursor: itemSummary(serverEvidence?.cursor && catalog.fromPrismarineItem(serverEvidence.cursor)),
        localCursor: itemSummary(bot.inventory.selectedItem && catalog.fromPrismarineItem(bot.inventory.selectedItem)),
        resultPresent: serverEvidence?.resultPresent ?? null,
        snapshotError: snapshotError?.message || null
      })
      throw failure
    } finally {
      clearTimeout(timer)
      restoreFence?.()
      restoreMovement?.()
      evidence?.close()
      signal?.removeEventListener('abort', onAbort)
      bot.removeListener?.('windowOpen', onWindow)
      active = null
    }
  }

  return { execute, preview, cancel, isBusy: () => active !== null }
}

module.exports = { createInventoryExecutor }

class AsyncMutex {
  constructor () {
    this.tail = Promise.resolve()
  }

  async run (fn) {
    const previous = this.tail
    let release
    this.tail = new Promise(resolve => { release = resolve })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

class BotTaskPool {
  constructor (config = {}) {
    this.config = config
    this.workers = new Set()
    this.queue = []
    this.sequence = 0
    this.fused = false
    this.fuseDrain = null
    this.seenMessages = new Map()
    // Retain the execution lease even when death/reconnect changes worker.active
    // or unregisters a disconnected worker. Its network calls may still drain.
    this.inFlight = new Map()
    this.drainWaiters = new Set()
    this.packingDrainWaiters = new Set()
    this.packingRecoveryLeases = new Set()
    this.warehouseMutex = new AsyncMutex()
    this.warehouseState = { revision: 0, chestRevisions: new Map() }
  }

  register (service) {
    this.workers.add(service)
    this.dispatch()
  }

  unregister (service) {
    this.workers.delete(service)
    this.dispatch()
  }

  cancelQueuedForWorker (worker) {
    const cancelled = []
    this.queue = this.queue.filter(task => {
      if (task.stickyWorker !== worker) return true
      cancelled.push(task)
      task.resolve?.(null)
      return false
    })
    if (cancelled.length) this.dispatch()
    return cancelled.length
  }

  cancelQueuedCraftRecovery (botId) {
    const cancelled = []
    this.queue = this.queue.filter(task => {
      if (task.type !== 'craft_recovery' || task.stickyWorker?.botId !== botId) return true
      cancelled.push(task)
      task.resolve?.(null)
      return false
    })
    if (cancelled.length) this.dispatch()
    return cancelled.length
  }

  acceptIncoming (username, message, source = '') {
    if (!String(message || '').trim().startsWith('!')) return true
    const now = Date.now()
    const ttl = Math.max(500, Number(this.config.timing?.commandDedupeMs || 1500))
    const key = `${String(username).toLowerCase()}|${source}|${String(message).trim()}`
    const seenAt = this.seenMessages.get(key) || 0
    if (now - seenAt < ttl) return false
    this.seenMessages.set(key, now)
    for (const [entry, timestamp] of this.seenMessages) {
      if (now - timestamp > ttl * 4) this.seenMessages.delete(entry)
    }
    return true
  }

  enqueue (task) {
    return new Promise((resolve, reject) => {
      if (this.fused) {
        resolve(null)
        return
      }
      const queued = {
        ...task,
        id: ++this.sequence,
        resolve,
        reject,
        enqueuedAt: Date.now()
      }
      this.queue.push(queued)
      task.onQueued?.(this.queue.length)
      this.dispatch()
    })
  }

  beginFuse (reason = 'admin task fuse') {
    if (this.fuseDrain) return this.fuseDrain.result
    this.fused = true
    const cancelled = this.queue.splice(0)
    for (const task of cancelled) task.resolve?.(null)
    let resolveDrained
    const drained = new Promise(resolve => { resolveDrained = resolve })
    const result = { cancelledQueued: cancelled.length, stopRequested: 0, drained }
    this.fuseDrain = { result, resolveDrained }
    const workers = new Set([...this.inFlight.keys(), ...this.workers].filter(worker => worker.active))
    for (const worker of workers) {
      try {
        if (worker.cancelActiveTask?.(reason)) result.stopRequested++
      } catch (error) {
        console.warn(`[task-fuse] failed to stop ${worker.botId || worker.bot?.username || 'worker'}: ${error.message}`)
      }
    }
    this.resolveFuseDrain()
    return result
  }

  resolveFuseDrain () {
    if (!this.fused || this.inFlight.size || this.packingRecoveryLeases.size) return
    const fuse = this.fuseDrain
    if (!fuse) return
    this.fused = false
    this.fuseDrain = null
    fuse.resolveDrained()
  }

  eligibleWorkerForTask (task) {
    // Craft recovery is bound to the bot that owns its physical inventory and
    // durable journal. Unlike ordinary private tasks, it must never fall back.
    if (task.type === 'craft_recovery' || task.type === 'packing_recovery') {
      const original = task.stickyWorker
      const sticky = this.workers.has(original) ? original : original?.botId
        ? [...this.workers].find(worker => worker.botId === original.botId)
        : null
      if (!sticky) return null
      return sticky.ready && !sticky.connectionInvalidated && !sticky.active && !this.inFlight.has(sticky) &&
        !(sticky.botId && this.hasInFlightPacking(sticky.botId)) &&
        !(sticky.botId && this.hasInFlightCraft(sticky.botId)) && !sticky.recoveringFromDeath && !sticky.emergencyRescueActive ? sticky : null
    }
    // 私聊进来的业务任务优先发给接收私信的机器人；它忙或身上挂着未恢复的
    // 合成记录时，退回任意空闲机器人，避免一条恢复循环把队列粘死
    // （2026-11-22 活塞恢复期间全站排队，空闲机器人空转 19 分钟）。
    const sticky = task.stickyWorker && this.workers.has(task.stickyWorker) ? task.stickyWorker : null
    const available = candidate => candidate.ready && !candidate.active && !this.inFlight.has(candidate) &&
      !(candidate.botId && this.hasInFlightPacking(candidate.botId)) &&
      !candidate.recoveringFromDeath && !candidate.emergencyRescueActive &&
      !candidate.db?.hasPendingCraft?.(candidate.botId)
    if (sticky && available(sticky)) return sticky
    return [...this.workers].find(available) || null
  }

  hasInFlightPacking (botId = '') {
    return [...this.packingRecoveryLeases].some(worker => !botId || worker.botId === botId) || [...this.inFlight].some(([worker, task]) =>
      (task.type === 'packing' || task.type === 'packing_recovery') && (!botId || worker.botId === botId))
  }

  async withPackingRecoveryLease (worker, fn) {
    if (this.hasInFlightPacking(worker.botId)) throw new Error('Previous packing calls must drain before lifecycle recovery')
    this.packingRecoveryLeases.add(worker)
    try { return await fn() } finally {
      this.packingRecoveryLeases.delete(worker)
      this.resolvePackingDrainWaiters()
      this.resolveFuseDrain()
      this.dispatch()
    }
  }

  waitForPackingDrain (botId = '') {
    if (!this.hasInFlightPacking(botId)) return Promise.resolve()
    return new Promise(resolve => this.packingDrainWaiters.add({ botId, resolve }))
  }

  resolvePackingDrainWaiters () {
    for (const waiter of this.packingDrainWaiters) {
      if (!this.hasInFlightPacking(waiter.botId)) {
        this.packingDrainWaiters.delete(waiter)
        waiter.resolve()
      }
    }
  }

  hasInFlightCraft (botId = '') {
    return [...this.inFlight].some(([worker, task]) =>
      (task.type === 'craft' || task.type === 'craft_recovery') && (!botId || worker.botId === botId))
  }

  waitForCraftDrain (botId = '') {
    if (!this.hasInFlightCraft(botId)) return Promise.resolve()
    return new Promise(resolve => this.drainWaiters.add({ botId, resolve }))
  }

  resolveCraftDrainWaiters () {
    for (const waiter of this.drainWaiters) {
      if (!this.hasInFlightCraft(waiter.botId)) {
        this.drainWaiters.delete(waiter)
        waiter.resolve()
      }
    }
  }

  snapshot () {
    const active = [...this.workers]
      .filter(worker => worker.active)
      .map(worker => ({ ...worker.active, botName: worker.bot.username }))
    return {
      queued: this.queue.map(task => ({
        id: task.id,
        type: task.type,
        username: task.username,
        stickyBotName: this.workers.has(task.stickyWorker) ? task.stickyWorker.bot.username : ''
      })),
      active,
      onlineBots: this.workers.size
    }
  }

  dispatch () {
    if (this.fused) return
    for (let index = 0; index < this.queue.length; index++) {
      const task = this.queue[index]
      const worker = this.eligibleWorkerForTask(task)
      // exclusive 任务只互斥 exclusive：起跑前仍要求全池空闲，但拿不到就
      // 跳过排队等待，不再作为全局屏障饿死后面的普通任务。
      if (task.exclusive) {
        if (this.inFlight.size || [...this.workers].some(current => current.active) || !worker) continue
        this.queue.splice(index, 1)
        this.run(worker, task)
        return
      }
      if (!worker) continue
      this.queue.splice(index, 1)
      index--
      this.run(worker, task)
    }
  }

  async run (worker, task) {
    this.inFlight.set(worker, task)
    try {
      const result = await worker.runExclusive(task.username, task.type, () => task.run(worker), {
        taskId: task.id,
        commandLogId: task.commandLogId || 0,
        exclusive: Boolean(task.exclusive)
      })
      task.resolve(result)
    } catch (error) {
      worker.handleCommandError(task.username, error)
      task.resolve(null)
    } finally {
      this.inFlight.delete(worker)
      this.resolveCraftDrainWaiters()
      this.resolvePackingDrainWaiters()
      this.resolveFuseDrain()
      this.dispatch()
    }
  }
}

module.exports = { AsyncMutex, BotTaskPool }

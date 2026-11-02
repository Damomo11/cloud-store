// ─────────────────────────────────────────────────────────────────────────────
// long-command-mutex.js — bot 级长命令互斥（跨执行器共享）
//
// 每个 bot 同一时刻至多执行 1 条长命令。此前各执行器（collect/craft/inventory/
// combat/interact）各自 createLongCommandMutex() 自持一个实例，station-executor
// 另有本地 activeLongCommand——两套锁互不感知：station-executor 把 collect_mine
// 委派给 collect-executor 时是本地的 activeLongCommand=null、collect-executor 自己
// 拿自己的锁，于是同批 inbox 里紧随的 supply_visit/move_to 会并发执行（移动/交互
// 打架）。收敛为 bot 级唯一实例：station-executor（唯一轮询者）创建并挂到
// bot._longCommandMutex，各执行器改为共享它，本地工厂仅作兜底。
// ─────────────────────────────────────────────────────────────────────────────

function createLongCommandMutex () {
  let active = null
  const idleWaiters = new Set()
  let lifecycleHooks = {}

  function callHook (name, ...args) {
    try { lifecycleHooks[name]?.(...args) } catch (_) { /* mutex semantics must not depend on telemetry */ }
  }

  function notifyIdle () {
    if (active || idleWaiters.size === 0) return
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }
  return {
    tryStart (kind, requestId, options = {}) {
      if (active) return false
      active = {
        kind,
        requestId,
        botGeneration: Number(options.botGeneration) || 0,
        startedAt: Date.now(),
        deadline: Number.isFinite(options.deadline) ? options.deadline : null,
        cancelReason: null,
        cancellationRequestedAt: null,
      }
      callHook('start', { ...active })
      return true
    },
    requestCancellation (requestId, botGeneration, reason = 'api_cancelled') {
      if (!active || active.requestId !== requestId || active.botGeneration !== (Number(botGeneration) || 0)) return false
      if (active.cancelReason == null) active.cancelReason = String(reason || 'api_cancelled')
      if (active.cancellationRequestedAt == null) active.cancellationRequestedAt = Date.now()
      return true
    },
    cancellation (requestId) {
      if (!active || (requestId && active.requestId !== requestId)) return null
      return active.cancelReason
    },
    finish (requestId, botGeneration) {
      const generationMatches = active?.botGeneration === (Number(botGeneration) || 0)
      if (active && active.requestId === requestId && generationMatches) {
        const finished = { ...active }
        active = null
        callHook('finish', finished, 'finished')
        notifyIdle()
        return true
      }
      return false
    },
    isBusy: () => !!active,
    current: () => active,
    setLifecycleHooks (hooks = {}) {
      lifecycleHooks = hooks && typeof hooks === 'object' ? hooks : {}
    },
    waitForIdle (owner = {}) {
      if (!active) return Promise.resolve()
      const requestMatches = !owner.requestId || active.requestId === owner.requestId
      const generationMatches = owner.botGeneration === undefined || active.botGeneration === (Number(owner.botGeneration) || 0)
      if (!requestMatches || !generationMatches) return Promise.resolve()
      return new Promise(resolve => idleWaiters.add(resolve))
    },
  }
}

// 取 bot 级共享 mutex；未挂载（单测/独立加载）时退回独立实例。
function longCommandMutexFor (bot) {
  if (bot && bot._longCommandMutex && typeof bot._longCommandMutex.tryStart === 'function') {
    return bot._longCommandMutex
  }
  return createLongCommandMutex()
}

module.exports = { createLongCommandMutex, longCommandMutexFor }

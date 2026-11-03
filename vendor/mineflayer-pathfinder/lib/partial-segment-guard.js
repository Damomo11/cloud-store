'use strict'

const DEFAULT_PREFIX_DISTANCE = 6
const DEFAULT_START_RADIUS = 3
const DEFAULT_CORRIDOR_RADIUS = 3
const DEFAULT_REVISIT_RADIUS = 3
const DEFAULT_MIN_HEURISTIC_IMPROVEMENT = 0.5
const DEFAULT_HISTORY_LIMIT = 32
const DEFAULT_TTL_MS = 120000

function finitePoint (value) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)) return null
  return { x: value.x, y: value.y, z: value.z }
}

function distance (a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function readHeuristic (goal, node) {
  try {
    const value = goal?.heuristic?.(node)
    return Number.isFinite(value) ? value : null
  } catch (_) {
    return null
  }
}

function createPartialSegmentGuard (options = {}) {
  const prefixDistance = options.prefixDistance ?? DEFAULT_PREFIX_DISTANCE
  const startRadius = options.startRadius ?? DEFAULT_START_RADIUS
  const corridorRadius = options.corridorRadius ?? DEFAULT_CORRIDOR_RADIUS
  const revisitRadius = options.revisitRadius ?? DEFAULT_REVISIT_RADIUS
  const minImprovement = options.minHeuristicImprovement ?? DEFAULT_MIN_HEURISTIC_IMPROVEMENT
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = typeof options.now === 'function' ? options.now : Date.now
  let records = []
  let nextId = 1
  let activeId = null
  let acceptedCount = 0
  let rejectedCount = 0
  let lastRejectionReason = null
  const rejectionReasons = {}

  function prune () {
    const cutoff = now() - ttlMs
    records = records.filter(record => record.acceptedAt >= cutoff)
    if (records.length > historyLimit) records = records.slice(-historyLimit)
    if (activeId !== null && !records.some(record => record.id === activeId)) activeId = null
  }
  function snapshot () {
    prune()
    return {
      acceptedCount,
      rejectedCount,
      failedCount: records.filter(record => record.failed).length,
      historySize: records.length,
      active: activeId !== null,
      lastRejectionReason,
      rejectionReasons: { ...rejectionReasons }
    }
  }

  function reject (reason, candidate) {
    rejectedCount += 1
    lastRejectionReason = reason
    rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1
    return {
      accepted: false,
      reason,
      startHeuristic: candidate.startHeuristic,
      endHeuristic: candidate.endHeuristic,
      ...snapshot()
    }
  }

  function consider ({ start, path, goal }) {
    prune()
    const startPoint = finitePoint(start)
    const nodes = Array.isArray(path) ? path.map(finitePoint).filter(Boolean) : []
    if (!startPoint || nodes.length === 0) {
      return { accepted: true, reason: 'insufficient_geometry', ...snapshot() }
    }

    const endpoint = nodes.at(-1)
    const corridor = nodes.find(node => distance(startPoint, node) >= prefixDistance) || endpoint
    const candidate = {
      start: startPoint,
      corridor,
      endpoint,
      startHeuristic: readHeuristic(goal, startPoint),
      endHeuristic: readHeuristic(goal, endpoint)
    }
    const improvesFromStart = candidate.startHeuristic === null || candidate.endHeuristic === null ||
      candidate.endHeuristic <= candidate.startHeuristic - minImprovement

    if (distance(startPoint, endpoint) <= revisitRadius && !improvesFromStart) {
      return reject('local_loop_without_progress', candidate)
    }

    for (const record of records) {
      if (record.failed &&
          distance(startPoint, record.start) <= startRadius &&
          distance(corridor, record.corridor) <= corridorRadius) {
        return reject('repeated_failed_corridor', candidate)
      }

      const revisitsStart = distance(endpoint, record.start) <= revisitRadius
      const revisitsEnd = distance(endpoint, record.endpoint) <= revisitRadius
      const referenceHeuristic = revisitsStart ? record.startHeuristic : (revisitsEnd ? record.endHeuristic : null)
      if ((revisitsStart || revisitsEnd) &&
          referenceHeuristic !== null && candidate.endHeuristic !== null &&
          candidate.endHeuristic > referenceHeuristic - minImprovement) {
        return reject('revisited_region_without_progress', candidate)
      }
    }

    const record = {
      id: nextId++,
      ...candidate,
      acceptedAt: now(),
      failed: false,
      completed: false
    }
    records.push(record)
    activeId = record.id
    acceptedCount += 1
    prune()
    return { accepted: true, reason: 'new_progress_corridor', ...snapshot() }
  }
  function noteReset (reason) {
    if (activeId === null) return
    const record = records.find(item => item.id === activeId)
    if (record && reason === 'stuck') record.failed = true
    activeId = null
  }

  function noteCompleted () {
    if (activeId === null) return
    const record = records.find(item => item.id === activeId)
    if (record) record.completed = true
    activeId = null
  }

  function reset () {
    records = []
    activeId = null
    acceptedCount = 0
    rejectedCount = 0
    lastRejectionReason = null
    for (const key of Object.keys(rejectionReasons)) delete rejectionReasons[key]
  }

  return { consider, noteReset, noteCompleted, reset, snapshot }
}

module.exports = { createPartialSegmentGuard }

const crypto = require('node:crypto')

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sha1 (value) {
  return crypto.createHash('sha1').update(value).digest('hex')
}

function stableStringify (value) {
  if (value === undefined) return 'null'
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function clampInt (value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function formatItemList (items) {
  if (!items.length) return '无'
  return items.map(item => `${item.displayName || item.itemId} x${item.amount}`).join('，')
}

function sumBy (items, getKey) {
  const result = new Map()
  for (const item of items) {
    const key = getKey(item)
    result.set(key, (result.get(key) || 0) + item.amount)
  }
  return result
}

module.exports = {
  clampInt,
  formatItemList,
  sha1,
  sleep,
  stableStringify,
  sumBy
}

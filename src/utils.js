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

// 聊天消息出口清洗：只保留白名单字符（中文/假名/全角数字与常用标点/ASCII 常用字符），
// 其余字符（git 输出里的特殊符号、控制字符等）一律替换为空格，避免服务器聊天过滤器
// 判定"非法字符"把 bot 踢下线。在 service.msg 发送出口统一调用，任何模块的报错文本都安全。
function sanitizeChatText (value) {
  return String(value ?? '')
    .replace(/[^\u4e00-\u9fa5\u3040-\u30ff\uff10-\uff19a-zA-Z0-9 .,:;!?\[\]()\-_\/%+*=<>@#'"“”‘’–—，。：；！？（）【】、～×…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

module.exports = {
  clampInt,
  formatItemList,
  sanitizeChatText,
  sha1,
  sleep,
  stableStringify,
  sumBy
}

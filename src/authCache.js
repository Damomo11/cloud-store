const fs = require('node:fs')
const path = require('node:path')

function invalidateMinecraftAccessTokenCache (profilesFolder) {
  const folder = path.resolve(String(profilesFolder || ''))
  if (!profilesFolder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return 0
  let cleared = 0
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('_mca-cache.json')) continue
    const file = path.join(folder, entry.name)
    fs.writeFileSync(file, '{}', { encoding: 'utf8', mode: 0o600 })
    try { fs.chmodSync(file, 0o600) } catch {}
    cleared += 1
  }
  return cleared
}

function isMinecraftProfileAuthError (error) {
  return /Failed to obtain profile data/i.test(String(error?.message || error || ''))
}

function isMicrosoftAuthRateLimitError (error) {
  const message = String(error?.message || error || '')
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0)
  return status === 429 || (/\b429\b|Too Many Requests/i.test(message) && /login_with_xbox|authentication|minecraftservices/i.test(message))
}

function microsoftAuthRetryDelayMs (attempt, reconnectDelayMs, random = Math.random) {
  const baseDelay = Math.max(30000, Number(reconnectDelayMs) || 0)
  const exponent = Math.min(4, Math.max(0, Number(attempt || 1) - 1))
  const exponentialDelay = Math.min(5 * 60 * 1000, baseDelay * (2 ** exponent))
  const jitter = 0.75 + (Math.max(0, Math.min(1, Number(random()) || 0)) * 0.5)
  return Math.min(5 * 60 * 1000, Math.round(exponentialDelay * jitter))
}

module.exports = {
  invalidateMinecraftAccessTokenCache,
  isMinecraftProfileAuthError,
  isMicrosoftAuthRateLimitError,
  microsoftAuthRetryDelayMs
}

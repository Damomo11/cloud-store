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

module.exports = { invalidateMinecraftAccessTokenCache, isMinecraftProfileAuthError }

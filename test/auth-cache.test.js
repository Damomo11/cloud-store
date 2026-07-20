const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { invalidateMinecraftAccessTokenCache, isMinecraftProfileAuthError } = require('../src/authCache')

test('profile auth recovery only clears Minecraft access-token caches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-auth-cache-'))
  try {
    const minecraftCache = path.join(root, 'account_mca-cache.json')
    const liveCache = path.join(root, 'account_live-cache.json')
    const xblCache = path.join(root, 'account_xbl-cache.json')
    fs.writeFileSync(minecraftCache, '{"mca":{"access_token":"expired"}}')
    fs.writeFileSync(liveCache, '{"refreshToken":"keep"}')
    fs.writeFileSync(xblCache, '{"xsts":"keep"}')

    assert.equal(invalidateMinecraftAccessTokenCache(root), 1)
    assert.equal(fs.readFileSync(minecraftCache, 'utf8'), '{}')
    assert.equal(fs.readFileSync(liveCache, 'utf8'), '{"refreshToken":"keep"}')
    assert.equal(fs.readFileSync(xblCache, 'utf8'), '{"xsts":"keep"}')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('profile auth errors are detected without matching unrelated disconnects', () => {
  assert.equal(isMinecraftProfileAuthError(new Error('Failed to obtain profile data for user@example.com, does the account own minecraft?')), true)
  assert.equal(isMinecraftProfileAuthError(new Error('read ECONNRESET')), false)
})

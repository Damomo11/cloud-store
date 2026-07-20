const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { signCloudStoreToken } = require('../src/botPlatformSso')

test('cloud store signs a short-lived Bot platform identity token', () => {
  const secret = 's'.repeat(64)
  const token = signCloudStoreToken({ uuid: 'player-uuid', username: 'Damomo1' }, secret, { now: 1000, lifetimeMs: 60000 })
  const [encoded, signature] = token.split('.')
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  assert.equal(signature, expected)
  assert.deepEqual({ iss: payload.iss, sub: payload.sub, username: payload.username, iat: payload.iat, exp: payload.exp }, {
    iss: 'cloud-store',
    sub: 'player-uuid',
    username: 'Damomo1',
    iat: 1000,
    exp: 61000
  })
  assert.ok(payload.nonce)
})

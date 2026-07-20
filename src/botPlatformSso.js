const crypto = require('node:crypto')

function encode (value) {
  return Buffer.from(value).toString('base64url')
}

function signCloudStoreToken (user, secret, options = {}) {
  const key = String(secret || '').trim()
  if (key.length < 32) throw new Error('Bot 自托管平台 SSO 密钥未配置或长度不足。')
  const now = Number(options.now ?? Date.now())
  const lifetimeMs = Number(options.lifetimeMs ?? 60 * 1000)
  const payload = {
    iss: 'cloud-store',
    sub: String(user.uuid || ''),
    username: String(user.username || ''),
    iat: now,
    exp: now + lifetimeMs,
    nonce: crypto.randomBytes(12).toString('base64url')
  }
  if (!payload.sub || !/^[A-Za-z0-9_]{1,16}$/.test(payload.username)) throw new Error('云仓库玩家身份无效。')
  const encoded = encode(JSON.stringify(payload))
  const signature = crypto.createHmac('sha256', key).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

module.exports = { signCloudStoreToken }

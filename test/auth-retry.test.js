const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isMicrosoftAuthRateLimitError,
  microsoftAuthRetryDelayMs
} = require('../src/authCache')

test('recognizes Minecraft login_with_xbox 429 errors as retryable rate limits', () => {
  assert.equal(isMicrosoftAuthRateLimitError(new Error('429 Too Many Requests { "path" : "/authentication/login_with_xbox" }')), true)
  assert.equal(isMicrosoftAuthRateLimitError({ status: 429, message: 'request failed' }), true)
  assert.equal(isMicrosoftAuthRateLimitError(new Error('401 Unauthorized { "path" : "/authentication/login_with_xbox" }')), false)
  assert.equal(isMicrosoftAuthRateLimitError(new Error('429 Too Many Requests from an unrelated endpoint')), false)
})

test('Microsoft auth rate-limit retries use capped exponential backoff with jitter', () => {
  assert.equal(microsoftAuthRetryDelayMs(1, 10000, () => 0), 22500)
  assert.equal(microsoftAuthRetryDelayMs(1, 10000, () => 0.5), 30000)
  assert.equal(microsoftAuthRetryDelayMs(2, 10000, () => 0.5), 60000)
  assert.equal(microsoftAuthRetryDelayMs(9, 10000, () => 1), 300000)
})

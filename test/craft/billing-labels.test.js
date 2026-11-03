'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const WebServer = require('../../src/webServer')

test('craft ledger events have readable cloud warehouse transaction labels', () => {
  const label = WebServer.prototype.transactionTypeLabel
  assert.equal(label.call({}, 'craft_consume'), '合成消耗')
  assert.equal(label.call({}, 'craft_produce'), '合成产出')
  assert.equal(label.call({}, 'craft'), '合成订单')
})

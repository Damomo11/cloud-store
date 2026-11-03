const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const CloudStoreWebServer = require('../src/webServer')

function createFixture ({ canAccess = true } = {}) {
  const calls = []
  const db = {
    db: {
      prepare: () => ({ run: () => {}, get: () => null, all: () => [] })
    },
    isAdmin: () => false,
    listCustomWarehousesForPlayer: () => [],
    canWebUserAccessOwner: () => canAccess,
    ownerLabel: owner => owner,
    getCustomWarehouse: () => null
  }
  const service = {
    taskPool: { snapshot: () => ({ active: [], queued: [] }) },
    previewWithdrawShortage: (...args) => {
      calls.push(args)
      return {
        requests: args[2],
        allocations: [{ itemId: 'minecraft:stone', amount: 2 }],
        shortages: [{ itemId: 'minecraft:stone', missing: 3 }],
        shortage: [{ itemId: 'minecraft:stone', missing: 3 }],
        craft: [{ itemId: 'minecraft:stone', amount: 3, status: 'unavailable', reason: 'needs_collection' }]
      }
    }
  }
  const server = new CloudStoreWebServer(db, { web: { enabled: true, host: '127.0.0.1', port: 0 } }, () => service)
  server.sessions.set('test-session', {
    sid: 'test-session', createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + 60000,
    user: { uuid: 'player-1', username: 'Alice' }
  })
  return { server, calls }
}

async function request (server, body) {
  server.start()
  await new Promise(resolve => server.server.once('listening', resolve))
  const address = server.server.address()
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: address.port, path: '/api/action/withdraw/plan', method: 'POST',
      headers: { cookie: 'cs_sid=test-session', 'content-type': 'application/json' }
    }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

test('withdraw planning endpoint returns a read-only shortage plan and active snapshot', async () => {
  const { server, calls } = createFixture()
  try {
    const response = await request(server, {
      ownerUuid: 'player-1',
      items: [{ itemKey: 'stone-key', amount: 5 }],
      targetUsername: 'Alice'
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.shortage[0].missing, 3)
    assert.equal(response.body.craft[0].status, 'unavailable')
    assert.equal(response.body.active, null)
    assert.equal(calls.length, 1)
    assert.equal(calls[0][1], 'player-1')
  } finally {
    await new Promise(resolve => server.server?.close(resolve))
  }
})

test('withdraw planning endpoint enforces warehouse access', async () => {
  const { server, calls } = createFixture({ canAccess: false })
  try {
    const response = await request(server, { ownerUuid: 'other-owner', items: [{ itemKey: 'stone-key', amount: 1 }] })
    assert.equal(response.status, 403)
    assert.equal(response.body.ok, false)
    assert.equal(calls.length, 0)
  } finally {
    await new Promise(resolve => server.server?.close(resolve))
  }
})

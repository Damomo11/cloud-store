const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const StoreDb = require('../src/db')
const CloudStoreWebServer = require('../src/webServer')
const { DEFAULT_CONFIG } = require('../src/config')

async function startFixture () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-malformed-url-'))
  const config = structuredClone(DEFAULT_CONFIG)
  config.web.host = '127.0.0.1'
  config.web.port = 0
  const db = new StoreDb(path.join(directory, 'store.sqlite'), config)
  const server = new CloudStoreWebServer(db, config, () => null)
  const rejected = []
  server.logRejectedRequest = (req, error) => rejected.push({ method: req.method, url: req.url, message: error.message })
  await new Promise((resolve, reject) => {
    server.start()
    if (!server.server) return reject(new Error('web server did not start'))
    const address = server.server.address()
    if (address) return resolve()
    server.server.once('listening', resolve)
    server.server.once('error', reject)
  })
  return {
    server,
    rejected,
    close: () => {
      server.server.closeAllConnections()
      server.server.close()
      db.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

test('malformed request target // is rejected with 400 instead of crashing the process', async () => {
  const fixture = await startFixture()
  try {
    const base = `http://127.0.0.1:${fixture.server.server.address().port}`

    const malformed = await fetch(`${base}//`)
    assert.equal(malformed.status, 400)
    assert.equal(await malformed.text(), 'Bad request')

    const malformedWithQuery = await fetch(`${base}//?q=1`)
    assert.equal(malformedWithQuery.status, 400)

    assert.equal(fixture.rejected.length, 2)
    assert.equal(fixture.rejected[0].url, '//')

    const normal = await fetch(`${base}/api/me`)
    assert.equal(normal.status, 200)
    const body = await normal.json()
    assert.equal(body.ok, true)
    assert.equal(body.loggedIn, false)
  } finally {
    fixture.close()
  }
})

test('protocol-relative target with a host parses and falls through to 404', async () => {
  const fixture = await startFixture()
  try {
    const base = `http://127.0.0.1:${fixture.server.server.address().port}`
    const response = await fetch(`${base}//example.com/definitely-not-a-route`)
    assert.equal(response.status, 404)
    assert.equal(fixture.rejected.length, 0)
  } finally {
    fixture.close()
  }
})

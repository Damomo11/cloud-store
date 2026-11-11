const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const CloudStoreWebServer = require('../src/webServer')

async function fixture () {
  const server = new CloudStoreWebServer({ db: { prepare: () => ({ run: () => ({ changes: 0 }) }) } }, { web: {} }, () => null)
  let html
  await server.handle({ method: 'GET', url: '/', headers: {}, socket: {} }, {
    setHeader () {}, writeHead () {}, end: data => { html = Buffer.from(data).toString() }
  })
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  const state = {}
  const elements = new Map()
  const requests = []
  let respond
  const context = vm.createContext({
    state, esc: String,
    $: id => {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', childElementCount: 0 })
      return elements.get(id)
    },
    api: async (path, params) => { requests.push({ path, params }); return respond() }
  })
  vm.runInContext(script.slice(script.indexOf('    function adminLogTimeLabel'), script.indexOf('    function startAdminLogPolling')), context)
  return {
    state, elements, requests,
    respond: value => { respond = value },
    load: reset => vm.runInContext('loadAdminConsoleLogs(' + Boolean(reset) + ')', context)
  }
}

function batch (seq, text) {
  return { rows: [{ seq, text, level: 'log', tsLabel: '2026-11-11 15:00:00' }], nextSeq: seq + 1, total: seq, limit: 5000 }
}

test('incremental console polling includes the immediately next log sequence', async () => {
  const f = await fixture()
  f.respond(() => batch(1, 'first'))
  await f.load(true)
  f.respond(() => batch(2, 'second'))
  await f.load(false)
  assert.equal(f.requests[1].params.afterSeq, 1)
  assert.match(f.elements.get('adminLogConsole').innerHTML, /first.*second/)
})

test('overlapping console refreshes share a request and render its rows once', async () => {
  const f = await fixture()
  let release
  f.respond(() => new Promise(resolve => { release = resolve }))
  const pending = f.load(false)
  const refresh = f.load(true)
  assert.equal(f.requests.length, 1)
  release(batch(1, 'only once'))
  await Promise.all([pending, refresh])
  assert.equal((f.elements.get('adminLogConsole').innerHTML.match(/only once/g) || []).length, 1)
})

test('a failed console poll releases the request so the same unread row can be retried', async () => {
  const f = await fixture()
  f.respond(() => batch(3, 'baseline'))
  await f.load(false)
  f.respond(() => { throw new Error('offline') })
  await assert.rejects(f.load(false), /offline/)
  f.respond(() => batch(4, 'retry'))
  await f.load(false)
  assert.equal(f.requests[2].params.afterSeq, 3)
  assert.match(f.elements.get('adminLogConsole').innerHTML, /baseline.*retry/)
})

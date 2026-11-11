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
  const elements = new Map()
  const element = id => {
    if (elements.has(id)) return elements.get(id)
    let content = ''
    const classes = new Set(id === 'adminLogCaptureCopy' ? ['hidden'] : [])
    const el = {
      textContent: '', disabled: false, handlers: {}, scrollHeight: 0,
      classList: {
        add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
      },
      addEventListener: (event, handler) => { el.handlers[event] = handler },
      get innerHTML () { return content }, set innerHTML (value) { content = value },
      get childElementCount () { return (content.match(/class="log-line /g) || []).length },
      removeChild () { content = content.replace(/^<span class="log-line [\s\S]*?<\/span><\/span>/, '') },
      querySelectorAll: () => [{ classList: { remove: name => { content = content.replaceAll(' ' + name, '') } } }]
    }
    elements.set(id, el)
    return el
  }
  const state = {}
  const requests = []
  const clipboard = []
  let response
  const context = vm.createContext({
    state, $: element,
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    api: async (path, params) => { requests.push({ path, params }); return typeof response === 'function' ? response() : response },
    copyText: async text => clipboard.push(text), toast: text => { element('toast').textContent = text },
    setInterval, clearInterval
  })
  vm.runInContext(script.slice(script.indexOf('    // ===== 管理面板：终端实时日志'), script.indexOf('    async function loadAdminBots()')), context)
  vm.runInContext(script.slice(script.indexOf("    $('adminLogPause').addEventListener"), script.indexOf("    $('adminLogFileClose').addEventListener")), context)
  return {
    html, state, requests, clipboard, element,
    load: async (rows, reset = false, startedAt = 100) => {
      response = { rows, nextSeq: (rows.at(-1)?.seq || state.adminLogAfterSeq || 0) + 1, startedAt, total: rows.length, limit: 5000 }
      return vm.runInContext('loadAdminConsoleLogs(' + reset + ')', context)
    },
    click: id => element(id).handlers.click(),
    setResponse: value => { response = value }, context
  }
}

const row = (seq, text) => ({ seq, text, level: 'log', tsLabel: '2026-11-11 14:00:00' })

test('capture highlights only new rows, stops locally and copies the whole captured segment', async () => {
  const f = await fixture()
  await f.load([row(1, 'old')], true)
  f.click('adminLogCapture')
  assert.equal(f.element('adminLogCapture').textContent, '停止截取')
  await f.load([row(2, '<new>'), row(3, '多行\n下一行')])
  assert.match(f.element('adminLogConsole').innerHTML, /log-captured/)
  assert.match(f.element('adminLogConsole').innerHTML, /&lt;new&gt;/)
  const beforeStop = f.requests.length
  f.click('adminLogCapture')
  assert.equal(f.requests.length, beforeStop, 'stopping must not send a capture request')
  assert.doesNotMatch(f.element('adminLogConsole').innerHTML, /log-captured/)
  assert.equal(f.element('adminLogCaptureCopy').classList.contains('hidden'), false)
  await f.load([row(4, 'after stop')])
  await f.click('adminLogCaptureCopy')
  assert.equal(f.clipboard[0], '14:00:00 <new>\n14:00:00 多行\n下一行')
  f.click('adminLogCapture')
  await f.load([row(5, 'next capture')])
  f.click('adminLogCapture')
  await f.click('adminLogCaptureCopy')
  assert.equal(f.clipboard[1], '14:00:00 next capture')
})

test('clearing, replaying and trimming visible logs retain captured rows without duplicates', async () => {
  const f = await fixture()
  await f.load([row(1, 'old')], true)
  f.click('adminLogCapture')
  await f.load([row(2, 'first')])
  f.click('adminLogClear')
  await f.load([row(1, 'old'), row(2, 'first'), row(3, 'second')], true)
  await f.load(Array.from({ length: 5001 }, (_, index) => row(index + 4, 'line ' + index)))
  assert.equal(f.element('adminLogConsole').childElementCount, 5000)
  f.click('adminLogCapture')
  await f.click('adminLogCaptureCopy')
  const lines = f.clipboard[0].split('\n')
  assert.equal(lines.length, 5003)
  assert.equal(lines[0], '14:00:00 first')
  assert.equal(lines[1], '14:00:00 second')
  assert.equal(lines.at(-1), '14:00:00 line 5000')
})

test('leaving the log view stops capture and later responses cannot change the copied segment', async () => {
  const f = await fixture()
  await f.load([row(1, 'old')], true)
  f.click('adminLogCapture')
  await f.load([row(2, 'captured')])
  vm.runInContext('stopAdminLogPolling()', f.context)
  await f.load([row(3, 'after leaving')])
  await f.click('adminLogCaptureCopy')
  assert.equal(f.clipboard[0], '14:00:00 captured')
  assert.equal(f.element('adminLogPause').disabled, false)
})

test('an empty capture cannot copy previous data and a restarted server can reuse sequence numbers', async () => {
  const f = await fixture()
  await f.load([row(1, 'old')], true)
  f.click('adminLogCapture')
  f.click('adminLogCapture')
  assert.equal(f.element('adminLogCaptureCopy').disabled, true)
  await f.click('adminLogCaptureCopy')
  assert.equal(f.clipboard.length, 0)
  f.click('adminLogCapture')
  await f.load([row(2, 'before restart')])
  await f.load([row(1, 'after restart')], true, 200)
  f.click('adminLogCapture')
  await f.click('adminLogCaptureCopy')
  assert.equal(f.clipboard[0], '14:00:00 before restart\n14:00:00 after restart')
})


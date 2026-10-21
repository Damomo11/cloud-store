const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  installConsoleLogBuffer,
  uninstallConsoleLogBuffer,
  snapshotConsoleLogs,
  pushPanelLog,
  isConsoleLogBufferInstalled,
  DEFAULT_LIMIT
} = require('../src/consoleLogBuffer')
const StoreDb = require('../src/db')
const CloudStoreWebServer = require('../src/webServer')
const { DEFAULT_CONFIG } = require('../src/config')

function withInstalledBuffer (options = {}) {
  uninstallConsoleLogBuffer()
  return installConsoleLogBuffer(options)
}

test('console methods are wrapped, still write through, and are restored on uninstall', (t) => {
  const originalLog = console.log
  const originalWarn = console.warn
  try {
    withInstalledBuffer({ limit: 100 })
    assert.equal(isConsoleLogBufferInstalled(), true)
    assert.notEqual(console.log, originalLog)
    assert.notEqual(console.warn, originalWarn)

    console.log('hello', 'panel')
    console.warn('careful', { code: 7 })
    const snapshot = snapshotConsoleLogs({})
    assert.equal(snapshot.rows.length >= 2, true)
    const texts = snapshot.rows.map(row => row.text)
    assert.ok(texts.includes('hello panel'))
    assert.ok(texts.some(text => text.includes('careful') && text.includes('"code":7')))
    const levels = snapshot.rows.map(row => row.level)
    assert.ok(levels.includes('log'))
    assert.ok(levels.includes('warn'))
  } finally {
    uninstallConsoleLogBuffer()
    assert.equal(console.log, originalLog)
    assert.equal(console.warn, originalWarn)
    assert.equal(isConsoleLogBufferInstalled(), false)
  }
})

test('ring buffer keeps only the last N entries (default 5000 rolling)', () => {
  try {
    withInstalledBuffer({ limit: 64 })
    for (let index = 0; index < 96; index++) console.log(`line-${index}`)
    const snapshot = snapshotConsoleLogs({})
    assert.equal(snapshot.rows.length, 64)
    assert.equal(snapshot.rows[0].text, 'line-32')
    assert.equal(snapshot.rows[snapshot.rows.length - 1].text, 'line-95')
  } finally {
    uninstallConsoleLogBuffer()
  }
})

test('default install limit is 5000 entries', () => {
  try {
    withInstalledBuffer({})
    assert.equal(DEFAULT_LIMIT, 5000)
    const snapshot = snapshotConsoleLogs({})
    assert.equal(snapshot.limit, 5000)
    for (let index = 0; index < 5005; index++) console.log(`x-${index}`)
    const after = snapshotConsoleLogs({})
    assert.equal(after.rows.length, 5000)
    assert.equal(after.rows[0].text, 'x-5')
    assert.equal(after.rows[after.rows.length - 1].text, 'x-5004')
  } finally {
    uninstallConsoleLogBuffer()
  }
})

test('afterSeq incremental polling returns only newer rows', () => {
  try {
    withInstalledBuffer({ limit: 200 })
    console.log('first')
    console.log('second')
    const first = snapshotConsoleLogs({})
    const lastSeq = first.rows[first.rows.length - 1].seq
    console.log('third')
    const delta = snapshotConsoleLogs({ afterSeq: lastSeq })
    assert.equal(delta.rows.length, 1)
    assert.equal(delta.rows[0].text, 'third')
    const empty = snapshotConsoleLogs({ afterSeq: delta.nextSeq - 1 })
    assert.equal(empty.rows.length, 0)
    // full snapshot with afterSeq=0 still returns everything buffered
    const full = snapshotConsoleLogs({ afterSeq: 0 })
    assert.ok(full.rows.length >= 3)
  } finally {
    uninstallConsoleLogBuffer()
  }
})

test('errors and objects are formatted into single-line text', () => {
  try {
    withInstalledBuffer({ limit: 50 })
    console.error(new Error('boom'))
    console.log({ nested: { list: [1, 2] } })
    const snapshot = snapshotConsoleLogs({ limit: 10 })
    assert.ok(snapshot.rows.some(row => row.level === 'error' && /Error: boom/.test(row.text)))
    assert.ok(snapshot.rows.some(row => row.text.includes('"nested"') && row.text.includes('[1,2]')))
    // single line per entry
    for (const row of snapshot.rows) assert.ok(!row.text.includes('\n'))
  } finally {
    uninstallConsoleLogBuffer()
  }
})

test('pushPanelLog appends entries without touching the terminal', () => {
  try {
    withInstalledBuffer({ limit: 20 })
    const entry = pushPanelLog('info', '面板说明信息')
    assert.equal(entry.text, '面板说明信息')
    assert.ok(entry.seq > 0)
    const snapshot = snapshotConsoleLogs({})
    assert.ok(snapshot.rows.some(row => row.text === '面板说明信息' && row.level === 'info'))
  } finally {
    uninstallConsoleLogBuffer()
  }
})

test('double install is idempotent and limit update applies', () => {
  try {
    withInstalledBuffer({ limit: 100 })
    installConsoleLogBuffer({ limit: 50 })
    assert.equal(isConsoleLogBufferInstalled(), true)
    assert.equal(snapshotConsoleLogs({}).limit, 50)
  } finally {
    uninstallConsoleLogBuffer()
  }
})

function createWebFixture () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-admin-logs-'))
  const config = structuredClone(DEFAULT_CONFIG)
  config.traceLog = { ...config.traceLog, directory: path.join(directory, 'logs') }
  const db = new StoreDb(path.join(directory, 'store.sqlite'), config)
  const server = new CloudStoreWebServer(db, config, () => null)
  server.requireAdmin = () => ({ username: 'admin', uuid: 'admin-uuid', isAdmin: true })
  return {
    directory,
    db,
    server,
    close: () => {
      db.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

test('admin log file APIs list and read logs directory files (tail, path guarded)', () => {
  const fixture = createWebFixture()
  try {
    const logsDir = path.join(fixture.directory, 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    fs.writeFileSync(path.join(logsDir, 'withdraw-trace-2026-10-01.jsonl'), 'a\n'.repeat(10) + 'last-line\n', 'utf8')
    fs.writeFileSync(path.join(logsDir, 'errors.jsonl'), '{"entry":true}\n', 'utf8')
    fs.mkdirSync(path.join(logsDir, 'subdir'), { recursive: true })

    const files = fixture.server.apiAdminLogFiles({ isAdmin: true })
    assert.equal(files.ok, true)
    const names = files.rows.map(row => row.name)
    assert.ok(names.includes('withdraw-trace-2026-10-01.jsonl'))
    assert.ok(names.includes('errors.jsonl'))
    assert.equal(names.includes('subdir'), false) // 目录不进清单
    const traceRow = files.rows.find(row => row.name === 'withdraw-trace-2026-10-01.jsonl')
    assert.ok(traceRow.sizeBytes > 0)
    assert.ok(traceRow.sizeLabel)
    assert.ok(traceRow.modifiedAtLabel)

    // 默认读末尾 256KB；这里文件很小应完整返回且未截断
    const content = fixture.server.apiAdminLogFile(
      { isAdmin: true },
      new URL('http://localhost/api/admin/log-file?name=withdraw-trace-2026-10-01.jsonl')
    )
    assert.equal(content.ok, true)
    assert.equal(content.truncated, false)
    assert.equal(content.text.endsWith('last-line\n'), true)

    // 路径穿越与非法名字被拒绝
    assert.throws(() => fixture.server.apiAdminLogFile(
      { isAdmin: true },
      new URL('http://localhost/api/admin/log-file?name=' + encodeURIComponent('../store.sqlite'))
    ), /无效的日志文件名|只允许读取 logs 目录/)
    assert.throws(() => fixture.server.apiAdminLogFile(
      { isAdmin: true },
      new URL('http://localhost/api/admin/log-file?name=' + encodeURIComponent('..\\config.json'))
    ), /无效的日志文件名|只允许读取 logs 目录/)

    // 空文件
    fs.writeFileSync(path.join(logsDir, 'empty.txt'), '', 'utf8')
    const empty = fixture.server.apiAdminLogFile(
      { isAdmin: true },
      new URL('http://localhost/api/admin/log-file?name=empty.txt')
    )
    assert.equal(empty.text, '')
  } finally {
    fixture.close()
  }
})

test('admin log file API truncates large files to the tail and drops partial first line', () => {
  const fixture = createWebFixture()
  try {
    const logsDir = path.join(fixture.directory, 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    const line = 'x'.repeat(200) + '\n'
    fs.writeFileSync(path.join(logsDir, 'big.log'), line.repeat(50), 'utf8') // 10 KB

    const data = fixture.server.apiAdminLogFile(
      { isAdmin: true },
      new URL('http://localhost/api/admin/log-file?name=big.log&maxBytes=2000')
    )
    assert.equal(data.ok, true)
    assert.equal(data.truncated, true)
    assert.equal(data.startByte, 50 * 201 - 2000)
    // 截断后第一行必须是完整行（200 个 x），不是残行
    const firstLine = data.text.split('\n')[0]
    assert.equal(firstLine.length, 200)
    assert.ok(data.text.endsWith('\n'))

    // maxBytes 上限 4MB
    const oversized = fixture.server.apiAdminLogFile(
      { isAdmin: true },
      new URL('http://localhost/api/admin/log-file?name=big.log&maxBytes=999999999')
    )
    assert.equal(oversized.startByte, 0) // 文件本身小于上限，全量读取
    assert.equal(oversized.truncated, false)
  } finally {
    fixture.close()
  }
})

test('admin console log API requires admin session and formats tsLabel', () => {
  const fixture = createWebFixture()
  try {
    withInstalledBuffer({ limit: 100 })
    console.log('面板测试行')
    const data = fixture.server.apiAdminConsoleLogs(
      { username: 'admin', uuid: 'admin-uuid' },
      new URL('http://localhost/api/admin/console-logs?afterSeq=0')
    )
    assert.equal(data.ok, true)
    assert.ok(data.rows.length >= 1)
    const row = data.rows.find(entry => entry.text === '面板测试行')
    assert.ok(row, 'expected the console line to appear in snapshot')
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.tsLabel))
    assert.equal(data.limit, 100)
    const lastSeq = data.rows[data.rows.length - 1].seq

    // 非管理员被 requireAdmin 拦下
    const savedRequireAdmin = fixture.server.requireAdmin
    fixture.server.requireAdmin = () => { throw Object.assign(new Error('只有管理员可以打开管理界面。'), { status: 403 }) }
    assert.throws(() => fixture.server.apiAdminConsoleLogs(
      { username: 'player', uuid: 'player-uuid' },
      new URL('http://localhost/api/admin/console-logs')
    ), /管理员/)
    fixture.server.requireAdmin = savedRequireAdmin

    // 增量：afterSeq 之后只剩新行（用快照里最后一行的 seq，而非 nextSeq）
    console.log('增量行')
    const delta = fixture.server.apiAdminConsoleLogs(
      { username: 'admin', uuid: 'admin-uuid' },
      new URL('http://localhost/api/admin/console-logs?afterSeq=' + lastSeq)
    )
    assert.equal(delta.rows.length, 1)
    assert.equal(delta.rows[0].text, '增量行')
  } finally {
    uninstallConsoleLogBuffer()
    fixture.close()
  }
})

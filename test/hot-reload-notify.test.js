const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fork, spawnSync } = require('node:child_process')
const hotReload = require('../src/hotReload')

function fixture (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-reload-notify-'))
  t.after(() => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        for (const name of fs.readdirSync(file)) fs.unlinkSync(path.join(file, name))
        fs.rmdirSync(file)
      } else fs.unlinkSync(file)
    }
    fs.rmdirSync(directory)
  })
  const pendingNotifyPath = path.join(directory, hotReload.PENDING_NOTIFY_FILE)
  const clock = { time: 1000 }
  const reload = overrides => hotReload.runHotReload({
    notify: () => {}, notifyTarget: 'Admin', now: () => clock.time,
    pullLockPath: path.join(directory, '.pull.lock'), pendingNotifyPath,
    gitPull: async () => ({ updated: true }), waitForIdle: async () => true,
    shutdown: () => {}, exitProcess: () => {}, ...overrides
  })
  const sent = []
  const deliver = () => hotReload.deliverHotReloadNotify({ msg: (...args) => sent.push(args) }, {
    pendingNotifyPath, now: () => clock.time, log: () => {}
  })
  return { clock, pendingNotifyPath, reload, sent, deliver }
}

function leaveNotifyLock (pendingNotifyPath, { dead = false } = {}) {
  let pid = process.pid
  if (dead) {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])
    assert.equal(child.status, 0)
    pid = Number(String(child.stdout))
  }
  const lockPath = `${pendingNotifyPath}.lock`
  fs.mkdirSync(lockPath)
  fs.writeFileSync(path.join(lockPath, `${pid}-test-owner`), '')
  return lockPath
}

test('a late restarting process preserves the completion receipt from its reload round', async t => {
  const f = fixture(t)
  const receipt = { target: 'Admin', version: 'already-sent', at: 2000, deliveredAt: 3000 }
  await f.reload({ waitForIdle: async () => {
    // Another process restarted and sent the completion while this one waited.
    f.clock.time = 4000
    fs.writeFileSync(f.pendingNotifyPath, JSON.stringify(receipt))
    return true
  } })
  assert.deepEqual(JSON.parse(fs.readFileSync(f.pendingNotifyPath)), receipt)
})

test('a failed shutdown does not remove another process completion reminder', async t => {
  const f = fixture(t)
  const pending = { target: 'Admin', version: 'other-process', at: 900 }
  fs.writeFileSync(f.pendingNotifyPath, JSON.stringify(pending))
  const result = await f.reload({ shutdown: () => { throw new Error('shutdown failed') } })
  assert.equal(result.status, 'shutdown_failed')
  assert.ok(fs.existsSync(f.pendingNotifyPath), 'the other process reminder must survive')
  assert.deepEqual(JSON.parse(fs.readFileSync(f.pendingNotifyPath)), pending)
})

test('staggered restarts notify once and a later reload of the same version can notify again', async t => {
  const f = fixture(t)
  let releaseIdle
  const idleGate = new Promise(resolve => { releaseIdle = resolve })
  const lateReload = f.reload({ waitForIdle: () => idleGate })
  await f.reload()
  f.clock.time = 2000
  assert.equal(await f.deliver(), true)
  assert.equal(await f.deliver(), false, 'another bot must not send the receipt again')
  f.clock.time = 3000
  releaseIdle(true)
  await lateReload
  assert.equal(await f.deliver(), false, 'the late restart must not recreate the reminder')
  assert.equal(f.sent.length, 1)
  assert.match(f.sent[0][1], /热重载完成/)

  await f.reload()
  assert.equal(await f.deliver(), true, 'a new request after delivery is a new reload round')
  assert.equal(f.sent.length, 2)
})

test('shutdown must succeed before the reminder and internal successor are created', async t => {
  const f = fixture(t)
  let scheduled = false
  const scheduleSuccessorProcess = () => {
    scheduled = true
    assert.ok(fs.existsSync(f.pendingNotifyPath), 'the reminder must precede the successor')
    return { cancel: () => {} }
  }
  const failed = await f.reload({
    spawnSuccessor: true, scheduleSuccessorProcess,
    shutdown: () => { throw new Error('shutdown failed') }
  })
  assert.equal(failed.status, 'shutdown_failed')
  assert.equal(scheduled, false)
  assert.equal(fs.existsSync(f.pendingNotifyPath), false)
  await f.reload({ spawnSuccessor: true, scheduleSuccessorProcess })
  assert.equal(scheduled, true)
})

test('malformed, stale or future-dated reminders are not delivered', async t => {
  const f = fixture(t)
  f.clock.time = 1000000
  for (const record of ['{', 'null', JSON.stringify({ target: 12, at: 1000000 }),
    JSON.stringify({ target: 'Admin', at: 'invalid' }),
    JSON.stringify({ target: 'Admin', at: 1 }),
    JSON.stringify({ target: 'Admin', at: 1000001 })]) {
    fs.writeFileSync(f.pendingNotifyPath, record)
    assert.equal(await f.deliver(), false)
  }
  assert.equal(f.sent.length, 0)
})

for (const abandonedLock of [false, true]) {
test(`two real processes claim once${abandonedLock ? ' after recovering a dead owner lock' : ''}`, { timeout: 10000 }, async t => {
  const f = fixture(t)
  if (abandonedLock) leaveNotifyLock(f.pendingNotifyPath, { dead: true })
  fs.writeFileSync(f.pendingNotifyPath, JSON.stringify({ target: 'Admin', at: Date.now() }))
  const children = [0, 1].map(() => fork(path.join(__dirname, 'fixtures', 'hot-reload-notify-child.cjs'),
    [f.pendingNotifyPath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }))
  t.after(() => children.forEach(child => child.kill()))
  const messages = []
  await Promise.all(children.map(child => new Promise((resolve, reject) => {
    let errorOutput = ''
    child.stderr.on('data', data => { errorOutput += data })
    child.on('error', reject)
    child.on('message', message => {
      if (message === 'ready') resolve()
      else messages.push(message)
    })
    child.on('exit', code => { if (code) reject(new Error(errorOutput || `child exited ${code}`)) })
  })))
  const exits = children.map(child => new Promise((resolve, reject) => {
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)))
  }))
  children.forEach(child => child.send('deliver'))
  await Promise.all(exits)
  assert.deepEqual(messages, [{ target: 'Admin' }])
  assert.ok(JSON.parse(fs.readFileSync(f.pendingNotifyPath)).deliveredAt)
})
}

test('a busy notification lock cannot prevent restart or remove its owner lock', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const lockPath = leaveNotifyLock(f.pendingNotifyPath)
  // A paused but live owner must retain its lock even after the old stale threshold.
  const stale = new Date(Date.now() - 60000)
  fs.utimesSync(lockPath, stale, stale)
  let exited = false
  const result = await f.reload({ exitProcess: () => { exited = true } })
  assert.equal(result.status, 'restarting')
  assert.equal(exited, true)
  assert.equal(fs.existsSync(f.pendingNotifyPath), false)
  assert.deepEqual(fs.readdirSync(lockPath), [`${process.pid}-test-owner`])
})

test('a dead notification owner lock can be recovered', async t => {
  const f = fixture(t)
  const lockPath = leaveNotifyLock(f.pendingNotifyPath, { dead: true })
  await f.reload()
  assert.equal(await f.deliver(), true)
  assert.equal(fs.existsSync(lockPath), false)
})

const test = require('node:test')
const assert = require('node:assert/strict')
const { BotTaskPool } = require('../src/taskPool')

function createWorker (username) {
  return {
    bot: { username },
    active: null,
    ready: true,
    recoveringFromDeath: false,
    async runExclusive (taskUsername, type, fn, extra) {
      this.active = { username: taskUsername, type, ...extra }
      try {
        return await fn()
      } finally {
        this.active = null
      }
    },
    handleCommandError (taskUsername, error) {
      throw error
    }
  }
}

test('two idle bots claim two queued tasks concurrently', async () => {
  const pool = new BotTaskPool()
  const first = createWorker('bot-1')
  const second = createWorker('bot-2')
  pool.register(first)
  pool.register(second)

  const startedBy = []
  const releases = []
  const task = username => pool.enqueue({
    username,
    type: 'withdraw',
    run: worker => new Promise(resolve => {
      startedBy.push(worker.bot.username)
      releases.push(resolve)
    })
  })

  const firstTask = task('player-1')
  const secondTask = task('player-2')
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(new Set(startedBy), new Set(['bot-1', 'bot-2']))
  for (const release of releases) release()
  await Promise.all([firstTask, secondTask])
})

test('task fuse cancels queued work, blocks dispatch while active work drains, then resumes', async () => {
  const pool = new BotTaskPool()
  const worker = createWorker('bot-1')
  let cancelled = 0
  worker.cancelActiveTask = () => { cancelled++; worker.active.cancelled = true; return true }
  pool.register(worker)
  let finishActive
  let started = 0
  const active = pool.enqueue({ type: 'withdraw', run: () => new Promise(resolve => { started++; finishActive = resolve }) })
  await new Promise(resolve => setImmediate(resolve))
  const queued = pool.enqueue({ type: 'deposit', run: () => { started++; return true } })
  const fuse = pool.beginFuse('admin test')

  assert.equal(fuse.cancelledQueued, 1)
  assert.equal(fuse.stopRequested, 1)
  assert.equal(cancelled, 1)
  assert.equal(pool.fused, true)
  assert.equal(await queued, null)
  assert.equal(started, 1)

  finishActive('cancelled')
  await active
  await fuse.drained
  assert.equal(pool.fused, false)

  const resumed = pool.enqueue({ type: 'deposit', run: () => { started++; return 'resumed' } })
  assert.equal(await resumed, 'resumed')
  assert.equal(started, 2)
})

test('task fuse rejects tasks enqueued while there is no active worker', async () => {
  const pool = new BotTaskPool()
  const worker = createWorker('bot-1')
  pool.packingRecoveryLeases.add(worker)
  const fuse = pool.beginFuse('admin test')
  assert.equal(pool.fused, true)
  assert.equal(await pool.enqueue({ type: 'withdraw', run: () => 'must not run' }), null)
  pool.packingRecoveryLeases.delete(worker)
  pool.resolveFuseDrain()
  assert.equal(await fuse.drained, undefined)
  assert.equal(pool.fused, false)
})

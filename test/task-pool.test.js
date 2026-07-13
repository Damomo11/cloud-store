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

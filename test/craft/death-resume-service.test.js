'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Service = require('../../src/service')

function context () {
  const events = []
  const messages = []
  return {
    events,
    messages,
    debugCraft: (event, data) => events.push({ event, data }),
    msg: (username, message) => messages.push({ username, message })
  }
}

test('craft recovery resumes the same operation only when recovery proves it resumable', async () => {
  const service = context()
  const calls = []
  const controller = {
    ledger: { get: () => ({ actor: 'Alice', target: { name: 'piston', quantity: 12 } }) },
    recover: async () => ({ status: 'resumable', operationId: 'craft:resume-me', stepIndex: 2, nextTrigger: 4 }),
    resume: async operationId => {
      calls.push(operationId)
      return { status: 'complete', operationId }
    }
  }

  const result = await Service.prototype.recoverAndResumeCraft.call(service, controller)

  assert.deepEqual(calls, ['craft:resume-me'])
  assert.equal(result.status, 'complete')
  assert.ok(service.events.some(event => event.event === 'service.resume_start' && event.data.operationId === 'craft:resume-me'))
  assert.deepEqual(service.messages, [{ username: 'Alice', message: '机器人已恢复并继续完成原合成订单：piston ×12。' }])
})

test('craft recovery does not resume an unknown or manually recoverable operation', async () => {
  const service = context()
  let resumed = false
  const result = { status: 'recovery_required', operationId: 'craft:inspect' }
  const controller = {
    recover: async () => result,
    resume: async () => { resumed = true }
  }

  assert.equal(await Service.prototype.recoverAndResumeCraft.call(service, controller), result)
  assert.equal(resumed, false)
})

test('craft recovery preserves pending state when automatic resume fails', async () => {
  const service = context()
  const failure = new Error('resume failed')
  const controller = {
    recover: async () => ({ status: 'resumable', operationId: 'craft:resume-failed' }),
    resume: async () => { throw failure }
  }

  await assert.rejects(Service.prototype.recoverAndResumeCraft.call(service, controller), error => error === failure)
})

test('death respawn reconciles then resumes the original craft after the old task drains', async () => {
  const service = Object.assign(Object.create(Service.prototype), {
    recoveringFromDeath: false,
    deathContext: { type: 'craft' },
    botId: 'bot-a',
    bot: { health: 20, _craftingExecutor: { isBusy: () => false } },
    db: { hasPendingCraft: () => true },
    taskPool: {
      hasInFlightCraft: () => true,
      waitForCraftDrain: async () => service.events.push({ event: 'drain' }),
      dispatch: () => {}
    },
    events: [],
    debugCraft (event) { this.events.push({ event }) },
    getCraftController: () => ({
      isBusy: () => false,
      cancel: () => {},
      recover: async () => {
        service.events.push({ event: 'recover' })
        return { status: 'resumable', operationId: 'craft:original' }
      },
      resume: async operationId => {
        service.events.push({ event: 'resume', operationId })
        return { status: 'complete', operationId }
      }
    })
  })

  await Service.prototype.handleRespawn.call(service)

  assert.deepEqual(service.events.map(event => event.event), ['drain', 'recover', 'service.resume_start', 'resume'])
  assert.equal(service.events.at(-1).operationId, 'craft:original')
  assert.equal(service.recoveringFromDeath, false)
})

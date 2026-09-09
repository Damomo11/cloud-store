const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const Warehouse = require('../src/warehouse')
const { DEFAULT_CONFIG } = require('../src/config')

function createRetryWarehouse ({ succeedOnCall = Infinity, failMessage = null, timeoutMs = 50, attempts, timeouts, lingeringWindowOnCall = 0 } = {}) {
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    heldItem: null,
    currentWindow: null
  }
  const closeWindowCalls = []
  const currentWindowAtOpen = []
  let openCalls = 0
  const container = { inventoryStart: 27, items: () => [] }

  bot.lookAt = async () => {}
  bot.closeWindow = window => {
    closeWindowCalls.push(window)
    bot.currentWindow = null
  }
  bot.openContainer = () => {
    openCalls++
    // 模拟超时后服务器迟到下发的窗口：已经打开但没有触发任何等待方。
    if (openCalls === lingeringWindowOnCall) bot.currentWindow = lateWindow
    currentWindowAtOpen.push(bot.currentWindow)
    if (openCalls >= succeedOnCall) return Promise.resolve(container)
    if (failMessage) return Promise.reject(new Error(failMessage))
    return new Promise(() => {})
  }

  const block = { name: 'barrel', position: new Vec3(0, 64, 0) }
  bot.blockAt = pos => (pos.x === 0 && pos.y === 64 && pos.z === 0) ? block : null

  const config = structuredClone(DEFAULT_CONFIG)
  config.debug = false
  config.timing.openContainerTimeoutsMs = timeouts || [timeoutMs]
  config.timing.containerSettleMs = 0
  if (attempts !== undefined) config.timing.openContainerAttempts = attempts

  const warehouse = new Warehouse(bot, {}, {}, config)
  warehouse.gotoForContainer = async () => {}
  const lateWindow = { id: 7 }
  return {
    warehouse,
    bot,
    container,
    lateWindow,
    chest: { chestId: '0,64,0', x: 0, y: 64, z: 0, blockName: 'barrel' },
    getOpenCalls: () => openCalls,
    getCloseWindowCalls: () => closeWindowCalls,
    getCurrentWindowAtOpen: () => currentWindowAtOpen
  }
}

test('openContainerAt retries a timed-out open and succeeds on a later attempt', async () => {
  const { warehouse, chest, container, getOpenCalls } = createRetryWarehouse({ succeedOnCall: 3 })

  const opened = await warehouse.openContainerAt(chest)

  assert.equal(opened, container)
  assert.equal(getOpenCalls(), 3)
})

test('openContainerAt makes at most the configured number of attempts in total', async () => {
  const { warehouse, chest, getOpenCalls } = createRetryWarehouse({ succeedOnCall: Infinity, attempts: 2 })

  await assert.rejects(warehouse.openContainerAt(chest), error => {
    assert.match(error.message, /打开箱子超时/)
    return true
  })
  assert.equal(getOpenCalls(), 2)
})

test('openContainerAt closes a lingering window before retrying a timed-out open', async () => {
  const { warehouse, chest, lateWindow, getCloseWindowCalls, getCurrentWindowAtOpen } = createRetryWarehouse({ succeedOnCall: 2, lingeringWindowOnCall: 1 })

  await warehouse.openContainerAt(chest)

  assert.deepEqual(getCloseWindowCalls(), [lateWindow])
  assert.equal(getCurrentWindowAtOpen()[1], null)
})

test('openContainerAt does not retry non-timeout open failures', async () => {
  const { warehouse, chest, getOpenCalls } = createRetryWarehouse({ failMessage: 'cannot open barrel' })

  await assert.rejects(warehouse.openContainerAt(chest), error => {
    assert.match(error.message, /cannot open barrel/)
    assert.doesNotMatch(error.message, /打开箱子超时/)
    return true
  })
  assert.equal(getOpenCalls(), 1)
})

test('open attempts escalate the timeout per the configured schedule', async () => {
  const { warehouse, chest, container } = createRetryWarehouse({ succeedOnCall: 2, timeouts: [40, 400] })
  const passedTimeouts = []
  const originalOpenContainerBlock = warehouse.openContainerBlock.bind(warehouse)
  warehouse.openContainerBlock = async (block, timeoutMs) => {
    passedTimeouts.push(timeoutMs)
    return originalOpenContainerBlock(block, timeoutMs)
  }

  const opened = await warehouse.openContainerAt(chest)

  assert.equal(opened, container)
  assert.deepEqual(passedTimeouts, [40, 400])
})

test('timeoutForOpenAttempt follows the schedule, clamps beyond its end, and falls back to openContainerTimeoutMs', () => {
  const { warehouse } = createRetryWarehouse({ timeouts: [2000, 4000, 8000] })

  assert.equal(warehouse.timeoutForOpenAttempt(0), 2000)
  assert.equal(warehouse.timeoutForOpenAttempt(1), 4000)
  assert.equal(warehouse.timeoutForOpenAttempt(2), 8000)
  assert.equal(warehouse.timeoutForOpenAttempt(3), 8000)

  const { warehouse: fallbackWarehouse } = createRetryWarehouse({})
  delete fallbackWarehouse.config.timing.openContainerTimeoutsMs
  fallbackWarehouse.config.timing.openContainerTimeoutMs = 1234
  assert.equal(fallbackWarehouse.timeoutForOpenAttempt(0), 1234)
})

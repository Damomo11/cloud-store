const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { configureTraceLog, startTrace, traceEvent, traceSummary, traceFileFor, shortKey } = require('../src/traceLog')
const Warehouse = require('../src/warehouse')
const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

const ITEM = {
  itemKey: 'minecraft:stone|plain',
  itemId: 'minecraft:stone',
  displayName: '石头'
}

const DIRT = {
  itemKey: 'minecraft:dirt|plain',
  itemId: 'minecraft:dirt',
  displayName: '泥土'
}

function makeTempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-trace-'))
}

function readTraceLines (directory) {
  const file = traceFileFor()
  assert.equal(path.dirname(file), path.resolve(directory), 'trace file must live in the configured directory')
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

test('trace events share one traceId and are appended as jsonl', () => {
  const directory = makeTempDir()
  configureTraceLog({ enabled: true, directory, retentionDays: 14 })

  const trace = startTrace({ bot: 'BotA', kind: 'withdraw', actor: 'Steve', requests: [] })
  traceEvent(trace, 'plan', 'allocate_start', { item: '石头', need: 10 })
  traceEvent(trace, 'decision', 'barrel_shortage_skip', { chest: 'barrel@1,2,3' })
  traceSummary(trace, { status: 'delivered', deliveredTotal: 4 })

  const lines = readTraceLines(directory)
  assert.equal(lines.length, 4)
  assert.equal(new Set(lines.map(line => line.traceId)).size, 1, 'all events of one task share the traceId')
  assert.equal(lines[0].event, 'trace_start')
  assert.equal(lines[0].actor, 'Steve')
  assert.equal(lines[1].phase, 'plan')
  assert.equal(lines[1].need, 10)
  assert.equal(lines[2].event, 'barrel_shortage_skip')
  assert.equal(lines[3].event, 'task_summary')
  assert.equal(lines[3].status, 'delivered')
  for (const line of lines) {
    assert.ok(line.ts, 'every line carries a timestamp')
    assert.ok(Number.isFinite(line.elapsed), 'every line carries elapsed ms')
  }
})

test('traceLog writes nothing when disabled or when trace is null', () => {
  const directory = makeTempDir()
  configureTraceLog({ enabled: false, directory })

  assert.equal(startTrace({ bot: 'BotA' }), null)
  traceEvent(null, 'plan', 'allocate_start', {})
  traceEvent({ traceId: 'x' }, 'plan', 'allocate_start', {})
  assert.equal(fs.readdirSync(directory).length, 0, 'disabled logger must not create files')

  configureTraceLog({ enabled: true, directory })
  const trace = startTrace({ bot: 'BotA' })
  traceEvent(null, 'plan', 'allocate_start', {})
  const lines = readTraceLines(directory)
  assert.equal(lines.length, 1, 'a null trace stays silent once the logger is enabled again')
  assert.equal(lines[0].event, 'trace_start')
})

test('shortKey keeps the fingerprint tail of an itemKey', () => {
  assert.equal(shortKey('minecraft:stone|abcdef0123456789'), '3456789'.slice(-6))
  assert.equal(shortKey('minecraft:stone|'), '')
  assert.equal(shortKey(''), '')
})

function makeContainer (readSlots) {
  const slots = readSlots.map(entry => ({ ...entry }))
  return {
    inventoryStart: 27,
    inventoryEnd: 63,
    items: () => slots.filter(entry => entry.count > 0),
    close: () => {}
  }
}

// chests: [{ chestId, recorded, reads: [[contents], ...] }]
function createTracedWarehouse (chests) {
  const readsByChest = new Map(chests.map(chest => [chest.chestId, chest.reads.map(read => read.map(entry => ({ ...entry })))]))

  const db = {
    getItemByKey: key => key === ITEM.itemKey ? { ...ITEM } : null,
    listSlotsForItemKey: () => chests.flatMap(chest => [
      {
        chestId: chest.chestId,
        x: 1, y: 2, z: 3,
        blockName: 'barrel',
        slot: 0,
        amount: chest.recorded,
        itemKey: ITEM.itemKey
      }
    ]),
    upsertChest: () => {},
    replaceChestSlots: () => {}
  }
  const catalog = {
    fromPrismarineItem: entry => entry.name === 'dirt' ? { ...DIRT } : { ...ITEM }
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.debug = false
  config.timing.containerSettleMs = 0

  const warehouse = new Warehouse({ username: 'BotA' }, db, catalog, config)
  warehouse.openContainerAt = async chest => {
    const queue = readsByChest.get(chest.chestId) || []
    return makeContainer(queue.length ? queue.shift() : [])
  }
  warehouse.tryWithdrawExactFrom = async (container, itemKey, amount) => {
    let remaining = amount
    for (const slot of container.items()) {
      if (remaining <= 0) break
      if (slot.name === 'dirt') continue
      const take = Math.min(remaining, slot.count)
      slot.count -= take
      remaining -= take
    }
    return amount - remaining
  }
  return warehouse
}

test('withdraw chain logs plan, locate, open snapshot, take result and shortage decision under one traceId', async () => {
  const directory = makeTempDir()
  configureTraceLog({ enabled: true, directory, retentionDays: 14 })

  const warehouse = createTracedWarehouse([
    { chestId: 'chest-1', recorded: 10, reads: [[{ slot: 0, count: 4, name: 'stone' }, { slot: 5, count: 9, name: 'dirt' }]] }
  ])
  const trace = startTrace({ bot: 'BotA', kind: 'withdraw', actor: 'Steve' })
  warehouse.attachTrace(trace)
  try {
    const result = await warehouse.withdrawAllocationsLocked([{ ...ITEM, amount: 10 }])
    assert.equal(result.withdrawn.reduce((sum, item) => sum + item.amount, 0), 4)
    assert.deepEqual(result.missing.map(item => item.amount), [6])
  } finally {
    warehouse.detachTrace()
  }

  const lines = readTraceLines(directory)
  const events = lines.map(line => line.event)
  for (const expected of [
    'trace_start',
    'allocate_start',
    'barrel_locate',
    'barrel_open',
    'barrel_take_result',
    'chest_record_refresh',
    'barrel_shortage_skip',
    'allocate_missing'
  ]) {
    assert.ok(events.includes(expected), `expected event ${expected} in ${JSON.stringify(events)}`)
  }
  assert.equal(new Set(lines.map(line => line.traceId)).size, 1)

  const openEvent = lines.find(line => line.event === 'barrel_open')
  assert.equal(openEvent.recorded, 10)
  assert.equal(openEvent.actual, 4)
  assert.equal(openEvent.toTake, 4)
  assert.deepEqual(
    openEvent.contents.map(entry => [entry.slot, entry.name, entry.n]),
    [[0, '石头', 4], [5, '泥土', 9]],
    'barrel_open carries the actual window snapshot'
  )
  const shortage = lines.find(line => line.event === 'barrel_shortage_skip')
  assert.equal(shortage.recorded, 10)
  assert.equal(shortage.actual, 4)
  assert.ok(shortage.decision.includes('换下一个木桶'))
})

test('syncSingleBarrel replaces the slot record and expands shulker contents in the detail', async () => {
  const directory = makeTempDir()
  configureTraceLog({ enabled: true, directory, retentionDays: 14 })

  const replaced = []
  const upserted = []
  const db = {
    listChests: () => [],
    upsertChest: chest => upserted.push(chest),
    replaceChestSlots: (chestId, slots) => replaced.push({ chestId, slots })
  }
  const SHULKER_KEY = 'minecraft:blue_shulker_box|box1'
  const catalog = {
    fromPrismarineItem: entry => entry.name === 'box'
      ? { itemKey: SHULKER_KEY, itemId: 'minecraft:blue_shulker_box', displayName: '蓝色潜影盒' }
      : { itemKey: ITEM.itemKey, itemId: 'minecraft:stone', displayName: '石头' },
    isShulkerBox: itemId => itemId === 'minecraft:blue_shulker_box',
    extractShulkerContents: () => [
      { item: { itemKey: ITEM.itemKey, itemId: 'minecraft:stone', displayName: '石头' }, amount: 128, slotCount: 2 }
    ]
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.server.botName = 'BotA'
  config.debug = false
  config.timing.containerSettleMs = 0

  const warehouse = new Warehouse({
    username: 'BotA',
    blockAt: () => ({ name: 'barrel', position: { x: 9, y: 9, z: 9 } })
  }, db, catalog, config)
  warehouse.goHome = async () => {}
  warehouse.openContainerAt = async () => makeContainer([
    { slot: 0, count: 12, name: 'stone' },
    { slot: 3, count: 1, name: 'box' }
  ])

  const trace = startTrace({ bot: 'BotA', kind: 'barrel-debug', actor: 'Admin' })
  warehouse.attachTrace(trace)
  let detail
  try {
    detail = await warehouse.syncSingleBarrel({ chestId: '9,9,9', x: 9, y: 9, z: 9, blockName: 'barrel' })
  } finally {
    warehouse.detachTrace()
  }

  assert.equal(replaced.length, 1, 'the barrel slot record is replaced')
  assert.equal(replaced[0].chestId, '9,9,9', 'the chest record is keyed by coordinates')
  assert.equal(upserted.length, 1)
  assert.equal(upserted[0].chestId, '9,9,9')
  assert.equal(upserted[0].blockName, 'barrel', 'the real block name is recorded')
  assert.equal(detail.total, 13)
  const shulkerEntry = detail.items.find(item => item.keyTail === shortKey(SHULKER_KEY))
  assert.deepEqual(
    shulkerEntry.shulkerContents.map(entry => [entry.name, entry.n, entry.slots]),
    [['石头', 128, 2]],
    'boxed items are expanded into the barrel detail'
  )

  const lines = readTraceLines(directory)
  const resultEvent = lines.find(line => line.event === 'barrel_debug_result')
  assert.ok(resultEvent, 'barrel_debug_result is traced')
  assert.equal(resultEvent.types, 2)
})

test('parseBarrelCoords accepts space and comma separated coordinates', () => {
  const service = new CloudStoreService({ username: 'BotA' }, {}, {}, {}, DEFAULT_CONFIG)
  assert.deepEqual(service.parseBarrelCoords('!同步木桶 120 64 -35'), { x: 120, y: 64, z: -35 })
  assert.deepEqual(service.parseBarrelCoords('!同步木桶 120,64,-35'), { x: 120, y: 64, z: -35 })
  assert.deepEqual(service.parseBarrelCoords('!同步木桶 120，64，-35'), { x: 120, y: 64, z: -35 })
  assert.equal(service.parseBarrelCoords('!同步木桶'), null)
  assert.equal(service.parseBarrelCoords('!同步木桶 120 64'), null)
  assert.equal(service.parseBarrelCoords('!同步木桶 a b c'), null)
})

test('deposit flow writes its own trace with kind=deposit', async () => {
  const directory = makeTempDir()
  configureTraceLog({ enabled: true, directory, retentionDays: 14 })
  const db = {
    addCommandReply: () => {},
    saveRecoveryTask: () => {},
    clearRecoveryTask: () => {},
    getRecoveryTask: () => null,
    addTransaction: () => {}
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.debugChat = false
  config.timing.pickupWindowMs = 10
  const service = new CloudStoreService(
    { username: 'BotA', players: {}, chat: () => {}, inventory: { items: () => [] } },
    db,
    { aggregatePrismarineItems: () => [] },
    {
      activeTrace: null,
      attachTrace(t) { this.activeTrace = t },
      detachTrace() { this.activeTrace = null },
      goHomeIfAway: async () => {},
      goHome: async () => {},
      collectNearbyDropsUntil: async () => {},
      waitForPickupSettle: async () => {},
      depositInventoryForOwner: async () => ({
        deposited: [{ itemKey: 'minecraft:stone|plain', itemId: 'minecraft:stone', displayName: '石头', amount: 5 }],
        leftover: [],
        stopReason: ''
      })
    },
    config
  )
  service.getPlayer = () => ({ uuid: 'uuid-alice', username: 'Alice' })
  service.getStorageQuota = () => ({ usedSlots: 0, quotaSlots: 270 })
  service.teleportToPlayer = async () => true

  await service.handleDeposit('Alice', { uuid: 'uuid-alice', username: 'Alice', scope: 'personal' })

  const lines = readTraceLines(directory)
  assert.equal(lines[0].kind, 'deposit')
  assert.equal(lines[0].actor, 'Alice')
  assert.equal(lines.filter(line => line.event === 'trace_start').length, 1)
  const events = lines.map(line => line.event)
  for (const expected of ['teleport_to_player', 'collect_done', 'deposit_flow_result', 'task_summary']) {
    assert.ok(events.includes(expected), `expected event ${expected} in ${JSON.stringify(events)}`)
  }
  const summary = lines.find(line => line.event === 'task_summary')
  assert.equal(summary.status, 'ok')
  const flow = lines.find(line => line.event === 'deposit_flow_result')
  assert.deepEqual(flow.deposited.map(item => [item.name, item.amount]), [['石头', 5]])
})

test('private message 同步木桶 gains the ! prefix like other admin commands', () => {
  const service = new CloudStoreService({ username: 'BotA' }, {}, {}, {}, DEFAULT_CONFIG)
  assert.equal(service.normalizePrivateCommandText('同步木桶 120 64 -35', 'whisper'), '!同步木桶 120 64 -35')
})

function createChatService (chatCalls = []) {
  const db = {
    isAdmin: () => false,
    createCommandLog: () => 42,
    currentCommandLogId: () => 42,
    runWithCommandContext: (id, fn) => fn(),
    addCommandReply: () => {}
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.debugChat = false
  const service = new CloudStoreService(
    { username: 'BotA', players: {}, chat: command => chatCalls.push(command) },
    db,
    {},
    { activeTrace: null },
    config
  )
  service.getPlayer = () => ({ uuid: 'uuid-steve', username: 'Steve' })
  service.withBotContext = fn => fn()
  return service
}

test('player chat input and the bot reply are both traced, keyed by commandLogId', async () => {
  const directory = makeTempDir()
  configureTraceLog({ enabled: true, directory, retentionDays: 14 })
  const chatCalls = []
  const service = createChatService(chatCalls)

  await service.handleIncoming('Steve', '！同步木桶 1 2 3', 'chat', { channel: 'public' })

  assert.equal(chatCalls.length, 1, 'the bot answered the rejected command in chat')
  const lines = readTraceLines(directory)
  const events = lines.map(line => line.event)
  assert.ok(events.includes('trace_start'), 'the raw input is recorded')
  assert.ok(events.includes('command_accepted'), 'the accept decision is recorded')
  assert.ok(events.includes('bot_reply'), 'the bot reply is recorded')

  const input = lines.find(line => line.event === 'trace_start' && line.kind === 'command')
  assert.equal(input.actor, 'Steve')
  assert.equal(input.rawMessage, '！同步木桶 1 2 3', 'the message is kept exactly as the player typed it')
  assert.equal(input.command, '!同步木桶 1 2 3')
  assert.equal(input.channel, 'public')
  assert.equal(input.commandLogId, undefined, 'commandLogId rides on its own event')

  const accepted = lines.find(line => line.event === 'command_accepted')
  assert.equal(accepted.traceId, input.traceId)
  const context = lines.find(line => line.event === 'command_context')
  assert.equal(context.commandLogId, 42)
  assert.equal(context.traceId, input.traceId)

  const reply = lines.find(line => line.event === 'bot_reply')
  assert.equal(reply.to, 'Steve')
  assert.ok(reply.message.includes('你没有权限同步木桶'))
  assert.ok(reply.traceId.startsWith('rpl-'), 'replies outside a task get their own standalone trace id')
})

test('duplicate command inside the dedupe window is recorded as rejected', async () => {
  const directory = makeTempDir()
  configureTraceLog({ enabled: true, directory, retentionDays: 14 })
  const service = createChatService()

  await service.handleIncoming('Steve', '!不存在的指令 1', 'chat', { channel: 'public' })
  await service.handleIncoming('Steve', '!不存在的指令 1', 'chat', { channel: 'public' })

  const lines = readTraceLines(directory)
  const rejected = lines.filter(line => line.event === 'command_rejected_duplicate')
  assert.equal(rejected.length, 1, 'the second identical command is rejected as duplicate')
  assert.equal(lines.filter(line => line.event === 'command_accepted').length, 1)
})

test('bot replies ride the active task trace while it exists and standalone once detached', () => {
  const directory = makeTempDir()
  configureTraceLog({ enabled: true, directory, retentionDays: 14 })
  const service = createChatService()
  const trace = startTrace({ bot: 'BotA', kind: 'withdraw', actor: 'Steve' })
  service.warehouse.activeTrace = trace
  service.msg('Steve', '取货完成：1种物品，共20个')
  service.warehouse.activeTrace = null
  service.msg('Steve', '机器人忙，请稍后再试。')

  const lines = readTraceLines(directory)
  const replies = lines.filter(line => line.event === 'bot_reply')
  assert.equal(replies.length, 2)
  assert.equal(replies[0].traceId, trace.traceId, 'task-scoped reply shares the task traceId')
  assert.equal(replies[0].to, 'Steve')
  assert.ok(replies[1].traceId.startsWith('rpl-'))
})

test('web withdraw requests are recorded as input events', () => {
  const directory = makeTempDir()
  configureTraceLog({ enabled: true, directory, retentionDays: 14 })
  const service = createChatService()
  service.resolveWebStorageOwner = () => ({ uuid: 'uuid-steve', username: 'Steve', scope: 'personal' })
  service.parsePositiveAmount = () => 5
  service.db.getItemByKey = key => ({ itemKey: key, itemId: 'minecraft:stone', displayName: '石头' })
  service.enqueueTask = async () => {}

  service.startWebWithdrawMany(
    { uuid: 'uuid-steve', username: 'Steve' },
    'uuid-steve',
    [{ itemKey: 'minecraft:stone|plain', amount: 5 }],
    'Steve'
  )

  const lines = readTraceLines(directory)
  const request = lines.find(line => line.event === 'web_withdraw_request')
  assert.ok(request, 'web withdraw input is traced')
  assert.equal(request.source, 'web')
  assert.equal(request.actor, 'Steve')
  assert.equal(request.target, 'Steve')
  assert.deepEqual(request.requests.map(entry => [entry.name, entry.amount]), [['石头', 5]])
})

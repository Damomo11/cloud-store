'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const StoreDb = require('../../src/db')
const ItemCatalog = require('../../src/itemCatalog')
const { CraftController } = require('../../src/craft/controller')
const { DEFAULT_CONFIG } = require('../../src/config')

// 自动恢复回归（2026-11-05 生产事故）：合成失败留下 recovery_required 记录后，
// 唯一会自动恢复的路径是 bot 掉线重连/重启（start 钩子），bot 存活期间全库被
// assertNoPendingCraft 锁住，取货/回存停摆约 19 分钟，靠一次偶发的掉线重连才解开。
// run() 现在在失败落恢复记录后立即自愈；主动取消（死亡/断线）仍留给 service 钩子。

function fixture () {
  const config = structuredClone(DEFAULT_CONFIG)
  const catalog = new ItemCatalog(config.server.version, {}, {})
  const Item = require('prismarine-item')(config.server.version)
  const make = (name, count) => new Item(catalog.mcData.itemsByName[name].id, count)
  const db = new StoreDb(':memory:', config)
  let inventory = []
  let deposits = 0
  const stored = new Map()
  const chest = { chestId: '0,64,0', x: 0, y: 64, z: 0, blockName: 'barrel' }
  db.upsertChest(chest)
  function refresh () {
    db.replaceChestSlots(chest.chestId, [...stored.values()].filter(item => item.count > 0)
      .map((item, slot) => ({ ...catalog.fromPrismarineItem(item), slot })))
  }
  const bot = new (require('node:events').EventEmitter)()
  bot._client = new (require('node:events').EventEmitter)()
  bot.inventory = { items: () => inventory, selectedItem: null, slots: [] }
  bot.username = 'CraftBot'
  const warehouse = {
    withWarehouseLock: fn => fn(),
    goHomeIfAway: async () => {},
    withdrawAllocationsLocked: async allocations => {
      const withdrawn = []
      for (const a of allocations) {
        const count = Math.min(a.amount, stored.get(a.itemKey)?.count || 0)
        if (count) {
          const source = stored.get(a.itemKey)
          source.count -= count
          inventory.push(make(source.name, count))
          withdrawn.push({ ...db.getItemByKey(a.itemKey), amount: count })
        }
      }
      refresh()
      return { withdrawn, missing: allocations.filter(a => !withdrawn.some(w => w.itemKey === a.itemKey && w.amount === a.amount)) }
    },
    depositAllPossible: async () => {
      deposits++
      for (const item of inventory) {
        const key = catalog.fromPrismarineItem(item).itemKey
        if (!stored.has(key)) stored.set(key, make(item.name, 0))
        stored.get(key).count += item.count
      }
      inventory = []
      refresh()
      return { stopReason: '' }
    },
    refreshChestSnapshot: () => refresh(),
    closeContainerQuietly: () => {}
  }
  function seed (owner, name, count) {
    const item = make(name, count)
    const row = catalog.fromPrismarineItem(item)
    db.addBalanceItems(owner, [row])
    if (!stored.has(row.itemKey)) stored.set(row.itemKey, make(name, 0))
    stored.get(row.itemKey).count += count
    refresh()
    return row
  }
  const executor = {
    execute: async () => { throw new Error('missing ingredient') },
    preview: (step, triggers = 1) => ({
      expectedConsumed: catalog.aggregatePrismarineItems(inventory),
      expectedProduced: [{ ...catalog.fromPrismarineItem(make(step.result.name, step.result.count * triggers)) }]
    }),
    cancel: () => {},
    isBusy: () => false
  }
  const controller = new CraftController({ bot, db, catalog, config, warehouse, executor, botId: 'bot-a' })
  const request = () => ({ actor: 'Alice', owner: { uuid: 'alice', username: 'Alice', scope: 'personal' }, item: 'stick', quantity: 4 })
  return {
    db, bot, warehouse, executor, controller, seed, stored, make, request,
    deposits: () => deposits,
    close: () => db.close()
  }
}

test('a natural craft failure left in recovery_required is auto-recovered immediately while the bot is alive', async () => {
  const f = fixture()
  try {
    const plank = f.seed('alice', 'oak_planks', 2)
    // executor 抛自然错误（无 partial 证据）→ 内层 catch 只能 markRecovery；
    // run() 外层必须立即 recover：把中断背包存回仓库、对账清零恢复记录、
    // 原错误照常上抛，而不是锁着全库等掉线重连/人工。
    await assert.rejects(f.controller.run(f.request()), /missing ingredient/)
    assert.equal(f.controller.ledger.pending('bot-a').length, 0, 'journal must be reconciled, not left pending')
    assert.equal(f.deposits(), 1, 'recovery must park the backpack into the warehouse')
    assert.equal(f.db.getBalance('alice', plank.itemKey), 2, 'unconsumed inputs stay owned by alice')
    assert.equal(f.stored.get(plank.itemKey).count, 2, 'inputs are physically back in the barrel')
  } finally { f.close() }
})

test('an aborted craft (death/invalidate cancel) keeps its journal for the service hooks instead of racing a recovery', async () => {
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 2)
    f.executor.execute = async ({ signal }) => {
      await new Promise(resolve => setTimeout(resolve, 30))
      if (signal.aborted) throw signal.reason
      throw new Error('missing ingredient')
    }
    const outcome = f.controller.run(f.request()).then(
      () => { throw new Error('expected the craft to reject') },
      error => error)
    setTimeout(() => f.controller.cancel('机器人死亡后等待合成恢复。'), 5)
    const error = await outcome
    assert.equal(error.message, '机器人死亡后等待合成恢复。')
    // 主动取消：不抢跑恢复，恢复记录原样留给死亡/重连钩子处理。
    assert.equal(f.controller.ledger.pending('bot-a').length, 1, 'journal stays for the death/spawn hooks')
    assert.equal(f.deposits(), 0, 'no auto recovery deposit may run on a cancelled task')
  } finally { f.close() }
})

test('a failed auto-recovery keeps the journal and surfaces both errors', async () => {
  const f = fixture()
  try {
    f.seed('alice', 'oak_planks', 2)
    // 仓库没有可用容器：自动恢复自身失败，必须保留记录供人工核对，
    // 并把两条错误都带给调用方。
    f.db.listChests = () => []
    await assert.rejects(f.controller.run(f.request()), /missing ingredient；自动恢复未完成/)
    assert.equal(f.controller.ledger.pending('bot-a').length, 1, 'journal stays pending for manual audit')
    assert.ok(f.controller.ledger.listCraftReservations(f.controller.ledger.pending('bot-a')[0].id).length,
      'reservations must be retained for the audit')
  } finally { f.close() }
})

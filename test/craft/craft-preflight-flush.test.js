'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const StoreDb = require('../../src/db')
const ItemCatalog = require('../../src/itemCatalog')
const Warehouse = require('../../src/warehouse')
const Service = require('../../src/service')
const { AsyncMutex } = require('../../src/taskPool')
const { DEFAULT_CONFIG } = require('../../src/config')

// 真实 SQLite + 服务层 + 入库记账封装 + 控制器全链；仅模拟容器/移动/物品转移。
// 覆盖 runCraftCommand 的合成前残留回库（复用每次存入前的 flushResidual 归属规则）。
function preflightFixture () {
  const config = structuredClone(DEFAULT_CONFIG)
  const catalog = new ItemCatalog(config.server.version, {}, {})
  const Item = require('prismarine-item')(config.server.version)
  const make = (name, count) => new Item(catalog.mcData.itemsByName[name].id, count)
  const db = new StoreDb(':memory:', config)
  let inventory = []
  const stored = new Map()
  const chest = { chestId: '0,64,0', x: 0, y: 64, z: 0, blockName: 'barrel' }
  db.upsertChest(chest)
  function refresh () {
    db.replaceChestSlots(chest.chestId, [...stored.values()].filter(item => item.count > 0).map((item, slot) => ({ ...catalog.fromPrismarineItem(item), slot })))
  }
  const bot = new (require('node:events').EventEmitter)()
  bot._client = new (require('node:events').EventEmitter)()
  bot.inventory = { items: () => inventory, selectedItem: null, slots: new Array(46).fill(null) }
  bot.username = 'CraftBot'
  bot.currentWindow = null

  const executor = {
    execute: async ({ step, triggers = 1 }) => {
      const before = catalog.aggregatePrismarineItems(inventory)
      inventory = [make(step.result.name, step.result.count * triggers)]
      const after = catalog.aggregatePrismarineItems(inventory)
      return { before, after, consumed: before, produced: after }
    },
    preview: (step, triggers = 1) => ({
      expectedConsumed: catalog.aggregatePrismarineItems(inventory),
      expectedProduced: [{ ...catalog.fromPrismarineItem(make(step.result.name, step.result.count * triggers)) }]
    }),
    cancel: () => {},
    isBusy: () => false
  }

  function storeAll () {
    for (const item of inventory) {
      const key = catalog.fromPrismarineItem(item).itemKey
      if (!stored.has(key)) stored.set(key, make(item.name, 0))
      stored.get(key).count += item.count
    }
    inventory = []
    refresh()
    return { deposited: [...stored.values()].filter(v => v.count > 0).map(v => ({ ...catalog.fromPrismarineItem(v), amount: v.count })), leftover: [] }
  }

  const warehouse = Object.assign(new Warehouse(bot, db, catalog, config, new AsyncMutex()), {
    withWarehouseLock: Warehouse.prototype.withWarehouseLock,
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
      const result = storeAll()
      return { deposited: result.deposited, stopReason: '' }
    },
    depositInventoryForOwner: async () => {
      const result = storeAll()
      return { deposited: result.deposited, leftover: [] }
    },
    depositInventoryWithoutBalance: async () => {
      const result = storeAll()
      return { deposited: result.deposited, leftover: [] }
    }
  })

  const service = new Service(bot, db, catalog, warehouse, config)
  bot._craftingExecutor = executor
  service.craftLedger()
  const messages = []
  service.msg = (to, message) => { messages.push(String(message)) }
  service.getPlayer = username => ({ uuid: username.toLowerCase(), username })
  service.validateCraftOwner = () => {}

  function seed (owner, name, count) {
    const item = make(name, count)
    const row = catalog.fromPrismarineItem(item)
    db.addBalanceItems(owner, [row])
    if (!stored.has(row.itemKey)) stored.set(row.itemKey, make(name, 0))
    stored.get(row.itemKey).count += count
    refresh()
    return row
  }

  const command = { player: 'Alice', owner: { uuid: 'alice', username: 'Alice', scope: 'personal' }, target: { name: 'stick', quantity: 4 } }
  return {
    db, config, catalog, bot, warehouse, executor, seed, stored, make, refresh, service, messages, command,
    setInventory: items => { inventory = items },
    getInventory: () => inventory,
    balance: (owner, name) => (db.getOwnerItemsByItemId(owner, `minecraft:${name}`) || []).reduce((sum, item) => sum + item.amount, 0),
    transactionCount: type => db.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE type=?').get(type).n,
    close: () => db.close()
  }
}

test('合成前背包有实物残留：按归属回仓(momo)后照常开工合成', async () => {
  const f = preflightFixture()
  try {
    f.seed('alice', 'oak_planks', 2)
    // 机器人捡拾的零散残留（无任何恢复任务可解释）。
    f.setInventory([f.make('cobblestone', 3)])

    const result = await f.service.runCraftCommand(f.command)
    assert.equal(result.status, 'complete')

    // 残留物归 momo：记账 + 实物回仓，背包清空。
    assert.equal(f.balance(f.config.momoOwner, 'cobblestone'), 3)
    assert.equal(f.transactionCount('residual_to_momo'), 1)
    assert.equal(f.stored.get(f.catalog.fromPrismarineItem(f.make('cobblestone', 1)).itemKey).count, 3)
    assert.deepEqual(f.getInventory(), [])
    // 合成本身完成：alice 得到木棍，事务齐全。
    assert.equal(f.balance('alice', 'stick'), 4)
    assert.equal(f.transactionCount('craft_consume'), 1)
    assert.equal(f.transactionCount('craft_produce'), 1)
    // 玩家收到清理提示。
    assert.equal(f.messages.some(message => /残留.*回仓/.test(message)), true)
    assert.equal(f.service.craftLedger().pending().length, 0)
  } finally { f.close() }
})

test('窗口/光标/合成格异常时直接关窗归位，随清理回仓后照常开工', async () => {
  const f = preflightFixture()
  try {
    f.seed('alice', 'oak_planks', 2)
    f.setInventory([f.make('cobblestone', 3)])
    // 上次操作遗留的未关窗口 + 持物光标。
    f.bot.currentWindow = { type: 'minecraft:chest', id: 7 }
    f.bot.inventory.selectedItem = f.make('dirt', 2)
    // 关窗把光标物退回背包（模拟服务器行为）。
    f.bot.closeWindow = () => {
      f.bot.currentWindow = null
      f.setInventory([...f.getInventory(), f.bot.inventory.selectedItem])
      f.bot.inventory.selectedItem = null
    }

    const result = await f.service.runCraftCommand(f.command)
    assert.equal(result.status, 'complete')

    // 窗已关；光标物与背包杂物全部随清理归 momo 回仓。
    assert.equal(f.bot.currentWindow, null)
    assert.equal(f.bot.inventory.selectedItem, null)
    assert.equal(f.balance(f.config.momoOwner, 'cobblestone'), 3)
    assert.equal(f.balance(f.config.momoOwner, 'dirt'), 2)
    assert.deepEqual(f.getInventory(), [])
    assert.equal(f.balance('alice', 'stick'), 4)
    assert.equal(f.transactionCount('craft_consume'), 1)
  } finally { f.close() }
})

test('背包干净时直接开工，不触发清理提示（回归）', async () => {
  const f = preflightFixture()
  try {
    f.seed('alice', 'oak_planks', 2)
    f.setInventory([])

    const result = await f.service.runCraftCommand(f.command)
    assert.equal(result.status, 'complete')
    assert.equal(f.balance('alice', 'stick'), 4)
    assert.equal(f.messages.some(message => /残留.*回仓/.test(message)), false)
  } finally { f.close() }
})

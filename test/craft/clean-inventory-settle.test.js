'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { CraftController } = require('../../src/craft/controller')

// 轻量 fixture：只覆盖清洁检查/自愈链路需要的 bot 表面，不跑完整合成流程。
// 真实 mineflayer 语义由 mock 显式表达：closeWindow 后服务器包会把窗口内容
// 退回背包（光标清空、合成格清空）；顽固的 stale 光标走 settle 的归位兜底。
function fixture (options = {}) {
  const items = options.items ? [...options.items] : []
  const bot = {
    inventory: {
      items: () => items.map(item => ({ ...item })),
      slots: options.slots || new Array(46).fill(null),
      selectedItem: options.selectedItem ? { ...options.selectedItem } : null
    },
    currentWindow: options.currentWindow ? { ...options.currentWindow } : null
  }
  bot.closeWindow = () => {
    bot.currentWindow = null
    if (!options.windowKeepsCursor) bot.inventory.selectedItem = null
    bot.inventory.slots = bot.inventory.slots.map((value, index) => (index < 5 ? null : value))
  }
  bot.clickWindow = async () => {
    bot.inventory.selectedItem = null
  }
  const catalog = {
    aggregatePrismarineItems: list => {
      const totals = new Map()
      for (const item of list) {
        const itemKey = `minecraft:${item.name}`
        const previous = totals.get(itemKey)
        totals.set(itemKey, { itemKey, displayName: item.displayName || item.name, amount: (previous?.amount || 0) + item.count })
      }
      return [...totals.values()]
    },
    fromPrismarineItem: item => ({ ...item, itemKey: `minecraft:${item.name}`, displayName: item.displayName || item.name })
  }
  const controller = new CraftController({
    bot,
    db: {},
    catalog,
    config: { timing: {} },
    warehouse: {},
    executor: null,
    botId: 'testbot',
    ledger: { pending: () => [] }
  })
  return { controller, bot }
}

test('幻影窗口残留：settle 自愈后清洁检查通过，不再拒绝开工', async () => {
  const { controller } = fixture({
    currentWindow: { type: 'minecraft:chest', id: 1 },
    // 上次取货/拆盒遗留：窗口未关、光标持物、合成格有幻影物品。
    selectedItem: { name: 'stick', displayName: '木棍', count: 3 },
    slots: (() => {
      const slots = new Array(46).fill(null)
      slots[1] = { name: 'stick', displayName: '木棍', count: 1 }
      return slots
    })()
  })

  assert.ok(controller.hasInventoryResidue())
  await controller.settleResidue()
  assert.equal(controller.bot.currentWindow, null)
  assert.equal(controller.bot.inventory.selectedItem, null)

  // settle 后幻影清空：清洁检查应通过（2026-11-05 金苹果合成即挂在这里）。
  assert.doesNotThrow(() => controller.assertCleanInventory())
})

test('关窗清不掉的顽固光标：settle 归位到背包空槽后清洁检查通过', async () => {
  const { controller } = fixture({
    currentWindow: { type: 'minecraft:barrel', id: 2 },
    selectedItem: { name: 'firework_rocket', displayName: '烟花火箭', count: 64 },
    windowKeepsCursor: true
  })

  await controller.settleResidue()
  assert.equal(controller.bot.inventory.selectedItem, null)
  assert.doesNotThrow(() => controller.assertCleanInventory())
})

test('真背包物品残留：清洁检查报错，且错误信息带具体残留描述', async () => {
  const { controller } = fixture({
    items: [{ name: 'firework_rocket', displayName: '烟花火箭', count: 64 }]
  })

  assert.throws(
    () => controller.assertCleanInventory(),
    error => {
      assert.match(error.message, /需先处理机器人背包、窗口、光标或合成格残留物品/)
      assert.match(error.message, /当前残留/)
      assert.match(error.message, /烟花火箭×64/)
      return true
    }
  )
})

test('光标残留的描述包含物品名：报错可直接定位卡的是什么', () => {
  const { controller } = fixture({
    selectedItem: { name: 'shulker_box', displayName: '潜影盒', count: 1 }
  })

  assert.match(controller.residueDescription(), /光标 潜影盒/)
})

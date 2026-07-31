const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const StoreDb = require('../src/db')
const { DEFAULT_CONFIG } = require('../src/config')

function createDb () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-test-'))
  const db = new StoreDb(path.join(directory, 'store.sqlite'), structuredClone(DEFAULT_CONFIG))
  return {
    db,
    close: () => {
      db.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

test('only one task can reserve the last item', () => {
  const fixture = createDb()
  const item = {
    itemKey: 'diamond-block',
    itemId: 'minecraft:diamond_block',
    displayName: '钻石块',
    nbtJson: '',
    metaJson: '',
    amount: 1
  }

  try {
    fixture.db.addBalanceItems('player-1', [item])
    fixture.db.reserveInventory('task-1', [{ ...item, ownerUuid: 'player-1' }])

    assert.equal(fixture.db.getOwnerItemsByItemKey('player-1', item.itemKey).length, 0)
    assert.deepEqual(fixture.db.getOwnerShulkersContainingItemId('player-1', item.itemId), [])
    assert.deepEqual(fixture.db.getOwnerShulkersContainingItemKey('player-1', item.itemKey), [])
    assert.deepEqual(fixture.db.findOwnerShulkersByContainedDisplayQuery('player-1', '钻石块'), [])
    assert.throws(
      () => fixture.db.reserveInventory('task-2', [{ ...item, ownerUuid: 'player-1' }]),
      /库存已被其他任务占用/
    )

    fixture.db.releaseInventoryReservation('task-1')
    fixture.db.reserveInventory('task-2', [{ ...item, ownerUuid: 'player-1' }])
  } finally {
    fixture.close()
  }
})

test('reservations are isolated by owner and released without changing balance', () => {
  const fixture = createDb()
  const item = {
    itemKey: 'diamond-block',
    itemId: 'minecraft:diamond_block',
    displayName: '钻石块',
    nbtJson: '',
    metaJson: '',
    amount: 1
  }

  try {
    fixture.db.addBalanceItems('player-1', [item])
    fixture.db.addBalanceItems('player-2', [item])
    fixture.db.reserveInventory('task-1', [{ ...item, ownerUuid: 'player-1' }])
    fixture.db.reserveInventory('task-2', [{ ...item, ownerUuid: 'player-2' }])
    fixture.db.releaseInventoryReservation('task-1')

    assert.equal(fixture.db.getBalance('player-1', item.itemKey), 1)
    assert.equal(fixture.db.getOwnerItemsByItemKey('player-1', item.itemKey)[0].amount, 1)
  } finally {
    fixture.close()
  }
})

test('bot accounts are persisted without credentials', () => {
  const fixture = createDb()
  try {
    const account = fixture.db.createBotAccount({
      id: 'bot-1',
      username: 'bot@example.com',
      botName: 'WarehouseBot1',
      profilesFolder: 'auth-cache/bots/bot-1'
    })
    assert.equal(account.username, 'bot@example.com')
    assert.equal(account.enabled, true)
    assert.equal(Object.hasOwn(account, 'password'), false)
    assert.equal(fixture.db.listBotAccounts().length, 1)
    fixture.db.setBotAccountEnabled('bot-1', false)
    assert.equal(fixture.db.getBotAccount('bot-1').enabled, false)
  } finally {
    fixture.close()
  }
})

test('global aliases keep an explicit display category', () => {
  const fixture = createDb()
  const item = {
    itemKey: 'rocket-flight-3',
    itemId: 'minecraft:firework_rocket',
    displayName: '烟花火箭',
    nbtJson: '',
    metaJson: '{"flight":3}',
    amount: 1
  }
  try {
    fixture.db.addBalanceItems('player-1', [item])
    fixture.db.saveGlobalItemAlias(item.itemKey, '三速烟花', 'variant')
    let alias = fixture.db.listGlobalItemAliases().find(row => row.alias === '三速烟花')
    assert.equal(alias.category, 'variant')
    assert.equal(fixture.db.findItemByGlobalAlias('三速烟花').itemKey, item.itemKey)

    fixture.db.saveGlobalItemAlias(item.itemKey, '三速烟花', 'normal')
    alias = fixture.db.listGlobalItemAliases().find(row => row.alias === '三速烟花')
    assert.equal(alias.category, 'normal')
    assert.throws(() => fixture.db.saveGlobalItemAlias(item.itemKey, '错误分类', 'unknown'), /分类无效/)
  } finally {
    fixture.close()
  }
})

test('web inventory exposes the localized base item name for variant searches', () => {
  const fixture = createDb()
  const books = [
    { itemKey: 'book-unbreaking-1', itemId: 'minecraft:enchanted_book', displayName: '耐久一', nbtJson: '', metaJson: '{}', amount: 2 },
    { itemKey: 'book-efficiency-5', itemId: 'minecraft:enchanted_book', displayName: '效率五', nbtJson: '', metaJson: '{}', amount: 3 }
  ]

  try {
    fixture.db.catalog = {
      getDisplayName: itemId => itemId === 'minecraft:enchanted_book' ? '附魔书' : itemId,
      extractShulkerContents: () => []
    }
    fixture.db.addBalanceItems('player-1', books)

    const inventory = fixture.db.getWebInventory('player-1', 'player-1')
    const enchantedBooks = inventory.items.filter(item => item.itemId === 'minecraft:enchanted_book')

    assert.equal(enchantedBooks.length, 2)
    assert.ok(enchantedBooks.every(item => item.baseDisplayName === '附魔书'))
  } finally {
    fixture.close()
  }
})

test('concurrent transaction records keep the executing bot', async () => {
  const fixture = createDb()
  try {
    await Promise.all([
      fixture.db.runWithBotContext({ botId: 'bot-a', botName: 'WarehouseA' }, async () => {
        await new Promise(resolve => setImmediate(resolve))
        fixture.db.addTransaction('withdraw', 'ok', 'player-1', 'Player1', [], '')
      }),
      fixture.db.runWithBotContext({ botId: 'bot-b', botName: 'WarehouseB' }, async () => {
        fixture.db.addTransaction('deposit', 'ok', 'player-2', 'Player2', [], '')
      })
    ])
    const rows = fixture.db.db.prepare('SELECT type, bot_id AS botId, bot_name AS botName FROM transactions ORDER BY id').all()
    assert.deepEqual(rows, [
      { type: 'deposit', botId: 'bot-b', botName: 'WarehouseB' },
      { type: 'withdraw', botId: 'bot-a', botName: 'WarehouseA' }
    ])
  } finally {
    fixture.close()
  }
})

test('command logs keep source and replies from different bots', async () => {
  const fixture = createDb()
  try {
    const commandLogId = fixture.db.createCommandLog({
      username: 'Player1',
      commandText: '!取 钻石块1',
      channel: 'public',
      receiverBotId: 'bot-a',
      receiverBotName: 'WarehouseA'
    })
    await fixture.db.runWithCommandContext(commandLogId, () => fixture.db.runWithBotContext({ botId: 'bot-b', botName: 'WarehouseB' }, async () => {
      await new Promise(resolve => setImmediate(resolve))
      fixture.db.addCommandReply({ targetUsername: 'Player1', message: '取货完成。' })
    }))
    const result = fixture.db.listCommandLogs({ page: 1, pageSize: 10 })
    assert.equal(result.total, 1)
    assert.equal(result.rows[0].channel, 'public')
    assert.equal(result.rows[0].receiverBotName, 'WarehouseA')
    assert.deepEqual(result.rows[0].replies.map(reply => reply.botName), ['WarehouseB'])
  } finally {
    fixture.close()
  }
})

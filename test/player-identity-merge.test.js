const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const StoreDb = require('../src/db')

function createContext () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-identity-'))
  const config = {
    admins: ['AdminGuy'],
    momoOwner: '__momo__',
    storage: { defaultQuotaSlots: 270, defaultCustomWarehouseQuotaSlots: 270 }
  }
  const db = new StoreDb(path.join(directory, 'store.sqlite'), config)
  const wool = { itemKey: 'minecraft:white_wool|aaaa', itemId: 'minecraft:white_wool', displayName: '白色羊毛', nbtJson: 'null', metaJson: '{}' }
  const glass = { itemKey: 'minecraft:glass|bbbb', itemId: 'minecraft:glass', displayName: '玻璃', nbtJson: 'null', metaJson: '{}' }
  db.upsertItem(wool)
  db.upsertItem(glass)
  return {
    db,
    wool,
    glass,
    directory,
    close: () => {
      db.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

test('mergePlayerIdentities 把双号账本、成员身份、登录密码并入主号', () => {
  const context = createContext()
  const { db } = context

  db.upsertPlayer('uuid-primary', 'TwinGuy')
  db.upsertPlayer('uuid-secondary', 'TwinGuy')

  db.createPersonalWarehouse('uuid-primary', 'TwinGuy', { username: 'admin' })
  db.createCustomWarehouse('VaultA', 'uuid-secondary', 'TwinGuy')
  db.db.prepare("UPDATE custom_warehouse_members SET role = 'member' WHERE player_uuid = 'uuid-secondary' AND warehouse_name_lower = 'vaulta'").run()
  db.setWebLoginToken('uuid-secondary', 'TwinGuy', 'pw-secondary')

  db.addBalanceItems('uuid-primary', [{ ...context.wool, amount: 10 }])
  db.addBalanceItems('uuid-secondary', [
    { ...context.wool, amount: 5 },
    { ...context.glass, amount: 64 }
  ])

  // 老的 web 会话挂在 secondary 上
  db.db.prepare(`
    INSERT INTO web_sessions (session_hash, owner_uuid, username, expires_at, created_at, updated_at)
    VALUES ('hash-1', 'uuid-secondary', 'TwinGuy', 9999999999999, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run()

  const result = db.mergePlayerIdentities('uuid-primary', 'uuid-secondary', 'AdminGuy')

  assert.equal(result.mergedTypes, 2)
  assert.equal(result.mergedAmount, 69)
  assert.equal(db.getBalance('uuid-primary', context.wool.itemKey), 15)
  assert.equal(db.getBalance('uuid-primary', context.glass.itemKey), 64)
  assert.equal(db.getBalance('uuid-secondary', context.wool.itemKey), 0)

  // secondary 的行应该全部消失
  assert.equal(db.db.prepare('SELECT COUNT(*) c FROM balances WHERE owner_uuid = ?').get('uuid-secondary').c, 0)
  assert.equal(db.db.prepare('SELECT COUNT(*) c FROM players WHERE uuid = ?').get('uuid-secondary').c, 0)
  assert.equal(db.db.prepare('SELECT COUNT(*) c FROM web_sessions WHERE owner_uuid = ?').get('uuid-secondary').c, 0)

  // 成员身份改挂主号
  const rows = db.db.prepare('SELECT player_uuid AS uuid, role FROM custom_warehouse_members WHERE warehouse_name_lower = ?').all('vaulta')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].uuid, 'uuid-primary')

  // 登录密码迁移到主号
  const token = db.db.prepare('SELECT owner_uuid AS uuid FROM web_login_tokens WHERE username = ?').get('TwinGuy')
  assert.equal(token.uuid, 'uuid-primary')

  // 事务留痕
  const tx = db.db.prepare('SELECT type, player_uuid AS owner, message FROM transactions ORDER BY id DESC LIMIT 1').get()
  assert.equal(tx.type, 'web_admin_identity_merge')
  assert.equal(tx.owner, 'uuid-primary')
  assert.match(tx.message, /from=uuid-secondary/)

  // 冲突表关闭并留 merged 审计
  const mergedRow = db.db.prepare("SELECT COUNT(*) c FROM wallet_identity_conflicts WHERE status = 'merged' AND real_uuid = ?").get('uuid-primary')
  assert.ok(mergedRow.c >= 1)
  const openRow = db.db.prepare("SELECT COUNT(*) c FROM wallet_identity_conflicts WHERE status = 'open' AND username = ?").get('TwinGuy')
  assert.equal(openRow.c, 0)

  context.close()
})

test('mergePlayerIdentities 两个号都是组织仓库 admin 时保留 admin', () => {
  const context = createContext()
  const { db } = context

  db.upsertPlayer('uuid-primary', 'RoleGuy')
  db.upsertPlayer('uuid-secondary', 'RoleGuy')
  db.createCustomWarehouse('VaultB', 'uuid-primary', 'RoleGuy')
  db.db.prepare("UPDATE custom_warehouse_members SET role = 'member' WHERE player_uuid = 'uuid-primary' AND warehouse_name_lower = 'vaultb'").run()
  db.addCustomWarehouseMember('VaultB', 'uuid-secondary', 'RoleGuy')
  db.db.prepare("UPDATE custom_warehouse_members SET role = 'admin' WHERE player_uuid = 'uuid-secondary' AND warehouse_name_lower = 'vaultb'").run()

  db.mergePlayerIdentities('uuid-primary', 'uuid-secondary', 'AdminGuy')

  const rows = db.db.prepare('SELECT player_uuid AS uuid, role FROM custom_warehouse_members WHERE warehouse_name_lower = ?').all('vaultb')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].uuid, 'uuid-primary')
  assert.equal(rows[0].role, 'admin')

  context.close()
})

test('mergePlayerIdentities 拒绝非法参数', () => {
  const context = createContext()
  const { db } = context
  db.upsertPlayer('uuid-a', 'SoloGuy')

  assert.throws(() => db.mergePlayerIdentities('uuid-a', 'uuid-a'), /相同/)
  assert.throws(() => db.mergePlayerIdentities('uuid-a', 'name:SoloGuy'), /不是真实玩家身份/)
  assert.throws(() => db.mergePlayerIdentities('uuid-a', 'vault:vaulta'), /不是真实玩家身份/)
  assert.throws(() => db.mergePlayerIdentities('uuid-a', 'uuid-missing'), /不存在于玩家表/)

  context.close()
})

test('upsertPlayer 遇到同名另一个真实 UUID 时登记冲突而不自动合并', () => {
  const context = createContext()
  const { db } = context

  db.upsertPlayer('uuid-one', 'ConflictGal')
  db.addBalanceItems('uuid-one', [{ ...context.wool, amount: 7 }])

  // 同名第二个真实 UUID 出现（玩家换启动器后离线 UUID）
  db.upsertPlayer('uuid-two', 'ConflictGal')

  // 两个号都还在，账本没动
  assert.equal(db.getBalance('uuid-one', context.wool.itemKey), 7)
  assert.ok(db.db.prepare('SELECT 1 FROM players WHERE uuid = ?').get('uuid-two'))

  // 冲突已登记
  const conflicts = db.listPlayerIdentityConflicts()
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].username, 'ConflictGal')
  assert.deepEqual(new Set(conflicts[0].uuids), new Set(['uuid-one', 'uuid-two']))
  assert.ok(db.hasIdentityConflict('ConflictGal'))

  // 重复 upsert 不重复登记
  db.upsertPlayer('uuid-two', 'ConflictGal')
  assert.equal(db.listPlayerIdentityConflicts().length, 1)

  // 合并后冲突关闭，canonical 把旧号指到主号
  db.mergePlayerIdentities('uuid-one', 'uuid-two', 'AdminGuy')
  assert.equal(db.listPlayerIdentityConflicts().length, 0)
  assert.equal(db.hasIdentityConflict('ConflictGal'), false)
  assert.equal(db.canonicalPlayerUuid('uuid-two'), 'uuid-one')
  assert.equal(db.canonicalPlayerUuid('uuid-one'), 'uuid-one')

  context.close()
})

test('canonicalPlayerUuid 对未知新号不误绑', () => {
  const context = createContext()
  const { db } = context

  db.upsertPlayer('uuid-main', 'FreshGuy')
  // 全新 UUID（不在 players 表）：保持原样，不能错绑到同名别人号
  assert.equal(db.canonicalPlayerUuid('uuid-brand-new'), 'uuid-brand-new')
  // name: 幽灵号与 vault: 原样返回
  assert.equal(db.canonicalPlayerUuid('name:Ghost'), 'name:Ghost')
  assert.equal(db.canonicalPlayerUuid('vault:vaultx'), 'vault:vaultx')
  assert.equal(db.canonicalPlayerUuid(''), '')

  context.close()
})

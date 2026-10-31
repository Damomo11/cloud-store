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

test('正版 v4 为准：启动自动合并把 v3 离线身份账本并入 v4 并删除 v3', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-identity-auto-'))
  const config = {
    admins: [],
    momoOwner: '__momo__',
    storage: { defaultQuotaSlots: 270, defaultCustomWarehouseQuotaSlots: 270 }
  }

  // 先用普通方式建库并塞入“已分裂”的数据（v4 正版 + v3 离线两个身份）
  const seedDb = new StoreDb(path.join(directory, 'store.sqlite'), config)
  const wool = { itemKey: 'minecraft:white_wool|aaaa', itemId: 'minecraft:white_wool', displayName: '白色羊毛', nbtJson: 'null', metaJson: '{}' }
  const glass = { itemKey: 'minecraft:glass|bbbb', itemId: 'minecraft:glass', displayName: '玻璃', nbtJson: 'null', metaJson: '{}' }
  seedDb.upsertItem(wool)
  seedDb.upsertItem(glass)

  const mojangUuid = 'eea2e783-d003-468b-a831-33d5185cde5e'   // v4 正版
  const offlineUuid = 'b419bf89-1f25-3fd5-bc6a-ede63b0da311'   // v3 离线派生
  seedDb.upsertPlayer(mojangUuid, 'TwinGuy')
  // 旧版本运行时留下的 v3 行：绕过 upsertPlayer 直插（现在的 upsert 会把 v3 改挂 v4）
  seedDb.db.prepare("INSERT INTO players (uuid, username, last_seen_at) VALUES (?, 'TwinGuy', CURRENT_TIMESTAMP)").run(offlineUuid)
  seedDb.createPersonalWarehouse(offlineUuid, 'TwinGuy', { username: 'auto:deposit' })
  seedDb.addBalanceItems(offlineUuid, [{ ...wool, amount: 37 }, { ...glass, amount: 64 }])
  seedDb.addBalanceItems(mojangUuid, [{ ...wool, amount: 8153 }])
  seedDb.setWebLoginToken(mojangUuid, 'TwinGuy', 'pw-main')
  seedDb.close()

  // 重开数据库：构造器里 autoMergeOfflineIdentities 自动执行
  const db = new StoreDb(path.join(directory, 'store.sqlite'), config)

  // v3 行已删，v4 是唯一身份
  assert.equal(db.db.prepare('SELECT COUNT(*) c FROM players WHERE uuid = ?').get(offlineUuid).c, 0)
  const remaining = db.db.prepare('SELECT uuid, username FROM players WHERE lower(username) = lower(?)').all('TwinGuy')
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].uuid, mojangUuid)

  // 账本并入主号：羊毛 8153+37，玻璃 64
  assert.equal(db.getBalance(mojangUuid, wool.itemKey), 8190)
  assert.equal(db.getBalance(mojangUuid, glass.itemKey), 64)

  // 个人仓库也改挂到主号
  assert.ok(db.hasPersonalWarehouse(mojangUuid))
  assert.equal(db.hasPersonalWarehouse(offlineUuid), false)

  // 旧的离线 UUID 再上线会被 canonical 指回主号
  assert.equal(db.canonicalPlayerUuid(offlineUuid), mojangUuid)

  // 幂等：再跑一遍没有可合并的
  assert.equal(db.autoMergeOfflineIdentities().length, 0)
  assert.equal(db.listOfflineUuidPairsToMerge().length, 0)

  db.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

test('没有 v4 主号的 v3 玩家不会被自动合并（避免丢库存）', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-identity-solo-'))
  const config = { admins: [], momoOwner: '__momo__', storage: {} }

  const seedDb = new StoreDb(path.join(directory, 'store.sqlite'), config)
  const sand = { itemKey: 'minecraft:sand|5e0e', itemId: 'minecraft:sand', displayName: '沙子', nbtJson: 'null', metaJson: '{}' }
  seedDb.upsertItem(sand)
  const offlineOnlyUuid = 'b419bf89-1f25-3fd5-bc6a-ede63b0da311'  // v3
  const v4OtherName = 'eea2e783-d003-468b-a831-33d5185cde5e'     // v4 但用户名不同
  seedDb.upsertPlayer(offlineOnlyUuid, 'OfflineOnlyGuy')
  seedDb.upsertPlayer(v4OtherName, 'SomeoneElse')
  seedDb.addBalanceItems(offlineOnlyUuid, [{ ...sand, amount: 100 }])
  seedDb.close()

  const db = new StoreDb(path.join(directory, 'store.sqlite'), config)
  // v3 玩家没有同名 v4 主号：原样保留
  assert.equal(db.listOfflineUuidPairsToMerge().length, 0)
  assert.equal(db.getBalance(offlineOnlyUuid, sand.itemKey), 100)
  assert.ok(db.db.prepare('SELECT 1 FROM players WHERE uuid = ?').get(offlineOnlyUuid))

  db.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

test('v3 离线身份上线不再插回 players 表（修复管理页双仓库复发）', () => {
  const context = createContext()
  const { db } = context
  const mojangUuid = 'eea2e783-d003-468b-a831-33d5185cde5e'   // v4
  const offlineUuid = 'b419bf89-1f25-3fd5-bc6a-ede63b0da311'   // v3 离线派生

  db.upsertPlayer(mojangUuid, 'TwinGuy')
  db.addBalanceItems(mojangUuid, [{ ...context.wool, amount: 100 }])

  // 玩家以 v3 离线身份上线：upsertPlayer 必须改挂 v4，不能原样插入
  db.upsertPlayer(offlineUuid, 'TwinGuy')

  const rows = db.db.prepare('SELECT uuid FROM players WHERE lower(username) = lower(?)').all('TwinGuy').map(row => row.uuid)
  assert.equal(rows.length, 1)
  assert.equal(rows[0], mojangUuid)

  // resolveOfflineUuidToMojang：v3 + 同名 v4 在库 → 返回 v4
  assert.equal(db.resolveOfflineUuidToMojang(offlineUuid, 'TwinGuy'), mojangUuid)
  // canonical + resolveOffline 的组合即 service.getPlayer 的调用链
  assert.equal(db.resolveOfflineUuidToMojang(db.canonicalPlayerUuid(offlineUuid), 'TwinGuy'), mojangUuid)

  // v4 玩家没有 v3 名下余额可丢：v3 从未落库
  assert.equal(db.getBalance(offlineUuid, context.wool.itemKey), 0)
  assert.equal(db.getBalance(mojangUuid, context.wool.itemKey), 100)

  // 没有 v4 主号时 v3 原样返回（不能误挂到别人身上）
  assert.equal(db.resolveOfflineUuidToMojang('c31d3e42-abcd-3efa-bbbb-000000000000', 'NoMainGuy'), 'c31d3e42-abcd-3efa-bbbb-000000000000')

  // 版本位解析回归：v3/v4 正确识别
  assert.equal(db.uuidVersion(offlineUuid), 3)
  assert.equal(db.uuidVersion(mojangUuid), 4)
  assert.equal(db.uuidVersion('name:Ghost'), -1)
  assert.ok(db.isOfflineDerivedUuid(offlineUuid))
  assert.equal(db.isOfflineDerivedUuid(mojangUuid), false)
  assert.equal(db.isOfflineDerivedUuid('name:Ghost'), false)

  context.close()
})

test('历史脏数据：v3 与 v4 都在库时重启自动清回单身份，再上线不复发', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-store-identity-dirty-'))
  const config = { admins: [], momoOwner: '__momo__', storage: {} }

  const mojangUuid = 'eea2e783-d003-468b-a831-33d5185cde5e'
  const offlineUuid = 'b419bf89-1f25-3fd5-bc6a-ede63b0da311'

  // 旧版本运行期间留下的脏数据：两个身份都存在，v3 名下还有库存
  const seedDb = new StoreDb(path.join(directory, 'store.sqlite'), config)
  seedDb.upsertItem(context0Wool())
  seedDb.upsertItem(context0Glass())
  seedDb.upsertPlayer(mojangUuid, 'TwinGuy')
  seedDb.addBalanceItems(mojangUuid, [{ ...context0Wool(), amount: 100 }])
  // 绕过 canonical 直插 v3（模拟旧代码写入）
  seedDb.db.prepare("INSERT INTO players (uuid, username, last_seen_at) VALUES (?, 'TwinGuy', CURRENT_TIMESTAMP)").run(offlineUuid)
  seedDb.createPersonalWarehouse(offlineUuid, 'TwinGuy', { username: 'dirty' })
  seedDb.addBalanceItems(offlineUuid, [{ ...context0Glass(), amount: 64 }])
  seedDb.close()

  // 重开（构造器里自动合并执行）
  const db = new StoreDb(path.join(directory, 'store.sqlite'), config)
  const rows = db.db.prepare('SELECT uuid FROM players WHERE lower(username) = lower(?)').all('TwinGuy').map(row => row.uuid)
  assert.equal(rows.length, 1)
  assert.equal(rows[0], mojangUuid)
  assert.equal(db.getBalance(mojangUuid, context0Wool().itemKey), 100)
  assert.equal(db.getBalance(mojangUuid, context0Glass().itemKey), 64)

  // 合并后 v3 再上线：不复发
  db.upsertPlayer(offlineUuid, 'TwinGuy')
  const rowsAfter = db.db.prepare('SELECT uuid FROM players WHERE lower(username) = lower(?)').all('TwinGuy').map(row => row.uuid)
  assert.equal(rowsAfter.length, 1)
  assert.equal(rowsAfter[0], mojangUuid)

  db.close()
  fs.rmSync(directory, { recursive: true, force: true })

  function context0Wool () { return { itemKey: 'minecraft:white_wool|aaaa', itemId: 'minecraft:white_wool', displayName: '白色羊毛', nbtJson: 'null', metaJson: '{}' } }
  function context0Glass () { return { itemKey: 'minecraft:glass|bbbb', itemId: 'minecraft:glass', displayName: '玻璃', nbtJson: 'null', metaJson: '{}' } }
})

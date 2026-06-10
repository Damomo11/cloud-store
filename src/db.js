const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const Database = require('better-sqlite3')

class StoreDb {
  constructor (dbPath, config) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.config = config
    this.momoOwner = config.momoOwner || '__momo__'
    this.catalog = null
    this.init()
  }

  init () {
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        uuid TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS items (
        item_key TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        nbt_json TEXT NOT NULL DEFAULT '',
        meta_json TEXT NOT NULL DEFAULT '',
        display_name_manual INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS balances (
        owner_uuid TEXT NOT NULL,
        item_key TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner_uuid, item_key),
        FOREIGN KEY (item_key) REFERENCES items(item_key)
      );

      CREATE TABLE IF NOT EXISTS chests (
        chest_id TEXT PRIMARY KEY,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        z INTEGER NOT NULL,
        block_name TEXT NOT NULL,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chest_slots (
        chest_id TEXT NOT NULL,
        slot INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        amount INTEGER NOT NULL,
        PRIMARY KEY (chest_id, slot),
        FOREIGN KEY (chest_id) REFERENCES chests(chest_id) ON DELETE CASCADE,
        FOREIGN KEY (item_key) REFERENCES items(item_key)
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        player_uuid TEXT NOT NULL,
        username TEXT NOT NULL,
        items_json TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS admin_users (
        username_lower TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        uuid TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS player_quotas (
        owner_uuid TEXT PRIMARY KEY,
        quota_slots INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS custom_warehouses (
        name_lower TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        creator_uuid TEXT NOT NULL,
        creator_username TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS custom_warehouse_members (
        warehouse_name_lower TEXT NOT NULL,
        player_uuid TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (warehouse_name_lower, player_uuid),
        FOREIGN KEY (warehouse_name_lower) REFERENCES custom_warehouses(name_lower) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS item_name_overrides (
        short_code TEXT PRIMARY KEY,
        item_key TEXT,
        item_id TEXT,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS item_key_aliases (
        short_code TEXT PRIMARY KEY,
        item_key TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (item_key) REFERENCES items(item_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS shulker_contents (
        shulker_item_key TEXT NOT NULL,
        contained_item_key TEXT NOT NULL,
        contained_item_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        slot_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (shulker_item_key, contained_item_key),
        FOREIGN KEY (shulker_item_key) REFERENCES items(item_key) ON DELETE CASCADE,
        FOREIGN KEY (contained_item_key) REFERENCES items(item_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS web_login_tokens (
        owner_uuid TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_hint TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS inventory_mismatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        owner_uuid TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL DEFAULT '',
        item_key TEXT NOT NULL,
        item_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        nbt_json TEXT NOT NULL DEFAULT '',
        meta_json TEXT NOT NULL DEFAULT '',
        amount INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_items_item_id ON items(item_id);
      CREATE INDEX IF NOT EXISTS idx_balances_item_key ON balances(item_key);
      CREATE INDEX IF NOT EXISTS idx_chest_slots_item_key ON chest_slots(item_key);
      CREATE INDEX IF NOT EXISTS idx_custom_warehouse_members_player ON custom_warehouse_members(player_uuid);
      CREATE INDEX IF NOT EXISTS idx_item_key_aliases_item_key ON item_key_aliases(item_key);
      CREATE INDEX IF NOT EXISTS idx_shulker_contents_contained_key ON shulker_contents(contained_item_key);
      CREATE INDEX IF NOT EXISTS idx_shulker_contents_contained_id ON shulker_contents(contained_item_id);
      CREATE INDEX IF NOT EXISTS idx_web_login_tokens_hash ON web_login_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_inventory_mismatches_status ON inventory_mismatches(status, kind, created_at);
      CREATE INDEX IF NOT EXISTS idx_inventory_mismatches_item_key ON inventory_mismatches(item_key);
    `)

    this.ensureColumn('items', 'display_name_manual', 'INTEGER NOT NULL DEFAULT 0')
    this.migrateManualItemNamesToOverrides()

    for (const username of this.config.admins || []) {
      this.addAdmin(username)
    }

    const cleanup = this.cleanupGhostOwners()
    if (cleanup.invalidQuotas || cleanup.orphanPlayers) {
      console.log(`Cleaned ghost owners: invalid quotas ${cleanup.invalidQuotas}, orphan players ${cleanup.orphanPlayers}`)
    }
  }

  setCatalog (catalog) {
    this.catalog = catalog
    const migrated = this.canonicalizeShulkerItemKeys()
    if (migrated.moved > 0) {
      console.log(`Canonicalized ${migrated.moved} shulker item keys, merged ${migrated.mergedBalances} balance rows`)
    }
    this.rebuildShulkerContentIndex()
  }

  rebuildShulkerContentIndex () {
    if (!this.catalog) return 0
    const rows = this.db.prepare(`
      SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson
      FROM items
      WHERE item_id LIKE '%shulker_box'
    `).all()
    let indexed = 0
    this.transaction(() => {
      for (const row of rows) {
        this.replaceShulkerContentsForItem(row)
        indexed++
      }
    })
    return indexed
  }

  canonicalizeShulkerItemKeys () {
    if (!this.catalog) return { moved: 0, mergedBalances: 0 }

    const rows = this.db.prepare(`
      SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson, display_name_manual AS displayNameManual
      FROM items
      WHERE item_id LIKE '%shulker_box'
      ORDER BY created_at ASC, item_key ASC
    `).all()

    const moves = []
    for (const row of rows) {
      const canonical = this.catalog.canonicalizeStoredItem(row)
      if (!canonical || canonical.itemKey === row.itemKey) continue
      moves.push({ old: row, canonical })
    }

    if (!moves.length) return { moved: 0, mergedBalances: 0 }

    let mergedBalances = 0
    this.transaction(() => {
      this.db.prepare('DELETE FROM shulker_contents').run()

      const insertBalance = this.db.prepare(`
        INSERT INTO balances (owner_uuid, item_key, amount)
        VALUES (?, ?, ?)
        ON CONFLICT(owner_uuid, item_key) DO UPDATE SET
          amount = balances.amount + excluded.amount
      `)
      const oldBalances = this.db.prepare('SELECT owner_uuid AS ownerUuid, amount FROM balances WHERE item_key = ?')
      const deleteOldBalances = this.db.prepare('DELETE FROM balances WHERE item_key = ?')
      const updateSlots = this.db.prepare('UPDATE chest_slots SET item_key = ? WHERE item_key = ?')
      const deleteOldItem = this.db.prepare('DELETE FROM items WHERE item_key = ?')
      const manualOverrideStmt = this.db.prepare(`
        UPDATE item_name_overrides
        SET item_key = COALESCE(item_key, ?),
            item_id = COALESCE(item_id, ?),
            updated_at = CURRENT_TIMESTAMP
        WHERE short_code = ?
      `)

      for (const move of moves) {
        this.upsertItem(move.canonical, { indexShulker: false })

        for (const balance of oldBalances.all(move.old.itemKey)) {
          insertBalance.run(balance.ownerUuid, move.canonical.itemKey, balance.amount)
          mergedBalances++
        }
        deleteOldBalances.run(move.old.itemKey)
        updateSlots.run(move.canonical.itemKey, move.old.itemKey)

        const oldCode = this.shortCodeForItemKey(move.old.itemKey)
        const newCode = this.shortCodeForItemKey(move.canonical.itemKey)
        if (oldCode && oldCode !== newCode) {
          manualOverrideStmt.run(move.canonical.itemKey, move.canonical.itemId, oldCode)
        }

        deleteOldItem.run(move.old.itemKey)
      }
    })

    return { moved: moves.length, mergedBalances }
  }

  ensureColumn (table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)
    if (!columns.includes(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  transaction (fn) {
    return this.db.transaction(fn)()
  }

  cleanupGhostOwners () {
    let invalidQuotas = 0
    let orphanPlayers = 0

    this.transaction(() => {
      invalidQuotas += this.db.prepare(`
        DELETE FROM player_quotas
        WHERE owner_uuid = 'name:momo'
           OR owner_uuid LIKE 'name:仓库:%'
           OR (
             owner_uuid LIKE 'name:%'
             AND lower(substr(owner_uuid, 6)) IN (
               SELECT name_lower FROM custom_warehouses
             )
           )
      `).run().changes

      orphanPlayers += this.db.prepare(`
        DELETE FROM players
        WHERE uuid LIKE 'name:%'
          AND uuid NOT IN (SELECT owner_uuid FROM balances)
          AND uuid NOT IN (SELECT owner_uuid FROM web_login_tokens)
          AND uuid NOT IN (SELECT player_uuid FROM custom_warehouse_members)
          AND uuid NOT IN (SELECT owner_uuid FROM player_quotas)
          AND uuid NOT IN (SELECT COALESCE(uuid, '') FROM admin_users)
      `).run().changes
    })

    return { invalidQuotas, orphanPlayers }
  }

  shortCodeForItemKey (itemKey) {
    const match = String(itemKey || '').match(/\|([0-9a-f]{6})/i)
    return match ? match[1].toLowerCase() : ''
  }

  getItemNameOverride (itemKey) {
    const shortCode = this.shortCodeForItemKey(itemKey)
    if (!shortCode) return null
    return this.db.prepare(`
      SELECT short_code AS shortCode, item_key AS itemKey, item_id AS itemId, display_name AS displayName
      FROM item_name_overrides
      WHERE short_code = ?
    `).get(shortCode) || null
  }

  listItemNameOverrides (query = '') {
    const rows = this.db.prepare(`
      SELECT o.short_code AS shortCode, o.item_key AS itemKey, o.item_id AS itemId,
             o.display_name AS displayName, o.created_at AS createdAt, o.updated_at AS updatedAt,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM item_name_overrides o
      LEFT JOIN items i ON i.item_key = o.item_key
      ORDER BY o.updated_at DESC, o.short_code ASC
    `).all()
    const text = String(query || '').trim().toLowerCase()
    return rows.filter(row => {
      if (!text) return true
      return [row.shortCode, row.itemKey, row.itemId, row.displayName, row.nbtJson, row.metaJson]
        .some(value => String(value || '').toLowerCase().includes(text))
    })
  }

  saveItemNameOverride (itemKey, displayName) {
    const item = this.getItemByKey(itemKey)
    if (!item) throw new Error(`找不到物品：${itemKey}`)
    const shortCode = this.shortCodeForItemKey(itemKey)
    if (!shortCode) throw new Error('这个物品没有 6 位码，无法设置别名。')
    const nextName = String(displayName || '').trim()
    if (!nextName) throw new Error('别名不能为空。')
    if ([...nextName].length > 80) throw new Error('别名不能超过 80 个字。')

    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO item_name_overrides (short_code, item_key, item_id, display_name, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(short_code) DO UPDATE SET
          item_key = excluded.item_key,
          item_id = excluded.item_id,
          display_name = excluded.display_name,
          updated_at = CURRENT_TIMESTAMP
      `).run(shortCode, item.itemKey, item.itemId, nextName)
      this.db.prepare(`
        UPDATE items
        SET display_name = ?, display_name_manual = 1
        WHERE item_key = ?
      `).run(nextName, item.itemKey)
    })

    return { ...item, oldDisplayName: item.displayName, displayName: nextName, shortCode }
  }

  deleteItemNameOverride (shortCode) {
    const code = String(shortCode || '').trim().replace(/^#/, '').toLowerCase()
    if (!/^[0-9a-f]{6}$/.test(code)) throw new Error('短码必须是 6 位十六进制。')
    const row = this.db.prepare(`
      SELECT short_code AS shortCode, item_key AS itemKey
      FROM item_name_overrides
      WHERE short_code = ?
    `).get(code)
    if (!row) return { changed: 0, shortCode: code }

    this.transaction(() => {
      this.db.prepare('DELETE FROM item_name_overrides WHERE short_code = ?').run(code)
      if (row.itemKey) {
        const item = this.getItemByKey(row.itemKey)
        const restored = item && this.catalog
          ? this.catalog.describeStoredItem(item.itemId, item.metaJson, item.nbtJson)
          : null
        if (restored) {
          this.db.prepare(`
            UPDATE items
            SET display_name = ?, display_name_manual = 0
            WHERE item_key = ?
          `).run(restored, row.itemKey)
        } else {
          this.db.prepare(`
            UPDATE items
            SET display_name_manual = 0
            WHERE item_key = ?
          `).run(row.itemKey)
        }
      }
    })

    return { changed: 1, shortCode: code, itemKey: row.itemKey || '' }
  }

  migrateManualItemNamesToOverrides () {
    const rows = this.db.prepare(`
      SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName
      FROM items
      WHERE display_name_manual = 1
    `).all()
    const stmt = this.db.prepare(`
      INSERT INTO item_name_overrides (short_code, item_key, item_id, display_name, updated_at)
      VALUES (@shortCode, @itemKey, @itemId, @displayName, CURRENT_TIMESTAMP)
      ON CONFLICT(short_code) DO UPDATE SET
        item_key = COALESCE(item_name_overrides.item_key, excluded.item_key),
        item_id = COALESCE(item_name_overrides.item_id, excluded.item_id),
        display_name = item_name_overrides.display_name,
        updated_at = CURRENT_TIMESTAMP
    `)
    this.transaction(() => {
      for (const row of rows) {
        const shortCode = this.shortCodeForItemKey(row.itemKey)
        if (!shortCode) continue
        stmt.run({ ...row, shortCode })
      }
    })
  }

  upsertPlayer (uuid, username) {
    this.db.prepare(`
      INSERT INTO players (uuid, username, last_seen_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(uuid) DO UPDATE SET
        username = excluded.username,
        last_seen_at = CURRENT_TIMESTAMP
    `).run(uuid, username)

    this.db.prepare(`
      UPDATE admin_users
      SET uuid = COALESCE(uuid, ?)
      WHERE username_lower = ?
    `).run(uuid, username.toLowerCase())
  }

  hashWebLoginToken (token) {
    return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex')
  }

  generateWebLoginToken (ownerUuid, username) {
    const random = crypto.randomBytes(18).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    const token = `cs-${random}`
    return this.setWebLoginToken(ownerUuid, username, token)
  }

  setWebLoginToken (ownerUuid, username, token) {
    token = String(token || '').trim()
    if (!token) throw new Error('登录密钥不能为空。')
    const tokenHash = this.hashWebLoginToken(token)
    const tokenHint = token.slice(-6)

    this.db.prepare(`
      INSERT INTO web_login_tokens (owner_uuid, username, token_hash, token_hint, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(owner_uuid) DO UPDATE SET
        username = excluded.username,
        token_hash = excluded.token_hash,
        token_hint = excluded.token_hint,
        updated_at = CURRENT_TIMESTAMP
    `).run(ownerUuid, username, tokenHash, tokenHint)

    return { token, tokenHint }
  }

  getWebUserByToken (token) {
    const tokenHash = this.hashWebLoginToken(token)
    const row = this.db.prepare(`
      SELECT owner_uuid AS uuid, username, token_hint AS tokenHint, updated_at AS updatedAt
      FROM web_login_tokens
      WHERE token_hash = ?
      LIMIT 1
    `).get(tokenHash)
    return row || null
  }

  getPlayerByUsername (username) {
    return this.db.prepare(`
      SELECT uuid, username
      FROM players
      WHERE lower(username) = lower(?)
      ORDER BY last_seen_at DESC
      LIMIT 1
    `).get(username) || null
  }

  addAdmin (username, uuid = null) {
    this.db.prepare(`
      INSERT INTO admin_users (username_lower, username, uuid)
      VALUES (?, ?, ?)
      ON CONFLICT(username_lower) DO UPDATE SET
        username = excluded.username,
        uuid = COALESCE(admin_users.uuid, excluded.uuid)
    `).run(username.toLowerCase(), username, uuid)
  }

  isAdmin (username, uuid = null) {
    const row = this.db.prepare(`
      SELECT 1
      FROM admin_users
      WHERE username_lower = ? OR (uuid IS NOT NULL AND uuid = ?)
      LIMIT 1
    `).get(username.toLowerCase(), uuid)
    return Boolean(row)
  }

  normalizeWarehouseName (name) {
    return String(name || '').trim().toLowerCase()
  }

  countWarehousesCreatedBy (creatorUuid) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM custom_warehouses
      WHERE creator_uuid = ?
    `).get(creatorUuid)
    return row.count
  }

  createCustomWarehouse (name, creatorUuid, creatorUsername) {
    const nameLower = this.normalizeWarehouseName(name)
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO custom_warehouses (name_lower, name, creator_uuid, creator_username)
        VALUES (?, ?, ?, ?)
      `).run(nameLower, name, creatorUuid, creatorUsername)

      this.db.prepare(`
        INSERT INTO custom_warehouse_members (warehouse_name_lower, player_uuid, username, role)
        VALUES (?, ?, ?, 'admin')
      `).run(nameLower, creatorUuid, creatorUsername)
    })
  }

  getCustomWarehouse (name) {
    return this.db.prepare(`
      SELECT name_lower AS nameLower, name, creator_uuid AS creatorUuid,
             creator_username AS creatorUsername, created_at AS createdAt
      FROM custom_warehouses
      WHERE name_lower = ?
      LIMIT 1
    `).get(this.normalizeWarehouseName(name)) || null
  }

  listCustomWarehousesForPlayer (playerUuid) {
    return this.db.prepare(`
      SELECT w.name_lower AS nameLower, w.name, w.creator_uuid AS creatorUuid,
             w.creator_username AS creatorUsername, m.role, w.created_at AS createdAt
      FROM custom_warehouse_members m
      JOIN custom_warehouses w ON w.name_lower = m.warehouse_name_lower
      WHERE m.player_uuid = ?
      ORDER BY w.created_at ASC, w.name ASC
    `).all(playerUuid)
  }

  isCustomWarehouseMember (name, playerUuid) {
    const row = this.db.prepare(`
      SELECT 1
      FROM custom_warehouse_members
      WHERE warehouse_name_lower = ? AND player_uuid = ?
      LIMIT 1
    `).get(this.normalizeWarehouseName(name), playerUuid)
    return Boolean(row)
  }

  isCustomWarehouseAdmin (name, playerUuid) {
    const row = this.db.prepare(`
      SELECT 1
      FROM custom_warehouse_members
      WHERE warehouse_name_lower = ? AND player_uuid = ? AND role = 'admin'
      LIMIT 1
    `).get(this.normalizeWarehouseName(name), playerUuid)
    return Boolean(row)
  }

  addCustomWarehouseMember (name, playerUuid, username) {
    this.db.prepare(`
      INSERT INTO custom_warehouse_members (warehouse_name_lower, player_uuid, username, role)
      VALUES (?, ?, ?, 'member')
      ON CONFLICT(warehouse_name_lower, player_uuid) DO UPDATE SET
        username = excluded.username
    `).run(this.normalizeWarehouseName(name), playerUuid, username)
  }

  setCustomWarehouseMemberRole (name, playerUuid, username, role) {
    this.db.prepare(`
      INSERT INTO custom_warehouse_members (warehouse_name_lower, player_uuid, username, role)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(warehouse_name_lower, player_uuid) DO UPDATE SET
        username = excluded.username,
        role = excluded.role
    `).run(this.normalizeWarehouseName(name), playerUuid, username, role)
  }

  setCustomWarehouseMemberRoleIfExists (name, playerUuid, role) {
    return this.db.prepare(`
      UPDATE custom_warehouse_members
      SET role = ?
      WHERE warehouse_name_lower = ? AND player_uuid = ?
    `).run(role, this.normalizeWarehouseName(name), playerUuid).changes
  }

  removeCustomWarehouseMember (name, playerUuid) {
    return this.db.prepare(`
      DELETE FROM custom_warehouse_members
      WHERE warehouse_name_lower = ? AND player_uuid = ? AND role <> 'admin'
    `).run(this.normalizeWarehouseName(name), playerUuid).changes
  }

  listCustomWarehouseMembers (name) {
    return this.db.prepare(`
      SELECT player_uuid AS playerUuid, username, role, added_at AS addedAt
      FROM custom_warehouse_members
      WHERE warehouse_name_lower = ?
      ORDER BY role = 'admin' DESC, username COLLATE NOCASE ASC
    `).all(this.normalizeWarehouseName(name))
  }

  upsertItem (item, options = {}) {
    const override = this.getItemNameOverride(item.itemKey)
    const itemToSave = override ? { ...item, displayName: override.displayName } : item
    this.db.prepare(`
      INSERT INTO items (item_key, item_id, display_name, nbt_json, meta_json)
      VALUES (@itemKey, @itemId, @displayName, @nbtJson, @metaJson)
      ON CONFLICT(item_key) DO UPDATE SET
        display_name = CASE
          WHEN items.display_name_manual = 1 THEN items.display_name
          ELSE excluded.display_name
        END,
        nbt_json = excluded.nbt_json,
      meta_json = excluded.meta_json
    `).run(itemToSave)

    if (override && (!override.itemKey || !override.itemId)) {
      this.db.prepare(`
        UPDATE item_name_overrides
        SET item_key = COALESCE(item_key, ?),
            item_id = COALESCE(item_id, ?),
            updated_at = CURRENT_TIMESTAMP
        WHERE short_code = ?
      `).run(item.itemKey, item.itemId, override.shortCode)
    }

    if (options.indexShulker !== false) {
      this.replaceShulkerContentsForItem(itemToSave)
    }
  }

  replaceShulkerContentsForItem (item) {
    this.db.prepare('DELETE FROM shulker_contents WHERE shulker_item_key = ?').run(item.itemKey)
    if (!this.catalog) return

    const contents = this.catalog.extractShulkerContents(item)
    if (!contents.length) return

    const stmt = this.db.prepare(`
      INSERT INTO shulker_contents (shulker_item_key, contained_item_key, contained_item_id, amount, slot_count)
      VALUES (?, @itemKey, @itemId, @amount, @slotCount)
      ON CONFLICT(shulker_item_key, contained_item_key) DO UPDATE SET
        contained_item_id = excluded.contained_item_id,
        amount = excluded.amount,
        slot_count = excluded.slot_count
    `)

    for (const content of contents) {
      this.upsertItem(content.item, { indexShulker: false })
      stmt.run(item.itemKey, {
        itemKey: content.item.itemKey,
        itemId: content.item.itemId,
        amount: content.amount,
        slotCount: content.slotCount
      })
    }
  }

  refreshItemDisplayNames (catalog) {
    const rows = this.db.prepare(`
      SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson
      FROM items
      WHERE display_name_manual = 0
    `).all()
    const stmt = this.db.prepare('UPDATE items SET display_name = ? WHERE item_key = ?')
    let changed = 0
    this.transaction(() => {
      for (const row of rows) {
        const override = this.getItemNameOverride(row.itemKey)
        const next = override?.displayName || catalog.describeStoredItem(row.itemId, row.metaJson, row.nbtJson)
        if (next && next !== row.displayName) {
          stmt.run(next, row.itemKey)
          changed++
        }
      }
    })
    return changed
  }

  addTransaction (type, status, playerUuid, username, items, message = '') {
    this.db.prepare(`
      INSERT INTO transactions (type, status, player_uuid, username, items_json, message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(type, status, playerUuid, username, JSON.stringify(items), message)
  }

  getBalance (ownerUuid, itemKey) {
    const row = this.db.prepare(`
      SELECT amount FROM balances WHERE owner_uuid = ? AND item_key = ?
    `).get(ownerUuid, itemKey)
    return row ? row.amount : 0
  }

  adjustBalance (ownerUuid, itemKey, delta) {
    const current = this.getBalance(ownerUuid, itemKey)
    const next = current + delta
    if (next < 0) {
      throw new Error(`balance would become negative for ${ownerUuid} ${itemKey}: ${next}`)
    }
    this.db.prepare(`
      INSERT INTO balances (owner_uuid, item_key, amount)
      VALUES (?, ?, ?)
      ON CONFLICT(owner_uuid, item_key) DO UPDATE SET amount = excluded.amount
    `).run(ownerUuid, itemKey, next)
    return next
  }

  addBalanceItems (ownerUuid, items) {
    this.transaction(() => {
      for (const item of items) {
        this.upsertItem(item)
        this.adjustBalance(ownerUuid, item.itemKey, item.amount)
      }
    })
  }

  removeBalanceItems (ownerUuid, items) {
    this.transaction(() => {
      for (const item of items) {
        this.upsertItem(item)
        this.adjustBalance(ownerUuid, item.itemKey, -item.amount)
      }
    })
  }

  getOwnerItemsByItemId (ownerUuid, itemId) {
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid, b.item_key AS itemKey, b.amount,
             i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ? AND i.item_id = ? AND b.amount > 0
      ORDER BY i.nbt_json = '' DESC, i.created_at ASC
    `).all(ownerUuid, itemId)
  }

  getOwnerItemsByItemKey (ownerUuid, itemKey) {
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid, b.item_key AS itemKey, b.amount,
             i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ? AND i.item_key = ? AND b.amount > 0
      ORDER BY i.created_at ASC
    `).all(ownerUuid, itemKey)
  }

  getOwnerBalances (ownerUuid) {
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid, b.item_key AS itemKey, b.amount,
             i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ? AND b.amount > 0
      ORDER BY i.item_id, i.created_at
    `).all(ownerUuid)
  }

  ownerLabel (ownerUuid) {
    if (ownerUuid === this.momoOwner) return 'momo'
    if (ownerUuid.startsWith('vault:')) {
      const row = this.db.prepare('SELECT name FROM custom_warehouses WHERE name_lower = ? LIMIT 1').get(ownerUuid.slice(6))
      return row ? `仓库:${row.name}` : ownerUuid
    }
    if (ownerUuid.startsWith('name:')) return ownerUuid.slice(5)
    const row = this.db.prepare('SELECT username FROM players WHERE uuid = ? LIMIT 1').get(ownerUuid)
    return row?.username || ownerUuid
  }

  ownerTotalAmount (ownerUuid) {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS amount
      FROM balances
      WHERE owner_uuid = ? AND amount > 0
    `).get(ownerUuid)
    return row.amount || 0
  }

  listWebOwnersForUser (user) {
    const isAdmin = this.isAdmin(user.username, user.uuid)
    const owners = []

    if (isAdmin) {
      for (const row of this.db.prepare(`
        SELECT p.uuid, p.username, COALESCE(SUM(b.amount), 0) AS totalAmount
        FROM players p
        JOIN balances b ON b.owner_uuid = p.uuid AND b.amount > 0
        GROUP BY p.uuid
        HAVING totalAmount > 0
        ORDER BY p.username COLLATE NOCASE ASC
      `).all()) {
        owners.push({ ownerUuid: row.uuid, label: row.username, type: 'personal', role: 'admin', totalAmount: row.totalAmount })
      }

      const momoTotal = this.ownerTotalAmount(this.momoOwner)
      if (momoTotal > 0) {
        owners.push({ ownerUuid: this.momoOwner, label: 'momo', type: 'system', role: 'admin', totalAmount: momoTotal })
      }

      for (const row of this.db.prepare(`
        SELECT w.name_lower AS nameLower, w.name, COALESCE(SUM(b.amount), 0) AS totalAmount
        FROM custom_warehouses w
        JOIN balances b ON b.owner_uuid = 'vault:' || w.name_lower AND b.amount > 0
        GROUP BY w.name_lower
        HAVING totalAmount > 0
        ORDER BY w.name COLLATE NOCASE ASC
      `).all()) {
        owners.push({ ownerUuid: `vault:${row.nameLower}`, label: `仓库:${row.name}`, type: 'custom', role: 'admin', totalAmount: row.totalAmount })
      }
      return owners
    }

    owners.push({
      ownerUuid: user.uuid,
      label: user.username,
      type: 'personal',
      role: 'owner',
      totalAmount: this.ownerTotalAmount(user.uuid)
    })

    for (const row of this.db.prepare(`
      SELECT w.name_lower AS nameLower, w.name, m.role, COALESCE(SUM(b.amount), 0) AS totalAmount
      FROM custom_warehouse_members m
      JOIN custom_warehouses w ON w.name_lower = m.warehouse_name_lower
      LEFT JOIN balances b ON b.owner_uuid = 'vault:' || w.name_lower AND b.amount > 0
      WHERE m.player_uuid = ?
      GROUP BY w.name_lower
      HAVING totalAmount > 0
      ORDER BY w.name COLLATE NOCASE ASC
    `).all(user.uuid)) {
      owners.push({ ownerUuid: `vault:${row.nameLower}`, label: `仓库:${row.name}`, type: 'custom', role: row.role, totalAmount: row.totalAmount })
    }

    return owners
  }

  canWebUserAccessOwner (user, ownerUuid) {
    if (this.isAdmin(user.username, user.uuid)) return true
    if (ownerUuid === user.uuid) return true
    if (ownerUuid.startsWith('vault:')) {
      return this.isCustomWarehouseMember(ownerUuid.slice(6), user.uuid)
    }
    return false
  }

  getWebInventory (ownerUuid) {
    const rows = this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid, i.item_key AS itemKey, i.item_id AS itemId,
             i.display_name AS displayName, i.nbt_json AS nbtJson,
             i.meta_json AS metaJson, b.amount
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ? AND b.amount > 0
      ORDER BY i.display_name COLLATE NOCASE ASC, i.item_key ASC
    `).all(ownerUuid)

    const shulkerKeys = rows.filter(row => row.itemId.endsWith('shulker_box')).map(row => row.itemKey)
    const shulkerContents = this.getShulkerContentsByBox(shulkerKeys)
    const totalAmount = rows.reduce((sum, row) => sum + row.amount, 0)

    return {
      ownerUuid,
      ownerLabel: this.ownerLabel(ownerUuid),
      stats: {
        totalAmount,
        itemTypes: rows.length
      },
      items: rows.map(row => ({
        ...this.rowToItem(row),
        amount: row.amount,
        shortCode: this.shortCodeForItemKey(row.itemKey),
        shulkerContents: shulkerContents.get(row.itemKey) || []
      }))
    }
  }

  getShulkerContentsByBox (shulkerKeys) {
    const result = new Map()
    if (!shulkerKeys.length) return result
    const placeholders = shulkerKeys.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT sc.shulker_item_key AS shulkerItemKey,
             sc.amount, sc.slot_count AS slotCount,
             i.item_key AS itemKey, i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM shulker_contents sc
      JOIN items i ON i.item_key = sc.contained_item_key
      WHERE sc.shulker_item_key IN (${placeholders})
      ORDER BY i.display_name COLLATE NOCASE ASC
    `).all(...shulkerKeys)
    for (const row of rows) {
      const item = {
        ...this.rowToItem(row),
        amount: row.amount,
        slotCount: row.slotCount,
        shortCode: this.shortCodeForItemKey(row.itemKey)
      }
      if (!result.has(row.shulkerItemKey)) result.set(row.shulkerItemKey, [])
      result.get(row.shulkerItemKey).push(item)
    }
    return result
  }

  listWebTransactions (ownerUuid, limit = 80) {
    return this.db.prepare(`
      SELECT id, type, status, player_uuid AS playerUuid, username,
             items_json AS itemsJson, message, created_at AS createdAt
      FROM transactions
      WHERE player_uuid = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(ownerUuid, limit).map(row => {
      let items = []
      try {
        items = JSON.parse(row.itemsJson || '[]')
      } catch {
        items = []
      }
      return {
        ...row,
        ownerLabel: this.ownerLabel(row.playerUuid),
        items: items.map(item => ({
          ...item,
          displayName: item.displayName || item.itemId,
          shortCode: this.shortCodeForItemKey(item.itemKey),
          amount: Number(item.amount || 0)
        }))
      }
    })
  }

  getQuotaSlots (ownerUuid, defaultSlots) {
    const row = this.db.prepare(`
      SELECT quota_slots AS quotaSlots
      FROM player_quotas
      WHERE owner_uuid = ?
    `).get(ownerUuid)
    return row ? row.quotaSlots : defaultSlots
  }

  setQuotaSlots (ownerUuid, slots) {
    this.db.prepare(`
      INSERT INTO player_quotas (owner_uuid, quota_slots, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(owner_uuid) DO UPDATE SET
        quota_slots = excluded.quota_slots,
        updated_at = CURRENT_TIMESTAMP
    `).run(ownerUuid, slots)
  }

  getOwnerTotalByItemId (ownerUuid, itemId) {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(b.amount), 0) AS amount
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ? AND i.item_id = ?
    `).get(ownerUuid, itemId)
    return row.amount
  }

  getOwnerTotalByItemKey (ownerUuid, itemKey) {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS amount
      FROM balances
      WHERE owner_uuid = ? AND item_key = ?
    `).get(ownerUuid, itemKey)
    return row.amount
  }

  getOwnerShulkersContainingItemId (ownerUuid, itemId) {
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid,
             sc.shulker_item_key AS shulkerItemKey,
             box.item_id AS shulkerItemId,
             box.display_name AS shulkerDisplayName,
             box.nbt_json AS shulkerNbtJson,
             box.meta_json AS shulkerMetaJson,
             b.amount AS shulkerAmount,
             sc.contained_item_id AS containedItemId,
             GROUP_CONCAT(DISTINCT contained.display_name) AS containedDisplayNames,
             SUM(sc.amount) AS containedAmount,
             SUM(sc.slot_count) AS slotCount,
             SUM(sc.amount) * b.amount AS totalContainedAmount
      FROM shulker_contents sc
      JOIN balances b ON b.item_key = sc.shulker_item_key
      JOIN items box ON box.item_key = sc.shulker_item_key
      JOIN items contained ON contained.item_key = sc.contained_item_key
      WHERE b.owner_uuid = ?
        AND b.amount > 0
        AND sc.contained_item_id = ?
        AND sc.amount > 0
      GROUP BY b.owner_uuid, sc.shulker_item_key
      ORDER BY totalContainedAmount DESC, box.display_name COLLATE NOCASE ASC
    `).all(ownerUuid, itemId)
  }

  getOwnerShulkersContainingItemKey (ownerUuid, itemKey) {
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid,
             sc.shulker_item_key AS shulkerItemKey,
             box.item_id AS shulkerItemId,
             box.display_name AS shulkerDisplayName,
             box.nbt_json AS shulkerNbtJson,
             box.meta_json AS shulkerMetaJson,
             b.amount AS shulkerAmount,
             sc.contained_item_id AS containedItemId,
             contained.display_name AS containedDisplayNames,
             sc.amount AS containedAmount,
             sc.slot_count AS slotCount,
             sc.amount * b.amount AS totalContainedAmount
      FROM shulker_contents sc
      JOIN balances b ON b.item_key = sc.shulker_item_key
      JOIN items box ON box.item_key = sc.shulker_item_key
      JOIN items contained ON contained.item_key = sc.contained_item_key
      WHERE b.owner_uuid = ?
        AND b.amount > 0
        AND sc.contained_item_key = ?
        AND sc.amount > 0
      ORDER BY totalContainedAmount DESC, box.display_name COLLATE NOCASE ASC
    `).all(ownerUuid, itemKey)
  }

  findOwnerShulkersByContainedDisplayQuery (ownerUuid, query) {
    const text = String(query || '').trim()
    if (!text) return []
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid,
             sc.shulker_item_key AS shulkerItemKey,
             box.item_id AS shulkerItemId,
             box.display_name AS shulkerDisplayName,
             box.nbt_json AS shulkerNbtJson,
             box.meta_json AS shulkerMetaJson,
             b.amount AS shulkerAmount,
             sc.contained_item_id AS containedItemId,
             GROUP_CONCAT(DISTINCT contained.display_name) AS containedDisplayNames,
             SUM(sc.amount) AS containedAmount,
             SUM(sc.slot_count) AS slotCount,
             SUM(sc.amount) * b.amount AS totalContainedAmount
      FROM shulker_contents sc
      JOIN balances b ON b.item_key = sc.shulker_item_key
      JOIN items box ON box.item_key = sc.shulker_item_key
      JOIN items contained ON contained.item_key = sc.contained_item_key
      WHERE b.owner_uuid = ?
        AND b.amount > 0
        AND sc.amount > 0
        AND (
          lower(contained.display_name) = lower(?)
          OR lower(contained.display_name) LIKE '%' || lower(?) || '%'
          OR lower(contained.item_id) = lower(?)
        )
      GROUP BY b.owner_uuid, sc.shulker_item_key, sc.contained_item_id
      ORDER BY lower(contained.display_name) = lower(?) DESC,
               totalContainedAmount DESC,
               box.display_name COLLATE NOCASE ASC
      LIMIT 10
    `).all(ownerUuid, text, text, text, text)
  }

  findItemsByDisplayQuery (query) {
    const text = String(query || '').trim()
    if (!text) return []
    return this.db.prepare(`
      SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson
      FROM items
      WHERE lower(display_name) = lower(?)
         OR lower(display_name) LIKE '%' || lower(?) || '%'
         OR lower(item_id) = lower(?)
      ORDER BY lower(display_name) = lower(?) DESC, created_at ASC
      LIMIT 10
    `).all(text, text, text, text)
  }

  findOwnerItemsByDisplayQuery (ownerUuid, query) {
    const text = String(query || '').trim()
    if (!text) return []
    return this.db.prepare(`
      SELECT b.owner_uuid AS ownerUuid, b.item_key AS itemKey, b.amount,
             i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.owner_uuid = ?
        AND b.amount > 0
        AND (
          lower(i.display_name) = lower(?)
          OR lower(i.display_name) LIKE '%' || lower(?) || '%'
          OR lower(i.item_id) = lower(?)
        )
      ORDER BY lower(i.display_name) = lower(?) DESC, i.created_at ASC
      LIMIT 10
    `).all(ownerUuid, text, text, text, text)
  }

  findItemByShortCode (code) {
    const text = String(code || '').trim().replace(/^#/, '').toLowerCase()
    if (!/^[0-9a-f]{6}$/.test(text)) return null
    const rows = this.db.prepare(`
      SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson
      FROM items
      WHERE lower(substr(item_key, instr(item_key, '|') + 1, 6)) = ?
      ORDER BY created_at ASC
      LIMIT 2
    `).all(text)
    if (rows.length === 1) return rows[0]
    if (rows.length > 1) {
      throw new Error(`短码 ${text} 匹配到多个物品，请使用完整 itemKey。`)
    }
    return null
  }

  upsertChest (chest) {
    this.db.prepare(`
      INSERT INTO chests (chest_id, x, y, z, block_name, last_seen_at)
      VALUES (@chestId, @x, @y, @z, @blockName, CURRENT_TIMESTAMP)
      ON CONFLICT(chest_id) DO UPDATE SET
        x = excluded.x,
        y = excluded.y,
        z = excluded.z,
        block_name = excluded.block_name,
        last_seen_at = CURRENT_TIMESTAMP
    `).run(chest)
  }

  listChests () {
    return this.db.prepare(`
      SELECT chest_id AS chestId, x, y, z, block_name AS blockName
      FROM chests
      ORDER BY y, x, z
    `).all()
  }

  listChestSlots () {
    return this.db.prepare(`
      SELECT c.chest_id AS chestId, c.x, c.y, c.z, c.block_name AS blockName,
             cs.slot, cs.item_key AS itemKey, cs.amount
      FROM chests c
      LEFT JOIN chest_slots cs ON cs.chest_id = c.chest_id
      ORDER BY c.y, c.x, c.z, cs.slot
    `).all()
  }

  clearChests () {
    this.transaction(() => {
      this.db.prepare('DELETE FROM chest_slots').run()
      this.db.prepare('DELETE FROM chests').run()
    })
  }

  clearInventoryData () {
    const counts = {
      balances: this.db.prepare('SELECT COUNT(*) AS count FROM balances').get().count,
      chestSlots: this.db.prepare('SELECT COUNT(*) AS count FROM chest_slots').get().count,
      chests: this.db.prepare('SELECT COUNT(*) AS count FROM chests').get().count,
      transactions: this.db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count,
      shulkerContents: this.db.prepare('SELECT COUNT(*) AS count FROM shulker_contents').get().count,
      inventoryMismatches: this.db.prepare('SELECT COUNT(*) AS count FROM inventory_mismatches').get().count,
      items: this.db.prepare('SELECT COUNT(*) AS count FROM items').get().count
    }

    this.transaction(() => {
      this.db.prepare('DELETE FROM shulker_contents').run()
      this.db.prepare('DELETE FROM chest_slots').run()
      this.db.prepare('DELETE FROM chests').run()
      this.db.prepare('DELETE FROM balances').run()
      this.db.prepare('DELETE FROM inventory_mismatches').run()
      this.db.prepare('DELETE FROM transactions').run()
      this.db.prepare('DELETE FROM items').run()
    })

    return counts
  }

  getItemByKey (itemKey) {
    const row = this.db.prepare(`
      SELECT item_key AS itemKey, item_id AS itemId, display_name AS displayName,
             nbt_json AS nbtJson, meta_json AS metaJson
      FROM items
      WHERE item_key = ?
    `).get(itemKey)
    return row || null
  }

  replaceChestSlots (chestId, slots) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM chest_slots WHERE chest_id = ?').run(chestId)
      const stmt = this.db.prepare(`
        INSERT INTO chest_slots (chest_id, slot, item_key, amount)
        VALUES (?, @slot, @itemKey, @amount)
      `)
      for (const slot of slots) {
        this.upsertItem(slot)
        stmt.run(chestId, slot)
      }
    })
  }

  listSlotsForItemKey (itemKey) {
    return this.db.prepare(`
      SELECT cs.chest_id AS chestId, cs.slot, cs.amount,
             c.x, c.y, c.z, c.block_name AS blockName
      FROM chest_slots cs
      JOIN chests c ON c.chest_id = cs.chest_id
      WHERE cs.item_key = ? AND cs.amount > 0
      ORDER BY c.y, c.x, c.z, cs.slot
    `).all(itemKey)
  }

  clearAllWarehouseSlots () {
    this.db.prepare('DELETE FROM chest_slots').run()
  }

  getLedgerTotals () {
    return this.db.prepare(`
      SELECT b.item_key AS itemKey, i.item_id AS itemId, i.display_name AS displayName,
             i.nbt_json AS nbtJson, i.meta_json AS metaJson, SUM(b.amount) AS amount
      FROM balances b
      JOIN items i ON i.item_key = b.item_key
      WHERE b.amount > 0
      GROUP BY b.item_key
    `).all()
  }

  getOwnerLabelForMismatch (ownerUuid) {
    if (!ownerUuid) return ''
    if (ownerUuid === this.momoOwner) return 'momo'
    if (ownerUuid.startsWith('vault:')) {
      const row = this.db.prepare(`
        SELECT name FROM custom_warehouses WHERE name_lower = ? LIMIT 1
      `).get(ownerUuid.slice(6))
      return row ? `仓库:${row.name}` : ownerUuid
    }
    if (ownerUuid.startsWith('name:')) return ownerUuid.slice(5)
    const player = this.db.prepare(`
      SELECT username FROM players WHERE uuid = ? LIMIT 1
    `).get(ownerUuid)
    return player?.username || ownerUuid
  }

  allocateMissingOwners (itemKey, amount) {
    const rows = this.db.prepare(`
      SELECT owner_uuid AS ownerUuid, amount
      FROM balances
      WHERE item_key = ? AND amount > 0 AND owner_uuid <> ?
      ORDER BY owner_uuid LIKE 'vault:%' DESC, owner_uuid COLLATE NOCASE ASC
    `).all(itemKey, this.momoOwner)

    let remaining = amount
    const allocations = []
    for (const row of rows) {
      if (remaining <= 0) break
      const count = Math.min(remaining, row.amount)
      allocations.push({
        ownerUuid: row.ownerUuid,
        username: this.getOwnerLabelForMismatch(row.ownerUuid),
        amount: count
      })
      remaining -= count
    }
    if (remaining > 0) {
      allocations.push({ ownerUuid: '', username: '未知归属', amount: remaining })
    }
    return allocations
  }

  addInventoryMismatch (kind, ownerUuid, username, item, amount, note = '') {
    if (!amount || amount <= 0 || !item?.itemKey) return
    this.upsertItem(this.rowToItem(item))
    this.db.prepare(`
      INSERT INTO inventory_mismatches (
        kind, status, owner_uuid, username, item_key, item_id, display_name,
        nbt_json, meta_json, amount, note
      )
      VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      kind,
      ownerUuid || '',
      username || '',
      item.itemKey,
      item.itemId,
      item.displayName,
      item.nbtJson || '',
      item.metaJson || '',
      amount,
      note
    )
  }

  resolveOpenInventoryMismatches (note = '') {
    return this.db.prepare(`
      UPDATE inventory_mismatches
      SET status = 'resolved',
          resolved_at = CURRENT_TIMESTAMP,
          note = CASE
            WHEN ? = '' THEN note
            WHEN note = '' THEN ?
            ELSE note || '；' || ?
          END
      WHERE status = 'open'
    `).run(note, note, note).changes
  }

  reconcileTotalsToMomo (actualTotals) {
    const ledgerRows = this.getLedgerTotals()
    const ledger = new Map(ledgerRows.map(row => [row.itemKey, row]))
    const actual = new Map(actualTotals.map(row => [row.itemKey, row]))
    const keys = new Set([...ledger.keys(), ...actual.keys()])
    const addedToMomo = []
    const removedFromMomo = []
    const unresolved = []

    this.transaction(() => {
      this.resolveOpenInventoryMismatches('新的同步已刷新库存异常状态。')

      for (const key of keys) {
        const actualRow = actual.get(key)
        const ledgerAmount = ledger.get(key)?.amount || 0
        const actualAmount = actualRow?.amount || 0
        const diff = actualAmount - ledgerAmount
        const item = actualRow || ledger.get(key)

        if (item) this.upsertItem(this.rowToItem(item))

        if (diff > 0) {
          this.adjustBalance(this.momoOwner, key, diff)
          addedToMomo.push({ ...this.rowToItem(item), amount: diff })
        } else if (diff < 0) {
          const missing = Math.abs(diff)
          const momoBalance = this.getBalance(this.momoOwner, key)
          const covered = Math.min(missing, momoBalance)
          if (covered > 0) {
            this.adjustBalance(this.momoOwner, key, -covered)
            removedFromMomo.push({ ...this.rowToItem(item), amount: covered })
          }
          if (covered < missing) {
            const unresolvedAmount = missing - covered
            const missingItem = this.rowToItem(item)
            unresolved.push({ ...missingItem, amount: unresolvedAmount })
            for (const allocation of this.allocateMissingOwners(key, unresolvedAmount)) {
              this.addInventoryMismatch(
                'missing',
                allocation.ownerUuid,
                allocation.username,
                missingItem,
                allocation.amount,
                '同步发现仓库实物少于账本；归属为按账本库存估算，不会自动扣除。'
              )
            }
          }
        }
      }

      for (const item of addedToMomo) {
        this.addInventoryMismatch(
          'extra',
          this.momoOwner,
          'momo',
          item,
          item.amount,
          '同步发现仓库实物多于账本，已自动划入 momo，可在查看器转移给正确归属。'
        )
      }
    })

    return { addedToMomo, removedFromMomo, unresolved }
  }

  rowToItem (row) {
    return {
      itemKey: row.itemKey,
      itemId: row.itemId,
      displayName: row.displayName,
      nbtJson: row.nbtJson || '',
      metaJson: row.metaJson || ''
    }
  }

  close () {
    this.db.close()
  }
}

module.exports = StoreDb

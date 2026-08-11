const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')

const CloudStoreWebServer = require('../src/webServer')

test('admin warehouse management includes quota controls without a separate quota tab', async () => {
  const db = {
    db: {
      prepare: () => ({ run: () => ({ changes: 0 }) })
    }
  }
  const server = new CloudStoreWebServer(db, { web: {} }, () => null)
  const headers = {}
  let html = ''
  const req = { method: 'GET', url: '/', headers: {}, socket: {} }
  const res = {
    setHeader: (name, value) => { headers[name] = value },
    writeHead: (status, responseHeaders) => {
      assert.equal(status, 200)
      Object.assign(headers, responseHeaders)
    },
    end: data => { html = Buffer.from(data).toString('utf8') }
  }

  await server.handle(req, res)

  assert.match(html, /data-admin-tab="warehouses">仓库管理<\/button>/)
  assert.doesNotMatch(html, /data-admin-tab="quotas"|>额度管理<\/button>/)
  const warehousesStart = html.indexOf('<section id="adminWarehouses"')
  const quotasStart = html.indexOf('<h3 class="section-title">仓库容量与额度</h3>')
  const warehousesEnd = html.indexOf('<section id="adminMismatches"')
  assert.ok(warehousesStart >= 0 && quotasStart > warehousesStart && warehousesEnd > quotasStart)
  assert.equal((html.match(/id="adminQuotaTable"/g) || []).length, 1)
  assert.match(html, /\.player-menu \{[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;/)
  assert.match(html, /\.player-option > span:first-child \{[^}]*text-overflow: ellipsis;/)
  assert.match(html, /\.subscription-grid \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(260px, 300px\)\);[^}]*justify-content: start;/)
  assert.match(html, /data-view="subscriptions">◇　订阅<\/button>/)
  assert.match(html, /id="subscriptionsView"/)
  assert.match(html, /data-admin-tab="players">玩家管理<\/button>/)
  assert.match(html, /data-admin-tab="subscriptions">订阅管理<\/button>/)
  assert.match(html, /<h3 class="section-title">全部充值记录<\/h3>/)
  assert.match(html, /if \(entitlement\.quotaMode === 'custom'\) return '自定义版 · '/)
})

test('quota listing includes empty warehouses so their quota can be configured', () => {
  const server = new CloudStoreWebServer({
    db: {
      prepare: sql => {
        if (sql.includes('FROM chests')) return { get: () => ({ count: 0 }) }
        if (sql.includes('FROM chest_slots')) return { get: () => ({ count: 0 }) }
        throw new Error(`Unexpected query: ${sql}`)
      }
    },
    getQuotaSlots: () => 270
  }, { storage: { defaultQuotaSlots: 270 }, warehouse: { containerSlots: 27 } }, () => null)
  server.requireAdmin = () => ({ username: 'admin' })
  server.apiAdminOwners = () => ({ rows: [{ ownerUuid: 'player-1', label: '玩家:空仓库', totalAmount: 0 }] })
  server.adminOwnerUsedSlots = () => 0

  const result = server.apiAdminQuotas({}, new URL('http://localhost/api/admin/quotas'))

  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].quotaSlots, 270)
  assert.equal(result.rows[0].usedSlots, 0)
})

test('rendered browser script is valid JavaScript', async () => {
  const db = {
    db: {
      prepare: () => ({ run: () => ({ changes: 0 }) })
    }
  }
  const server = new CloudStoreWebServer(db, { web: {} }, () => null)
  let html = ''
  const req = { method: 'GET', url: '/', headers: {}, socket: {} }
  const res = {
    setHeader: () => {},
    writeHead: status => assert.equal(status, 200),
    end: data => { html = Buffer.from(data).toString('utf8') }
  }

  await server.handle(req, res)

  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  assert.doesNotThrow(() => new vm.Script(script))
  assert.match(html, /\.tip-grid \{[^}]*grid-template-columns: repeat\(9, minmax\(0, 1fr\)\);[^}]*\}/)
  assert.doesNotMatch(html, /\.tip-grid \{[^}]*overflow:\s*(?:auto|scroll)/)
  assert.match(script, /Math\.max\(0, 27 - shulker\.length\)/)
  assert.doesNotMatch(script, /shulker\.slice\(0, 21\)|种未显示/)
  assert.match(html, /\.tooltip\.locked \{[^}]*pointer-events: auto;/)
  assert.match(script, /data-tip-name=/)
  assert.match(script, /event\.key === 'Control' && !event\.repeat\) lockTip\(\)/)
  assert.match(script, /event\.key === 'Control' && state\.tipLocked\) closeTip\(\)/)
  assert.match(script, /if \(state\.tipLocked\) closeTip\(\)/)
  assert.match(script, /const queue = rows\.filter\(row => visibleKeys\.has\(row\.itemKey\)\);/)
  assert.doesNotMatch(script, /visibleKeys\.has\(row\.itemKey\)\)\.slice\(0, 180\)/)
  assert.match(script, /document\.querySelector\('main'\)\.addEventListener\('scroll', handleInventoryScroll/)
  assert.match(script, /item\.baseDisplayName/)
  assert.match(script, /x\.baseDisplayName/)
  assert.match(script, /state\.adminMismatchRows = new Map\(rows\.map/)
  assert.match(script, /#adminMismatches \[data-admin-card\]/)
  assert.match(script, /bindAdminMismatchTooltips\(\);/)
  assert.match(script, /data-admin-mm-components=/)
  assert.match(script, /openNbtModal\(row\);/)
})

test('admin inventory search matches localized base item names', () => {
  const server = new CloudStoreWebServer({
    catalog: {
      getDisplayName: itemId => itemId === 'minecraft:enchanted_book' ? '附魔书' : itemId
    },
    shortCodeForItemKey: () => 'abc123'
  }, { web: {} }, () => null)
  const item = server.adminItem({
    itemKey: 'book-unbreaking-3',
    itemId: 'minecraft:enchanted_book',
    displayName: '耐久三'
  })

  assert.equal(item.baseDisplayName, '附魔书')
  assert.equal(server.adminItemMatches(item, '附魔书'), true)
})

test('admin inventory applies owner filter before limiting rows', () => {
  let inventorySql = ''
  let inventoryParams = []
  const server = new CloudStoreWebServer({
    db: {
      prepare: sql => {
        if (sql.includes('GROUP BY owner_uuid')) {
          return {
            all: () => [
              { ownerUuid: 'vault:xmc' },
              { ownerUuid: 'vault:锈色' }
            ]
          }
        }
        if (sql.includes('FROM balances b') && sql.includes('JOIN items i') && sql.includes('LIMIT ?')) {
          return {
            all: (...params) => {
              inventorySql = sql
              inventoryParams = params
              return [{
                ownerUuid: 'vault:锈色',
                itemKey: 'minecraft:iron_ingot',
                itemId: 'minecraft:iron_ingot',
                displayName: '铁锭',
                amount: 24978
              }]
            }
          }
        }
        throw new Error(`Unexpected query: ${sql}`)
      }
    },
    ownerLabel: ownerUuid => ownerUuid === 'vault:锈色' ? '仓库:锈色' : ownerUuid,
    shortCodeForItemKey: () => 'abc123',
    getGlobalAliasesForItems: () => new Map(),
    getShulkerContentsByBox: () => new Map()
  }, { web: {} }, () => null)
  server.requireAdmin = () => ({ username: 'admin' })

  const result = server.apiAdminInventory({}, new URL('http://localhost/api/admin/inventory?owner=vault%3A%E9%94%88%E8%89%B2'))

  assert.match(inventorySql, /b\.owner_uuid IN \(\?\)/)
  assert.deepEqual(inventoryParams, ['vault:锈色', 1500])
  assert.equal(result.rows.length, 1)
  assert.equal(result.stats.owners, 1)
  assert.equal(result.stats.itemTypes, 1)
  assert.equal(result.stats.totalAmount, 24978)
})

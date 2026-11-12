const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

test('withdraw pinyin works after a code-only update without the npm package installed', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict')
    const Module = require('node:module')
    const originalLoad = Module._load
    Module._load = function (request, ...args) {
      if (request === 'pinyin-pro' || request.startsWith('pinyin-pro/')) {
        const error = new Error('pinyin-pro is not installed on this deployment')
        error.code = 'MODULE_NOT_FOUND'
        throw error
      }
      return originalLoad.call(this, request, ...args)
    }
    const ItemCatalog = require('./src/itemCatalog')
    const CloudStoreService = require('./src/service')
    const { DEFAULT_CONFIG } = require('./src/config')
    const catalog = new ItemCatalog('1.21.11', {}, { file: 'data/zh_cn.json' })
    const db = {
      findItemByShortCode: () => null,
      findItemByPlayerAlias: () => null,
      findItemByGlobalAlias: () => null,
      isGlobalItemAliasDisabled: () => false,
      findItemsByDisplayQuery: () => []
    }
    const service = new CloudStoreService({ username: 'Bot' }, db, catalog, {}, structuredClone(DEFAULT_CONFIG))
    for (const [name, id] of [
      ['hongshifen', 'redstone'], ['hsk', 'redstone_block'],
      ['hongsk', 'redstone_block'], ['hshikuai', 'redstone_block'],
      ['tntkc', 'tnt_minecart'], ['fengdan', 'wind_charge'],
      ['zuanshigao', 'diamond_pickaxe'], ['yunshanmu', 'spruce_wood'],
      ['lvbaoshi', 'emerald']
    ]) {
      const [item] = service.parseWithdraw(name + '16')
      assert.equal(item.itemId, 'minecraft:' + id)
      assert.equal(item.amount, 16)
    }
    assert.throws(() => service.parseWithdraw('hs'), { code: 'WITHDRAW_PINYIN_AMBIGUOUS' })
  `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

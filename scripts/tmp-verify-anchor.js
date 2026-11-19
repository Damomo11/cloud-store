// 本地模拟锚定扫描：mock db/warehouse/catalog，验证 runPotionAnchorScan 的
// 配对 → 投票 → 冲突检测 → 报告文件逻辑。不连服务器、不动真实数据。
const fs = require('fs')
const path = require('path')

// 已知锚点（模拟线上 server-potions.json 的 12/37）
const knownAnchors = new Map([
  ['long_fire_resistance', 12],
  ['long_invisibility', 37]
])

// 假账本（Servux 字符串档）：
const slots = [
  { chestId: 'A,1,1', x: 1, y: 1, z: 1, blockName: 'barrel', slot: 0, itemKey: 'minecraft:potion|aaa', amount: 1 },
  { chestId: 'A,1,1', x: 1, y: 1, z: 1, blockName: 'barrel', slot: 1, itemKey: 'minecraft:potion|bbb', amount: 1 },
  { chestId: 'B,2,2', x: 2, y: 2, z: 2, blockName: 'barrel', slot: 0, itemKey: 'minecraft:potion|ccc', amount: 1 },
  { chestId: 'B,2,2', x: 2, y: 2, z: 2, blockName: 'barrel', slot: 1, itemKey: 'minecraft:potion|ddd', amount: 1 },
  { chestId: 'C,3,3', x: 3, y: 3, z: 3, blockName: 'barrel', slot: 0, itemKey: 'minecraft:splash_potion|eee', amount: 1 },
  { chestId: 'C,3,3', x: 3, y: 3, z: 3, blockName: 'barrel', slot: 1, itemKey: 'minecraft:potion|fff', amount: 1 },
  { chestId: 'D,4,4', x: 4, y: 4, z: 4, blockName: 'barrel', slot: 3, itemKey: 'minecraft:potion|ggg', amount: 1 },
  { chestId: '9,9,9', x: 9, y: 9, z: 9, blockName: 'stone', slot: 5, itemKey: 'minecraft:stone|zzz', amount: 1 },
  { chestId: 'E,5,5', x: 5, y: 5, z: 5, blockName: 'barrel', slot: 0, itemKey: 'minecraft:potion|hhh', amount: 1 }
]
// itemKey -> Servux 档药水名
const itemsMeta = {
  'minecraft:potion|aaa': { components: [{ type: 'potion_contents', data: { potion: 'minecraft:long_fire_resistance' } }] },
  'minecraft:potion|bbb': { components: [{ type: 'potion_contents', data: { potion: 'minecraft:long_invisibility' } }] },
  'minecraft:potion|ccc': { components: [{ type: 'potion_contents', data: { potion: 'minecraft:poison' } }] },
  'minecraft:potion|ddd': { components: [{ type: 'potion_contents', data: { potion: 'minecraft:poison' } }] },
  'minecraft:splash_potion|eee': { components: [{ type: 'potion_contents', data: { potion: 'minecraft:strength' } }] },
  'minecraft:potion|fff': { components: [{ type: 'potion_contents', data: { potion: 'minecraft:weakness' } }] },
  'minecraft:potion|ggg': { components: [{ type: 'custom_name', data: {} }] }, // 槽3：无 potion_contents
  'minecraft:potion|hhh': { components: [{ type: 'potion_contents', data: { potion: 'minecraft:healing' } }] }
}

// 假开窗物品（数字档）：E 桶开窗抛错模拟网络失败
const openWindows = {
  'A,1,1': [
    { slot: 0, name: 'potion', count: 1, potionId: 12, customEffects: [] },
    { slot: 1, name: 'potion', count: 1, potionId: 37, customEffects: [] },
    { slot: 2, name: 'stone', count: 5 } // 非药水槽跳过
  ],
  'B,2,2': [
    { slot: 0, name: 'potion', count: 1, potionId: 24, customEffects: [] },
    { slot: 1, name: 'potion', count: 1, potionId: 24, customEffects: [] }
  ],
  'C,3,3': [
    { slot: 0, name: 'splash_potion', count: 1, potionId: 40, customEffects: [] },
    { slot: 1, name: 'potion', count: 1, potionId: 40, customEffects: [{ id: 'minecraft:weakness' }] }
  ],
  'D,4,4': [
    { slot: 3, name: 'potion', count: 1, potionId: null, customEffects: null, noComponent: true }
  ],
  'E,5,5': null // 抛错
}

const openedLog = []
const worker = {
  db: {
    listChestSlots: () => slots,
    getItemByKey: key => {
      const meta = itemsMeta[key]
      return meta ? { metaJson: JSON.stringify(meta) } : null
    }
  },
  warehouse: {
    assertConnectionHealthy: () => {},
    openContainerAt: async chest => {
      openedLog.push(chest.chestId)
      if (openWindows[chest.chestId] === null) throw new Error('模拟开窗失败：超时')
      return { id: chest.chestId }
    },
    containerContentItems: container => {
      const list = openWindows[container.id] || []
      return list.map(entry => ({ slot: entry.slot, name: entry.name, count: entry.count, ...entry }))
    },
    closeContainerQuietly: () => {}
  },
  catalog: {
    serverPotionIdByName: knownAnchors,
    fromPrismarineItem: item => ({
      itemKey: `minecraft:${item.name}|fake-${item.potionId ?? 'x'}-${item.slot}`,
      metaJson: JSON.stringify(item.noComponent
        ? { components: [{ type: 'custom_name', data: {} }] }
        : { components: [{ type: 'potion_contents', data: { potionId: item.potionId, customEffects: item.customEffects, customColor: null, customName: null } }] })
    })
  }
}

async function main () {
  const serviceModule = require('../src/service')
  const runScan = serviceModule.prototype.runPotionAnchorScan
  if (typeof runScan !== 'function') throw new Error('runPotionAnchorScan 不存在')

  // —— 场景1：全量扫描（不带单桶参数）——
  const report = await runScan.call(null, worker, null)
  const pass = (label, cond) => { if (!cond) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`) }

  pass('5个药水桶（排除石头桶）', report.chestCount === 5)
  pass('实扫4桶1失败', report.scannedChests === 4 && report.failedChests === 1)
  pass('6对配对（12/37/24x2/40x2）', report.pairCount === 6)
  pass('unknown 1 条（槽3无组件）', report.unknownCount === 1 && report.unknown[0].chestId === 'D,4,4')
  pass('4 种唯一药水', report.anchors.length === 4)
  pass('新锚点 2 个（24/40），12/37 为已锚', report.newAnchorCount === 2)
  pass('12 已锚不为新', report.anchors.find(a => a.potionId === 12).isNew === false)
  pass('24=poison 2票', (() => { const a = report.anchors.find(a => a.potionId === 24); return a.name === 'poison' && a.votes === 2 })())
  pass('40 有冲突1组（strength vs weakness 各1票）', report.conflicts.length === 1 && report.conflicts[0].potionId === 40)
  pass('40 top 为二者其一', ['strength', 'weakness'].includes(report.anchors.find(a => a.potionId === 40).name))
  pass('报告文件已写', fs.existsSync(path.resolve(process.cwd(), 'data/potion-anchor-scan.json')))
  pass('pairs 里 customEffects 数量', (() => {
    const p = report.pairs.find(p => p.openPotionId === 40 && p.slot === 1)
    return p.openCustomEffects === 1
  })())
  const written = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/potion-anchor-scan.json'), 'utf8'))
  pass('写盘报告 anchors 与返回一致', written.anchors.length === 4 && written.newAnchorCount === 2)

  // —— 场景2：单桶过滤（只扫 C,3,3）——
  const reportSingle = await runScan.call(null, worker, { x: 3, y: 3, z: 3 })
  pass('单桶模式只扫 C,3,3', reportSingle.chestCount === 1 && reportSingle.scannedChests === 1)
  pass('单桶配对 2 槽', reportSingle.pairCount === 2)

  // —— 场景3：单桶坐标无匹配 ——
  let missed = null
  try { await runScan.call(null, worker, { x: 100, y: 100, z: 100 }) } catch (e) { missed = e }
  pass('无匹配坐标抛错', missed && /没有坐标/.test(missed.message))

  // —— 场景4：没有药水桶 ——
  const emptyWorker = { ...worker, db: { ...worker.db, listChestSlots: () => [] } }
  let noChests = null
  try { await runScan.call(null, emptyWorker, null) } catch (e) { noChests = e }
  pass('无药水桶时抛错', noChests && /没有药水桶/.test(noChests.message))

  console.log('\n全部场景 PASS ✔')
}

main().then(() => {
  const p = path.resolve(process.cwd(), 'data/potion-anchor-scan.json')
  if (fs.existsSync(p)) fs.unlinkSync(p)
  console.log('（已清理测试报告文件）')
  process.exit(0)
}).catch(error => {
  console.error('VERIFY-FAIL:', error)
  const p = path.resolve(process.cwd(), 'data/potion-anchor-scan.json')
  if (fs.existsSync(p)) fs.unlinkSync(p)
  process.exit(1)
})

// 从 ViaFabricPlus-Mortis 源码自带的 Via 数据（identifiers NBT）解码 26.1/26.2/26.3
// 注册表 id 对照，生成 26.3 伪版本所需的增量数据（items/blocks/entities/组件表）。
// 用法：node scripts/gen-via-26x.js
// 产物：data/via/26.3/*.json（src/via.js 运行时读取，不依赖 D:\SSS）

const fs = require('node:fs')
const path = require('node:path')
const nbt = require('prismarine-nbt')

const VIA_ASSETS = 'D:/SSS/ViaFabricPlus-ver-1.21.11/build/decomp/vv/assets/viaversion/data'
const VFP_ROOT = 'D:/SSS/ViaFabricPlus-ver-1.21.11'
const OUT_DIR = path.join(__dirname, '..', 'data', 'via', '26.3')

async function readNbt (file) {
  const buf = fs.readFileSync(path.join(VIA_ASSETS, file))
  // Via 的 NBT 是未压缩的（文件头 0A 00 00）；parse 返回 { parsed, type }
  const { parsed } = await nbt.parse(buf)
  return nbt.simplify(parsed)
}

// Via identifiers NBT 的 val 解码（MappingDataLoader.java:190-295）
// strategy 0：zigzag-varint 差分累加，size 条 → values[i]
// strategy 1：位移对 (at 差分 varint, to 差分 zigzag-varint) → 分段线性展开
// strategy 2：改动点对（未实现：当前数据未用到）
// strategy 3：恒等映射
function decodeMapping (entry) {
  const size = entry.size
  const strategy = entry.id
  if (strategy === 3) return Array.from({ length: size }, (_, i) => i)
  const bytes = Uint8Array.from(entry.val.map(b => b & 0xff))
  let pos = 0
  const readVarint = () => {
    let value = 0
    let shift = 0
    while (pos < bytes.length) {
      const b = bytes[pos++]
      value |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) return value >>> 0
      shift += 7
    }
    throw new Error('varint 越界')
  }
  const readZigzag = () => {
    const v = readVarint()
    return (v >>> 1) ^ -(v & 1)
  }

  if (strategy === 0) {
    const out = []
    let prev = 0
    for (let i = 0; i < size; i++) {
      prev += readZigzag()
      out.push(prev)
    }
    return out
  }
  if (strategy === 1 || strategy === 2) {
    const at = []
    const to = []
    let prevAt = -1
    let prevTo = 0
    while (pos < bytes.length) {
      prevAt = prevAt + 1 + readVarint()
      prevTo = prevTo + readZigzag()
      at.push(prevAt)
      to.push(prevTo)
    }
    const out = new Array(size)
    if (strategy === 1) {
      let mappedId = 0
      let nextId = 0
      // 首段 [0, at[0]) 恒等（MappingDataLoader L218-224）
      for (; nextId < at[0]; nextId++) out[nextId] = mappedId++
      for (let i = 0; i < at.length; i++) {
        const end = i === at.length - 1 ? size : at[i + 1]
        mappedId = to[i]
        for (let id = at[i]; id < end; id++) out[id] = mappedId++
      }
    } else {
      // strategy 2：改动点 + 中间恒等填充（nofill 默认 false）
      out.fill(-1)
      let nextUnhandled = 0
      for (let i = 0; i < at.length; i++) {
        for (let id = nextUnhandled; id < at[i]; id++) out[id] = id
        nextUnhandled = at[i] + 1
        out[at[i]] = to[i]
      }
      for (let id = nextUnhandled; id < size; id++) out[id] = id
    }
    return out
  }
  throw new Error(`未知 strategy: ${strategy}`)
}

// 解某个版本的某注册表：返回数组（下标=本版本 id，值=全局名）
function decodeRegistry (versionNbt, global, registryName) {
  const entry = versionNbt[registryName]
  const globalTable = global[registryName]
  if (!entry || !Array.isArray(globalTable)) return null
  const ids = decodeMapping(entry)
  return ids.map(globalId => (globalId >= 0 && globalId < globalTable.length ? globalTable[globalId] : null))
}

async function main () {
  const global = await readNbt('identifier-table.nbt')
  const v261 = await readNbt('identifiers-26.1.nbt')
  const v262 = await readNbt('identifiers-26.2.nbt')
  const v263 = await readNbt('identifiers-26.3.nbt')

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const report = {}

  for (const registryName of ['items', 'blocks', 'entities', 'data_component_type', 'particles', 'sounds', 'attributes']) {
    const t261 = decodeRegistry(v261, global, registryName)
    const t263 = decodeRegistry(v263, global, registryName)
    if (!t261 || !t263) {
      report[registryName] = '缺少注册表，跳过'
      continue
    }
    const out = {
      version: '26.3',
      registry: registryName,
      names263: t263, // 下标 = 26.3 协议 id，值 = 全局名（无 minecraft: 前缀）
      names261: t261, // 26.1 侧同编码（用于与 minecraft-data 26.1 数据对齐）
      count261: t261.length,
      count263: t263.length
    }
    fs.writeFileSync(path.join(OUT_DIR, `${registryName}.json`), JSON.stringify(out))
    const added = t263.filter(n => !t261.includes(n)).length
    report[registryName] = `26.1=${t261.length} → 26.3=${t263.length}（新增 ${added}）`
  }

  // ===== mappings NBT：解码 26.1→26.2→26.3 的 id 链式映射（blockStates 等）=====
  async function readMappings () {
    const m12 = await readNbt('mappings-26.1to26.2.nbt')
    const m23 = await readNbt('mappings-26.2to26.3.nbt')
    return { m12, m23 }
  }
  const { m12, m23 } = await readMappings()
  const chainOut = {}
  for (const key of Object.keys(m12)) {
    const a = m12[key]
    const b = m23[key]
    if (!a || !b) continue
    if (!a.size || (!a.val && a.id !== 3) || !b.size || (!b.val && b.id !== 3)) continue // tags 等非 id 映射跳过
    // 两跳映射：旧 id → [26.2 id] → [26.3 id]；-1 = 已删除
    // 注意 decodeMapping 数组长度=旧侧 size，新侧总数用 max+1 估
    const step1 = decodeMapping(a)
    const step2 = decodeMapping(b)
    const chain = step1.map((mid) => (mid >= 0 && mid < step2.length ? step2[mid] : -1))
    const chainTo = Math.max(...step2) + 1
    chainOut[key] = { chainFrom: step1.length, chainTo, map: chain }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'id-chain-26.1-to-26.3.json'), JSON.stringify({
    version: '26.3',
    note: '下标 = 26.1 id，值 = 26.3 id（-1 = 该 id 在 26.3 已删除/合并）',
    registries: chainOut
  }))
  const chainReport = {}
  for (const [k, v] of Object.entries(chainOut)) {
    const moved = v.map.filter((m, i) => m !== i && m !== -1).length
    chainReport[k] = `26.1=${v.map.length} → 26.3=${v.chainTo}，位移 ${moved} 条`
  }
  report['id链式映射'] = chainReport

  // ===== 新方块的状态段：链式映射值域之外的 id = 新状态（空洞位置本身即真实位置），
  // 归属按 26.3 客户端 Blocks.java 的真实注册序认领（backport-ids.json 的文件键序 ≠ 注册序，
  // 2026-11 审计发现旧逻辑把 sulfur 分到 poplar_planks 的 27 号段、全表 118 块错位）=====
  const backport = JSON.parse(fs.readFileSync(
    path.join(VFP_ROOT, 'src', 'main', 'resources', 'assets', 'viafabricplus', 'data', 'backport-ids.json'),
    'utf8'
  ))
  const bsChain = chainOut.blockstates
  const used = new Set(bsChain.map.filter(v => v >= 0))
  const totalStates = bsChain.chainTo
  const freeIds = []
  for (let id = 0; id < totalStates; id++) if (!used.has(id)) freeIds.push(id)
  const newBlocks = backport['26.3'].block_states || {}
  const registrationOrder = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'new-block-registration-order.json'), 'utf8'
  )).order
  const missing = newBlocks && Object.keys(newBlocks).filter(n => !registrationOrder.includes(n))
  const extra = registrationOrder.filter(n => !(n in newBlocks))
  if (!newBlocks || missing.length || extra.length) {
    throw new Error(`[gen-via-26x] 新方块集合与真实注册序不一致 missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}，26.x 版本变了？需重新提取 scripts/new-block-registration-order.json`)
  }
  const assign = {}
  let cursor = 0
  for (const name of registrationOrder) {
    const states = newBlocks[name]
    // backport 的 states 数组长度 = 该方块状态数；按真实注册序连续认领空闲段
    const count = Math.max(1, states.length)
    assign[name] = { count, firstStateId: freeIds[cursor] ?? -1 }
    // 认领的段必须全部是空洞，否则说明注册序或状态数与真实表不符
    for (let i = 0; i < count; i++) {
      const id = freeIds[cursor + i]
      if (id === undefined || used.has(id)) {
        throw new Error(`[gen-via-26x] ${name} 认领的状态段 ${freeIds[cursor]}+${i} 与真实链映射冲突，注册序/状态数需人工核对`)
      }
    }
    cursor += count
  }
  fs.writeFileSync(path.join(OUT_DIR, 'new-block-states.json'), JSON.stringify({
    totalStates,
    freeCount: freeIds.length,
    assigned: cursor,
    blocks: assign
  }))
  report['新方块状态段'] = `空闲 ${freeIds.length} 个，按真实注册序分配 ${cursor} 个${cursor === freeIds.length ? '（吻合）' : '（!不吻合，需人工核对）'}`

  // ===== 新方块真实属性（hardness/noCollision/noOcclusion）：scripts/new-block-props-source.json，
  // 从 26.3 客户端 Blocks.java 反编译提取（2026-11 审计）。校验集合与生成的新方块一致后写入运行时数据 =====
  const blockPropsSource = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'new-block-props-source.json'), 'utf8'
  ))
  const propNames = Object.keys(blockPropsSource)
  const propMissing = propNames.filter(n => !(n in newBlocks))
  const propExtra = Object.keys(newBlocks).filter(n => !propNames.includes(n))
  if (propMissing.length || propExtra.length) {
    throw new Error(`[gen-via-26x] 新方块属性表与 backport-ids 不一致 missing=${JSON.stringify(propMissing)} extra=${JSON.stringify(propExtra)}，需重新提取`)
  }
  fs.writeFileSync(path.join(OUT_DIR, 'new-block-props.json'), JSON.stringify({
    note: '26.3 真实方块属性（26.3 客户端 Blocks.java）；noCollision/noOcclusion 决定 boundingBox/transparent',
    blocks: blockPropsSource
  }))
  report['新方块属性'] = `${propNames.length} 条（hardness/noCollision/noOcclusion）`

  // ===== 26.3 新物品/新方块中文翻译：从 Mortis 语言文件合并进 bot 的 data/zh_cn.json =====
  const vfpLangDir = path.join(VFP_ROOT, 'src', 'main', 'resources', 'assets', 'viafabricplus', 'lang')
  const mortisZh = JSON.parse(fs.readFileSync(path.join(vfpLangDir, 'zh_cn.json'), 'utf8'))
  const zhCnPath = path.join(__dirname, '..', 'data', 'zh_cn.json')
  const botZh = JSON.parse(fs.readFileSync(zhCnPath, 'utf8'))
  let addedZh = 0
  const itemNames263 = decodeRegistry(v263, global, 'items')
  const blockNames263 = decodeRegistry(v263, global, 'blocks')
  const wanted = new Set()
  for (const name of itemNames263) wanted.add(`item.minecraft.${name}`)
  for (const name of blockNames263) wanted.add(`block.minecraft.${name}`)
  for (const key of wanted) {
    if (botZh[key] !== undefined) continue
    const localized = mortisZh[key]
    if (localized === undefined) continue
    botZh[key] = localized
    addedZh++
  }
  fs.writeFileSync(zhCnPath, JSON.stringify(botZh, null, 2))
  report['中文翻译合并'] = `Mortis zh_cn 494 条中为 26.3 新内容新增 ${addedZh} 条进 data/zh_cn.json`

  // 与 minecraft-data 26.1 的 items 对齐校验：名字→id 应一致
  const mcData261 = require('minecraft-data')('26.1')
  const item263 = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'items.json'), 'utf8'))
  let mismatch = 0
  let checked = 0
  for (let id = 0; id < item263.names261.length; id++) {
    const name = item263.names261[id]
    const known = mcData261.itemsArray.find(it => it.id === id)
    if (known && known.name !== name) mismatch++
    checked++
  }
  report['id对齐校验'] = `抽查 ${checked} 条，不一致 ${mismatch} 条${mismatch === 0 ? '（Via NBT 与 minecraft-data 26.1 id 编码一致）' : '（!需要人工核对）'}`

  console.log('[gen-via-26x]', JSON.stringify(report, null, 2))
  console.log('[gen-via-26x] 产物目录:', OUT_DIR)
}

main()

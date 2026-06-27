const fs = require('node:fs')
const path = require('node:path')
const nbt = require('prismarine-nbt')
const mcDataLoader = require('minecraft-data')
const { loadOptionalConfig } = require('../src/config')

function unwrap (value) {
  return value?.value ?? value
}

function unsigned64 (value) {
  const big = BigInt(value)
  return big < 0n ? big + (1n << 64n) : big
}

function plainCompound (compound) {
  const raw = unwrap(compound) || {}
  const result = {}
  for (const [key, value] of Object.entries(raw)) result[key] = unwrap(value)
  return result
}

function paletteEntry (entry) {
  const value = unwrap(entry)
  return {
    name: unwrap(value.Name),
    properties: value.Properties ? plainCompound(value.Properties) : {}
  }
}

function stateKey (entry) {
  const keys = Object.keys(entry.properties || {}).sort()
  if (!keys.length) return entry.name
  return `${entry.name}[${keys.map(key => `${key}=${entry.properties[key]}`).join(',')}]`
}

function decodeBlockStateIndexes (longs, bitsPerEntry, volume) {
  const mask = (1n << BigInt(bitsPerEntry)) - 1n
  const indexes = []

  for (let index = 0; index < volume; index++) {
    const bitIndex = index * bitsPerEntry
    const longIndex = Math.floor(bitIndex / 64)
    const startOffset = bitIndex % 64
    let value = unsigned64(longs[longIndex]) >> BigInt(startOffset)

    if (startOffset + bitsPerEntry > 64) {
      value |= unsigned64(longs[longIndex + 1]) << BigInt(64 - startOffset)
    }

    indexes.push(Number(value & mask))
  }

  return indexes
}

function loadLanguage (languageFile) {
  if (!languageFile) return {}
  try {
    return JSON.parse(fs.readFileSync(languageFile, 'utf8'))
  } catch {
    return {}
  }
}

function displayNameForBlock (blockId, language = {}) {
  const key = blockId.replace(/^minecraft:/, '')
  return language[`block.minecraft.${key}`] || language[`item.minecraft.${key}`] || blockId
}

const BLOCK_ITEM_ALIASES = new Map([
  ['redstone_wire', 'redstone'],
  ['tripwire', 'string'],
  ['wall_torch', 'torch'],
  ['soul_wall_torch', 'soul_torch'],
  ['redstone_wall_torch', 'redstone_torch']
])

function itemIdForBlockId (blockId, mcData) {
  const name = blockId.replace(/^minecraft:/, '')
  const directAlias = BLOCK_ITEM_ALIASES.get(name)
  if (directAlias && mcData.itemsByName[directAlias]) return `minecraft:${directAlias}`
  if (/_wall_fan$/.test(name)) {
    const fanName = name.replace('_wall_fan', '_fan')
    if (mcData.itemsByName[fanName]) return `minecraft:${fanName}`
  }
  if (/_wall_sign$/.test(name)) {
    const signName = name.replace('_wall_sign', '_sign')
    if (mcData.itemsByName[signName]) return `minecraft:${signName}`
  }
  if (/_wall_hanging_sign$/.test(name)) {
    const signName = name.replace('_wall_hanging_sign', '_hanging_sign')
    if (mcData.itemsByName[signName]) return `minecraft:${signName}`
  }
  if (/_wall_banner$/.test(name)) {
    const bannerName = name.replace('_wall_banner', '_banner')
    if (mcData.itemsByName[bannerName]) return `minecraft:${bannerName}`
  }
  return mcData.itemsByName[name] ? blockId : null
}

function stackSizeForItemId (itemId, mcData) {
  const name = String(itemId || '').replace(/^minecraft:/, '')
  return mcData.itemsByName[name]?.stackSize || 64
}

async function parseLitematicData (data, options = {}) {
  const { parsed } = await nbt.parse(data)
  const root = parsed.value
  const regions = root.Regions?.value || {}
  const regionNames = Object.keys(regions)
  const mcData = mcDataLoader(options.version || '1.21.1')
  const language = loadLanguage(options.languageFile)

  const materials = new Map()
  const states = new Map()
  const nonItemBlocks = new Map()
  const metadata = root.Metadata?.value || {}
  let totalVolume = 0
  let totalBlocks = 0

  for (const regionName of regionNames) {
    const region = regions[regionName].value
    const size = plainCompound(region.Size)
    const volume = Math.abs(Number(size.x || 0) * Number(size.y || 0) * Number(size.z || 0))
    totalVolume += volume

    const palette = (unwrap(region.BlockStatePalette).value || unwrap(region.BlockStatePalette)).map(paletteEntry)
    const bitsPerEntry = Math.max(2, Math.ceil(Math.log2(Math.max(1, palette.length))))
    const indexes = decodeBlockStateIndexes(unwrap(region.BlockStates), bitsPerEntry, volume)

    for (const paletteIndex of indexes) {
      const entry = palette[paletteIndex]
      if (!entry || entry.name === 'minecraft:air') continue

      totalBlocks += 1
      const key = stateKey(entry)
      states.set(key, (states.get(key) || 0) + 1)

      const itemId = itemIdForBlockId(entry.name, mcData)
      if (!itemId) {
        nonItemBlocks.set(entry.name, (nonItemBlocks.get(entry.name) || 0) + 1)
        continue
      }

      const current = materials.get(itemId) || {
        itemId,
        blockId: entry.name,
        displayName: displayNameForBlock(itemId, language),
        amount: 0,
        stackSize: stackSizeForItemId(itemId, mcData)
      }
      current.amount += 1
      materials.set(itemId, current)
    }
  }

  const rows = [...materials.values()]
    .map(row => ({
      ...row,
      slots: Math.ceil(row.amount / Math.max(1, row.stackSize))
    }))
    .sort((a, b) => b.amount - a.amount || a.displayName.localeCompare(b.displayName, 'zh-CN'))

  const unavailable = [...nonItemBlocks.entries()]
    .map(([blockId, amount]) => ({
      blockId,
      displayName: displayNameForBlock(blockId, language),
      amount
    }))
    .sort((a, b) => b.amount - a.amount || a.displayName.localeCompare(b.displayName, 'zh-CN'))

  return {
    file: options.filePath || '',
    name: unwrap(metadata.Name) || (options.filePath ? path.basename(options.filePath) : 'uploaded.litematic'),
    author: unwrap(metadata.Author) || '',
    litematicVersion: unwrap(root.Version),
    minecraftDataVersion: unwrap(root.MinecraftDataVersion),
    regionCount: regionNames.length,
    totalVolume: unwrap(metadata.TotalVolume) || totalVolume,
    totalBlocks: unwrap(metadata.TotalBlocks) || totalBlocks,
    materialAmount: rows.reduce((sum, row) => sum + row.amount, 0),
    requiredSlots: rows.reduce((sum, row) => sum + row.slots, 0),
    overBotInventory: rows.reduce((sum, row) => sum + row.slots, 0) > (options.maxSlots || 36),
    maxSlots: options.maxSlots || 36,
    materials: rows,
    unavailable,
    states: [...states.entries()]
      .map(([key, amount]) => ({ key, amount }))
      .sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key))
  }
}

async function parseLitematicMaterials (filePath, options = {}) {
  const data = fs.readFileSync(filePath)
  return parseLitematicData(data, { ...options, filePath })
}

async function main () {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('用法：node scripts/litematic-materials.js <文件.litematic> [--json]')
    process.exit(1)
  }

  const config = loadOptionalConfig(path.resolve(process.cwd(), 'config.json'), {})
  const result = await parseLitematicMaterials(path.resolve(filePath), {
    version: config.server?.version || '1.21.1',
    languageFile: path.resolve(process.cwd(), config.language?.file || 'data/zh_cn.json'),
    maxSlots: 36
  })

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`蓝图：${result.name}${result.author ? ` / ${result.author}` : ''}`)
  console.log(`方块：${result.totalBlocks}，可准备材料：${result.materialAmount}，预计占用格数：${result.requiredSlots}/${result.maxSlots}`)
  console.log('')
  console.log('材料清单：')
  for (const row of result.materials) {
    console.log(`- ${row.displayName} x${row.amount} (${row.itemId}, ${row.slots}格)`)
  }
  if (result.unavailable.length) {
    console.log('')
    console.log('不可直接作为物品准备的状态方块：')
    for (const row of result.unavailable) {
      console.log(`- ${row.displayName} x${row.amount} (${row.blockId})`)
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error)
    process.exit(1)
  })
}

module.exports = {
  parseLitematicData,
  parseLitematicMaterials
}

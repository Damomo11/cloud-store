// 26.x（26.1/26.2/26.3）的 ChunkColumn 适配：
// prismarine-chunk 最高只支持 1.21，而 26.1 起每个 section 在 nonAir 计数后多了一个
// fluidCount SHORT（Via ChunkType26_1；26.2/26.3 区块格式未再变化）。本文件基于
// prismarine-chunk 的 1.18 实现（26.x 与 1.21.11 的 section 调色板结构一致），派生一个
// 在 section 解析时跳过 fluidCount 的 ChunkColumn，并注册进 prismarine-chunk 的
// require.cache loader，mineflayer 的 blocks 插件即可正常工作。
// 依据：ViaFabricPlus-Mortis 源码（ChunkType26_1 用于 26.x 双向转译，26.2/26.3 沿用）。

'use strict'

const path = require('node:path')

const SmartBuffer = require('smart-buffer').SmartBuffer

// prismarine-chunk 内部实现（无 exports 限制，按绝对路径 require 绕过）
const chunkRoot = path.dirname(require.resolve('prismarine-chunk/package.json'))
const chunkFactory = require(path.join(chunkRoot, 'src', 'pc', '1.18', 'chunk'))
const ChunkSectionBase = require(path.join(chunkRoot, 'src', 'pc', 'common', 'PaletteChunkSection'))
const BiomeSection = require(path.join(chunkRoot, 'src', 'pc', 'common', 'PaletteBiome'))
const paletteContainer = require(path.join(chunkRoot, 'src', 'pc', 'common', 'PaletteContainer'))
const varInt = require(path.join(chunkRoot, 'src', 'pc', 'common', 'varInt'))
const constants = require(path.join(chunkRoot, 'src', 'pc', 'common', 'constants'))
const { SingleValueContainer, IndirectPaletteContainer, DirectPaletteContainer } = paletteContainer

// 26.x 的 section 读：solidBlockCount SHORT + fluidCount SHORT + 调色板。
// 复刻 PaletteChunkSection.read（99-147 行），仅多读一个 fluidCount SHORT。
class ChunkSection26 extends ChunkSectionBase {
  static read (smartBuffer, maxBitsPerBlock = constants.GLOBAL_BITS_PER_BLOCK, noSizePrefix) {
    const solidBlockCount = smartBuffer.readInt16BE()
    smartBuffer.readInt16BE() // fluidCount：26.x 独有，bot 不消费
    const bitsPerBlock = smartBuffer.readUInt8()
    if (bitsPerBlock > 16) throw new Error(`Bits per block is too big: ${bitsPerBlock}`)
    // Case 1: Single Value Container（整段同值）
    if (bitsPerBlock === 0) {
      const section = new this({
        noSizePrefix,
        solidBlockCount,
        singleValue: varInt.read(smartBuffer),
        maxBitsPerBlock
      })
      if (!noSizePrefix) smartBuffer.readUInt8()
      return section
    }
    // Case 2: Direct Palette（全局调色板）
    if (bitsPerBlock > constants.MAX_BITS_PER_BLOCK) {
      return new this({
        noSizePrefix,
        solidBlockCount,
        data: new DirectPaletteContainer({
          noSizePrefix,
          bitsPerValue: maxBitsPerBlock,
          capacity: constants.BLOCK_SECTION_VOLUME
        }).readBuffer(smartBuffer, bitsPerBlock)
      })
    }
    // Case 3: Indirect Palette（局部调色板）
    const palette = []
    const paletteLength = varInt.read(smartBuffer)
    for (let i = 0; i < paletteLength; ++i) {
      palette.push(varInt.read(smartBuffer))
    }
    return new this({
      noSizePrefix,
      solidBlockCount,
      data: new IndirectPaletteContainer({
        noSizePrefix,
        bitsPerValue: bitsPerBlock,
        capacity: constants.BLOCK_SECTION_VOLUME,
        maxBits: constants.MAX_BITS_PER_BLOCK,
        maxBitsPerBlock,
        palette
      }).readBuffer(smartBuffer, bitsPerBlock)
    })
  }
}

// 26.x 的 ChunkColumn：继承 1.18 实现，仅重写 section 二进制解析
function build26ChunkColumn (registry) {
  const BaseChunkColumn = chunkFactory(registry)
  const noSizePrefix = registry.version['>=']('1.21.5')

  return class ChunkColumn26 extends BaseChunkColumn {
    static get section () { return ChunkSection26 }

    load (data) {
      const reader = SmartBuffer.fromBuffer(data)
      for (let i = 0; i < this.numSections; ++i) {
        this.sections[i] = ChunkSection26.read(reader, this.maxBitsPerBlock, noSizePrefix)
        this.biomes[i] = BiomeSection.read(reader, this.maxBitsPerBiome, noSizePrefix)
      }
    }
  }
}

// 把 26.x 注册进 prismarine-chunk 的 loader（替换 require.cache 的 exports，
// 保持原函数对非 26.x 版本透传）。必须在 mineflayer 首次 require prismarine-chunk
// 之前调用——via 的 activate 在 index.js 顶部，时机满足。
let installed = false

function installChunk26 () {
  if (installed) return
  installed = true
  const chunkPath = require.resolve('prismarine-chunk')
  if (!require.cache[chunkPath]) require(chunkPath) // 确保 cache 存在
  const chunkMod = require.cache[chunkPath]
  const origLoader = chunkMod.exports

  function loader26 (registryOrVersion) {
    const registry = typeof registryOrVersion === 'string'
      ? require('prismarine-registry')(registryOrVersion)
      : registryOrVersion
    const majorVersion = registry.version?.majorVersion
    if (majorVersion === '26.1' || majorVersion === '26.2' || majorVersion === '26.3') {
      return build26ChunkColumn(registry)
    }
    return origLoader(registryOrVersion)
  }
  Object.assign(loader26, origLoader) // 保留 BlobEntry/BlobType 等附加导出
  chunkMod.exports = loader26
}

module.exports = { installChunk26 }

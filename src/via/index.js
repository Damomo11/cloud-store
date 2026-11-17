// cloud-store 的 via 模块：把 minecraft-data 注入一个"26.3 伪版本"，
// 让 mineflayer 以 26.3（协议号 777，Via ProtocolVersion.java:75 对齐）直连 26.3 fabric 服。
//
// 数据依据：scripts/gen-via-26x.js 从 ViaFabricPlus-Mortis 4.4.15 自带的 identifiers/mappings
// NBT 解码（data/via/26.3/），protocol 手术依据 decomp 的 ViaVersion 5.12.2 差异层。
//
// 用法：必须在 require('mineflayer') 之前调用 activate()——
// mineflayer/lib/loader.js 在加载时解构 version.js 的 latestSupportedVersion，
// 晚了就补不进去。index.js 顶部第一时间调用。

'use strict'

const path = require('node:path')

// 独立于包 exports 拿到 minecraft-data 的 data.js（内部未导出）
function requireMcDataIndex () {
  const pkgDir = path.dirname(require.resolve('minecraft-data/package.json'))
  return require(path.join(pkgDir, 'data.js'))
}

let activated = false

function activate () {
  if (activated) return
  activated = true

  const dataIndex = requireMcDataIndex()
  if (dataIndex.pc['26.3']) return // 已注入过（例如热重载）

  const base261 = dataIndex.pc['26.1']
  if (!base261) throw new Error('[via] minecraft-data 里没有 26.1 基础数据，无法构建 26.3 伪版本')

  const built = require('./build').build263(base261)
  dataIndex.pc['26.3'] = built

  // prismarine-chunk 注册 26.x 区块实现（26.1 起 section 多一个 fluidCount SHORT）
  require('./chunk-26').installChunk26()

  // prismarine-physics 特性表补 26.x（不然 Physics() 抛 No liquid gravity settings）
  require('./physics-features').installPhysics26()

  // mineflayer 的版本边界检查（lib/version.js → lib/loader.js 解构）放行 26.3
  try {
    const mfPkgDir = path.dirname(require.resolve('mineflayer/package.json'))
    const version = require(path.join(mfPkgDir, 'lib', 'version.js'))
    if (!version.testedVersions.includes('26.3')) version.testedVersions.push('26.3')
    version.latestSupportedVersion = '26.3'
    version.oldestSupportedVersion = version.oldestSupportedVersion
  } catch (e) {
    // mineflayer 还没装/路径变化：抛错早失败，避免带着没放行的边界上线
    throw new Error('[via] 无法 patch mineflayer 版本表：' + e.message)
  }
}

module.exports = { activate }

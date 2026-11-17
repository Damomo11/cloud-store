// prismarine-physics 的特性表按 majorVersion 字符串硬匹配（lib/features.json），
// 不走 minecraft-data 的版本比较，26.x 不在表里 → Physics() 直接抛
// "No liquid gravity settings"，连带 mineflayer 插件注入循环中断。
//
// JSON 模块的缓存导出是共享引用：往 require(...) 拿到的数组里 push 即可生效，
// 与 prismarine-physics 是否已被加载无关（它顶层 require 的是同一个对象）。
//
// 26.x 物理特性与 1.21 对齐：
//   proportionalLiquidGravity —— 水/岩浆重力为普通重力的 1/16、1/4（比例制）
//   climbUsingJump            —— 按住跳跃键可攀爬梯子/藤蔓
//   （velocityBlocksOnTop / climbableTrapdoor 到 1.20 为止，1.21 已移除，26.x 同样不加）

'use strict'

const MAJOR_VERSIONS_26X = ['26.1', '26.2', '26.3']

// 与 1.21 保持一致的特性名
const FEATURES_FROM_121 = ['proportionalLiquidGravity', 'climbUsingJump']

let installed = false

function installPhysics26 () {
  if (installed) return
  installed = true

  const features = require(require.resolve('prismarine-physics/lib/features.json'))

  let patched = 0
  for (const feature of features) {
    if (!FEATURES_FROM_121.includes(feature.name)) continue
    for (const v of MAJOR_VERSIONS_26X) {
      if (!feature.versions.includes(v)) {
        feature.versions.push(v)
        patched++
      }
    }
  }

  if (patched === 0) {
    // 一条都没补上：要么表结构变了，要么已被手动改过——确认表还是老样子
    const has121 = features.some(f => f.name === 'proportionalLiquidGravity' && f.versions.includes('26.3'))
    if (!has121) throw new Error('[via] prismarine-physics features.json 结构异常，26.x 特性补不上')
  }
}

module.exports = { installPhysics26 }

'use strict'

// Terrain adapters ported from OlelaBot's movement plugin.
// Keep flight, harvesting and station execution outside warehouse navigation.
const { snowDescriptor, supportHeightWithSnow, classifySurfaceTransition, standingClearanceObstructions } = require('./snow-surface')
const { getClimbableController, resolveVineClimbSupport } = require('./climbables')
const { isPassableDoor } = require('./trapdoor-passage')
const DIAGONAL_DIG_TRACE = process.env.BOT_DIAGONAL_DIG_TRACE === '1'
const DIAGONAL_DIG_TRACE_LIMIT = 500
const CLIMB_TRACE = process.env.BOT_CLIMB_TRACE === '1'
const CLIMB_TRACE_LIMIT = 500

function isWaterLikeName (name) {
  if (typeof name !== 'string') return false
  return name === 'water' || name === 'flowing_water' || name === 'bubble_column' ||
    name === 'kelp' || name === 'kelp_plant' || name === 'seagrass' || name === 'tall_seagrass'
}

function patchFastGetBlock (moves, bot, tag) {
  const Vec3 = require('vec3')
  // 原始 Block 缓存(供 exclusionStep 读 boundingBox / 供描述符构建)
  const rawCache = new Map()
  const rawAt = (x, y, z) => {
    const key = x + ',' + y + ',' + z
    let b = rawCache.get(key)
    if (b !== undefined) return b
    b = bot.blockAt(new Vec3(x, y, z), false) || null
    if (rawCache.size > 300000) rawCache.clear()
    rawCache.set(key, b)
    return b
  }
  // 已算好的"寻路方块描述符"缓存:命中直接拷贝返回,不再重算 Set.has/shapes/门雪毯分类。
  // 描述符是 immutable 模板;getBlock 每次返回一份浅拷贝,让调用方能安全改 height(getMoveJumpUp 的 +=1)不污染缓存。
  const tmplCache = new Map()
  moves._pathBlockCacheEpoch = 0
  const clear = () => {
    if (rawCache.size) rawCache.clear()
    if (tmplCache.size) tmplCache.clear()
    moves._pathBlockCacheEpoch += 1
  }
  bot.on('blockUpdate', clear)
  bot.on('chunkColumnLoad', clear)
  bot.on('chunkColumnUnload', clear)
  bot.on('respawn', clear)
  bot.on('end', clear)
  moves._rawBlockAt = rawAt

  const stub = (dy) => ({ replaceable: false, canFall: false, safe: false, physical: false, liquid: false, climbable: false, height: dy, openable: false, _properties: Object.freeze({}) })

  // 构建某坐标的描述符模板(只在首次访问时算一次)。返回 null 表示该格无方块。
  const buildTemplate = (bx, by, bz) => {
    const b = rawAt(bx, by, bz)
    if (!b) return null
    const climbable = moves.climbables.has(b.type)
    let safe = (b.boundingBox === 'empty' || climbable || moves.carpets.has(b.type)) && !moves.blocksToAvoid.has(b.type)
    let physical = b.boundingBox === 'block' && !moves.fences.has(b.type)
    let replaceable = moves.replaceables.has(b.type) && !physical
    const liquid = moves.liquids.has(b.type)
    const canFall = moves.gravityBlocks.has(b.type)
    const openable = moves.openable.has(b.type)
    let properties = {}
    try { properties = { ...(b.getProperties?.() || {}) } } catch (_) { /* retain empty properties */ }
    properties = Object.freeze(properties)
    let height = by
    const shapes = b.shapes
    if (shapes && shapes.length) {
      for (let i = 0; i < shapes.length; i++) { const sh = by + shapes[i][4]; if (sh > height) height = sh }
    }
    const name = b.name
    if (isPassableDoor(b)) { safe = true; physical = false }
    else if (name === 'snow') {
      const snow = snowDescriptor(b, by)
      safe = snow.safe
      physical = snow.physical
      replaceable = snow.replaceable
      height = snow.height
    } else if (isCarpetName(name)) {
      const below = rawAt(bx, by - 1, bz)
      if (below && isCarpetName(below.name)) { safe = false; physical = false } else { safe = true; physical = false }
    }

    if (physical && b.boundingBox === 'block' && name !== 'snow') {
      const above = rawAt(bx, by + 1, bz)
      height = supportHeightWithSnow(height, by, above)
    }

    // 挖掘所需字段必须一并带上：canDig=true 时 pathfinder 的 safeOrBreak 会调
    // bestHarvestTool(block) 与 block.digTime(...)。描述符是普通对象、没有 Block 原型，
    // 缺这几项会直接 `block.digTime is not a function` 把整个 bot 进程打挂（真服实测）。
    // digTime 绑定到原始 Block 上，与调用方可能改写的 height 无关，可安全按模板复用。
    // 原始 Block 极少数情况下没有 digTime（未知方块 / 版本差异）。此时给一个"很贵"的常量，
    // 让 A* 视为几乎不可破坏，而不是让整个进程崩掉。
    const digTime = typeof b.digTime === 'function'
      ? (...args) => b.digTime(...args)
      : () => 60_000
    return {
      type: b.type,
      name,
      boundingBox: b.boundingBox,
      position: b.position,
      shapes,
      climbable,
      safe,
      physical,
      replaceable,
      liquid,
      canFall,
      openable,
      height,
      _properties: properties,
      material: b.material,
      harvestTools: b.harvestTools,
      hardness: b.hardness,
      digTime,
    }
  }

  moves.getBlock = function (pos, dx, dy, dz) {
    if (!pos) return stub(dy)
    const bx = pos.x + dx
    const by = pos.y + dy
    const bz = pos.z + dz
    const key = bx + ',' + by + ',' + bz
    let t = tmplCache.get(key)
    if (t === undefined) { t = buildTemplate(bx, by, bz); tmplCache.set(key, t) }
    if (t === null) return stub(dy)
    // 浅拷贝返回(调用方可安全改 height 等,不污染模板)
    return {
      type: t.type,
      name: t.name,
      boundingBox: t.boundingBox,
      position: t.position,
      shapes: t.shapes,
      climbable: t.climbable,
      safe: t.safe,
      physical: t.physical,
      replaceable: t.replaceable,
      liquid: t.liquid,
      canFall: t.canFall,
      openable: t.openable,
      height: t.height,
      _properties: t._properties,
      material: t.material,
      harvestTools: t.harvestTools,
      hardness: t.hardness,
      digTime: t.digTime,
    }
  }

  patchSnowSurfaceEdges(moves, rawAt)

  console.log(`${tag} getBlock 已 patch (描述符缓存:命中直接拷贝,免重算 Set.has/shapes/门雪毯;blockUpdate/chunkLoad 失效)`)
}

function configureGroundHazards (moves, bot, tag) {
  const powderSnow = bot.registry?.blocksByName?.powder_snow
  if (!powderSnow || !moves?.blocksToAvoid) return false
  moves.blocksToAvoid.add(powderSnow.id)
  console.log(`${tag} 地面危险方块已配置 (powder_snow=hard_avoid)`)
  return true
}

function patchSnowSurfaceEdges (moves, rawAt) {
  const originalForward = moves.getMoveForward.bind(moves)
  const originalJumpUp = moves.getMoveJumpUp.bind(moves)
  const originalDiagonal = moves.getMoveDiagonal.bind(moves)

  const columnHasSnow = (x, z, minY, maxY) => {
    for (let y = minY; y <= maxY; y++) {
      if (rawAt(x, y, z)?.name === 'snow') return true
    }
    return false
  }

  const standingSurface = (self, node, dx, dz, nodeYOffset = 0) => {
    const below = self.getBlock(node, dx, nodeYOffset - 1, dz)
    const feet = self.getBlock(node, dx, nodeYOffset, dz)
    return feet?.name === 'snow' ? Math.max(below.height, feet.height) : below.height
  }

  const touchesSnow = (node, dx, dz, maxYOffset = 1) => {
    const minY = node.y - 1
    const maxY = node.y + maxYOffset
    return columnHasSnow(node.x, node.z, minY, maxY) ||
      columnHasSnow(node.x + dx, node.z + dz, minY, maxY)
  }

  const assess = (node, dx, dz, sourceHeight, targetHeight) => {
    const transition = classifySurfaceTransition(sourceHeight, targetHeight)
    if (!transition.allowed) return { ...transition, loaded: true, obstructions: [] }
    const standing = standingClearanceObstructions(
      rawAt,
      node.x + dx + 0.5,
      node.z + dz + 0.5,
      targetHeight
    )
    if (!Array.isArray(standing)) return { ...transition, loaded: false, obstructions: [] }
    const needsFractionalHop = Math.abs(transition.rise) > 0.05 && Math.abs(transition.rise) <= 0.5
    const hop = needsFractionalHop
      ? standingClearanceObstructions(
          rawAt,
          node.x + dx + 0.5,
          node.z + dz + 0.5,
          Math.max(sourceHeight, targetHeight) + 0.42
        )
      : []
    if (!Array.isArray(hop)) return { ...transition, loaded: false, obstructions: [] }
    const combined = new Map()
    for (const block of [...standing, ...hop]) {
      const p = block.position
      combined.set(`${p.x},${p.y},${p.z}`, block)
    }
    return {
      ...transition,
      loaded: true,
      obstructions: [...combined.values()]
    }
  }

  const clearanceBreaks = (self, obstructions) => {
    if (!Array.isArray(obstructions) || obstructions.length === 0) {
      return { allowed: true, required: new Map() }
    }
    if (!self.canDig) return { allowed: false, required: new Map() }
    const required = new Map()
    for (const rawBlock of obstructions) {
      const block = self.getBlock(rawBlock.position, 0, 0, 0)
      const pending = []
      const cost = self.safeOrBreak(block, pending)
      if (cost >= 100 || pending.length === 0) return { allowed: false, required: new Map() }
      for (const pos of pending) {
        const key = `${pos.x},${pos.y},${pos.z}`
        if (!required.has(key)) required.set(key, { pos, cost })
      }
    }
    return { allowed: true, required }
  }

  const mergeClearanceBreaks = (neighbors, start, required) => {
    if (!(required instanceof Map) || required.size === 0) return
    for (let i = start; i < neighbors.length; i++) {
      const edge = neighbors[i]
      const existing = new Set((edge.toBreak || []).map(pos => `${pos.x},${pos.y},${pos.z}`))
      for (const [key, entry] of required) {
        if (existing.has(key)) continue
        edge.toBreak.push(entry.pos)
        edge.cost += entry.cost
        existing.add(key)
      }
    }
  }

  const markEdges = (neighbors, start, assessment, targetHeight, addJumpCost, snowSurface) => {
    for (let i = start; i < neighbors.length; i++) {
      const edge = neighbors[i]
      edge.surfaceY = targetHeight
      edge.plannedSurfaceY = targetHeight
      if (snowSurface) edge.snowSurface = true
      if (assessment.requiresJump) {
        edge.requiresJump = true
        if (addJumpCost) edge.cost += 1
      }
      if (assessment.rise < -0.5) edge.requiresLanding = true
    }
  }

  const diagonalSweepObstructions = (node, dir, sourceHeight, targetHeight) => {
    const obstructions = new Map()
    const samples = 8
    for (let i = 0; i <= samples; i++) {
      const t = i / samples
      const centerX = node.x + 0.5 + dir.x * t
      const centerZ = node.z + 0.5 + dir.z * t
      const surface = sourceHeight + (targetHeight - sourceHeight) * t
      const sample = standingClearanceObstructions(rawAt, centerX, centerZ, surface)
      if (!Array.isArray(sample)) return null
      for (const block of sample) {
        const p = block.position
        obstructions.set(`${p.x},${p.y},${p.z}`, block)
      }
    }
    return [...obstructions.values()]
  }

  moves.getMoveForward = function (node, dir, neighbors) {
    if (!touchesSnow(node, dir.x, dir.z)) return originalForward(node, dir, neighbors)
    const sourceHeight = standingSurface(this, node, 0, 0)
    const targetHeight = standingSurface(this, node, dir.x, dir.z)
    const assessment = assess(node, dir.x, dir.z, sourceHeight, targetHeight)
    if (!assessment.allowed || !assessment.loaded) return
    const clearance = clearanceBreaks(this, assessment.obstructions)
    if (!clearance.allowed) return

    const start = neighbors.length
    originalForward(node, dir, neighbors)
    mergeClearanceBreaks(neighbors, start, clearance.required)
    const targetSnow = this.getBlock(node, dir.x, 0, dir.z)?.name === 'snow'
    markEdges(neighbors, start, assessment, targetHeight, true, targetSnow)
  }

  moves.getMoveJumpUp = function (node, dir, neighbors) {
    if (!touchesSnow(node, dir.x, dir.z, 2)) return originalJumpUp(node, dir, neighbors)
    const sourceHeight = standingSurface(this, node, 0, 0)
    const targetBlock = this.getBlock(node, dir.x, 0, dir.z)
    const targetHeight = targetBlock.height
    const assessment = assess(node, dir.x, dir.z, sourceHeight, targetHeight)
    if (!assessment.allowed || !assessment.loaded) return
    const clearance = clearanceBreaks(this, assessment.obstructions)
    if (!clearance.allowed) return

    const start = neighbors.length
    originalJumpUp(node, dir, neighbors)
    mergeClearanceBreaks(neighbors, start, clearance.required)
    const jumpAssessment = { ...assessment, requiresJump: true }
    markEdges(neighbors, start, jumpAssessment, targetHeight, false, targetBlock?.name === 'snow')
  }

  moves.getMoveDiagonal = function (node, dir, neighbors) {
    // Y+2 is a conservative precheck. If it contains snow but the actual
    // diagonal stays flat, the second check below preserves the old behavior.
    if (!touchesSnow(node, dir.x, dir.z, 2)) return originalDiagonal(node, dir, neighbors)
    const blockC = this.getBlock(node, dir.x, 0, dir.z)
    const y = blockC.physical ? 1 : 0
    if (!touchesSnow(node, dir.x, dir.z, y + 1)) return originalDiagonal(node, dir, neighbors)
    const sourceHeight = standingSurface(this, node, 0, 0)
    const targetHeight = y === 1 ? blockC.height : standingSurface(this, node, dir.x, dir.z)
    const assessment = assess(node, dir.x, dir.z, sourceHeight, targetHeight)
    if (!assessment.allowed || !assessment.loaded) return
    const sweep = diagonalSweepObstructions(node, dir, sourceHeight, targetHeight)
    if (!Array.isArray(sweep)) return
    const combined = new Map()
    for (const block of [...assessment.obstructions, ...sweep]) {
      const p = block.position
      combined.set(`${p.x},${p.y},${p.z}`, block)
    }
    const clearance = clearanceBreaks(this, [...combined.values()])
    if (!clearance.allowed) return

    const start = neighbors.length
    originalDiagonal(node, dir, neighbors)
    mergeClearanceBreaks(neighbors, start, clearance.required)
    const targetSnow = this.getBlock(node, dir.x, y, dir.z)?.name === 'snow'
    markEdges(neighbors, start, assessment, targetHeight, assessment.requiresJump && y === 0, targetSnow)
  }
}

function patchDiagonalCornerSafety (moves, tag) {
  const original = moves.getMoveDiagonal.bind(moves)
  const stats = {
    calls: 0,
    emitted: 0,
    rejectedRise: 0,
    rejectedDoor: 0,
    rejectedUnsafeNoDig: 0,
    rejectedUnbreakable: 0,
    breakableEnvelope: 0,
    addedBreakBlocks: 0,
    traceLines: 0
  }
  moves._diagonalCornerDebugSnapshot = () => ({ ...stats })

  const posKey = (p) => p ? `${p.x},${p.y},${p.z}` : '?'
  const blockLabel = (block) => block
    ? `${block.name || '?'}@${posKey(block.position)} safe=${!!block.safe} physical=${!!block.physical}`
    : '?'
  const trace = (reason, node, dir, detail = '') => {
    if (!DIAGONAL_DIG_TRACE || stats.traceLines >= DIAGONAL_DIG_TRACE_LIMIT) return
    stats.traceLines += 1
    console.log(
      `${tag} [diag-dig] diagonal ${reason} from=(${node.x},${node.y},${node.z}) ` +
      `dir=(${dir.x},${dir.z}) canDig=${!!moves.canDig}${detail ? ` ${detail}` : ''}`
    )
  }

  moves.getMoveDiagonal = function (node, dir, neighbors) {
    stats.calls += 1
    const blockC = this.getBlock(node, dir.x, 0, dir.z)
    const y = blockC.physical ? 1 : 0  // 跟原版一致:目标格实在则斜跳上(y=1)否则平移(y=0)

    // Diagonal jump-up is substantially less tolerant than a flat diagonal:
    // the 0.6-wide hitbox can hit either target face before its feet clear the
    // upper surface. Keep flat diagonals, but split rises into cardinal moves.
    if (y === 1) {
      stats.rejectedRise += 1
      trace('reject_rise', node, dir, `target=${blockLabel(blockC)}`)
      return
    }

    // 门口禁止斜切:门被本项目标成 safe(当空气)让 A* 规划穿门,但物理上斜着过 1 格宽门口
    // 会撞门框/门板角 → 卡死。所以斜线目标格是门 → 直接不规划斜线,逼 A* 用 cardinal 正向直穿门。
    if (isPassableDoor(blockC)) {
      stats.rejectedDoor += 1
      trace('reject_target_door', node, dir, `target=${blockLabel(blockC)}`)
      return
    }

    // squeeze 层:斜跳上时 (y=1) 0/1/2 三层都得 safe(起跳层 + 跳跃中 + 头);
    // 平地斜线时 (y=0) 0/1 两层(身体 + 头)。
    const layers = y === 1 ? [0, 1, 2] : [0, 1]
    const envelopeBreaks = new Map()
    for (const ly of layers) {
      const side1 = this.getBlock(node, 0, ly, dir.z)
      const side2 = this.getBlock(node, dir.x, ly, 0)
      // 挤角侧是门(被标 safe)→ 斜线会蹭门框,禁止 → 强制 cardinal 绕门正穿
      if (isPassableDoor(side1) || isPassableDoor(side2)) {
        stats.rejectedDoor += 1
        trace('reject_side_door', node, dir, `layer=${ly} side1=${blockLabel(side1)} side2=${blockLabel(side2)}`)
        return
      }

      for (const side of [side1, side2]) {
        if (side.safe) continue
        if (!this.canDig) {
          stats.rejectedUnsafeNoDig += 1
          trace('reject_unsafe_standard', node, dir, `layer=${ly} blocked=${blockLabel(side)}`)
          return
        }

        // 上游只把斜角两侧较便宜的一侧并入 toBreak，但真实碰撞箱会扫过两侧。
        // canDig 模式必须先确认两侧都可挖，并在生成边后补齐整个碰撞包络。
        const pending = []
        const breakCost = this.safeOrBreak(side, pending)
        if (breakCost >= 100 || pending.length === 0) {
          stats.rejectedUnbreakable += 1
          trace('reject_unbreakable', node, dir, `layer=${ly} blocked=${blockLabel(side)} cost=${breakCost}`)
          return
        }
        for (const p of pending) {
          const key = posKey(p)
          if (!envelopeBreaks.has(key)) envelopeBreaks.set(key, { pos: p, cost: breakCost })
        }
      }
    }

    const start = neighbors.length
    original(node, dir, neighbors)
    const emitted = neighbors.slice(start)
    stats.emitted += emitted.length
    if (emitted.length === 0) {
      trace('upstream_rejected', node, dir, `envelopeBreaks=${envelopeBreaks.size}`)
      return
    }

    if (envelopeBreaks.size > 0) {
      stats.breakableEnvelope += 1
      for (const move of emitted) {
        const existing = new Set((move.toBreak || []).map(posKey))
        const added = []
        for (const [key, required] of envelopeBreaks) {
          if (existing.has(key)) continue
          move.toBreak.push(required.pos)
          move.cost += required.cost
          existing.add(key)
          added.push(key)
        }
        stats.addedBreakBlocks += added.length
        trace(
          'emit_breakable',
          node,
          dir,
          `to=(${move.x},${move.y},${move.z}) allBreaks=${move.toBreak.map(posKey).join('|')} ` +
          `added=${added.join('|') || '-'} cost=${Number(move.cost).toFixed(2)}`
        )
      }
    } else {
      trace('emit_clear', node, dir, `to=(${emitted[0].x},${emitted[0].y},${emitted[0].z})`)
    }
  }
  console.log(`${tag} getMoveDiagonal 已 patch (标准寻路要求两侧净空;canDig 斜线先挖净两侧碰撞包络;禁用 y=1 斜跳上;门口禁斜切)`)
}

function patchPulseJump (bot, tag) {
  const Vec3 = require('vec3')
  const originalSetControlState = bot.setControlState.bind(bot)
  let jumpReleaseTimer = null
  let horizontalLockActive = false
  let jumpCycleActive = false
  let jumpCycleLeftGround = false
  let allowSyntheticTakeoff = false
  let backoffActive = false
  let backoffFramesUsed = 0
  let backoffNodeKey = null
  let backoffTarget = null
  let backoffStartXz = null
  let backoffStartPos = null
  let backoffSequence = 0
  let activeBackoffSequence = null
  let preparedJumpKey = null
  const JUMP_RELEASE_MS = 60    // jump 输入 60ms 自动释放,避免持续 jump 让服务端 reject
  const BACKOFF_MIN_PHYSICS_FRAMES = 2
  const BACKOFF_MAX_PHYSICS_FRAMES = 4
  const BACKOFF_MIN_GAIN = 0.04
  let lastInWaterAt = 0
  const WATER_EXIT_GRACE_MS = 600  // 出水后宽限:这段内仍按水中透传(不锁水平),让 bot 完整做"跳+前进上岸"

  const nodeKey = (node) => node && Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z)
    ? `${node.x},${node.y},${node.z}`
    : null

  const shortNumber = (value) => Number.isFinite(value) ? value.toFixed(3) : '?'
  const shortPosition = (position) => position
    ? `(${shortNumber(position.x)},${shortNumber(position.y)},${shortNumber(position.z)})`
    : '(?)'

  const distanceToNode = (node) => {
    const position = bot.entity?.position
    if (!position || !node) return null
    return Math.hypot(node.x - position.x, node.z - position.z)
  }

  const clearHorizontalVelocity = () => {
    if (!bot.entity?.velocity) return
    bot.entity.velocity.x = 0
    bot.entity.velocity.z = 0
  }

  const clearJumpRelease = () => {
    if (!jumpReleaseTimer) return
    clearTimeout(jumpReleaseTimer)
    jumpReleaseTimer = null
  }

  const hasBackoffSupport = (dbg) => {
    const entity = bot.entity
    const target = dbg?.next
    if (!entity?.position || !target || entity.isInWater) return false
    const vy = entity.velocity?.y
    const settled = entity.onGround === true || (entity.onGround === false && Number.isFinite(vy) && Math.abs(vy) <= 0.1)
    if (!settled) return false

    const dx = target.x - entity.position.x
    const dz = target.z - entity.position.z
    const length = Math.hypot(dx, dz)
    if (length < 0.001) return false

    const sample = new Vec3(
      entity.position.x - (dx / length) * 0.35,
      entity.position.y - 0.2,
      entity.position.z - (dz / length) * 0.35
    )
    let support = null
    try { support = bot.blockAt(sample.floored()) } catch (_) { return false }
    if (!support || support.name === 'air' || support.name === 'powder_snow' || support.name === 'water' || support.name === 'lava') return false
    return support.name === 'snow' || support.boundingBox === 'block' || (Array.isArray(support.shapes) && support.shapes.length > 0)
  }

  const cancelBackoff = (reason, clearPrepared = true) => {
    const wasActive = backoffActive
    const sequence = activeBackoffSequence
    const key = backoffNodeKey
    const endXz = distanceToNode(backoffTarget)
    if (wasActive) {
      console.log(`${tag} pulse jump backoff_cancel seq=${sequence} node=${key} reason=${reason} startXZ=${shortNumber(backoffStartXz)} endXZ=${shortNumber(endXz)} pos=${shortPosition(bot.entity?.position)}`)
    }
    try { originalSetControlState('back', false) } catch (_) {}
    if (wasActive) clearHorizontalVelocity()
    backoffActive = false
    backoffFramesUsed = 0
    backoffNodeKey = null
    backoffTarget = null
    backoffStartXz = null
    backoffStartPos = null
    activeBackoffSequence = null
    if (clearPrepared) preparedJumpKey = null
  }

  const resetPulseState = (reason, syntheticTakeoff = false) => {
    cancelBackoff(reason)
    clearJumpRelease()
    jumpCycleActive = false
    jumpCycleLeftGround = false
    horizontalLockActive = false
    allowSyntheticTakeoff = syntheticTakeoff
    preparedJumpKey = null
    try { originalSetControlState('jump', false) } catch (_) {}
    try { originalSetControlState('back', false) } catch (_) {}
  }

  const beginBackoff = (dbg, reason) => {
    const key = nodeKey(dbg?.next)
    if (!key || !hasBackoffSupport(dbg)) {
      console.log(`${tag} pulse jump backoff_skip node=${key} reason=unsafe_or_unsettled pos=${shortPosition(bot.entity?.position)}`)
      return false
    }
    if (backoffActive) {
      if (backoffNodeKey === key) return true
      cancelBackoff(`target_replaced:${key}`)
    }

    clearHorizontalVelocity()
    backoffActive = true
    backoffFramesUsed = 0
    backoffNodeKey = key
    backoffTarget = { x: dbg.next.x, y: dbg.next.y, z: dbg.next.z }
    backoffStartXz = distanceToNode(backoffTarget)
    backoffStartPos = bot.entity?.position?.clone?.() || (bot.entity?.position ? { ...bot.entity.position } : null)
    activeBackoffSequence = ++backoffSequence
    preparedJumpKey = null
    allowSyntheticTakeoff = false
    jumpCycleActive = false
    jumpCycleLeftGround = false
    horizontalLockActive = false
    clearJumpRelease()
    try { originalSetControlState('forward', false) } catch (e) {}
    try { originalSetControlState('sprint', false) } catch (e) {}
    try { originalSetControlState('jump', false) } catch (e) {}
    try { originalSetControlState('back', false) } catch (e) {}
    console.log(`${tag} pulse jump backoff_start seq=${activeBackoffSequence} node=${key} reason=${reason} startXZ=${shortNumber(backoffStartXz)} pos=${shortPosition(backoffStartPos)}`)
    return true
  }

  // pathfinder 的 monitorMovement 监听器先注册；本监听器紧随其后运行。
  // 因此 arm 时清掉当前 tick 的普通水平输入，这里解锁后，后置的攀爬/容器
  // 控制器可按所有权覆盖，下一 tick 的 forward 也不会再被吞掉。
  bot.on('physicsTick', () => {
    horizontalLockActive = false
    if (!backoffActive) return

    let dbg = null
    try { dbg = bot.pathfinder?.getDebugState?.() } catch (_) { /* cancel below */ }
    const currentKey = nodeKey(dbg?.next)
    const stillCurrent = currentKey === backoffNodeKey &&
      dbg?.next?.requiresJump === true &&
      !bot.pathfinder?.isControlPaused?.()
    if (!stillCurrent) {
      cancelBackoff(`target_invalid:${currentKey}`)
      return
    }

    // A snow step can lift the bot to target Y before its XZ hitbox clears the
    // face. That is not node arrival: isNodeReached/path_debug node_reached owns
    // the full XZ+Y decision. Keep preparing while this is still the same rise.

    const currentXz = distanceToNode(backoffTarget)
    const retreat = Number.isFinite(currentXz) && Number.isFinite(backoffStartXz)
      ? currentXz - backoffStartXz
      : null
    const needsMoreFrames = backoffFramesUsed < BACKOFF_MIN_PHYSICS_FRAMES || (
      Number.isFinite(retreat) && retreat < BACKOFF_MIN_GAIN && backoffFramesUsed < BACKOFF_MAX_PHYSICS_FRAMES
    )
    if (needsMoreFrames) {
      // monitorMovement has already run in this event. Override its controls so
      // the next physics simulation backs away from the step face.
      try { originalSetControlState('forward', false) } catch (e) {}
      try { originalSetControlState('sprint', false) } catch (e) {}
      try { originalSetControlState('jump', false) } catch (e) {}
      try { originalSetControlState('back', true) } catch (e) {}
      backoffFramesUsed += 1
      if (backoffFramesUsed > BACKOFF_MIN_PHYSICS_FRAMES) {
        console.log(`${tag} pulse jump backoff_extend seq=${activeBackoffSequence} node=${backoffNodeKey} frame=${backoffFramesUsed} retreat=${shortNumber(retreat)}`)
      }
      return
    }

    // Leave one neutral simulation to settle, then let the next monitorMovement
    // pass consume the preparation token and arm a fresh vertical pulse.
    try { originalSetControlState('forward', false) } catch (e) {}
    try { originalSetControlState('sprint', false) } catch (e) {}
    try { originalSetControlState('jump', false) } catch (e) {}
    try { originalSetControlState('back', false) } catch (e) {}
    clearHorizontalVelocity()

    if (!Number.isFinite(retreat) || retreat < BACKOFF_MIN_GAIN) {
      const failedTarget = backoffTarget
      const failedKey = backoffNodeKey
      cancelBackoff(`insufficient_retreat:${shortNumber(retreat)}`)
      if (failedTarget && typeof bot._avoidPathNode === 'function') {
        bot._avoidPathNode(failedTarget, `backoff_failed:${failedKey}`, 30000)
      }
      const goal = bot.pathfinder?.goal
      if (goal) {
        setImmediate(() => {
          if (bot.pathfinder?.goal !== goal || bot.pathfinder?.isControlPaused?.()) return
          bot.pathfinder.setGoal(goal)
        })
      }
      return
    }

    const completedSequence = activeBackoffSequence
    const completedKey = backoffNodeKey
    const completedFrames = backoffFramesUsed
    const completedStartXz = backoffStartXz
    backoffActive = false
    backoffFramesUsed = 0
    preparedJumpKey = completedKey
    backoffNodeKey = null
    backoffTarget = null
    backoffStartXz = null
    backoffStartPos = null
    activeBackoffSequence = null
    allowSyntheticTakeoff = true
    console.log(`${tag} pulse jump backoff_complete seq=${completedSequence} node=${completedKey} frames=${completedFrames} startXZ=${shortNumber(completedStartXz)} endXZ=${shortNumber(currentXz)} retreat=${shortNumber(retreat)} pos=${shortPosition(bot.entity?.position)}`)
  })

  // 雪层表面偶尔长期报告 onGround=false。stuck 重算说明本轮起跳已经结束，
  // 允许新路径的第一条上升边重新 arm。path_reset 在 vendor 清空旧 path
  // 之前同步发出，因此不能在这里用旧 next 启动 backoff。
  bot.on('path_reset', (reason) => {
    resetPulseState(`path_reset:${reason}`, reason === 'stuck')
  })

  bot.on('path_resume', (info) => {
    if (info?.resumed !== true) return
    resetPulseState('path_resume', true)
  })

  bot.on('path_pause', () => resetPulseState('path_pause', false))
  bot.on('path_stop', () => resetPulseState('path_stop', false))
  bot.on('goal_updated', () => resetPulseState('goal_updated', false))
  bot.on('death', () => resetPulseState('death', false))
  bot.on('end', () => resetPulseState('end', false))

  bot.on('path_debug', (info) => {
    if (info?.reason !== 'node_reached') return
    if (info?.reached?.reachKind === 'surface') {
      // monitorMovement may consume the previous surface node immediately
      // after the post-monitor listener completed backoff for the current
      // required-rise node. Keep that preparation token when debug.next still
      // names the same target; otherwise the next physics frame backs away
      // again and can repeat until the guarded-goto watchdog fires.
      let currentNextKey = null
      try { currentNextKey = nodeKey(bot.pathfinder?.getDebugState?.()?.next) } catch (_) {}
      const keepPreparedKey = preparedJumpKey && currentNextKey === preparedJumpKey
        ? preparedJumpKey
        : null
      resetPulseState('node_reached', true)
      if (keepPreparedKey) {
        preparedJumpKey = keepPreparedKey
        allowSyntheticTakeoff = true
      }
    }
    else cancelBackoff('node_reached')
  })

  bot.setControlState = (control, state) => {
    const now = Date.now()

    if (bot.pathfinder?.isControlPaused?.()) {
      return originalSetControlState(control, state)
    }

    if (backoffActive && state === true && (control === 'forward' || control === 'sprint' || control === 'jump' || control === 'back')) {
      return
    }

    const onGround = bot.entity?.onGround
    if (onGround === true) allowSyntheticTakeoff = false
    if (jumpCycleActive) {
      if (onGround === false) jumpCycleLeftGround = true
      else if (onGround === true && jumpCycleLeftGround) {
        jumpCycleActive = false
        jumpCycleLeftGround = false
      }
    }

    // 水中完全透传 + 出水宽限:pathfinder 在水里每个 physics tick 都 setControlState('jump',true) 上浮
    // (index.js:611-612)。pulse jump 的水平锁若被每 tick 续上会永久压制 forward,
    // 导致 bot 在水里只上下扑腾、几乎不前进。游泳本来就需要持续按 jump,不该套"起跳纯垂直"。
    // 另:bot 跳起上岸时脚一离水 isInWater 瞬间变 false → pulse jump 立即锁 forward → 上不了岸又掉回水里
    // 反复扑腾。所以出水后再宽限 WATER_EXIT_GRACE_MS,期间仍透传,保证"跳+前进上岸"动作完整做完。
    let feetInWater = false
    const position = bot.entity?.position
    if (position) {
      try {
        const feet = bot.blockAt(new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)))
        feetInWater = !!(feet && isWaterLikeName(feet.name))
      } catch (_) { /* unloaded block: keep the entity flag as the authority */ }
    }
    const inWater = bot.entity?.isInWater || feetInWater
    if (inWater) lastInWaterAt = now
    if (inWater || (now - lastInWaterAt) < WATER_EXIT_GRACE_MS) {
      return originalSetControlState(control, state)
    }

    // 只吞掉 arm 所在 physicsTick 的水平输入。
    if (horizontalLockActive && state === true && (control === 'forward' || control === 'sprint' || control === 'back')) {
      return  // 静默吃掉,bot 起跳一瞬间纯垂直
    }

    if (control === 'jump' && state === true) {
      let jumpDebug = null
      try { jumpDebug = bot.pathfinder?.getDebugState?.() } catch (_) { /* ignore */ }
      const nextJumpKey = nodeKey(jumpDebug?.next)
      const jumpXz = jumpDebug?.nextDelta?.xz
      const jumpDy = jumpDebug?.nextDelta?.dy
      const requiredRise = jumpDebug?.next?.requiresJump === true && Number.isFinite(jumpDy) && jumpDy > 0.05

      // Climbable entry edges have their own post-monitor controller. Applying
      // the surface-step backoff here would make that controller clear `back`
      // while this wrapper suppresses its forward/jump inputs, leaving every
      // movement control false. Relinquish pulse ownership for the whole edge.
      if (jumpDebug?.next?.reachKind === 'climbable' && jumpDebug.next.requiresJump === true) {
        preparedJumpKey = null
        allowSyntheticTakeoff = false
        jumpCycleActive = false
        jumpCycleLeftGround = false
        horizontalLockActive = false
        return originalSetControlState(control, state)
      }

      // A normal sprint-jump on a flat or descending edge was selected by the
      // physics simulator with simultaneous forward+jump. Do not rewrite it as
      // a vertical-only pulse; that made descending snow edges impossible.
      if (!requiredRise) {
        preparedJumpKey = null
        return originalSetControlState(control, state)
      }

      // monitorMovement asks for jump every physics tick. Arm the horizontal
      // pulse only once per takeoff. A stuck reset may happen on a fractional
      // snow surface whose client-side onGround flag remains false; permit one
      // synthetic re-arm only when vertical speed shows the bot is resting.
      const syntheticTakeoff = allowSyntheticTakeoff && onGround === false && Math.abs(bot.entity?.velocity?.y ?? Infinity) <= 0.1
      if (jumpCycleActive) {
        const climbing = jumpDebug?.next?.reachKind === 'climbable'
        return climbing ? originalSetControlState(control, state) : undefined
      }
      if (onGround === false && !syntheticTakeoff) {
        return originalSetControlState(control, state)
      }
      const needsRoom = Number.isFinite(jumpXz) && jumpXz <= 1.05
      const roomPrepared = Boolean(nextJumpKey && nextJumpKey === preparedJumpKey)
      if (needsRoom && !roomPrepared) {
        if (beginBackoff(jumpDebug, `pre_jump_xz_${jumpXz.toFixed(2)}`)) return
      }
      // A valid backoff belongs to the required-rise node, not just to one
      // jump cycle. The first pulse can land back on the source block while
      // the same node remains current; retaining the token lets that retry
      // take off immediately instead of backing away on every landing.
      if (!roomPrepared) preparedJumpKey = null
      allowSyntheticTakeoff = false
      jumpCycleActive = true
      // jump=true 触发起跳,同时启动两个定时器:
      // 1. 60ms 后自动释放 jump 输入(避免持续按 jump)
      // 2. 当前 physicsTick 锁住水平移动(让起跳第 1 tick 纯垂直)
      horizontalLockActive = true
      // 立即把 forward/sprint/back 状态改 false,免得已经按下的水平输入推 bot 撞墙
      try { originalSetControlState('forward', false) } catch (e) {}
      try { originalSetControlState('sprint', false) } catch (e) {}
      try { originalSetControlState('back', false) } catch (e) {}
      const result = originalSetControlState(control, state)
      if (jumpReleaseTimer) clearTimeout(jumpReleaseTimer)
      jumpReleaseTimer = setTimeout(() => {
        try { originalSetControlState('jump', false) } catch (e) {}
      }, JUMP_RELEASE_MS)
      return result
    }

    return originalSetControlState(control, state)
  }
  console.log(`${tag} bot.setControlState 已 patch (required-rise pulse ${JUMP_RELEASE_MS}ms;惯性清零 + ${BACKOFF_MIN_PHYSICS_FRAMES}-${BACKOFF_MAX_PHYSICS_FRAMES} 帧可验证 backoff;生命周期联动取消)`)
}

function installClimbControlBridge (bot, controller, tag) {
  if (!controller || typeof controller.applyClimbControls !== 'function') return false

  let activeController = null
  let activeMovements = null
  let activeNodeKey = null
  let traceLines = 0
  const trace = (message) => {
    if (!CLIMB_TRACE || traceLines >= CLIMB_TRACE_LIMIT) return
    traceLines += 1
    console.log(`${tag} [climb-trace] ${message}`)
  }
  const controllerForCurrentMovements = () => {
    const currentMovements = bot.pathfinder?.movements
    return {
      movements: currentMovements,
      controller: getClimbableController(currentMovements) ||
        (currentMovements == null ? controller : null)
    }
  }
  const clear = (reason = 'clear') => {
    if (activeController) {
      try { activeController.clearClimbPhase() } catch (_) { /* ignore */ }
      trace(`clear reason=${reason}`)
    }
    activeController = null
    activeMovements = null
    activeNodeKey = null
  }
  bot.on('physicsTick', () => {
    if (bot.pathfinder?.isControlPaused?.()) {
      clear('controls_paused')
      return
    }
    const debug = bot.pathfinder?.getDebugState?.()
    const next = debug?.next
    const dy = debug?.nextDelta?.dy
    if (!next || next.reachKind !== 'climbable') {
      clear('non_climb_node')
      return
    }
    const current = controllerForCurrentMovements()
    if (!current.controller) {
      clear('missing_current_controller')
      trace(
        `missing_controller next=(${next.x},${next.y},${next.z}) ` +
        `movementCanDig=${!!current.movements?.canDig}`
      )
      return
    }
    if (activeController !== current.controller || activeMovements !== current.movements) {
      clear('movements_switched')
      activeController = current.controller
      activeMovements = current.movements
      trace(`controller_switch canDig=${!!current.movements?.canDig}`)
    }
    const nodeKey = `${next.x},${next.y},${next.z}:${next.climbTransition || 'column'}`
    if (nodeKey !== activeNodeKey) {
      activeNodeKey = nodeKey
      const vineSupport = resolveVineClimbSupport(bot, next)
      trace(
        `node=${nodeKey} block=${next.climbBlockName || '?'} ` +
        `direction=${next.climbDirection ?? '?'} jump=${!!next.requiresJump} ` +
        `landing=${!!next.requiresLanding} dy=${Number.isFinite(dy) ? dy.toFixed(2) : '?'} ` +
        `support=${vineSupport ? `${vineSupport.face}@${vineSupport.x},${vineSupport.y},${vineSupport.z}:${vineSupport.blockName}` : '-'} ` +
        `supportVerified=${vineSupport !== null}`
      )
    }
    current.controller.applyClimbControls(next, dy)
  })
  bot.on('path_reset', reason => clear(`path_reset:${reason || '?'}`))
  bot.on('path_stop', () => clear('path_stop'))
  bot.on('goal_reached', () => clear('goal_reached'))
  bot.on('death', () => clear('death'))
  bot.on('end', () => clear('end'))
  console.log(`${tag} 攀爬执行控制已挂载 (梯子/脚手架/普通与新藤蔓逐层上下;攀爬固定 1x)`)
  return true
}

function patchEdgeAvoidance (moves, bot, tag) {
  const EDGE_COST_NEAR = 7
  const EDGE_COST_FAR = 2
  const CARDINAL_OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  // 复用 patchFastGetBlock 的寻路方块缓存(避免每次 exclusionStep 再打 9 次未缓存的 world.getBlock)。
  const rawAt = moves._rawBlockAt
  const edgeCostCache = new WeakMap()

  moves.exclusionAreasStep.push((block) => {
    if (!block || !block.position) return 0
    try {
      const foot = block.position
      const cacheable = (typeof foot === 'object' && foot !== null) || typeof foot === 'function'
      const epoch = moves._pathBlockCacheEpoch || 0
      const cached = cacheable ? edgeCostCache.get(foot) : null
      if (cached?.epoch === epoch) return cached.cost
      // 关键判断:只对"身体水平 air"做 penalty(它脚下是 physical 立足方块)。
      // 头顶 air / 身体上方 air 它脚下也是 air,直接返 0 不重复累加。
      const standing = rawAt(foot.x, foot.y - 1, foot.z)
      if (!standing || standing.boundingBox !== 'block') {
        if (cacheable) edgeCostCache.set(foot, { epoch, cost: 0 })
        return 0
      }

      let cost = 0
      // 近场:脚下方块的 4 cardinal 邻居,每空一边 +7
      for (const [dx, dz] of CARDINAL_OFFSETS) {
        const adj = rawAt(foot.x + dx, foot.y - 1, foot.z + dz)
        if (!adj || adj.boundingBox !== 'block') {
          cost += EDGE_COST_NEAR
        }
      }
      // 远场:2 格远 cardinal 邻居,识别 3 块宽桥靠边节点
      for (const [dx, dz] of CARDINAL_OFFSETS) {
        const adjFar = rawAt(foot.x + dx * 2, foot.y - 1, foot.z + dz * 2)
        if (!adjFar || adjFar.boundingBox !== 'block') {
          cost += EDGE_COST_FAR
        }
      }
      if (cacheable) edgeCostCache.set(foot, { epoch, cost })
      return cost
    } catch (e) { return 0 }
  })
  console.log(`${tag} exclusionAreasStep 已加 patchEdgeAvoidance (只对站立 air 算 penalty:近场每边 +${EDGE_COST_NEAR}, 远场 +${EDGE_COST_FAR})`)
}

function doorIsOpen (b) {
  try {
    const props = b.getProperties ? b.getProperties() : null
    if (props && props.open !== undefined) return String(props.open) === 'true'
  } catch (e) { /* ignore */ }
  return false
}

function patchDoorPlanningEdges (moves) {
  if (!moves || typeof moves.getMoveJumpUp !== 'function' || moves._doorPlanningEdgesPatched) return false
  const originalJumpUp = moves.getMoveJumpUp.bind(moves)
  moves.getMoveJumpUp = function getMoveJumpUpWithoutDoorSupport (node, dir, neighbors) {
    const lower = this.getBlock(node, dir.x, 0, dir.z)
    const upper = this.getBlock(node, dir.x, 1, dir.z)
    if (isPassableDoor(lower) || isPassableDoor(upper)) return
    return originalJumpUp(node, dir, neighbors)
  }
  moves._doorPlanningEdgesPatched = true
  return true
}

function isDoorSupportedRise (node, move, rawAt) {
  if (!node || !move || typeof rawAt !== 'function') return false
  if (!Number.isFinite(node.y) || !Number.isFinite(move.y) || move.y <= node.y + 0.05) return false
  const x = Math.floor(move.x)
  const y = Math.floor(move.y)
  const z = Math.floor(move.z)
  return isPassableDoor(rawAt(x, y - 1, z)) || isPassableDoor(rawAt(x, y, z))
}

function patchDoorRiseNeighborFilter (moves) {
  if (!moves || typeof moves.getNeighbors !== 'function' || moves._doorRiseNeighborFilterPatched) return false
  const rawAt = moves._rawBlockAt
  if (typeof rawAt !== 'function') return false
  const originalGetNeighbors = moves.getNeighbors.bind(moves)
  moves.getNeighbors = function getNeighborsWithoutDoorSupportedRise (node) {
    const neighbors = originalGetNeighbors(node)
    if (!Array.isArray(neighbors)) return neighbors
    return neighbors.filter(move => !isDoorSupportedRise(node, move, rawAt))
  }
  moves._doorRiseNeighborFilterPatched = true
  return true
}

function planDoorTakeover (position, doorCenter, next) {
  if (!position || !doorCenter) return null
  const toDoorX = doorCenter.x - position.x
  const toDoorZ = doorCenter.z - position.z
  const doorDist = Math.hypot(toDoorX, toDoorZ)
  const hasNext = next && Number.isFinite(next.x) && Number.isFinite(next.z)
  let toNextX = 0
  let toNextZ = 0
  let nextDist = 0
  let doorOnPath = false

  if (hasNext) {
    toNextX = next.x - position.x
    toNextZ = next.z - position.z
    nextDist = Math.hypot(toNextX, toNextZ)
    if (doorDist > 1e-3 && nextDist > 1e-3) {
      const dot = (toDoorX * toNextX + toDoorZ * toNextZ) / (doorDist * nextDist)
      doorOnPath = dot > 0.25 && doorDist <= nextDist + 1.0
    } else {
      doorOnPath = doorDist <= 1.2
    }
  } else {
    doorOnPath = doorDist <= 1.2
  }
  if (!doorOnPath) return null

  // Follow the actual path edge through the door. A bot can already be partly
  // inside the door volume, where "towards door center" points backwards.
  let dirx = hasNext && nextDist > 1e-3 ? toNextX : toDoorX
  let dirz = hasNext && nextDist > 1e-3 ? toNextZ : toDoorZ
  const len = Math.hypot(dirx, dirz) || 1
  dirx /= len
  dirz /= len
  return {
    doorCenter,
    dir: { x: dirx, z: dirz },
    target: { x: doorCenter.x + dirx * 2, z: doorCenter.z + dirz * 2 },
    jump: Boolean(hasNext && Number.isFinite(next.y) && next.y > position.y + 0.45),
  }
}

function patchDoorPassing (moves, bot, tag) {
  // A. 门标 safe/physical=false(当空气走,不触发 useOne)已合并进 patchFastGetBlock 的 getBlock。
  //    这里只保留 B(physicsTick 门通行控制器)。

  // B. 自挂门通行控制器(physicsTick):
  //    ① 门 2 格内 → 强制取消 sprint(sprint 惯性/转向会蹭门板、对不准门洞,精准通行必须走步速);
  //    ② 紧邻(≤1格)关着的门 → activateBlock 开一次(只开关着的,防反复开关)。
  //    本 handler 在 spawn 时注册,晚于库的 monitorMovement(inject 时注册),所以同一 tick 里
  //    我们的 setControlState('sprint',false) 覆盖库设的 sprint=true,精准生效。
  const Vec3 = require('vec3')
  const NEAR_R = 2
  let lastActAt = 0
  let activationInFlight = null
  // 卡门手动接管状态
  let takeover = null   // { until, doorCenter:{x,z}, dir:{x,z}, target:{x,z} }
  let lastPos = null
  let lastMoveAt = 0
  bot.on('physicsTick', () => {
    if (bot.pathfinder?.isControlPaused?.()) {
      takeover = null
      lastPos = null
      return
    }
    // 有寻路目标就算(含 Patch A 站着算路期:isMoving()=false 但 goal 仍在),否则清状态退出
    const hasGoal = bot.pathfinder && (bot.pathfinder.goal || (bot.pathfinder.isMoving && bot.pathfinder.isMoving()))
    if (!hasGoal) { takeover = null; lastPos = null; return }
    const pathDebug = bot.pathfinder?.getDebugState?.()
    if (bot.pathfinder?.isInteracting?.() || pathDebug?.next?.reachKind === 'climbable') {
      takeover = null
      lastPos = null
      return
    }
    const p = bot.entity && bot.entity.position
    if (!p) return
    const now = Date.now()
    const moved = lastPos ? Math.hypot(p.x - lastPos.x, p.z - lastPos.z) : 999
    if (!lastPos || moved > 0.15) { lastPos = p.clone ? p.clone() : new Vec3(p.x, p.y, p.z); lastMoveAt = now }
    const cx = Math.floor(p.x)
    const cy = Math.floor(p.y)
    const cz = Math.floor(p.z)
    let doorNear = false
    let toOpen = null
    let nearestDoor = null
    let nearestD2 = Infinity
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = -NEAR_R; dx <= NEAR_R; dx++) {
        for (let dz = -NEAR_R; dz <= NEAR_R; dz++) {
          let b
          try { b = bot.blockAt(new Vec3(cx + dx, cy + dy, cz + dz)) } catch (e) { continue }
          if (!isPassableDoor(b)) continue
          doorNear = true
          const d2 = dx * dx + dz * dz
          if (d2 < nearestD2) { nearestD2 = d2; nearestDoor = b }
          if (!toOpen && Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && !doorIsOpen(b)) toOpen = b
        }
      }
    }

    // 先确保门开着(只开关着的)
    if (toOpen && !activationInFlight && Date.now() - lastActAt >= 300) {
      lastActAt = Date.now()
      try {
        const pending = Promise.resolve(bot.activateBlock(toOpen)).then(() => {
          console.log(`${tag} 开门器:activateBlock ${toOpen.name} @(${toOpen.position.x},${toOpen.position.y},${toOpen.position.z})`)
        }, e => {
          console.warn(`${tag} 开门器:activateBlock 异步异常 ${e && e.message}`)
        })
        activationInFlight = pending
        pending.finally(() => {
          if (activationInFlight === pending) activationInFlight = null
        }).catch(() => {})
      } catch (e) {
        activationInFlight = null
        console.warn(`${tag} 开门器:activateBlock 异常 ${e && e.message}`)
      }
    }

    // 手动接管进行中:正对门洞中心纯前进直穿,过门或超时即交还
    if (takeover) {
      const dx = takeover.target.x - p.x
      const dz = takeover.target.z - p.z
      try {
        bot.look(Math.atan2(-dx, -dz), 0, true)
        bot.setControlState('forward', true)
        bot.setControlState('sprint', false)
        bot.setControlState('jump', takeover.jump === true)
        bot.setControlState('back', false)
        bot.setControlState('left', false)
        bot.setControlState('right', false)
      } catch (e) { /* ignore */ }
      const crossed = (p.x - takeover.doorCenter.x) * takeover.dir.x + (p.z - takeover.doorCenter.z) * takeover.dir.z
      if (Date.now() > takeover.until || crossed > 0.6) {
        takeover = null
        lastPos = null
        lastMoveAt = Date.now()
      }
      return
    }

    if (doorNear) {
      try { bot.setControlState('sprint', false) } catch (e) { /* ignore */ }
      // 接管触发(仅限"当前路径确实要穿这扇门"):2 格内有门 + 卡住 >250ms + 门在通往下一节点的方向上。
      // 否则(门只是恰好在脚边、但路要往别处走)绝不夺权——历史上无条件朝门推会和寻路对抗,
      // 在"脚手架/楼梯底部紧邻一扇门、但目标在另一侧"的场景把 bot 往门里拽,反复卡死。
      if (nearestDoor && (now - lastMoveAt) > 250) {
        const dc = { x: nearestDoor.position.x + 0.5, z: nearestDoor.position.z + 0.5 }
        const next = pathDebug?.next
        const plan = planDoorTakeover(p, dc, next)
        if (plan) {
          takeover = { until: now + 1500, ...plan }
          console.log(`${tag} 卡门接管:手动直穿 door@(${nearestDoor.position.x},${nearestDoor.position.y},${nearestDoor.position.z})`)
        }
      }
    }
  })

  console.log(`${tag} 木门/栅栏门寻路已 patch (getBlock 标 safe 当空气走 + 门 2 格内取消 sprint 精准通行 + 只开关着的门)`)
}

function isCarpetName (n) {
  return typeof n === 'string' && n.endsWith('carpet')
}

const AVOIDED_NODE_LIMIT = 4096
const AVOIDED_NODE_KEEP = 3072
const AVOIDED_SWEEP_INTERVAL_MS = 30000

function installTemporaryNodeAvoidance (moves, bot, tag) {
  const avoided = new Map()
  const keyOf = (point) => `${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}`
  // 采集器的挖掘段用的是另一个 Movements 实例，也必须看到同一份避让表，否则「挖不动的方块」
  // 在挖掘寻路里会被反复选中（真服实测同一条 3 节点挖掘路径重算到导航窗口耗尽）。
  bot._avoidedPathNodes = avoided

  // exclusionAreasStep 只在 A* 恰好重新评估同一坐标时才惰性删除过期项，长跑几天下来
  // 走过的所有失败节点都会留在表里。每次写入时摊还清理：先删过期，仍超上限就丢最早到期的。
  let lastSweepAt = Date.now()
  const sweep = (now) => {
    for (const [key, entry] of avoided) {
      if (entry.expiresAt <= now) avoided.delete(key)
    }
    if (avoided.size <= AVOIDED_NODE_LIMIT) return
    const byExpiry = Array.from(avoided.entries()).sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    const drop = byExpiry.length - AVOIDED_NODE_KEEP
    for (let i = 0; i < drop; i++) avoided.delete(byExpiry[i][0])
    console.warn(`${tag} 临时避让表超上限,丢弃最早到期的 ${drop} 项 (size=${avoided.size}/${AVOIDED_NODE_LIMIT})`)
  }
  const maybeSweep = () => {
    const now = Date.now()
    if (now - lastSweepAt < AVOIDED_SWEEP_INTERVAL_MS && avoided.size <= AVOIDED_NODE_LIMIT) return
    lastSweepAt = now
    sweep(now)
  }

  moves.exclusionAreasStep.push((block) => {
    if (!block?.position) return 0
    const key = keyOf(block.position)
    const entry = avoided.get(key)
    if (!entry) return 0
    if (entry.expiresAt <= Date.now()) {
      avoided.delete(key)
      return 0
    }
    return 1000
  })

  bot._avoidPathNode = (node, reason = 'runtime', ttlMs = 120000) => {
    if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.z)) return false
    const key = keyOf(node)
    avoided.set(key, { expiresAt: Date.now() + Math.max(1000, ttlMs), reason })
    maybeSweep()
    console.warn(`${tag} 临时避让路径节点 ${key} ttl=${Math.round(ttlMs / 1000)}s reason=${reason}`)
    return true
  }

  bot._avoidPathCorridor = (nodes, reason = 'runtime_corridor', ttlMs = 45000) => {
    if (!Array.isArray(nodes)) return 0
    let added = 0
    const seen = new Set()
    for (const node of nodes) {
      if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.z)) continue
      const key = keyOf(node)
      if (seen.has(key)) continue
      seen.add(key)
      avoided.set(key, { expiresAt: Date.now() + Math.max(1000, ttlMs), reason })
      added += 1
    }
    if (added > 0) {
      maybeSweep()
      console.warn(`${tag} 临时避让失败走廊 nodes=${added} ttl=${Math.round(ttlMs / 1000)}s reason=${reason}`)
    }
    return added
  }

  bot._pathAvoidanceSnapshot = () => Array.from(avoided.entries()).map(([key, value]) => ({
    key,
    reason: value.reason,
    remainingMs: Math.max(0, value.expiresAt - Date.now())
  }))
}

module.exports = {
  installTemporaryNodeAvoidance,
  patchFastGetBlock,
  configureGroundHazards,
  patchSnowSurfaceEdges,
  patchDiagonalCornerSafety,
  patchPulseJump,
  installClimbControlBridge,
  patchEdgeAvoidance,
  patchDoorPlanningEdges,
  isDoorSupportedRise,
  patchDoorRiseNeighborFilter,
  planDoorTakeover,
  patchDoorPassing
}

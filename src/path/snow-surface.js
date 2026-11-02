'use strict'

const PLAYER_STEP_HEIGHT = 0.6
const PATHFINDER_JUMP_HEIGHT = 1.2
const PLAYER_HEIGHT = 1.8
const PLAYER_HALF_WIDTH = 0.3
const EPSILON = 1e-7

function readSnowLayers (block) {
  if (!block || block.name !== 'snow') return null
  try {
    const value = block.getProperties?.().layers
    const layers = Number(value)
    return Number.isFinite(layers) && layers >= 1 && layers <= 8 ? layers : null
  } catch (_) {
    return null
  }
}

function shapeTop (block) {
  if (!Array.isArray(block?.shapes)) return 0
  let top = 0
  for (const shape of block.shapes) {
    const value = Number(shape?.[4])
    if (Number.isFinite(value) && value > top) top = value
  }
  return top
}

function snowCollisionHeight (block) {
  if (!block || block.name !== 'snow') return 0
  const top = shapeTop(block)
  if (top > 0) return top
  const layers = readSnowLayers(block)
  return layers == null ? 0 : (layers - 1) / 8
}

function snowDescriptor (block, blockY) {
  return {
    layers: readSnowLayers(block),
    collisionHeight: snowCollisionHeight(block),
    safe: true,
    physical: false,
    replaceable: false,
    height: blockY + snowCollisionHeight(block)
  }
}

function supportHeightWithSnow (baseHeight, baseY, aboveBlock) {
  if (!aboveBlock || aboveBlock.name !== 'snow') return baseHeight
  return Math.max(baseHeight, baseY + 1 + snowCollisionHeight(aboveBlock))
}

function classifySurfaceTransition (sourceHeight, targetHeight) {
  if (!Number.isFinite(sourceHeight) || !Number.isFinite(targetHeight)) {
    return { allowed: false, requiresJump: false, rise: Infinity }
  }
  const rise = targetHeight - sourceHeight
  return {
    allowed: rise <= PATHFINDER_JUMP_HEIGHT + EPSILON,
    requiresJump: rise > PLAYER_STEP_HEIGHT + EPSILON,
    rise
  }
}

function collisionShapes (block) {
  if (Array.isArray(block?.shapes) && block.shapes.length > 0) return block.shapes
  return block?.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : []
}

function intervalsOverlap (aMin, aMax, bMin, bMax) {
  return aMax > bMin + EPSILON && bMax > aMin + EPSILON
}

function standingClearanceObstructions (rawAt, centerX, centerZ, surfaceHeight) {
  if (typeof rawAt !== 'function' || !Number.isFinite(surfaceHeight)) return null

  const playerMinX = centerX - PLAYER_HALF_WIDTH
  const playerMaxX = centerX + PLAYER_HALF_WIDTH
  const playerMinY = surfaceHeight + EPSILON
  const playerMaxY = surfaceHeight + PLAYER_HEIGHT - EPSILON
  const playerMinZ = centerZ - PLAYER_HALF_WIDTH
  const playerMaxZ = centerZ + PLAYER_HALF_WIDTH

  const minBlockX = Math.floor(playerMinX)
  const maxBlockX = Math.floor(playerMaxX - EPSILON)
  const minBlockY = Math.floor(playerMinY)
  const maxBlockY = Math.floor(playerMaxY - EPSILON)
  const minBlockZ = Math.floor(playerMinZ)
  const maxBlockZ = Math.floor(playerMaxZ - EPSILON)
  const obstructions = new Map()

  for (let x = minBlockX; x <= maxBlockX; x++) {
    for (let y = minBlockY; y <= maxBlockY; y++) {
      for (let z = minBlockZ; z <= maxBlockZ; z++) {
        const block = rawAt(x, y, z)
        if (!block) return null
        for (const shape of collisionShapes(block)) {
          if (!Array.isArray(shape) || shape.length < 6) continue
          if (
            intervalsOverlap(playerMinX, playerMaxX, x + shape[0], x + shape[3]) &&
            intervalsOverlap(playerMinY, playerMaxY, y + shape[1], y + shape[4]) &&
            intervalsOverlap(playerMinZ, playerMaxZ, z + shape[2], z + shape[5])
          ) {
            const key = `${x},${y},${z}`
            if (!obstructions.has(key)) obstructions.set(key, block)
            break
          }
        }
      }
    }
  }
  return [...obstructions.values()]
}

function hasStandingClearance (rawAt, centerX, centerZ, surfaceHeight) {
  const obstructions = standingClearanceObstructions(rawAt, centerX, centerZ, surfaceHeight)
  return Array.isArray(obstructions) && obstructions.length === 0
}

module.exports = {
  PLAYER_STEP_HEIGHT,
  PATHFINDER_JUMP_HEIGHT,
  PLAYER_HEIGHT,
  readSnowLayers,
  shapeTop,
  snowCollisionHeight,
  snowDescriptor,
  supportHeightWithSnow,
  classifySurfaceTransition,
  standingClearanceObstructions,
  hasStandingClearance
}

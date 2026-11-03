const { Movements } = require('mineflayer-pathfinder')
const { installClimbableSupport, registerClimbables } = require('./path/climbables')
const { installHollowContainerSupport } = require('./path/hollow-container')
const { installTrapdoorPassage } = require('./path/trapdoor-passage')
const {
  configureGroundHazards, patchFastGetBlock, patchDoorPlanningEdges,
  patchDiagonalCornerSafety, patchEdgeAvoidance, patchPulseJump,
  patchDoorPassing, installClimbControlBridge, patchDoorRiseNeighborFilter,
  installTemporaryNodeAvoidance
} = require('./path/terrain')

// Multiple Warehouse instances can share one bot. Install controllers once per
// pathfinder so repeated chest visits do not wrap controls or add listeners.
const movementCache = new WeakMap()

function warehouseMovements (bot) {
  const pathfinder = bot.pathfinder
  if (movementCache.has(pathfinder)) return movementCache.get(pathfinder)
  const movements = new Movements(bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowParkour = false
  movements.canOpenDoors = false
  movements.scafoldingBlocks = []
  movements.countScaffoldingItems = () => 0
  movements.getScaffoldingItem = () => null
  // The Olela fork defaults to unlimited drops for its flight executor.
  // cloud-store must retain the upstream four-block limit.
  movements.maxDropDown = 4
  movements.infiniteLiquidDropdownDistance = false
  movements.liquidCost = Math.max(movements.liquidCost, 20)
  const tag = '[warehouse|path]'
  configureGroundHazards(movements, bot, tag)
  registerClimbables(movements, bot.registry)
  patchFastGetBlock(movements, bot, tag)
  patchDoorPlanningEdges(movements)
  installTemporaryNodeAvoidance(movements, bot, tag)
  patchDiagonalCornerSafety(movements, tag)
  patchEdgeAvoidance(movements, bot, tag)
  patchPulseJump(bot, tag)
  patchDoorPassing(movements, bot, tag)
  installTrapdoorPassage(movements, bot)
  const climbController = installClimbableSupport(movements, bot)
  installClimbControlBridge(bot, climbController, tag)
  installHollowContainerSupport(movements, bot, { logger: console, requireActiveGoal: true })
  patchDoorRiseNeighborFilter(movements)
  // A liquid landing can be exactly four blocks below the source even with
  // maxDropDown=4. Such fork nodes require a flight callback we do not install.
  const neighbors = movements.getNeighbors.bind(movements)
  movements.getNeighbors = node => neighbors(node).filter(move => !(Number(move.controlledDropDistance) > 3))
  movementCache.set(pathfinder, movements)
  return movements
}

module.exports = warehouseMovements

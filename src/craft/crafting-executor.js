'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// crafting-executor.js — bot 端自研合成执行器（material-preparation 阶段2 · W5）
//
// 任务 8.1：处理 craft_plan 命令，全材料就位后【自底向上 · 全程过缓冲桶】合成。
//   - 材料全部堆入 buffer 桶前不开始合成（Req 14.1，由服务端在 hauling 完成后才下发
//     craft_plan 保证；本执行器把「收到 craft_plan」视为「材料已全部入 buffer 桶」）。
//   - 按 CraftPlan.craftSteps 拓扑序（叶子→…→目标）自底向上逐层合成：craftSteps 已是
//     拓扑序，顺序处理即可保证「先凑够本层全部产物再进上层」（下层产物先于上层步骤出现
//     且被完整产出后才轮到依赖它的上层步骤，Req 14.2）。
//   - 每个产物：从 buffer 桶按配方比例取「占满周转区的等比例原料」（Req 14.4）→ 2x2
//     就地合成 / 3x3 去 purpose:workstation 工作台 bot.craft（Req 14.5）→ 产物放回 buffer 桶
//     （任意时刻中间产物落在 buffer 桶、背包仅周转，Req 14.3）。
//
// ── 命令投递（照抄阶段1 inventory-executor.js，见其顶部长注释）──
// inbox 由 station-executor 作为唯一轮询者统一拉取，并按 command id 先 ack、再委派。
// 本插件不自建 inbox 轮询，而是把 handleCommand 挂到共享 bot 对象上
// （bot._craftingExecutor），避免多个 listener 抢同一条命令。ack/replay 允许 HTTP
// 响应丢失时重投同 id；执行器仍按 requestId 幂等。单长命令互斥仍由本插件自持
// （tryStartLongCommand），
// 收尾统一走 finally：关闭仍打开的容器窗口、finishLongCommand、恢复空闲态（Req 13.3）。
//
// ── 移动约束（Req 13.4）──
// 长途移动一律走标准快速三维移动（由服务端在下发 craft_plan 前把 bot 带到工作站附近）；
// 本执行器只做「就近前往 buffer 桶 / 工作台」的本地 A* 收尾，不魔改标准移动配置。
//
// ── 任务边界（W5 拆分，本文件将由 8.2 / 8.3 扩展）──
// 任务 8.1（本任务）：自底向上过缓冲桶的核心合成流程 + 单长命令互斥 + finally 收尾基础。
// 任务 8.2（SEAM：craftBatchWithRetry）：一次合成事务失败 → 点击间加延时重试最多 5 次，
//                    5 次仍失败 → 上报 craft_failed，中间产物留 buffer 桶（Req 14.6）。
// 任务 8.3（本任务 · deliverOutputs / executor_busy 收尾）：最终产物合成完成后从 buffer 桶取出并
//                    交付 purpose:output 成品容器（Req 16.3，未登记成品容器 → craft_failed
//                    reason=no_output_container，不做半成品交付）；仅交付成功后才上报 craft_completed；
//                    进行中已有长命令时拒绝并上报 executor_busy（Req 13.2）；finally 关闭交付期打开的
//                    成品容器窗口 + finishLongCommand（Req 13.3）。
//
// Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 13.1, 13.4, 16.3, 13.2, 13.3
// ─────────────────────────────────────────────────────────────────────────────

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const minecraftData = require('minecraft-data')
// Ported from olela: the station event reporter is replaced by the local sink provided
// through cfg.craftSink (see index.js). Olela relied on its own central preparation server;
// cloud-store has no such server. The affinity projection stays — it is a pure function and
// its fields are harmless when the caller does not use fencing.
const { preparationTerminalPayload, buildDepositCompletionPayload } = require('./preparation-affinity')
const { normalizeItemName, serializeItem } = require('./item-serializer')
const { guardedGoto } = require('./path/guarded-goto')
const { resolveCommandBudgetMs } = require('./command-budget')
const { CONTAINER_APPROACH_DISTANCE } = require('./path/interaction-reach')
const { createLongCommandMutex, longCommandMutexFor } = require('./path/long-command-mutex')
const { enterFullArmor, restoreEquipMode } = require('./preparation-safety')

// Ported from olela: station HTTP helpers were removed. Buffer barrels, workstations
// and output containers are now resolved from cloud-store's own chest registry through
// cfg.craftSink.resolveContainers(kind) — see src/craft/index.js.


// The preparation service is intentionally sourced from the 1.21.4 recipe
// registry.  The live server speaks protocol 1.21.11, whose minecraft-data
// recipe table currently contains shifted/incorrect entries for some recipes
// (lead was interpreted as the four-string white_wool recipe).  Keep recipe
// semantics on the planner's source registry and translate only item IDs to
// the live bot registry before clicking.
let canonicalRecipeRegistry = null
try { canonicalRecipeRegistry = minecraftData('1.21.4') } catch (_) { canonicalRecipeRegistry = null }

// 整次合成自命令下发起的预算（Req 13.3 收尾兜底双保险，服务端另有更长 GC 兜底）。
const CRAFT_TIMEOUT_MS = Number(process.env.CRAFT_PLAN_TIMEOUT_MS || 20 * 60 * 1000)
const CRAFT_MUTEX_HANDOFF_TIMEOUT_MS = Number(process.env.CRAFT_MUTEX_HANDOFF_TIMEOUT_MS || 30_000)
// Mineflayer normally bounds each inventory acknowledgement itself, but a
// plugin override or a lost event can still leave an external Promise pending.
// Keep both individual clicks and the complete one-trigger craft transaction
// below the preparation command deadline so failure reporting and mutex
// release always remain reachable.
const CRAFT_WINDOW_CLICK_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.CRAFT_WINDOW_CLICK_TIMEOUT_MS || 25_000),
)
const CRAFT_TRANSACTION_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.CRAFT_TRANSACTION_TIMEOUT_MS || 30_000),
)
// "要不要再走近点"的阈值（脚→方块中心口径）。数值与几何推导统一由 interaction-reach.js
// 提供（单一真源）。服务端方块交互上限是原版 4.5（眼睛→碰撞盒最近点，见 interaction-reach.js
// 头注释——真服实测吻合：49 次开箱成功全 ≤4.3、5.91 失败）。此处默认取
// CONTAINER_APPROACH_DISTANCE（随单一真源推导，=3.5），够近才开箱：approach 严格保守于 reach，
// 保证判成够近时服务端必定受理。
const CONTAINER_INTERACT_DISTANCE = Number(
  process.env.CRAFT_CONTAINER_INTERACT_DISTANCE || CONTAINER_APPROACH_DISTANCE,
)
// 开容器窗口超时。
const OPEN_WINDOW_TIMEOUT_MS = Number(process.env.CRAFT_OPEN_TIMEOUT_MS || 30_000)
// 单个物品堆叠上限（估算取料占用槽数用；具体物品堆叠上限差异由实机核定，这里取通用 64）。
const DEFAULT_STACK_SIZE = 64
// 周转区取料时为「合成产物落位」预留的空闲格数（避免取料把背包塞满导致产物无处落）。
const TURNOVER_OUTPUT_RESERVE = Number(process.env.CRAFT_TURNOVER_OUTPUT_RESERVE || 3)
// buffer 取料前必须保留的空槽数。crafting/deliver 的取料路径此前没有腾位闸，背包被
// 采集期杂物占满时 `可见=8,请求=8,确认=0,剩余=8，周转区已满立即交付` 重试 5 次仍失败
// （真服 short_grass 交付单取证）。取料需要把目标物搬进背包，至少要留 1 格，留 4 格
// 给多物品批次与光标暂存。
const CRAFT_WITHDRAW_MIN_FREE_SLOTS = Math.max(
  1, Number(process.env.CRAFT_WITHDRAW_MIN_FREE_SLOTS || 4))
// 取料后等待背包同步的轮询间隔。
const SYNC_SLEEP_MS = 120
// 真服批量合成的窗口槽同步可能明显滞后：16 次 3x3 事务要经过大量窗口点击与 set_slot 回包，
// 产物在 bot.craft resolve 之后仍可能延迟若干秒才落账。确认期可配置，默认 8 秒——过短会把
// 「已消耗输入、产物慢同步」误判成 ambiguous 而整单判死（本轮真服 0/16 即因 3 秒窗口过短触发）。
const CRAFT_RESULT_CONFIRM_MS = Number(process.env.CRAFT_RESULT_CONFIRM_MS || 8_000)
// 事务规模越大，窗口槽回包越多、慢同步越可能拖过固定确认窗。按「本次事务触发数 × 配方规模」给
// 每条点击链留足回包时间：单次触发下限 8s，每多一触发追加 800ms（16 触发的事务≈20.8s），
// 上限 30s 防慢服把确认期无限拉长。函数取纯以便单测钉住比例。
function craftResultConfirmMs (triggerCount) {
  const triggers = Number.isFinite(triggerCount) ? Math.max(0, Math.floor(triggerCount)) : 0
  // 基础窗已覆盖单次触发；只为「超出第一触发」的额外触发追加回包时间。
  const extra = Math.max(0, Math.min(triggers, 16) - 1) * 800
  return Math.min(CRAFT_RESULT_CONFIRM_MS + extra, 30_000)
}
// mineflayer 会在服务端最终确认前先乐观更新合成窗口/玩家背包。即使已看到足量产物，也必须等
// 输入与产物同时稳定一小段时间，避免把随后被服务器纠正回原料的本地预测当成真实产出。
const CRAFT_RESULT_SETTLE_MS = Number(process.env.CRAFT_RESULT_SETTLE_MS || 1_200)
// A server result-slot packet is authoritative; once both it and the consumed inputs agree, only
// keep a short debounce for trailing inventory packets. This removes most of the visible pause
// between successful single-trigger transactions without trusting mineflayer's optimistic delta.
const CRAFT_AUTHORITATIVE_SETTLE_MS = Math.min(
  CRAFT_RESULT_SETTLE_MS,
  Math.max(120, Number(process.env.CRAFT_AUTHORITATIVE_SETTLE_MS || 360)),
)
function craftResultSettleMs (serverTriggers) {
  return Number(serverTriggers) > 0 ? CRAFT_AUTHORITATIVE_SETTLE_MS : CRAFT_RESULT_SETTLE_MS
}
// 一次合成事务失败后的最大重试次数（Req 14.6：最多重试 5 次）。
const MAX_CRAFT_RETRIES = Number(process.env.CRAFT_MAX_RETRIES || 5)
// 单次 bot.craft 的最大配方触发数。大批量一次点击在真服会出现“部分输出已确认但输入已继续消耗”，
// 小批事务把损失边界压到一组，并与已稳定实测的 16 次 bamboo_slab 批量一致。
const MAX_CRAFT_BATCH_TRIGGERS = Number(process.env.CRAFT_MAX_BATCH_TRIGGERS || 16)
// 合成事务重试时「合成点击之间」的延时（Req 14.6 / §11.4）。
const CRAFT_RETRY_DELAY_MS = Number(process.env.CRAFT_RETRY_DELAY_MS || 500)
// mineflayer 原生 craft 会连续乐观发送窗口点击；真服可能只接受其中一部分，却仍在本地生成完整产物。
// 对单次事务内部的每次后续 clickWindow 加短间隔，让服务端有时间确认配方格变化。
const CRAFT_CLICK_DELAY_MS = Number(process.env.CRAFT_CLICK_DELAY_MS || 150)

// 合成回包追踪始终开启：mineflayer 的 bot.craft 是本地伪造产物的，服务端合成窗口产物槽（slot 0）
// 的回包是唯一的权威产出信号，已是判定必需品。CRAFT_PACKET_TRACE=0 只关掉那行紧凑诊断摘要。
// 追踪监听贯穿整个结果确认期（本身就在轮询等待），因此不再额外给每笔事务加固定尾延时。
const CRAFT_PACKET_TRACE = process.env.CRAFT_PACKET_TRACE !== '0'
// Mineflayer 容器点击也会先乐观更新本地窗口。容器移动必须在双侧同向变化且光标为空后，
// 保持稳定一段时间才确认；不能再以任一侧变化或 deposit/withdraw promise 作为成功依据。
const CRAFT_WINDOW_MOVE_CONFIRM_MS = Number(process.env.CRAFT_WINDOW_MOVE_CONFIRM_MS || 3_000)
const CRAFT_WINDOW_MOVE_SETTLE_MS = Number(process.env.CRAFT_WINDOW_MOVE_SETTLE_MS || 1_200)
// 合成格回收同样受服务端窗口回包约束。clickWindow resolve 只代表点击已发送，不能证明
// set_slot/set_content 已把格子和光标稳定到最终状态。
const CRAFT_GRID_RECLAIM_CONFIRM_MS = Number(process.env.CRAFT_GRID_RECLAIM_CONFIRM_MS || 3_000)
const CRAFT_GRID_RECLAIM_SETTLE_MS = Number(process.env.CRAFT_GRID_RECLAIM_SETTLE_MS || 1_200)
const CRAFT_GRID_RECLAIM_POLL_MS = Number(process.env.CRAFT_GRID_RECLAIM_POLL_MS || SYNC_SLEEP_MS)
// 融合库存提示可能过期；已知桶全部尝试后，只探测有限个最近 fallback，禁止账实不符时扫完整个仓库。
// 真服 shears 成品入桶 0/8 取证：8 个最近桶全满时直接失败。与 inventory-executor 的
// 目的桶候选对齐到 24，在 120 桶仓库里显著提高成功率。
const MAX_WITHDRAW_FALLBACK_BARRELS = Number(process.env.CRAFT_WITHDRAW_FALLBACK_BARRELS || 24)
// 主流程失败后用独立短预算把本命令背包增量放回 buffer；不能沿用已经耗尽的主 deadline。
const FAILURE_CLEANUP_MS = Number(process.env.CRAFT_FAILURE_CLEANUP_MS || 90_000)

// 合成流程内的结构化失败：携带上报用 reason，与「意外异常」区分。
class CraftError extends Error {
  constructor (reason) {
    super(reason)
    this.name = 'CraftError'
    this.reason = reason
    this.isCraftError = true
  }
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function boundedOperationTimeoutError (reason, timeoutMs) {
  return new CraftError(`${reason}:${Math.max(1, Math.floor(timeoutMs))}ms`)
}

async function runBoundedOperation (
  operation,
  timeoutMs,
  reason = 'external_operation_timeout',
  setTimer = setTimeout,
  clearTimer = clearTimeout,
) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function')
  const limit = Math.max(1, Math.floor(Number(timeoutMs) || 1))
  const pending = Promise.resolve().then(operation)
  // Promise.race observes the original rejection only while the race is live.
  // Keep a permanent rejection observer for operations that settle after the
  // caller has already timed out and released the long-command mutex.
  pending.catch(() => {})
  let timer = null
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimer(() => reject(boundedOperationTimeoutError(reason, limit)), limit)
      }),
    ])
  } finally {
    if (timer != null) clearTimer(timer)
  }
}

async function waitForLongCommandHandoff (mutex, timeoutMs = CRAFT_MUTEX_HANDOFF_TIMEOUT_MS) {
  if (!mutex || typeof mutex.isBusy !== 'function' || !mutex.isBusy()) return true
  if (typeof mutex.waitForIdle !== 'function') return false
  let timer = null
  try {
    await Promise.race([
      mutex.waitForIdle(),
      new Promise(resolve => { timer = setTimeout(resolve, Math.max(1, timeoutMs)) }),
    ])
    return !mutex.isBusy()
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

function createThrottledClickWindow (
  clickWindow,
  delayMs = CRAFT_CLICK_DELAY_MS,
  wait = sleep,
  timeoutMs = CRAFT_WINDOW_CLICK_TIMEOUT_MS,
) {
  if (typeof clickWindow !== 'function') throw new TypeError('clickWindow must be a function')
  const delay = Number.isFinite(delayMs) ? Math.max(0, Math.floor(delayMs)) : 0
  let first = true
  return async function throttledClickWindow (...args) {
    if (!first && delay > 0) await wait(delay)
    first = false
    const receiver = this
    return runBoundedOperation(
      () => clickWindow.apply(receiver, args),
      timeoutMs,
      'window_click_timeout',
    )
  }
}

// 只接受容器与背包两侧方向一致的交集数量。单侧乐观变化不得记账。
function confirmedMoveFromCounts ({
  requested,
  beforeContainer,
  beforeBackpack,
  nowContainer,
  nowBackpack,
  direction,
} = {}) {
  const limit = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0
  if (limit <= 0 || (direction !== 'withdraw' && direction !== 'deposit')) return 0
  const containerDelta = direction === 'withdraw'
    ? Math.max(0, beforeContainer - nowContainer)
    : Math.max(0, nowContainer - beforeContainer)
  const backpackDelta = direction === 'withdraw'
    ? Math.max(0, nowBackpack - beforeBackpack)
    : Math.max(0, beforeBackpack - nowBackpack)
  return Math.min(limit, containerDelta, backpackDelta)
}

/**
 * 窗口移动确认状态机（纯逻辑，供单测）。
 *
 * observe(moved, cursorEmpty) 逐次喂入 confirmedMoveFromCounts 的观测：
 *   - 双侧同向确认且光标为空、且同一数值持续 settleMs → { settled: true }，可立即采用
 *   - 其余情况只累积，不下结论
 *
 * expired() 是确认窗口耗尽时的取值口径：必须交出最近一次「双侧同向 + 光标为空」的观测，
 * 不能记 0。settle 只是在双侧一致之上多加一层「稳定持续时长」，窗口耗尽不构成把已经
 * 双侧确认过的真实移动作废的理由；记 0 会让调用方少算并提前中断取料 —— 真服 oak_stairs
 * 的 insufficient_buffer_materials:5/6 差的正是慢同步的最后一手。
 */
function createWindowMoveConfirmer ({ settleMs = 0, now = Date.now } = {}) {
  const settle = Math.max(0, Number(settleMs) || 0)
  const clock = typeof now === 'function' ? now : Date.now
  let stableMoved = 0
  let stableSince = 0
  let lastConfirmed = 0
  return {
    observe (moved, cursorEmpty) {
      const value = Number.isFinite(moved) ? Math.max(0, Math.trunc(moved)) : 0
      if (value > 0 && cursorEmpty) {
        lastConfirmed = value
        if (value !== stableMoved) {
          stableMoved = value
          stableSince = clock()
          return { settled: false, value }
        }
        if (clock() - stableSince >= settle) return { settled: true, value }
        return { settled: false, value }
      }
      stableMoved = 0
      stableSince = 0
      lastConfirmed = 0
      return { settled: false, value: 0 }
    },
    expired () {
      return lastConfirmed > 0 ? lastConfirmed : 0
    },
  }
}

function safeNbtEqual (a, b, depth = 0, seen = null) {
  if (a === b) return true
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false
  if (depth > 12) return false
  seen = seen || new Set()
  if (seen.has(a) || seen.has(b)) return false
  seen.add(a)
  seen.add(b)
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    const av = a[key]
    const bv = b[key]
    if (av && bv && typeof av === 'object' && typeof bv === 'object') {
      if (!safeNbtEqual(av, bv, depth + 1, seen)) return false
    } else if (av !== bv) {
      return false
    }
  }
  return true
}

function sameStackKind (a, b) {
  if (!a || !b || a.type !== b.type || a.metadata !== b.metadata) return false
  return safeNbtEqual(a.nbt == null ? null : a.nbt, b.nbt == null ? null : b.nbt)
}

function transferRanges (window, direction) {
  const inventoryStart = Number.isInteger(window && window.inventoryStart) ? window.inventoryStart : 0
  const inventoryEnd = Number.isInteger(window && window.inventoryEnd)
    ? window.inventoryEnd
    : ((window && Array.isArray(window.slots)) ? window.slots.length : inventoryStart)
  return direction === 'withdraw'
    ? { sourceStart: 0, sourceEnd: inventoryStart, destStart: inventoryStart, destEnd: inventoryEnd }
    : { sourceStart: inventoryStart, sourceEnd: inventoryEnd, destStart: 0, destEnd: inventoryStart }
}

function destinationCapacity (window, template, start, end) {
  let capacity = 0
  const stackSize = Math.max(1, Number(template && template.stackSize) || DEFAULT_STACK_SIZE)
  for (let slot = start; slot < end; slot++) {
    const item = window.slots[slot]
    if (!item) capacity += stackSize
    else if (sameStackKind(item, template)) capacity += Math.max(0, (Number(item.stackSize) || stackSize) - item.count)
  }
  return capacity
}

function transferableWindowCount (window, sourceSlot, requested, direction) {
  const count = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0
  if (count <= 0 || !window || !Array.isArray(window.slots)) return 0
  const ranges = transferRanges(window, direction)
  if (!Number.isInteger(sourceSlot) || sourceSlot < ranges.sourceStart || sourceSlot >= ranges.sourceEnd) return 0
  const template = window.slots[sourceSlot]
  if (!template || !(template.count > 0)) return 0
  const capacity = destinationCapacity(window, template, ranges.destStart, ranges.destEnd)
  return Math.min(count, Math.max(0, Math.floor(template.count)), capacity)
}

function isWindowTransferDestinationFull (window, sourceSlot, direction) {
  if (!window || !Array.isArray(window.slots) || !Number.isInteger(sourceSlot)) return false
  const source = window.slots[sourceSlot]
  return Boolean(
    source && source.count > 0 &&
    transferableWindowCount(window, sourceSlot, 1, direction) <= 0
  )
}

function findTransferSlot (window, template, start, end) {
  for (let slot = start; slot < end; slot++) {
    const item = window.slots[slot]
    if (sameStackKind(item, template) && item.count < (Number(item.stackSize) || DEFAULT_STACK_SIZE)) return slot
  }
  for (let slot = start; slot < end; slot++) {
    if (!window.slots[slot]) return slot
  }
  return null
}

// 把光标物安全放回优先槽或背包。只合并同类堆/使用空槽，绝不交换杂物，更绝不点 -999。
async function parkWindowCursor (bot, window, preferredSlots = [], opts = {}) {
  if (!window || !window.selectedItem) return true
  if (!bot || typeof bot.clickWindow !== 'function') throw new CraftError('window_cursor_no_click_api')
  const click = opts.clickWindow || createThrottledClickWindow(
    bot.clickWindow,
    opts.delayMs == null ? CRAFT_CLICK_DELAY_MS : opts.delayMs,
    opts.wait || sleep,
  )
  const ranges = transferRanges(window, 'deposit')
  const candidates = []
  const add = (slot, allowOutsideBackpack = false) => {
    const valid = Number.isInteger(slot) && slot >= 0 && slot < window.slots.length
    const inBackpack = valid && slot >= ranges.sourceStart && slot < ranges.sourceEnd
    if (valid && (allowOutsideBackpack || inBackpack) && !candidates.includes(slot)) candidates.push(slot)
  }
  // 原始来源槽即使位于容器段也可优先回放；通用兜底只使用玩家背包。
  for (const slot of preferredSlots) add(slot, true)
  for (let slot = ranges.sourceStart; slot < ranges.sourceEnd; slot++) {
    const item = window.slots[slot]
    if (sameStackKind(item, window.selectedItem) && item.count < (Number(item.stackSize) || DEFAULT_STACK_SIZE)) add(slot)
  }
  for (let slot = ranges.sourceStart; slot < ranges.sourceEnd; slot++) {
    if (!window.slots[slot]) add(slot)
  }
  for (const slot of candidates) {
    if (!window.selectedItem) return true
    const target = window.slots[slot]
    if (target && (!sameStackKind(target, window.selectedItem) || target.count >= (Number(target.stackSize) || DEFAULT_STACK_SIZE))) continue
    await click.call(bot, slot, 0, 0)
  }
  if (window.selectedItem) throw new CraftError(`window_cursor_unrecoverable:${window.selectedItem.name || window.selectedItem.type || 'unknown'}`)
  return true
}

// 不使用 window.withdraw/deposit：其内部闭包 clickWindow 绕过 gear-guard/节流，并可能在满目的端时 -999。
// 这里通过当前 bot.clickWindow 精确移动，异常时只回收光标；真实成功量仍由后续双侧稳定确认决定。
async function transferWindowItem (bot, window, sourceSlot, requested, direction, opts = {}) {
  const count = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0
  if (count <= 0) return 0
  if (!window || !Array.isArray(window.slots)) throw new CraftError('window_transfer_invalid_window')
  if (window.selectedItem) throw new CraftError('window_transfer_cursor_not_empty')
  const ranges = transferRanges(window, direction)
  if (!Number.isInteger(sourceSlot) || sourceSlot < ranges.sourceStart || sourceSlot >= ranges.sourceEnd) {
    throw new CraftError('window_transfer_invalid_source')
  }
  const template = window.slots[sourceSlot]
  if (!template || template.count < count) throw new CraftError(`window_transfer_source_short:${template ? template.count : 0}/${count}`)
  const capacity = destinationCapacity(window, template, ranges.destStart, ranges.destEnd)
  if (capacity < count) throw new CraftError(`window_transfer_destination_full:${capacity}/${count}`)

  const click = createThrottledClickWindow(
    bot.clickWindow,
    opts.delayMs == null ? CRAFT_CLICK_DELAY_MS : opts.delayMs,
    opts.wait || sleep,
  )
  let remaining = count
  try {
    await click.call(bot, sourceSlot, 0, 0)
    while (remaining > 0) {
      const cursor = window.selectedItem
      if (!sameStackKind(cursor, template)) throw new CraftError('window_transfer_cursor_desync')
      const destSlot = findTransferSlot(window, cursor, ranges.destStart, ranges.destEnd)
      if (destSlot == null) throw new CraftError('window_transfer_destination_full_during_move')
      const dest = window.slots[destSlot]
      const capacityHere = dest
        ? Math.max(0, (Number(dest.stackSize) || DEFAULT_STACK_SIZE) - dest.count)
        : (Number(cursor.stackSize) || DEFAULT_STACK_SIZE)
      const movable = Math.min(cursor.count, capacityHere)
      if (movable <= remaining) {
        await click.call(bot, destSlot, 0, 0)
        remaining -= movable
      } else {
        while (remaining > 0) {
          await click.call(bot, destSlot, 1, 0)
          remaining -= 1
        }
      }
    }
    await parkWindowCursor(bot, window, [sourceSlot], { clickWindow: click })
    return count
  } catch (error) {
    try {
      await parkWindowCursor(bot, window, [sourceSlot], { clickWindow: click })
    } catch (parkError) {
      throw parkError
    }
    throw error
  }
}

// 合成窗口（玩家 2x2 = 窗口 0、工作台 3x3）产物槽固定为 0，合成格从 1 开始。
function isCraftingTableWindow (window) {
  const type = (window && typeof window.type === 'string') ? window.type : ''
  return type.startsWith('minecraft:crafting')
}

// 事务前后都必须清空合成格：滞留在格子里的原料不出现在 bot.inventory.items() 里，会被记成
// 「已消耗」，而下一单往别的格子再放就永远凑不成配方 —— 真服 oak_button 的永久失败循环即此。
// 取不回就以 crafting_grid_stuck 明确失败，绝不无声丢件。别的容器窗口开着时不动手：clickWindow
// 作用于 currentWindow，会打到那个容器上。
async function reclaimCraftingGrid (bot, opts = {}) {
  const current = bot && bot.currentWindow
  const isTable = isCraftingTableWindow(current)
  if (current && !isTable) return []
  const window = isTable ? current : (bot && bot.inventory)
  if (!window || !Array.isArray(window.slots)) return []
  const click = opts.clickWindow || createThrottledClickWindow(
    bot.clickWindow,
    opts.delayMs == null ? CRAFT_CLICK_DELAY_MS : opts.delayMs,
    opts.wait || sleep,
  )
  const gridEnd = Math.min(window.slots.length, isTable ? 10 : 5)
  const wait = opts.wait || sleep
  const confirmMs = Number.isFinite(opts.confirmMs)
    ? Math.max(0, Math.floor(opts.confirmMs))
    : CRAFT_GRID_RECLAIM_CONFIRM_MS
  const settleMs = Number.isFinite(opts.settleMs)
    ? Math.max(0, Math.floor(opts.settleMs))
    : CRAFT_GRID_RECLAIM_SETTLE_MS
  const pollMs = Number.isFinite(opts.pollMs)
    ? Math.max(1, Math.floor(opts.pollMs))
    : CRAFT_GRID_RECLAIM_POLL_MS
  const reclaimed = []
  for (let slot = 1; slot < gridEnd; slot++) {
    const stuck = window.slots[slot]
    if (!stuck || !(stuck.count > 0)) continue
    const label = `${normalizeItemName(stuck.name) || 'unknown'}x${stuck.count}`
    try {
      await click.call(bot, slot, 0, 0)
      await parkWindowCursor(bot, window, [], { clickWindow: click })
    } catch (_) {
      // 背包确实放不下时，把仍在光标上的原料放回原格，失败也不能把物品悬在光标上。
      if (window.selectedItem) {
        try { await parkWindowCursor(bot, window, [slot], { clickWindow: click }) } catch (_) { /* report below */ }
      }
      throw new CraftError(`crafting_grid_stuck:${slot}:${label}`)
    }

    const deadline = Date.now() + confirmMs
    let stableSince = null
    while (true) {
      if (window.selectedItem) {
        try {
          await parkWindowCursor(bot, window, [], { clickWindow: click })
        } catch (_) {
          try { await parkWindowCursor(bot, window, [slot], { clickWindow: click }) } catch (_) { /* report below */ }
          throw new CraftError(`crafting_grid_stuck:${slot}:${label}`)
        }
      }
      if (!window.slots[slot] && !window.selectedItem) {
        if (stableSince == null) stableSince = Date.now()
        if (Date.now() - stableSince >= settleMs) break
      } else {
        stableSince = null
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw new CraftError(`crafting_grid_stuck:${slot}:${label}`)
      await wait(Math.min(pollMs, remainingMs))
    }
    reclaimed.push(`${slot}:${label}`)
  }
  // 事务之间绝不留着工作台窗口：留着会让下一次 activateBlock 拿不到 windowOpen。
  if (isTable) safeCloseWindow(window)
  return reclaimed
}

// mineflayer 的 putSelectedItemRange / putAway 在目的区放不下时会 clickWindow(-999) 把原料或产物
// 直接丢到地上，且走的是模块闭包 clickWindow —— 包装 bot.clickWindow 拦不住，gear-guard 的 -999
// 出口闸也不含合成物资。合成事务期间换成只落背包/来源槽的实现：真放不下就失败，绝不丢地上。
function installCraftLeftoverGuard (bot, click) {
  const originalPutAway = bot.putAway
  const originalPutSelectedItemRange = bot.putSelectedItemRange
  const park = (window, sourceSlot) => parkWindowCursor(
    bot,
    window || bot.currentWindow || bot.inventory,
    Number.isInteger(sourceSlot) ? [sourceSlot] : [],
    { clickWindow: click },
  )
  const putSelectedItemRange = async function craftPutSelectedItemRange (start, end, window, slot) {
    await park(window, slot)
  }
  const putAway = async function craftPutAway (slot) {
    const window = bot.currentWindow || bot.inventory
    await click.call(bot, slot, 0, 0)
    await park(window, null)
  }
  bot.putSelectedItemRange = putSelectedItemRange
  bot.putAway = putAway
  return function restoreCraftLeftoverGuard () {
    if (bot.putSelectedItemRange === putSelectedItemRange) bot.putSelectedItemRange = originalPutSelectedItemRange
    if (bot.putAway === putAway) bot.putAway = originalPutAway
  }
}

// 抓取合成事务期间的服务端窗口回包。除诊断摘要外，结构化记录「合成窗口产物槽（slot 0）」的每一次
// 回包：mineflayer 的 bot.craft 无论服务端是否真产出都会本地伪造产物（craft.js grabResult 直接
// window.updateSlot(0, ...) 再 putAway），所以只有这条回包能证明服务端真的凑成了配方。
// 产物槽观测不去重也不设上限——多记只会被「输入真实消耗」的交集夹掉，少记却会让已成功的事务被
// 重放并超产。
function startCraftPacketTrace (bot, fixedCraftWindowId = null) {
  const events = []
  const listeners = []
  const botListeners = []
  const craftWindowIds = new Set()
  const resultSlotItems = []
  if (Number.isInteger(fixedCraftWindowId)) craftWindowIds.add(fixedCraftWindowId)
  const push = (label) => { if (events.length < 80) events.push(label) }
  const itemOf = (item) => {
    if (!item || item.present === false) return null
    const count = Number(item.itemCount != null ? item.itemCount : item.count)
    if (!(count > 0)) return null
    const id = item.itemId != null ? item.itemId : (item.blockId != null ? item.blockId : item.id)
    const entry = bot.registry && bot.registry.items && bot.registry.items[id]
    return { name: entry ? normalizeItemName(entry.name) : `id${id}`, count }
  }
  const itemLabel = (item) => {
    const parsed = itemOf(item)
    return parsed ? `${parsed.name}x${parsed.count}` : 'empty'
  }
  // 少认一个窗口号就会把成功的事务判成「服务端零产出」并重放超产，所以除了开窗回包认领的窗口号，
  // 还兜底认当前打开的工作台窗口（mineflayer 的开窗监听先于本追踪注册，此刻 currentWindow 已更新）。
  const isCraftWindowId = (windowId) => {
    if (craftWindowIds.has(windowId)) return true
    const current = bot.currentWindow
    return isCraftingTableWindow(current) && current.id === windowId
  }
  // 按产物槽的「状态变更」计数，而不是按回包次数：服务端每次 set_slot 之后往往还会补一个整窗
  // set_content 重述同一内容,按包计会把一次产出记成两次。真实的连续产出之间必有 empty(产物被取走),
  // 所以只在内容真的变了时才计一次。多认会被输入消耗夹掉不至于超产,但会让账实比对天天误报。
  let lastResultKey = null
  const observeSlot = (windowId, slot, item) => {
    if (slot !== 0 || !isCraftWindowId(windowId)) return
    const parsed = itemOf(item)
    const key = parsed ? `${parsed.name}x${parsed.count}` : 'empty'
    if (key === lastResultKey) return
    lastResultKey = key
    if (parsed) resultSlotItems.push(parsed)
  }
  const on = (name, fn) => {
    bot._client.on(name, fn)
    listeners.push([name, fn])
  }
  const onBot = (name, fn) => {
    if (!bot || typeof bot.on !== 'function') return
    bot.on(name, fn)
    botListeners.push([name, fn])
  }
  const onSetSlot = (p) => {
    push(`set_slot(w${p.windowId},s${p.slot},${itemLabel(p.item)})`)
    observeSlot(p.windowId, p.slot, p.item)
  }
  on('container_set_slot', onSetSlot)
  on('set_slot', onSetSlot)
  // 整窗回包必须解出前若干个非空槽：只有这样才能看出服务端到底把原料放到了哪一格、
  // 产物槽（合成输出）是否真的有东西。否则「服务端零效果」永远只能靠猜。
  const onContent = (p) => {
    const items = Array.isArray(p.items) ? p.items : []
    const parts = []
    for (let i = 0; i < items.length && parts.length < 10; i++) {
      const label = itemLabel(items[i])
      if (label !== 'empty') parts.push(`${i}:${label}`)
    }
    push(`set_content(w${p.windowId},n${items.length}${parts.length ? ',' + parts.join(' ') : ''})`)
    if (items.length > 0) observeSlot(p.windowId, 0, items[0])
  }
  on('container_set_content', onContent)
  on('window_items', onContent)
  on('set_cursor_item', (p) => push(`cursor(${itemLabel(p.contents || p.item)})`))
  on('place_ghost_recipe', () => push('ghost_recipe'))
  // 1.21.4 的开窗回包叫 open_window；open_screen 是更新版协议的名字，两个都收。
  const onOpenWindow = (p) => {
    if (Number.isInteger(p.windowId)) craftWindowIds.add(p.windowId)
    push(`open_window(w${p.windowId},t${p.inventoryType != null ? p.inventoryType : '?'})`)
  }
  on('open_window', onOpenWindow)
  on('open_screen', onOpenWindow)
  // ViaVersion/protocol bridges do not always expose the raw open packet under
  // either name above, while Mineflayer must emit windowOpen before bot.craft
  // can continue. Register that authoritative window id as a second source.
  onBot('windowOpen', (window) => {
    if (!isCraftingTableWindow(window) || !Number.isInteger(window.id)) return
    craftWindowIds.add(window.id)
    push(`windowOpen(w${window.id},t${window.type || '?'})`)
  })
  on('close_window', (p) => push(`close(w${p.windowId})`))
  on('transaction', (p) => push(`transaction(accepted=${p.accepted})`))
  on('systemChat', () => push('systemChat'))
  return {
    summary: () => (events.length === 0 ? '无窗口回包（服务端完全没有响应点击）' : events.join(' ')),
    resultTriggers: (name) => {
      const target = normalizeItemName(name)
      let count = 0
      for (const item of resultSlotItems) if (item.name === target) count += 1
      return count
    },
    stop: () => {
      for (const [name, fn] of listeners) bot._client.removeListener(name, fn)
      for (const [name, fn] of botListeners) bot.removeListener(name, fn)
    },
  }
}

async function closeWindowAfterCursorPark (bot, window, beforeClose = null) {
  if (!window) return
  let parkError = null
  try { await parkWindowCursor(bot, window) } catch (error) { parkError = error }
  if (typeof beforeClose === 'function') beforeClose()
  if (parkError) throw parkError
  safeCloseWindow(window)
}

// 单长命令互斥闸门（Req 13.2 / 13.3）已抽到 ../path/long-command-mutex.js 供 bot 级共享。

// 安全关窗：忽略任何异常（收尾兜底统一入口，Req 13.3）。
function safeCloseWindow (win) {
  if (!win) return
  try { win.close() } catch (_) { /* ignore */ }
}

// ── 纯逻辑（便于单测，任务 8.4）─────────────────────────────────────────────

// 工作台候选换台的判据：只有「方块实测不是工作台 / 工作台方块缺失」才值得换下一台。
// 其他失败（寻路超时、站位不可达、开箱失败）不代表这台坏了，换台同样会失败且更费预算。
function isWorkstationSwitchableReason (reason) {
  const r = String(reason || '')
  return r.startsWith('workstation_block_mismatch') || r.startsWith('workstation_block_missing')
}

// 容器方块中心点（用于 lookAt 与交互距离判定）。
function containerCenter (blockPos) {
  return { x: blockPos.x + 0.5, y: blockPos.y + 0.5, z: blockPos.z + 0.5 }
}

// 背包中某物品当前数量（取料前后做差、达标判定用）。
function countInventoryItem (bot, name) {
  const target = normalizeItemName(name)
  const items = (bot && bot.inventory && typeof bot.inventory.items === 'function') ? bot.inventory.items() : []
  let total = 0
  for (const it of items) {
    if (it && normalizeItemName(it.name) === target && it.count > 0) total += it.count
  }
  return total
}

function inventoryBaselineCounts (bot) {
  const counts = new Map()
  const items = (bot && bot.inventory && typeof bot.inventory.items === 'function') ? bot.inventory.items() : []
  for (const item of items) {
    const name = normalizeItemName(item && item.name)
    const count = Math.max(0, Math.floor(Number(item && item.count) || 0))
    if (!name || count <= 0) continue
    counts.set(name, (counts.get(name) || 0) + count)
  }
  return counts
}

// 合成只能消费本命令开始后从 buffer 取入或本命令合成出的数量。旧背包同名物作为数量基线
// 保留；物品实体虽不可区分，但只要始终让 current-baseline 负担配方，命令结束时旧数量仍在。
function countInventoryAboveBaseline (bot, name, baselineCounts) {
  const target = normalizeItemName(name)
  const baseline = baselineCounts instanceof Map ? Math.max(0, baselineCounts.get(target) || 0) : 0
  return Math.max(0, countInventoryItem(bot, target) - baseline)
}

// 失败清理只处理本命令可能持有的配方输入/中间产物/目标物，并严格按 current-baseline 计数。
function taskItemNames (craftSteps, targetName) {
  const names = new Set()
  for (const step of Array.isArray(craftSteps) ? craftSteps : []) {
    for (const input of (step && Array.isArray(step.inputs)) ? step.inputs : []) {
      for (const name of Array.isArray(input && input.names) ? input.names : []) {
        const normalized = normalizeItemName(name)
        if (normalized) names.add(normalized)
      }
    }
    const result = normalizeItemName(step && step.result && step.result.name)
    if (result) names.add(result)
  }
  const target = normalizeItemName(targetName)
  if (target) names.add(target)
  return [...names]
}

function taskItemCountsAboveBaseline (bot, names, baselineCounts) {
  const counts = new Map()
  for (const name of normalizedNameSet(names)) {
    const count = countInventoryAboveBaseline(bot, name, baselineCounts)
    if (count > 0) counts.set(name, count)
  }
  return counts
}

// 运维恢复参数：--recover-buffer=<item>:<quantity>:<expectedBaseline>。
// expectedBaseline 是事故前已记录的旧库存；恢复量始终夹在 current-baseline 内，重复启动也不会吞旧物。
function parseRecoveredBufferArg (argv = process.argv) {
  const prefix = '--recover-buffer='
  const raw = (Array.isArray(argv) ? argv : []).find(arg => typeof arg === 'string' && arg.startsWith(prefix))
  if (!raw) return null
  const value = raw.slice(prefix.length)
  const baselineSplit = value.lastIndexOf(':')
  if (baselineSplit <= 0) return null
  const quantitySplit = value.lastIndexOf(':', baselineSplit - 1)
  if (quantitySplit <= 0) return null
  const itemName = normalizeItemName(value.slice(0, quantitySplit))
  const quantity = Number(value.slice(quantitySplit + 1, baselineSplit))
  const expectedBaseline = Number(value.slice(baselineSplit + 1))
  if (!itemName || !Number.isInteger(quantity) || quantity <= 0 ||
      !Number.isInteger(expectedBaseline) || expectedBaseline < 0) return null
  return { itemName, quantity, expectedBaseline }
}

// 当前容器窗口背包段 / 容器段计数。容器 GUI 打开期间 bot.inventory 可能要到关窗后才同步，
// 因此所有取存确认都必须以 window.slots 为准。
// 把「服务端按 vanilla 物品 tag 给出的可接受原料名集合」收窄到「bot 自己的配方表真的能用的那些」
// （纯函数，供单测）。
//
// 服务端规划器按 vanilla tag 展开原料，例如 `oak_planks` 的原料是 `#oak_logs`，四个变体
// （oak_log / oak_wood / stripped_oak_log / stripped_oak_wood）都合法。但 **minecraft-data
// 的配方表并没有把 tag 展开**：实测 1.21.4 的 `oak_planks` 只有一条配方、原料只认 `oak_log`。
// 于是「buffer 里恰好只有 stripped_oak_log」时，bot 会老老实实取它，然后 `bot.recipesFor`
// 返回空 —— 整单死于 `recipe_unavailable`，而日志上看只是「取料成功了然后配方没了」，
// 极难定位（真服 cyc76 就是这样：确认取到 stripped_oak_log ×1，随即 recipe_unavailable）。
//
// 因此取料前必须先按「本地配方表真能吃」过滤候选名。取不到交集时**返回原集合**（fail-open）：
// 配方数据缺失/异形时保持改动前行为，不因为看不懂就把本来能做的单判死。
function craftableInputNames (recipesForResult, candidateNames, nameOfId) {
  const candidates = (Array.isArray(candidateNames) ? candidateNames : [])
    .map(normalizeItemName)
    .filter(Boolean)
  if (candidates.length <= 1) return candidates
  const recipes = Array.isArray(recipesForResult) ? recipesForResult : []
  if (recipes.length === 0 || typeof nameOfId !== 'function') return candidates
  const encodable = new Set()
  for (const recipe of recipes) {
    const raw = []
    if (Array.isArray(recipe && recipe.ingredients)) raw.push(...recipe.ingredients)
    if (Array.isArray(recipe && recipe.inShape)) {
      for (const row of recipe.inShape) {
        if (Array.isArray(row)) raw.push(...row)
      }
    }
    for (const entry of raw) {
      if (entry == null) continue
      const id = (typeof entry === 'object') ? entry.id : entry
      if (id == null || id === -1) continue
      const name = normalizeItemName(nameOfId(id) || '')
      if (name) encodable.add(name)
    }
  }
  if (encodable.size === 0) return candidates
  const usable = candidates.filter(n => encodable.has(n))
  return usable.length > 0 ? usable : candidates
}

function normalizedNameSet (names) {
  const values = names instanceof Set ? [...names] : (Array.isArray(names) ? names : [names])
  return new Set(values.map(normalizeItemName).filter(Boolean))
}

function rebindRecipeAlternatives (recipe, step, nameOfLiveId, liveIdOfName, countOfName) {
  if (!recipe || !step || !Array.isArray(step.inputs)) return recipe
  const bindings = []
  for (const input of step.inputs) {
    const candidates = (Array.isArray(input && input.names) ? input.names : [])
      .map(normalizeItemName)
      .filter(Boolean)
    if (candidates.length <= 1) continue
    let selected = null
    let selectedCount = 0
    for (const name of candidates) {
      const count = Math.max(0, Number(countOfName(name)) || 0)
      if (count > selectedCount) {
        selected = name
        selectedCount = count
      }
    }
    if (selected && selectedCount > 0) bindings.push({ candidates: new Set(candidates), selected })
  }
  if (bindings.length === 0) return recipe

  let changed = false
  const remap = (entry) => {
    if (!entry || typeof entry !== 'object' || entry.id == null || entry.id === -1) return entry
    const current = normalizeItemName(nameOfLiveId(entry.id) || '')
    const binding = bindings.find(value => value.candidates.has(current))
    if (!binding || binding.selected === current) return entry
    const id = liveIdOfName(binding.selected)
    if (!Number.isInteger(id)) return entry
    changed = true
    return { ...entry, id }
  }
  const inShape = Array.isArray(recipe.inShape)
    ? recipe.inShape.map(row => Array.isArray(row) ? row.map(remap) : row)
    : recipe.inShape
  const ingredients = Array.isArray(recipe.ingredients)
    ? recipe.ingredients.map(remap)
    : recipe.ingredients
  return changed
    ? Object.assign(Object.create(Object.getPrototypeOf(recipe)), recipe, { inShape, ingredients })
    : recipe
}

function outputItemCapacity (snapshot, itemName, stackSizeOf = () => DEFAULT_STACK_SIZE) {
  const target = normalizeItemName(itemName)
  const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
  const totalSlots = Number(snapshot && snapshot.totalSlots)
  const maxStack = Math.max(1, Math.floor(Number(stackSizeOf(target)) || DEFAULT_STACK_SIZE))
  const freeSlots = Number.isFinite(totalSlots)
    ? Math.max(0, Math.floor(totalSlots) - items.length)
    : 0
  const partial = items.reduce((sum, item) => {
    if (normalizeItemName(item && item.name) !== target) return sum
    return sum + Math.max(0, maxStack - Math.max(0, Math.floor(Number(item && item.count) || 0)))
  }, 0)
  return partial + freeSlots * maxStack
}

// Recipe inputs already collected for the current step are transaction state,
// not clutter. Keep them out of the spill set while fetching later inputs.
function spillableInventoryCounts (items, keepNames, isProtectedName, deliverableNames) {
  const keep = normalizedNameSet(keepNames)
  const deliverables = normalizedNameSet(deliverableNames)
  const byName = new Map()
  for (const item of (Array.isArray(items) ? items : [])) {
    if (!item || !item.count) continue
    const name = normalizeItemName(item.name)
    if (!name || keep.has(name)) continue
    const protectedGear = typeof isProtectedName === 'function' && isProtectedName(name)
    if (protectedGear && !deliverables.has(name)) continue
    byName.set(name, (byName.get(name) || 0) + Math.max(0, Math.trunc(item.count || 0)))
  }
  return byName
}

function countWindowItems (window, names, backpack) {
  if (!window || !Array.isArray(window.slots)) return 0
  const accepted = normalizedNameSet(names)
  const invStart = Number.isInteger(window.inventoryStart) ? window.inventoryStart : window.slots.length
  const start = backpack ? invStart : 0
  const end = backpack ? window.slots.length : invStart
  let total = 0
  for (let i = start; i < end; i++) {
    const it = window.slots[i]
    if (it && it.count > 0 && accepted.has(normalizeItemName(it.name))) total += it.count
  }
  return total
}

function countWindowContainerItems (window, names) {
  return countWindowItems(window, names, false)
}

function countWindowBackpackItems (window, names) {
  return countWindowItems(window, names, true)
}

function findWindowBackpackItem (window, name) {
  if (!window || !Array.isArray(window.slots)) return null
  const target = normalizeItemName(name)
  const start = Number.isInteger(window.inventoryStart) ? window.inventoryStart : 0
  for (let i = start; i < window.slots.length; i++) {
    const it = window.slots[i]
    if (it && it.count > 0 && normalizeItemName(it.name) === target) return it
  }
  return null
}

function barrelId (barrel) {
  if (!barrel) return null
  if (barrel.containerId) return String(barrel.containerId)
  const p = barrel.blockPos
  return p && Number.isFinite(p.x) ? `${p.x}:${p.y}:${p.z}` : null
}

// 保存本命令最后一次真实看到的容器段快照。只读取 window.inventoryStart 之前的槽位，
// 绝不把玩家背包段混进融合库存；同一桶多次触达时由 Map 覆盖为最新状态。
function recordObservedSnapshot (observed, bot, window, container, tag) {
  if (!(observed instanceof Map) || !window || !Array.isArray(window.slots)) return
  const containerId = barrelId(container)
  if (!containerId) return
  const totalSlots = Number.isInteger(window.inventoryStart)
    ? Math.max(0, Math.min(window.inventoryStart, window.slots.length))
    : window.slots.length
  const items = []
  for (let slot = 0; slot < totalSlots; slot++) {
    const item = window.slots[slot]
    if (!item || item.count <= 0) continue
    items.push({ ...serializeItem(bot, item, { tag }), slot })
  }
  observed.set(containerId, {
    containerId,
    scannedAt: Date.now(),
    totalSlots,
    items,
  })
}

function observedPayload (bufferSnapshots, outputSnapshots) {
  const output = outputSnapshots instanceof Map
    ? [...outputSnapshots.values()].at(-1) || null
    : null
  return {
    observedBufferSnapshots: bufferSnapshots instanceof Map ? [...bufferSnapshots.values()] : [],
    ...(output ? { observedOutputSnapshot: output } : {}),
  }
}

// 单条 craft_plan 生命周期内的 buffer 观测索引：写入/取出成功后记住物品所在桶，
// 已确认无该物品的桶不再重复扫描；touchedAny 记录本命令实际腾出过空间的任意取料桶，
// 让首次出现的新产物优先回填这些桶，而不是从 120 个未知桶开始盲扫。
function createBufferKnowledge () {
  return { locations: new Map(), absent: new Map(), touched: new Map(), touchedAny: new Set() }
}

function knowledgeSet (map, name) {
  const target = normalizeItemName(name)
  let set = map.get(target)
  if (!set) {
    set = new Set()
    map.set(target, set)
  }
  return set
}

function rememberBufferAvailable (knowledge, names, barrel) {
  const id = barrelId(barrel)
  if (!knowledge || !id) return
  for (const name of normalizedNameSet(names)) {
    knowledgeSet(knowledge.locations, name).add(id)
    knowledgeSet(knowledge.absent, name).delete(id)
  }
}

function rememberBufferAbsent (knowledge, names, barrel) {
  const id = barrelId(barrel)
  if (!knowledge || !id) return
  for (const name of normalizedNameSet(names)) {
    knowledgeSet(knowledge.locations, name).delete(id)
    knowledgeSet(knowledge.absent, name).add(id)
  }
}

// 即使取空后被标记 absent，也保留“本命令曾从这里取出”的事实；失败回滚优先原桶，
// 新产物则可复用任意本命令实际腾出过空间的桶。只有真实取出量 >0 的调用方才会记录。
function rememberBufferTouched (knowledge, names, barrel) {
  const id = barrelId(barrel)
  if (!knowledge || !id) return
  if (knowledge.touchedAny instanceof Set) knowledge.touchedAny.add(id)
  for (const name of normalizedNameSet(names)) knowledgeSet(knowledge.touched, name).add(id)
}

function withdrawPriorityFor (barrel, targets) {
  const byItem = barrel && barrel.withdrawPriorities
  if (byItem && typeof byItem === 'object' && !Array.isArray(byItem)) {
    let score = 0
    for (const target of targets) {
      const value = Number(byItem[target])
      if (Number.isFinite(value) && value > 0) score += value
    }
    return score
  }
  const legacy = Number(barrel && barrel.withdrawPriority)
  return Number.isFinite(legacy) ? Math.max(0, legacy) : 0
}

// 命令从服务端入队到 bot 真正开始执行之间，融合库存可能刚被启动恢复或另一条真实快照更新。
// 用执行前实时 overview 只替换本次关注物品的分数；不改变桶清单，也不放宽有界 fallback。
function mergeLiveWithdrawPriorities (barrels, names, overview) {
  const targets = [...normalizedNameSet(names)]
  if (!Array.isArray(barrels) || targets.length === 0 || !overview || !Array.isArray(overview.items)) {
    return Array.isArray(barrels) ? barrels.slice() : []
  }

  const live = new Map()
  for (const item of overview.items) {
    const name = normalizeItemName(item && item.name)
    if (!targets.includes(name) || !Array.isArray(item.entries)) continue
    for (const entry of item.entries) {
      // craft_plan opens the registered buffer barrel and can only withdraw its
      // exposed slots. Boxed stock is handled earlier by container_transfer,
      // which knows the shulker path; treating it as bare stock makes crafting
      // wait, reopen the barrel, and then fall back after finding zero items.
      if (entry && entry.inShulker === true) continue
      const id = entry && entry.containerId ? String(entry.containerId) : ''
      const count = Number(entry && entry.count)
      if (!id || !Number.isFinite(count) || count <= 0) continue
      let byItem = live.get(id)
      if (!byItem) {
        byItem = new Map()
        live.set(id, byItem)
      }
      byItem.set(name, (byItem.get(name) || 0) + count)
    }
  }

  return barrels.map((barrel) => {
    const next = { ...barrel }
    const byItem = (barrel && barrel.withdrawPriorities && typeof barrel.withdrawPriorities === 'object' && !Array.isArray(barrel.withdrawPriorities))
      ? { ...barrel.withdrawPriorities }
      : {}
    for (const target of targets) delete byItem[target]
    const current = live.get(barrelId(barrel))
    if (current) for (const [name, count] of current) byItem[name] = count

    const keys = Object.keys(byItem)
    if (keys.length > 0) next.withdrawPriorities = byItem
    else delete next.withdrawPriorities
    const score = targets.reduce((sum, name) => sum + Math.max(0, Number(byItem[name]) || 0), 0)
    if (score > 0) next.withdrawPriority = score
    else delete next.withdrawPriority
    return next
  })
}

function orderBarrelsForWithdraw (barrels, names, knowledge, botPos) {
  const targets = [...normalizedNameSet(names)]
  const priorityOf = barrel => withdrawPriorityFor(barrel, targets)
  const sorted = sortBarrelsByDistance(barrels, botPos)
    .sort((a, b) => priorityOf(b) - priorityOf(a))
  const hinted = new Set()
  if (knowledge) {
    for (const name of targets) {
      const ids = knowledge.locations.get(name)
      if (ids) for (const id of ids) hinted.add(id)
    }
  }
  const isKnownAbsentForAll = (barrel) => {
    if (!knowledge) return false
    const id = barrelId(barrel)
    return !!id && targets.length > 0 && targets.every(name => {
      const ids = knowledge.absent.get(name)
      return ids && ids.has(id)
    })
  }
  // Live overview priorities are refreshed immediately before craft/delivery.
  // A stale per-command `absent` mark must never hide a barrel that the live
  // index now reports as containing the requested item. Keep negative-cache
  // pruning for zero-priority barrels only; this preserves the fast path while
  // preventing output_delivery_incomplete when inventory was replenished.
  const candidates = sorted.filter(barrel =>
    !isKnownAbsentForAll(barrel) || priorityOf(barrel) > 0,
  )
  const learned = candidates.filter(barrel => hinted.has(barrelId(barrel)))
  const prioritized = candidates.filter(barrel =>
    !hinted.has(barrelId(barrel)) && priorityOf(barrel) > 0,
  )
  const fallbackLimit = Number.isFinite(MAX_WITHDRAW_FALLBACK_BARRELS)
    ? Math.max(0, Math.floor(MAX_WITHDRAW_FALLBACK_BARRELS))
    : 8
  const fallback = candidates.filter(barrel =>
    !hinted.has(barrelId(barrel)) && priorityOf(barrel) <= 0,
  ).slice(0, fallbackLimit)
  return [...learned, ...prioritized, ...fallback]
}

function orderBarrelsForDeposit (
  barrels,
  name,
  knowledge,
  botPos,
  fallbackLimit = MAX_WITHDRAW_FALLBACK_BARRELS,
) {
  const sorted = sortBarrelsByDistance(barrels, botPos)
  const limit = Number.isFinite(fallbackLimit)
    ? Math.max(0, Math.floor(fallbackLimit))
    : Math.max(0, Math.floor(MAX_WITHDRAW_FALLBACK_BARRELS))
  if (!knowledge) return sorted.slice(0, limit)

  const target = normalizeItemName(name)
  const touched = knowledge.touched.get(target) || new Set()
  const touchedAny = knowledge.touchedAny instanceof Set ? knowledge.touchedAny : new Set()
  const available = knowledge.locations.get(target) || new Set()
  const seen = new Set()
  const takeGroup = predicate => sorted.filter((barrel) => {
    const id = barrelId(barrel)
    if (!id || seen.has(id) || !predicate(id)) return false
    seen.add(id)
    return true
  })

  // 同物失败回存仍优先原桶；新产物没有同物 touched 时，会先复用本命令任意取料桶腾出的空间。
  const preferred = [
    ...takeGroup(id => touched.has(id)),
    ...takeGroup(id => touchedAny.has(id)),
    ...takeGroup(id => available.has(id)),
  ]
  const fallback = takeGroup(() => true).slice(0, limit)
  return [...preferred, ...fallback]
}

// 背包空闲格子数（周转区取料量估算用）。inventory 段 [inventoryStart, inventoryEnd)。
function countFreeInventorySlots (bot) {
  const inv = bot && bot.inventory
  if (!inv) return 0
  const start = Number.isInteger(inv.inventoryStart) ? inv.inventoryStart : 9
  const end = Number.isInteger(inv.inventoryEnd) ? inv.inventoryEnd : 45
  let used = 0
  const items = typeof inv.items === 'function' ? inv.items() : []
  for (const it of items) {
    if (it && Number.isInteger(it.slot) && it.slot >= start && it.slot < end) used += 1
  }
  return Math.max(0, (end - start) - used)
}

// 一个 craftStep 的触发次数（要跑几次配方）。planner 已把「需要多少个产物」换算为 times。
function craftStepTriggerTarget (step) {
  const times = step && Number.isFinite(step.times) ? Math.floor(step.times) : 0
  return Math.max(0, times)
}

function stepConsumesItem (step, itemName) {
  const target = normalizeItemName(itemName)
  if (!target || !step || !Array.isArray(step.inputs)) return false
  return step.inputs.some(input =>
    Array.isArray(input && input.names) && input.names.some(name => normalizeItemName(name) === target),
  )
}

// Only an immediate dependency may bypass the buffer. Branches and delayed
// dependencies keep the existing crash-recovery boundary.
function stepResultCarryQuantity (step, nextStep, isFinalStep) {
  const resultName = normalizeItemName(step && step.result && step.result.name)
  if (!resultName) return 0
  if (!isFinalStep && !stepConsumesItem(nextStep, resultName)) return 0
  const per = step && step.result && Number.isFinite(step.result.count)
    ? Math.max(1, Math.floor(step.result.count))
    : 1
  return craftStepTriggerTarget(step) * per
}

function bufferDepositQuantity (availableAboveBaseline, carryQuantity, finalHaul, haulProduced) {
  const available = Math.max(0, Math.floor(Number(availableAboveBaseline) || 0))
  const carry = Math.max(0, Math.floor(Number(carryQuantity) || 0))
  const produced = Math.max(0, Math.floor(Number(haulProduced) || 0))
  if (!finalHaul || carry <= 0) return produced
  return Math.min(produced, Math.max(0, available - carry))
}

// 跑 batch 次该配方所需输入原料占用的背包槽数估算（每种输入按堆叠上限向上取整）。
function inputSlotsForBatch (step, batch) {
  const inputs = (step && Array.isArray(step.inputs)) ? step.inputs : []
  let slots = 0
  for (const inp of inputs) {
    const per = inp && Number.isFinite(inp.count) ? Math.max(1, Math.floor(inp.count)) : 1
    slots += Math.ceil((batch * per) / DEFAULT_STACK_SIZE)
  }
  return slots
}

// 按「占满周转区的等比例原料」（Req 14.4）计算本趟取几次配方的原料：
// 在 freeSlots（扣除产物落位预留）能容纳的前提下尽量多取，且不超过剩余触发次数 remaining。
// 纯函数便于单测。
function computeBatchSize (step, freeSlots, remaining, outputReserve = TURNOVER_OUTPUT_RESERVE) {
  const rem = Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : 0
  if (rem <= 0) return 0
  const transactionCap = Math.max(1, Math.floor(MAX_CRAFT_BATCH_TRIGGERS))
  const cappedRemaining = Math.min(rem, transactionCap)
  const usable = Math.max(1, Math.floor(freeSlots) - Math.max(0, outputReserve))
  let batch = 1
  while (batch < cappedRemaining && inputSlotsForBatch(step, batch + 1) <= usable) batch += 1
  return Math.max(1, Math.min(batch, cappedRemaining))
}

/**
 * 依据背包里实际已有的输入量，算出还能完整跑几次该配方。
 * 用途：buffer 里该原料略少于本趟计划量时（上一步部分产出、别的任务占用等），不要整步判死，
 * 而是按真实可行次数降级继续；一次都跑不了才失败。countOf(name) 返回背包中该物品数量。
 * 纯函数便于单测。
 */
function feasibleBatchFromInventory (step, countOf) {
  const inputs = (step && Array.isArray(step.inputs)) ? step.inputs : []
  if (inputs.length === 0) return 0
  let feasible = Infinity
  for (const inp of inputs) {
    const per = inp && Number.isFinite(inp.count) ? Math.max(1, Math.floor(inp.count)) : 1
    const names = (inp && Array.isArray(inp.names) ? inp.names : []).map(normalizeItemName).filter(Boolean)
    if (names.length === 0) return 0
    let have = 0
    for (const nm of names) have += Math.max(0, Math.trunc(Number(countOf(nm)) || 0))
    feasible = Math.min(feasible, Math.floor(have / per))
    if (feasible <= 0) return 0
  }
  return Number.isFinite(feasible) ? Math.max(0, feasible) : 0
}

// 单次 bot.craft 事务的触发上限（真服部分成功的损失边界，不受物流批影响）。
function transactionBatchCap (requiresTable = false) {
  // Mineflayer 会在同一个 3x3 窗口里乐观连续点击；真服只接受前几次时，本地窗口
  // revision 已经失同步，后续会以 missing ingredient 结束并把原料留在格子里。
  // 工作台按一次一事务重开窗口；2x2 仍保留已验证的批量吞吐。
  // Inventory crafting can diverge in the same way: the server may accept a
  // prefix while mineflayer keeps consuming later inputs. Keep hauling batched
  // but make every server transaction exactly one recipe trigger.
  void requiresTable
  return 1
}

function preferredConcreteInputName (names, barrels, knowledge = null) {
  const candidates = [...normalizedNameSet(names)]
  if (candidates.length <= 1) return candidates[0] || null
  let best = null
  for (let index = 0; index < candidates.length; index++) {
    const name = candidates[index]
    let exactCount = 0
    for (const barrel of Array.isArray(barrels) ? barrels : []) {
      const byItem = barrel && barrel.withdrawPriorities
      const value = byItem && typeof byItem === 'object' && !Array.isArray(byItem)
        ? Number(byItem[name])
        : 0
      if (Number.isFinite(value) && value > 0) exactCount += value
    }
    const learnedCount = knowledge && knowledge.locations instanceof Map
      ? ((knowledge.locations.get(name) || new Set()).size)
      : 0
    const candidate = { name, exactCount, learnedCount, index }
    if (!best ||
      candidate.exactCount > best.exactCount ||
      (candidate.exactCount === best.exactCount && candidate.learnedCount > best.learnedCount) ||
      (candidate.exactCount === best.exactCount && candidate.learnedCount === best.learnedCount && candidate.index < best.index)) {
      best = candidate
    }
  }
  // 只有逐物品真值或本命令实测位置能支持锁定；旧 withdrawPriority 是候选合计，
  // 不能拿来猜某一种材料，否则会把不存在的变体排到最前。
  return best && (best.exactCount > 0 || best.learnedCount > 0) ? best.name : null
}

function hasAlternativeRecipeInput (step) {
  return Boolean(step && Array.isArray(step.inputs) && step.inputs.some(input =>
    input && Array.isArray(input.names) && input.names.filter(Boolean).length > 1,
  ))
}

function haulBatchCap (step, requiresTable = false) {
  // mc-data 会把 tag 配方解析成某一种具体材料。一次取入多种木板/台阶后，
  // recipesFor 可能只够完成前几次。每趟只拿一次配方量，下一趟重新按实时库存选配方。
  return requiresTable && hasAlternativeRecipeInput(step) ? 1 : Number.POSITIVE_INFINITY
}

// 一次事务的权威产出触发次数 = 服务端产物槽观测 ∩ 输入真实消耗（纯函数，供单测）。
// 本地背包 delta 绝不参与：mineflayer 的 bot.craft 无论服务端是否真产出都会本地伪造产物，
// 且上一次失败留下的幻影会抬高基线让真实产出算成 0（真服两单 oak_stairs 实际做出来了却被判
// craft_result_ambiguous_inputs_consumed 即此）。服务端观测可以多记（会被输入消耗夹掉），
// 但绝不能少记——少记会让已成功的事务被重放并超产。
function confirmedCraftTriggers ({ remaining, serverTriggers, inputsConsumed, inputPerTrigger } = {}) {
  const nonNegative = value => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)
  const rem = nonNegative(remaining)
  const server = nonNegative(serverTriggers)
  const per = nonNegative(inputPerTrigger)
  const consumedTriggers = per > 0
    ? Math.min(rem, Math.floor(nonNegative(inputsConsumed) / per))
    : Math.min(rem, server)
  return { consumedTriggers, confirmedTriggers: Math.min(rem, server, consumedTriggers) }
}

// 单次合成事务在结果确认期结束后的处置判定（纯函数，供单测）。真服里 bot.craft 可能：
//   - 正常返回却因交互未落地/服务器静默拒绝而实际什么都没发生（点击落空、桶方块引用瞬时失效等）；
//   - 正常返回且已消耗输入，但产物 set_slot 回包滞后于确认窗口。
// 二者都表现为「确认期内零产物」，但处置必须相反：
//   - 输入未被消耗（no_effect）→ 什么都没发生，可安全有界重试，不会重复消耗/超产；
//   - 输入已被消耗（ambiguous）→ 事务很可能已发生，绝不能重放，否则会二次消耗原料并超产。
// 有任何真实产出 → progress（推进/补剩余）。serverObserved 是服务端合成窗口产物槽的观测次数：
// 产物必须先出现在 slot 0 才可能被取走，因此 serverObserved===0 就是「服务端根本没凑成配方」的
// 确证。此时滞留原料已由合成格清理取回，inputsConsumed 仍 >0 也不代表合成发生过，重放不会重复
// 产出 → empty_result_retry（换一个新窗口会话有界重试），而不是整单判死。
// 无服务端观测可用（serverObserved 缺省）时退回旧的保守口径：输入已消耗即 ambiguous，绝不重放。
function classifyCraftAttempt ({ failure, confirmedTriggers, inputsConsumed, serverObserved = null } = {}) {
  if (Number(confirmedTriggers) > 0) return 'progress'
  if (Number(serverObserved) > 0) return 'ambiguous'
  if (Number(inputsConsumed) > 0) return serverObserved == null ? 'ambiguous' : 'empty_result_retry'
  if (failure) return 'failure_retry'
  return 'no_effect_retry'
}

// 跑 batch 次配方的产物占用的背包槽数估算（按产物堆叠上限向上取整）。
function outputSlotsForBatch (batch, resultPer) {
  const per = Number.isFinite(resultPer) ? Math.max(1, Math.floor(resultPer)) : 1
  const times = Number.isFinite(batch) ? Math.max(0, Math.floor(batch)) : 0
  return Math.ceil((times * per) / DEFAULT_STACK_SIZE)
}

/**
 * 一趟物流批的配方次数：一次取料能覆盖多少次触发。
 * 与事务批解耦——只受「输入原料槽 + 本趟全部产物槽 ≤ 可用空格」约束，不再被单次事务上限压到 16。
 * 这直接决定 buffer↔工作台的往返次数，是长链多步合成最主要的耗时来源。
 * 纯函数便于单测。
 */
function computeHaulBatchSize (step, freeSlots, remaining, resultPer = 1, outputReserve = TURNOVER_OUTPUT_RESERVE) {
  const rem = Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : 0
  if (rem <= 0) return 0
  // 至少保留 outputReserve 个空格给合成结果落位与窗口周转。
  const usable = Math.max(1, Math.floor(freeSlots) - Math.max(0, outputReserve))
  const fits = (batch) => inputSlotsForBatch(step, batch) + outputSlotsForBatch(batch, resultPer) <= usable
  // 指数上探 + 二分收敛：remaining 可能有数百次，逐 1 递增会做无意义的多次估算。
  let lo = 1
  let hi = 1
  while (hi < rem && fits(hi * 2)) hi *= 2
  hi = Math.min(rem, hi * 2)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  return Math.max(1, Math.min(lo, rem))
}

// 最终产物的交付数量（Req 16.3）：优先取命令 target.quantity（= 下单目标数量），缺失则回退到
// 最后一个 craftStep 的产出总量（result.count × times）。纯函数便于单测。
function finalDeliveryCount (cmd, finalStep) {
  const t = cmd && cmd.target
  if (t && Number.isFinite(t.quantity) && t.quantity > 0) return Math.floor(t.quantity)
  const times = finalStep && Number.isFinite(finalStep.times) ? Math.max(0, Math.floor(finalStep.times)) : 0
  const per = (finalStep && finalStep.result && Number.isFinite(finalStep.result.count))
    ? Math.max(1, Math.floor(finalStep.result.count))
    : 1
  return times * per
}

// 返回严格交付结果；只有 actual === expected 才能上报 deposit_completed。
function deliveryCompletionError (actual, expected) {
  const a = Number.isFinite(actual) ? Math.max(0, Math.floor(actual)) : 0
  const e = Number.isFinite(expected) ? Math.max(0, Math.floor(expected)) : 0
  return a === e ? null : `output_delivery_incomplete:${a}/${e}`
}

function finalDeliveryInventoryPlan (carried, requested) {
  const inBackpack = Number.isFinite(carried) ? Math.max(0, Math.floor(carried)) : 0
  const orderQuantity = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0
  const directToOutput = Math.min(inBackpack, orderQuantity)
  return {
    directToOutput,
    withdrawFromBuffer: orderQuantity - directToOutput,
    residueToBuffer: inBackpack - directToOutput,
  }
}

// craft_plan 的终态事件只能在精确交付成功后出现，并固定先 craft_completed 再 deposit_completed。
function craftCompletionEventTypes (actual, expected) {
  return deliveryCompletionError(actual, expected) ? [] : ['craft_completed', 'deposit_completed']
}

// 从桶候选中按到 bot 的三维直线距离就近排序（就近取料 / 入库）。纯函数便于单测。
function sortBarrelsByDistance (barrels, botPos) {
  const list = Array.isArray(barrels) ? barrels.slice() : []
  const validPos = p => p && [p.x, p.y, p.z].every(Number.isFinite)
  if (!validPos(botPos)) return list
  const dist = (b) => {
    const p = b && b.blockPos
    if (!validPos(p)) return Infinity
    return Math.hypot(p.x - botPos.x, p.y - botPos.y, p.z - botPos.z)
  }
  return list.sort((a, b) => dist(a) - dist(b))
}

// Capacity is the correctness constraint. Once multiple containers can each
// fit the whole delivery, distance wins so spare capacity does not cause a
// cross-station detour. If none fits, largest capacity remains the fallback.
function rankOutputContainers (entries, botPos, requiredCount = 0) {
  const list = Array.isArray(entries) ? entries.slice() : []
  const required = Math.max(0, Math.trunc(Number(requiredCount) || 0))
  const validPos = p => p && [p.x, p.y, p.z].every(Number.isFinite)
  const distance = (entry) => {
    const p = entry && entry.out && entry.out.blockPos
    if (!validPos(botPos) || !validPos(p)) return Infinity
    const center = containerCenter(p)
    return Math.hypot(center.x - botPos.x, center.y - botPos.y, center.z - botPos.z)
  }
  const capacity = entry => Number.isFinite(entry && entry.capacity) ? entry.capacity : -1
  const free = entry => Number.isFinite(entry && entry.free) ? entry.free : -1
  const sufficient = entry => required > 0 && capacity(entry) >= required
  return list.sort((a, b) => {
    const sufficientDiff = Number(sufficient(b)) - Number(sufficient(a))
    if (sufficientDiff !== 0) return sufficientDiff
    if (sufficient(a) && sufficient(b)) {
      return distance(a) - distance(b) || free(b) - free(a) || capacity(b) - capacity(a)
    }
    return capacity(b) - capacity(a) || free(b) - free(a) || distance(a) - distance(b)
  })
}

async function loadOutputContainerRanks (outputs, itemName, loadSnapshot, stackSizeOf) {
  const list = Array.isArray(outputs) ? outputs : []
  return Promise.all(list.map(async out => {
    let free = -1
    let capacity = -1
    try {
      const snap = await loadSnapshot(out)
      if (snap && Number.isFinite(snap.totalSlots) && Array.isArray(snap.items)) {
        free = snap.totalSlots - snap.items.length
        capacity = outputItemCapacity(snap, itemName, stackSizeOf)
      }
    } catch (_) {
      // A failed snapshot remains an unknown fallback candidate.
    }
    return { out, free, capacity }
  }))
}

function isCampaignScopedCommand (cmd) {
  return Boolean(cmd && (
    cmd.runId != null || cmd.itemId != null || cmd.laneId != null || cmd.laneResources != null
  ))
}

function recordConfirmedDepositDelta (rows, operation, containerId, beforeCount, afterCount, delta) {
  if (!Array.isArray(rows) || !operation || !operation.operationId || !containerId || !(delta > 0)) return false
  const existing = rows.find(row => row.containerId === containerId)
  if (existing) {
    existing.afterCount = afterCount
    existing.delta += delta
    return true
  }
  rows.push({
    operationId: operation.operationId,
    containerId,
    itemName: normalizeItemName(operation.itemName),
    requested: Math.max(0, Math.floor(Number(operation.requested) || 0)),
    beforeCount,
    afterCount,
    delta,
  })
  return true
}

function commandContainerCandidates (cmd, pluralKey, singularKey) {
  const plural = Array.isArray(cmd && cmd[pluralKey])
    ? cmd[pluralKey].filter(candidate => candidate && candidate.blockPos)
    : []
  if (plural.length > 0) return plural
  if (isCampaignScopedCommand(cmd)) return []
  const singular = cmd && cmd[singularKey]
  if (singular && singular.blockPos) return [singular]
  return null
}

module.exports = function craftingExecutor (bot, cfg) {
  const tag = `[${cfg.id}|craft-exec]`
  // Recipe IDs from the live protocol are not the planner's semantic source.
  // Keep the source registry explicit (1.21.4) and use bot.registry only for
  // the IDs that are sent over the current server connection.
  const recipeNameRegistry = canonicalRecipeRegistry
  // Ported from olela: events go to the local sink supplied by cloud-store instead of
  // an HTTP preparation server. Missing sink = no-op so unit/offline use stays safe.
  const craftSink = (cfg && cfg.craftSink) || {}
  const longCommand = longCommandMutexFor(bot)
  const botGeneration = Number(bot._olelaGeneration) || 0
  const recoveredBuffer = parseRecoveredBufferArg(process.argv)

  function reportEvent (type, payload, opts = {}) {
    if (typeof craftSink.onEvent === 'function') {
      try { craftSink.onEvent(type, { ...payload, botGeneration }, opts) } catch (_) { /* never break crafting on logging */ }
    }
  }

  // 单长命令互斥：同一时刻至多 1 条进行中长命令（Req 13.2 / 13.3）。
  function tryStartLongCommand (kind, requestId, deadline = Date.now() + CRAFT_TIMEOUT_MS) {
    return longCommand.tryStart(kind, requestId, { botGeneration, deadline })
  }

  function finishLongCommand (requestId) {
    longCommand.finish(requestId, botGeneration)
  }

  // 收尾兜底：任何窗口只有在光标物安全回到背包后才关闭；回收失败则 fail-closed 保持窗口打开。
  async function closeOpenWindows (trackedWindow) {
    const windows = []
    if (trackedWindow) windows.push(trackedWindow)
    const cur = bot && bot.currentWindow
    if (cur && !windows.includes(cur)) windows.push(cur)
    for (const window of windows) {
      try {
        await closeWindowAfterCursorPark(bot, window)
      } catch (error) {
        console.warn(`${tag} 收尾关窗被阻止: ${(error && (error.reason || error.message)) || error}`)
      }
    }
  }

  // 当前命令的生效执行预算（动态；旧服务端无 budgetMs 时回退 CRAFT_TIMEOUT_MS）。
  let activeBudgetMs = CRAFT_TIMEOUT_MS

  function throwIfTimedOut (deadline) {
    const cancelReason = longCommand.cancellation && longCommand.cancellation()
    if (cancelReason) throw new CraftError(`preparation_cancelled:${cancelReason}`)
    if (Date.now() > deadline) throw new CraftError(`executor_timeout_${activeBudgetMs}ms`)
  }

  function botPosition () {
    const p = bot.entity && bot.entity.position
    return (p && Number.isFinite(p.x)) ? p : null
  }

  function distTo (blockPos) {
    const pos = botPosition()
    if (!pos || !blockPos || !Number.isFinite(blockPos.x)) return Infinity
    const c = containerCenter(blockPos)
    return Math.hypot(pos.x - c.x, pos.y - c.y, pos.z - c.z)
  }

  // 本地前往某坐标（就近收尾；长途已由服务端标准快速三维移动带到附近，Req 13.4）。
  // 走共享 guardedGoto：与标准三维移动地面段同一套看门狗（4s 无进展触发 unstick 脱困、
  // 最多 4 次、45s 硬停判失败），只在真卡死/死亡/救援耗尽/整次 deadline 到时失败——
  // 不再用固定 nav 超时（复杂地形近距离也可能算得慢，固定毫秒会误杀）。timeoutOverride 保留
  // 签名兼容（现忽略：看门狗按停滞而非固定时长判定；整次预算由 deadline 兜底）。
  async function gotoNear (x, y, z, range, deadline, timeoutOverride = null) {
    if (!bot.pathfinder) throw new CraftError('pathfinder_not_ready')
    const goal = new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), Math.max(0, range))
    // 到桶/工作台/成品箱是静态目标：不设 timeoutOverride，仅靠整次 deadline + 看门狗停滞判定。
    const effDeadline = (timeoutOverride == null) ? deadline : Math.min(deadline, Date.now() + timeoutOverride)
    try {
      await guardedGoto(bot, goal, { tag, deadline: effDeadline })
    } catch (e) {
      if (e && e.name === 'AbortError') throw e
      throw new CraftError(`nav_failed:${(e && e.reason) || (e && e.message) || e}`)
    }
  }

  async function openWithTimeout (block, timeoutMs) {
    let timer = null
    const timeoutP = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CraftError('open_timeout')), Math.max(1000, timeoutMs))
    })
    try {
      return await Promise.race([bot.openContainer(block), timeoutP])
    } finally {
      clearTimeout(timer)
    }
  }

  // Ported from olela: container lists now come from cloud-store's own chest registry
  // (cfg.craftSink.resolveContainers) instead of the olela preparation server.
  // The command-attached candidates keep priority — see resolveBufferBarrels below.
  async function fetchContainers () {
    if (typeof craftSink.resolveContainers !== 'function') return []
    try {
      const list = await craftSink.resolveContainers()
      return Array.isArray(list) ? list : []
    } catch (_) {
      return []
    }
  }

  // Ported from olela: the live fused-inventory overview lived on the preparation
  // server. Cloud-store has a single, authoritative ledger, so the command-time
  // priority snapshot is kept as-is.
  async function refreshBufferPriorities (barrels, names) {
    return barrels
  }

  // 解析可用的 buffer 桶清单：优先用命令随附的 cmd.bufferBarrels，缺失则查登记容器筛 purpose:buffer 的 barrel。
  async function resolveBufferBarrels (cmd) {
    if (Array.isArray(cmd.bufferBarrels) && cmd.bufferBarrels.length > 0) return cmd.bufferBarrels
    const list = await fetchContainers()
    return list
      .filter(c => c && c.purpose === 'buffer' && c.containerType === 'barrel' && c.blockPos)
      .map(c => ({ containerId: c.id || c.containerId, blockPos: c.blockPos, standPos: c.standPos, secondaryPos: c.secondaryPos }))
  }

  // 解析工作台候选：优先命令随附 cmd.workstation，缺失则查登记容器筛 purpose:workstation 的
  // crafting_table。云仓库侧 workstations 由 cfg.craftingTable（config 坐标变量）提供，见 index.js。
  async function resolveWorkstations (cmd) {
    const commandCandidates = commandContainerCandidates(cmd, 'workstations', 'workstation')
    if (commandCandidates !== null) return commandCandidates
    const list = await fetchContainers()
    return list
      .filter(c => c && c.purpose === 'workstation' && c.containerType === 'crafting_table' && c.blockPos)
      .map(c => ({ containerId: c.id || c.containerId, blockPos: c.blockPos, standPos: c.standPos, secondaryPos: c.secondaryPos }))
  }

  // 解析成品交付容器（Req 16.3）：优先命令随附 cmd.outputContainer，缺失则查登记容器筛 purpose:output
  // 的任意 containerType（成品箱可以是 chest/barrel 等，不限类型）。返回 null 表示未登记成品容器。
  async function resolveOutputContainers (cmd, itemName, requiredCount = 0) {
    const commandCandidates = commandContainerCandidates(cmd, 'outputContainers', 'outputContainer')
    if (commandCandidates !== null) return commandCandidates
    const list = await fetchContainers()
    const outs = list.filter(c => c && c.purpose === 'output' && c.blockPos)
    if (outs.length === 0) return []
    // Keep every output as a fallback. The best single container can still be
    // too small for an unstackable order even when aggregate capacity is enough.
    // Ported from olela: per-container snapshots come from the local sink
    // (cloud-store chest_slots) instead of a preparation-server HTTP call.
    const ranked = await loadOutputContainerRanks(outs, itemName, async out => {
      if (typeof craftSink.snapshotContainer !== 'function') return null
      try { return await craftSink.snapshotContainer(out) } catch (_) { return null }
    }, name => {
      const item = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[name]
      return item && item.stackSize
    })
    const botPos = bot.entity && bot.entity.position
    return rankOutputContainers(ranked, botPos, requiredCount).map(({ out }) => ({
      containerId: out.id || out.containerId,
      blockPos: out.blockPos,
      standPos: out.standPos,
      secondaryPos: out.secondaryPos,
      containerType: out.containerType,
    }))
  }

  // 使用 inventory-executor 已实机验证的自适应站位开箱原语访问登记容器。它会先尝试
  // 当前站位，再以 OBFS 枚举可站立/可交互候选，适用于多层立体堆叠的 buffer 桶。
  // 若插件未挂载才退回旧的简化 GoalNear 路径，保持独立构造测试兼容。
  async function openRegisteredContainer (container, deadline, missingReason) {
    const bp = container && container.blockPos
    if (!bp || !Number.isFinite(bp.x)) throw new CraftError(missingReason)
    throwIfTimedOut(deadline)

    const sharedOpen = bot._inventoryExecutor && bot._inventoryExecutor.reachContainerAndOpen
    if (typeof sharedOpen === 'function') {
      let reach = null
      try {
        // The shared inventory opener normally has its own path/open guards, but
        // a stalled mineflayer window promise must never hold a preparation task
        // in depositing until the server-side GC. Bound this handoff to the
        // command deadline and consume late rejections from the abandoned call.
        const remainingMs = Math.max(1, deadline - Date.now())
        const timeoutMs = Math.min(OPEN_WINDOW_TIMEOUT_MS, remainingMs)
        let timer = null
        const opening = Promise.resolve().then(() => sharedOpen(
          bp,
          container.secondaryPos || null,
          container.standPos || null,
        ))
        let timedOut = false
        try {
          reach = await Promise.race([
            opening,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new CraftError(`container_access_timeout:${timeoutMs}ms`)), timeoutMs)
            }),
          ])
        } catch (e) {
          timedOut = true
          throw e
        } finally {
          if (timer) clearTimeout(timer)
          if (timedOut) {
            // 只有超时放弃时才需要回收迟到的窗口；成功路径绝不能提前关窗。
            opening.then((lateReach) => {
              if (lateReach && lateReach.window) safeCloseWindow(lateReach.window)
            }).catch(() => {})
          }
        }
        if (!reach || !reach.window) throw new CraftError('container_window_missing')
        // inventory-executor 已现场验证过该站位。保留在当前命令的容器引用上，后续重开同桶
        // 优先复用，避免再次尝试服务端乐观站位并重复昂贵 A* 候选搜索。
        if (reach.actualStandPos && Number.isFinite(reach.actualStandPos.x)) {
          container.standPos = {
            x: Math.floor(reach.actualStandPos.x),
            y: Math.floor(reach.actualStandPos.y),
            z: Math.floor(reach.actualStandPos.z),
          }
        }
        throwIfTimedOut(deadline)
        return reach.window
      } catch (e) {
        if (reach && reach.window) safeCloseWindow(reach.window)
        if (e && e.name === 'AbortError') throw e
        const reason = (e && (e.reason || e.message)) || e
        throw new CraftError(`container_access_failed:${reason}`)
      }
    }

    if (distTo(bp) > CONTAINER_INTERACT_DISTANCE) {
      await gotoNear(bp.x, bp.y, bp.z, 2, deadline)
    }
    throwIfTimedOut(deadline)
    const center = containerCenter(bp)
    try { await bot.lookAt(new Vec3(center.x, center.y, center.z)) } catch (_) { /* ignore */ }
    const block = bot.blockAt(new Vec3(bp.x, bp.y, bp.z))
    if (!block) throw new CraftError(missingReason)
    return openWithTimeout(block, OPEN_WINDOW_TIMEOUT_MS)
  }

  // 到桶旁并开桶（复用自适应站位访问，Req 13.4）。
  async function openBarrel (barrel, deadline) {
    return openRegisteredContainer(barrel, deadline, 'barrel_block_missing')
  }

  // 到成品容器旁并开容器（成品容器不限 containerType，Req 16.3）。
  async function openOutputContainer (container, deadline) {
    return openRegisteredContainer(container, deadline, 'output_block_missing')
  }

  // 容器段（[0, inventoryStart)）内首个名字命中候选集且非空的槽。
  function findContainerSlot (window, names) {
    const accepted = normalizedNameSet(names)
    const invStart = Number.isInteger(window && window.inventoryStart)
      ? window.inventoryStart
      : ((window && window.slots && window.slots.length) || 0)
    for (let i = 0; i < invStart; i++) {
      const slot = window.slots ? window.slots[i] : null
      if (slot && slot.count > 0 && accepted.has(normalizeItemName(slot.name))) return slot
    }
    return null
  }

  // 窗口内容可能在 windowOpen 后短暂落后于服务端；对索引声称有货的桶给一个同步窗口。
  async function waitForContainerSlot (window, names, deadline, timeoutMs = 2_000) {
    const until = Math.min(deadline, Date.now() + timeoutMs)
    while (Date.now() < until) {
      const slot = findContainerSlot(window, names)
      if (slot) return slot
      await sleep(150)
    }
    return findContainerSlot(window, names)
  }

  // 等待容器窗口同步：容器侧与背包侧必须同向变化，按两侧较小值确认，并在光标为空时稳定。
  async function confirmedWindowMove (window, names, requested, beforeContainer, beforeBackpack, direction, deadline) {
    const syncDeadline = Math.min(deadline, Date.now() + CRAFT_WINDOW_MOVE_CONFIRM_MS)
    const confirmer = createWindowMoveConfirmer({ settleMs: CRAFT_WINDOW_MOVE_SETTLE_MS })
    do {
      await sleep(SYNC_SLEEP_MS)
      const moved = confirmedMoveFromCounts({
        requested,
        beforeContainer,
        beforeBackpack,
        nowContainer: countWindowContainerItems(window, names),
        nowBackpack: countWindowBackpackItems(window, names),
        direction,
      })
      const step = confirmer.observe(moved, !window.selectedItem)
      if (step.settled) return step.value
    } while (Date.now() < syncDeadline)
    const salvaged = confirmer.expired()
    if (salvaged > 0) {
      console.warn(
        `${tag} 窗口移动确认窗口耗尽，采用最后一次双侧确认量 ${salvaged}/${requested}` +
        `（${direction}；settle 未满但双侧已同向且光标为空）`,
      )
    }
    return salvaged
  }

  // 从已打开的桶窗口取出至多 need 个命中候选集的物品到背包，只返回双侧稳定确认的实际数量。
  async function withdrawMatchingFromWindow (window, names, need, deadline) {
    let taken = 0
    while (taken < need) {
      throwIfTimedOut(deadline)
      const slot = findContainerSlot(window, names)
      if (!slot) break
      // The pre-open free-slot estimate can become stale after armor/elytra
      // restoration. Use the live container window capacity and take a partial
      // haul instead of turning capacity 26 / stack 43 into an access failure.
      const take = transferableWindowCount(window, slot.slot, need - taken, 'withdraw')
      if (take <= 0) break
      const beforeContainer = countWindowContainerItems(window, names)
      const beforeBackpack = countWindowBackpackItems(window, names)
      try {
        // 自研 click 序列在 zenoxs 真服上首击后不更新 window.selectedItem，
        // 稳定复现 window_transfer_cursor_desync；复用 inventory-executor 已实机
        // 验证的 window.withdraw 原语，再以双侧确认窗口记账。
        await window.withdraw(slot.type, slot.metadata, take)
      } catch (e) {
        // 前几次若已有真实移动，先把该实际数量交给上层，下一桶继续；绝不丢掉部分成功账。
        if (taken > 0) break
        throw new CraftError(`withdraw_failed:${(e && (e.reason || e.message)) || e}`)
      }
      const actual = await confirmedWindowMove(
        window, names, take, beforeContainer, beforeBackpack, 'withdraw', deadline,
      )
      if (actual <= 0) break
      taken += actual
    }
    return taken
  }

  // 从 buffer 桶取出 need 个候选物。优先访问本命令已确认存有该物品的桶，跳过已确认空桶；
  // 首次发现的位置也会加入索引，后续批次不再从 120 个桶头部盲扫。
  async function withdrawFromBarrels (
    names,
    need,
    barrels,
    deadline,
    knowledge,
    observedSnapshots = null,
    keepNames = null,
  ) {
    let left = need
    let accessFailures = 0
    // 取料前先腾位：背包被采集期杂物占满时，`确认=0` 且重试不会自愈
    // （真服 short_grass 交付单 5 次 `周转区已满立即交付` 取证）。
    await freeBackpackSpaceForWithdraw(
      barrels,
      CRAFT_WITHDRAW_MIN_FREE_SLOTS,
      deadline,
      knowledge,
      observedSnapshots,
      keepNames,
    )
    const ordered = orderBarrelsForWithdraw(barrels, names, knowledge, botPosition())
    const targetLabel = [...normalizedNameSet(names)].join('|')
    const positive = ordered
      .filter(barrel => withdrawPriorityFor(barrel, [...normalizedNameSet(names)]) > 0)
      .map(barrel => `${barrelId(barrel)}=${withdrawPriorityFor(barrel, [...normalizedNameSet(names)])}`)
    // 诊断必须能区分「桶没下发」「提示没命中」「fallback 被上限截断」三种情况：
    // 真服 cyc41 出现过 buffer_material_access_failed:54/64，而融合库存索引明确指出剩下的
    // 10 个就在 overworld:5856:130:28184 —— 但 bot 访问的 6 个桶全是 5858/5859 系列。
    // 只打「正库存提示」看不出那个桶是压根没在下发清单里，还是有提示但排在 fallback 上限外。
    const orderedIds = new Set(ordered.map(barrelId).filter(Boolean))
    const notOrdered = (Array.isArray(barrels) ? barrels : [])
      .map(barrelId)
      .filter(id => id && !orderedIds.has(id))
    console.log(
      `${tag} buffer 取料计划 ${targetLabel} ×${need}: 正库存提示 [${positive.join(', ')}], ` +
      `fallback上限=${MAX_WITHDRAW_FALLBACK_BARRELS}, 下发桶=${(barrels || []).length}, ` +
      `将访问=${ordered.length}${notOrdered.length > 0 ? `, 未纳入=${notOrdered.join(',')}` : ''}`,
    )
    for (const barrel of ordered) {
      if (left <= 0) break
      throwIfTimedOut(deadline)
      let win = null
      let turnoverFull = false
      try {
        win = await openBarrel(barrel, deadline)
        if (bot.currentWindow && bot.currentWindow !== win) {
          console.warn(`${tag} 开窗返回与当前窗口不一致，改用当前窗口: ${barrelId(barrel)}`)
          win = bot.currentWindow
        }
        bot.currentWindow = win
        const expectedStock = withdrawPriorityFor(barrel, [...normalizedNameSet(names)]) > 0
        let visibleBefore = countWindowContainerItems(win, names)
        if (visibleBefore === 0 && expectedStock) {
          const slot = await waitForContainerSlot(win, names, deadline)
          if (!slot) {
            // 服务端索引说有货但窗口仍为空：可能是上一扇窗的迟到状态，关窗重开一次。
            await closeWindowAfterCursorPark(bot, win, () => {
              recordObservedSnapshot(observedSnapshots, bot, win, barrel, tag)
            })
            win = await openBarrel(barrel, deadline)
            visibleBefore = countWindowContainerItems(win, names)
          }
        }
        const wantedBefore = left
        const moved = await withdrawMatchingFromWindow(win, names, left, deadline)
        left -= moved
        const remainingSlot = findContainerSlot(win, names)
        turnoverFull = left > 0 && Boolean(
          remainingSlot && isWindowTransferDestinationFull(win, remainingSlot.slot, 'withdraw')
        )
        console.log(
          `${tag} buffer 取料 ${barrel.containerId || '?'} ${targetLabel}: ` +
          `可见=${visibleBefore},请求=${wantedBefore},确认=${moved},剩余=${left}` +
          `${turnoverFull ? '，周转区已满立即交付' : ''}`,
        )
        if (moved > 0) rememberBufferTouched(knowledge, names, barrel)
        if (findContainerSlot(win, names)) rememberBufferAvailable(knowledge, names, barrel)
        else rememberBufferAbsent(knowledge, names, barrel)
      } catch (e) {
        if (e && (e.name === 'AbortError' || String(e.reason || '').startsWith('executor_timeout_'))) throw e
        accessFailures += 1
        console.warn(`${tag} 从 buffer 桶 ${barrel.containerId || '?'} 取料失败: ${(e && e.reason) || (e && e.message) || e}`)
      } finally {
        await closeWindowAfterCursorPark(bot, win, () => {
          recordObservedSnapshot(observedSnapshots, bot, win, barrel, tag)
        })
      }
      if (turnoverFull) break
    }
    if (left > 0 && accessFailures > 0) {
      throw new CraftError(`buffer_material_access_failed:${need - left}/${need}`)
    }
    return Math.max(0, left)
  }

  // 按配方比例取原料到背包；扣除已有量后从 buffer 补足。
  async function withdrawInputsForBatch (
    step,
    batch,
    barrels,
    deadline,
    knowledge,
    observedSnapshots = null,
    baselineCounts = null,
  ) {
    const inputs = (step && Array.isArray(step.inputs)) ? step.inputs : []
    const recipes = recipesForResultOf(step)
    const canonical = canonicalRecipeForStep(step, false)
    const plannedInputs = inputs.map((inp) => {
      const declared = (inp && Array.isArray(inp.names) ? inp.names : [])
        .map(normalizeItemName)
        .filter(Boolean)
      return {
        inp,
        declared,
        names: canonical ? declared : craftableInputNames(recipes, declared, itemNameOfId),
      }
    })
    const keepNames = new Set(plannedInputs.flatMap(input => input.names))
    for (const planned of plannedInputs) {
      throwIfTimedOut(deadline)
      const inp = planned.inp
      const per = inp && Number.isFinite(inp.count) ? Math.max(1, Math.floor(inp.count)) : 1
      const need = batch * per
      const declared = planned.declared
      if (declared.length === 0) throw new CraftError('invalid_recipe_input')
      // 只取本地配方表真能吃的那些变体，否则会取回一个「服务端认为合法、bot 却合不了」的原料。
      const preferredConcrete = preferredConcreteInputName(planned.names, barrels, knowledge)
      const names = preferredConcrete ? [preferredConcrete] : planned.names
      if (preferredConcrete && planned.names.length > 1) {
        console.log(
          `${tag} 可替代原料锁定单一变体: ${planned.names.join('|')} -> ${preferredConcrete} ` +
          `（本趟 ${need}，禁止混料污染本地具体配方）`,
        )
      }
      if (names.length !== declared.length) {
        console.log(
          `${tag} 原料候选按本地配方表收窄: ${declared.join('|')} → ${names.join('|')}` +
          `（产物 ${normalizeItemName((step && step.result && step.result.name) || '?')}）`,
        )
      }
      let have = 0
      for (const nm of names) have += countInventoryAboveBaseline(bot, nm, baselineCounts)
      const remaining = need - have
      if (remaining <= 0) continue
      const stillMissing = await withdrawFromBarrels(
        names, remaining, barrels, deadline, knowledge, observedSnapshots, keepNames,
      )
      if (stillMissing > 0) throw new CraftError(`insufficient_buffer_materials:${remaining - stillMissing}/${remaining}`)
    }
  }

  // 把本批真实合成出的 maxQuantity 个产物放回 buffer。以窗口双向槽位变化确认实际存入量，
  // 不会把命令开始前背包已有的同名物一起倒入，也不信任 deposit promise 本身。
  async function depositItemToBuffer (
    itemName,
    maxQuantity,
    barrels,
    deadline,
    knowledge,
    observedSnapshots = null,
    fallbackLimit = null,
  ) {
    const target = normalizeItemName(itemName)
    const requested = Number.isFinite(maxQuantity) ? Math.max(0, Math.floor(maxQuantity)) : 0
    let deposited = 0
    const depositFn = bot._inventoryExecutor && bot._inventoryExecutor.depositInventoryItem
    // Inventory windows can briefly expose a stale non-stackable slot after a
    // successful click. Re-open the registered barrels in bounded passes and
    // count only confirmed two-sided deltas from each pass.
    for (let pass = 0; pass < 3 && deposited < requested; pass++) {
      const ordered = orderBarrelsForDeposit(barrels, target, knowledge, botPosition(), fallbackLimit)
      for (const barrel of ordered) {
      if (deposited >= requested) break
      throwIfTimedOut(deadline)
      let win = null
      try {
        win = await openBarrel(barrel, deadline)
        if (bot.currentWindow && bot.currentWindow !== win) {
          win = bot.currentWindow
        }
        bot.currentWindow = win
        while (deposited < requested) {
          const item = findWindowBackpackItem(win, target)
          if (!item) break
          const count = Math.min(item.count, requested - deposited)
          const beforeContainer = countWindowContainerItems(win, [target])
          const beforeBackpack = countWindowBackpackItems(win, [target])
          try {
            let actual = 0
            if (typeof depositFn === 'function') {
              actual = await depositFn(win, target, count, deadline)
            } else {
              await win.deposit(item.type, item.metadata, count)
              actual = await confirmedWindowMove(
                win, [target], count, beforeContainer, beforeBackpack, 'deposit', deadline,
              )
            }
            if (actual <= 0) break
            deposited += actual
            rememberBufferAvailable(knowledge, [target], barrel)
          } catch (e) {
            console.warn(`${tag} 产物 ${target} 入桶 ${barrel.containerId || '?'} 失败: ${(e && (e.reason || e.message)) || e}`)
            break
          }
        }
      } catch (e) {
        if (e && (e.name === 'AbortError' || String(e.reason || '').startsWith('executor_timeout_'))) throw e
        console.warn(`${tag} 打开 buffer 桶 ${barrel.containerId || '?'} 入库失败: ${(e && e.reason) || (e && e.message) || e}`)
      } finally {
        await closeWindowAfterCursorPark(bot, win, () => {
          recordObservedSnapshot(observedSnapshots, bot, win, barrel, tag)
        })
      }
    }
    if (deposited !== requested) throw new CraftError(`buffer_deposit_incomplete:${deposited}/${requested}`)
    return deposited
  }
  }

  // 取料前腾出背包空位：把背包里的非受保护物品就近存入 buffer 桶。
  // 与 inventory-executor 的 freeInventorySpaceIntoBuffer 同职责；crafting/deliver 的
  // buffer 取料此前没有这道闸，真服 short_grass 交付单在背包被杂物占满时
  // `可见=8,请求=8,确认=0,剩余=8，周转区已满立即交付` 重试 5 次仍失败。
  // 受保护物品（装备/鞘翅/工具/消耗品）由 gear-guard 在 clickWindow 层拒绝，天然跳过。
  async function freeBackpackSpaceForWithdraw (
    barrels,
    needSlots,
    deadline,
    knowledge,
    observedSnapshots,
    keepNames = null,
  ) {
    const want = Math.max(1, Math.trunc(Number(needSlots) || CRAFT_WITHDRAW_MIN_FREE_SLOTS))
    const freeNow = () => countFreeInventorySlots(bot)
    if (freeNow() >= want) return 0
    const isProtectedName = name => typeof bot._isProtectedGear === 'function'
      ? bot._isProtectedGear(name)
      : (typeof bot._isContainerProtectedGear === 'function' && bot._isContainerProtectedGear(name))
    const byName = spillableInventoryCounts(
      bot.inventory.items() || [],
      keepNames,
      isProtectedName,
      bot._taskDeliverables instanceof Set ? bot._taskDeliverables : null,
    )
    if (byName.size === 0) {
      console.warn(`${tag} 取料前背包已满但无可腾位物品（全部受保护）`)
      return freeNow()
    }
    console.warn(
      `${tag} 取料前背包空位不足(${freeNow()}/${want})，先腾位: ` +
      `${[...byName].map(([n, c]) => `${n}x${c}`).join(', ')}`,
    )
    for (const [name, count] of byName) {
      if (freeNow() >= want) break
      throwIfTimedOut(deadline)
      try {
        await depositItemToBuffer(
          name, count, barrels, deadline, knowledge, observedSnapshots, MAX_WITHDRAW_FALLBACK_BARRELS,
        )
        console.log(`${tag} 腾位：${name} ×${count} → buffer`)
      } catch (e) {
        console.warn(`${tag} 腾位存入 ${name} 失败(跳过): ${(e && (e.reason || e.message)) || e}`)
      }
    }
    return freeNow()
  }

  // 余量收尾：逐名称把本命令增量放回 buffer。单个名称失败不阻断其它名称，调用方保留原始失败原因。
  async function flushTaskItemsToBuffer (
    names,
    baselineCounts,
    barrels,
    deadline,
    knowledge,
    observedSnapshots = null,
  ) {
    const failures = []
    const pending = taskItemCountsAboveBaseline(bot, names, baselineCounts)
    for (const [name, count] of pending) {
      try {
        await depositItemToBuffer(
          name,
          count,
          barrels,
          deadline,
          knowledge,
          observedSnapshots,
          MAX_WITHDRAW_FALLBACK_BARRELS,
        )
        console.log(`${tag} 余量收尾已把本命令增量 ${name} ×${count} 放回 buffer`)
      } catch (error) {
        const reason = String((error && (error.reason || error.message)) || error)
        failures.push(`${name}x${count}:${reason}`)
        console.warn(`${tag} 余量收尾回存 ${name} ×${count} 未完成: ${reason}`)
      }
    }
    return failures
  }

  // ── 成品交付（Req 16.3）────────────────────────────────────────────────────

  // 把背包中该物品的最多 maxQuantity 个存入成品容器，并以窗口真实槽位变化计数。
  async function depositItemToOutput (itemName, outputContainers, maxQuantity, deadline, observedSnapshots = null, depositOperation = null, depositDeltas = null) {
    const target = normalizeItemName(itemName)
    let deposited = 0
    let lastFailure = null
    const requested = Number.isFinite(maxQuantity) ? Math.max(0, Math.floor(maxQuantity)) : 0
    const candidates = (Array.isArray(outputContainers) ? outputContainers : [outputContainers]).filter(Boolean)
    for (const outputContainer of candidates) {
      if (deposited >= requested) break
      let win = null
      try {
        win = await openOutputContainer(outputContainer, deadline)
        if (bot.currentWindow && bot.currentWindow !== win) {
          win = bot.currentWindow
        }
        bot.currentWindow = win
        while (deposited < requested) {
          const item = findWindowBackpackItem(win, target)
          if (!item) break
          throwIfTimedOut(deadline)
          const moveCount = Math.min(item.count, requested - deposited)
          const beforeContainer = countWindowContainerItems(win, [target])
          const beforeBackpack = countWindowBackpackItems(win, [target])
          try {
            // Output is the task's commit boundary. The shared inventory helper
            // accepts either-side movement and can therefore mistake a local
            // optimistic backpack decrement for a server-confirmed deposit.
            // Use exact clicks here and require both container growth and
            // backpack shrinkage to remain stable before reporting completion.
            await transferWindowItem(bot, win, item.slot, moveCount, 'deposit')
            const actual = await confirmedWindowMove(
              win, [target], moveCount, beforeContainer, beforeBackpack, 'deposit', deadline,
            )
            if (actual <= 0) {
              lastFailure = `output_move_unconfirmed:${moveCount}`
              break
            }
            recordConfirmedDepositDelta(
              depositDeltas,
              depositOperation,
              outputContainer.containerId,
              beforeContainer,
              beforeContainer + actual,
              actual,
            )
            deposited += actual
          } catch (e) {
            lastFailure = (e && (e.reason || e.message)) || e
            break
          }
        }
      } catch (e) {
        lastFailure = (e && (e.reason || e.message)) || e
      } finally {
        await closeWindowAfterCursorPark(bot, win, () => {
          recordObservedSnapshot(observedSnapshots, bot, win, outputContainer, tag)
        })
      }
    }
    if (deposited < requested && lastFailure) {
      throw new CraftError(`output_deposit_failed:${lastFailure}`)
    }
    return deposited
  }

  // 交付最终产物到 purpose:output 成品容器（Req 16.3）：从 buffer 桶取出最终产物入背包周转区，
  // 再存入成品容器；分趟按背包周转量循环，直到交付满 deliverCount 或 buffer 中已无更多最终产物。
  // 返回实际交付到成品容器的数量。任意时刻背包仅做周转（与 §11.4 不变量一致）。
  async function deliverFinalProduct (
    finalName,
    deliverCount,
    barrels,
    outputContainer,
    deadline,
    knowledge,
    observedBufferSnapshots = null,
    observedOutputSnapshots = null,
    depositOperation = null,
    depositDeltas = null,
  ) {
    const names = [normalizeItemName(finalName)]
    const carryPerTrip = () => Math.max(1, countFreeInventorySlots(bot)) * DEFAULT_STACK_SIZE
    let deliveredTotal = 0
    let remaining = Number.isFinite(deliverCount) && deliverCount > 0 ? Math.floor(deliverCount) : 0

    // A previous command may have left the same item in the turnover inventory
    // (for example leather collected as a beef by-product). Consume that stock
    // first so the delivery does not fetch a duplicate quantity from buffer.
    let backpackCount = countInventoryItem(bot, finalName)
    let initialPlan = finalDeliveryInventoryPlan(backpackCount, remaining)
    if (initialPlan.directToOutput === 0 && backpackCount === 0 && remaining > 0) {
      // 换装/窗口同步后背包计数可能短暂落后；给一次短同步窗口再判定，避免把
      // 已在背包的成品误判为“必须从 buffer 取回”。
      await sleep(800)
      backpackCount = countInventoryItem(bot, finalName)
      initialPlan = finalDeliveryInventoryPlan(backpackCount, remaining)
    }
    if (initialPlan.directToOutput > 0) {
      const deposited = await depositItemToOutput(
        finalName,
        outputContainer,
        initialPlan.directToOutput,
        deadline,
        observedOutputSnapshots,
        depositOperation,
        depositDeltas,
      )
      deliveredTotal += deposited
      remaining -= deposited
      if (deposited !== initialPlan.directToOutput) return deliveredTotal
    }

    while (remaining > 0) {
      throwIfTimedOut(deadline)
      const batch = Math.min(remaining, carryPerTrip())
      const missing = await withdrawFromBarrels(
        names, batch, barrels, deadline, knowledge, observedBufferSnapshots, names,
      )
      const got = batch - missing
      if (got <= 0) break
      const deposited = await depositItemToOutput(
        finalName, outputContainer, Math.min(got, remaining), deadline, observedOutputSnapshots, depositOperation, depositDeltas,
      )
      deliveredTotal += deposited
      remaining -= deposited
      if (deposited <= 0) break
    }

    // Successful commands leave no target residue in the bot. Surplus stock is
    // inventory, not output for this order, so return it to the shared buffer.
    if (remaining === 0) {
      const residue = countInventoryItem(bot, finalName)
      if (residue > 0) {
        await depositItemToBuffer(
          finalName,
          residue,
          barrels,
          deadline,
          knowledge,
          observedBufferSnapshots,
          MAX_WITHDRAW_FALLBACK_BARRELS,
        )
      }
      const residueAfterCleanup = countInventoryItem(bot, finalName)
      if (residueAfterCleanup > 0) {
        throw new CraftError(`target_residue_cleanup_incomplete:${residueAfterCleanup}`)
      }
    }
    return deliveredTotal
  }

  // ── 配方解析 / 合成 ─────────────────────────────────────────────────────

  function resultItemId (step) {
    const reg = bot.registry
    const name = normalizeItemName(step && step.result && step.result.name)
    const item = reg && reg.itemsByName && reg.itemsByName[name]
    return item ? item.id : null
  }

  /** 物品 id → 名称（供 craftableInputNames 解析配方原料）。 */
  function itemNameOfId (id) {
    const reg = recipeNameRegistry || bot.registry
    const item = reg && reg.items && reg.items[id]
    return item ? item.name : ''
  }

  function liveItemIdOfName (name) {
    const normalized = normalizeItemName(name)
    const item = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[normalized]
    return item ? item.id : null
  }

  function sourceRecipeMatchesStep (recipe, step) {
    if (!recipe || !step || !Array.isArray(step.inputs) || step.inputs.length === 0) return true
    const counts = new Map()
    let sourceTotal = 0
    const add = (entry) => {
      if (entry == null || entry === -1) return
      const id = typeof entry === 'object' ? entry.id : entry
      const name = recipeNameRegistry && recipeNameRegistry.items && recipeNameRegistry.items[id]
        ? normalizeItemName(recipeNameRegistry.items[id].name)
        : ''
      if (name) {
        counts.set(name, (counts.get(name) || 0) + 1)
        sourceTotal += 1
      }
    }
    if (Array.isArray(recipe.inShape)) {
      for (const row of recipe.inShape) if (Array.isArray(row)) for (const entry of row) add(entry)
    }
    if (Array.isArray(recipe.ingredients)) for (const entry of recipe.ingredients) add(entry)
    const stepTotal = step.inputs.reduce((sum, input) => {
      const count = Number(input && input.count)
      return sum + (Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0)
    }, 0)
    if (sourceTotal !== stepTotal) return false
    return [...counts].every(([sourceName, sourceCount]) => {
      let allowedCount = 0
      for (const input of step.inputs) {
        const candidates = Array.isArray(input && input.names) ? input.names.map(normalizeItemName) : []
        if (candidates.includes(sourceName)) allowedCount += Math.max(0, Math.floor(Number(input.count) || 0))
      }
      return allowedCount >= sourceCount
    }) && step.inputs.every(input => {
      const candidates = Array.isArray(input && input.names) ? input.names.map(normalizeItemName) : []
      return candidates.length === 0 || candidates.some(name => counts.has(name))
    })
  }

  // Build a mineflayer Recipe from the planner's 1.21.4 recipe semantics and
  // the live bot registry's item IDs.  This avoids asking mineflayer to use a
  // malformed 1.21.11 recipe entry while preserving its normal click logic.
  function canonicalRecipeForStep (step, emitLog = true) {
    if (!recipeNameRegistry || !bot.registry || !step) return null
    const resultName = normalizeItemName(step.result && step.result.name)
    const sourceResult = recipeNameRegistry.itemsByName && recipeNameRegistry.itemsByName[resultName]
    const liveResultId = liveItemIdOfName(resultName)
    if (!sourceResult || liveResultId == null) return null
    const sourceList = recipeNameRegistry.recipes && recipeNameRegistry.recipes[sourceResult.id]
    if (!Array.isArray(sourceList) || sourceList.length === 0) return null
    const sourceRecipe = sourceList.find(recipe => sourceRecipeMatchesStep(recipe, step))
    if (!sourceRecipe) return null
    const mapEntry = (entry) => {
      if (entry == null || entry === -1) return null
      const sourceId = typeof entry === 'object' ? entry.id : entry
      const sourceItem = recipeNameRegistry.items && recipeNameRegistry.items[sourceId]
      const name = sourceItem && normalizeItemName(sourceItem.name)
      const liveId = liveItemIdOfName(name)
      if (liveId == null) throw new CraftError(`recipe_item_unmapped:${name || sourceId}`)
      const metadata = typeof entry === 'object' && entry.metadata != null ? entry.metadata : null
      return metadata == null ? liveId : [liveId, metadata]
    }
    const enumRecipe = {
      inShape: Array.isArray(sourceRecipe.inShape)
        ? sourceRecipe.inShape.map(row => Array.isArray(row) ? row.map(mapEntry) : row)
        : null,
      ingredients: Array.isArray(sourceRecipe.ingredients) ? sourceRecipe.ingredients.map(mapEntry) : null,
      result: { id: liveResultId, count: Number(sourceRecipe.result && sourceRecipe.result.count) || 1 },
    }
    const Recipe = require('prismarine-recipe')(bot.registry).Recipe
    let recipe = new Recipe(enumRecipe)
    recipe = rebindRecipeAlternatives(
      recipe,
      step,
      id => {
        const item = bot.registry && bot.registry.items && bot.registry.items[id]
        return item ? item.name : ''
      },
      liveItemIdOfName,
      name => countInventoryItem(bot, name),
    )
    if (emitLog) {
      console.log(`${tag} canonical recipe ${resultName}: source=1.21.4 live=${bot.version || '-'} resultId=${liveResultId}`)
    }
    return recipe
  }

  // The server is 1.21.11 while this bot's recipe table is built from the 1.21.4
  // protocol. IDs after the protocol insertion point can therefore point at a
  // different item even though the item name in the live inventory is correct.
  // Rebind recipe ingredients by name to the live item type before clicking.
  function remapRecipeIngredientsToLiveTypes (recipe) {
    if (!recipe || !bot.inventory || typeof bot.inventory.items !== 'function') return recipe
    const liveTypes = new Map()
    for (const item of bot.inventory.items()) {
      const name = normalizeItemName(item && item.name)
      const type = Number(item && item.type)
      if (name && Number.isInteger(type) && !liveTypes.has(name)) liveTypes.set(name, item)
    }
    let changed = false
    const remapEntry = (entry) => {
      if (!entry || typeof entry !== 'object' || entry.id == null || entry.id === -1) return entry
      const name = normalizeItemName(itemNameOfId(entry.id))
      const live = liveTypes.get(name)
      if (!live || live.type === entry.id) return entry
      changed = true
      return { ...entry, id: live.type, metadata: live.metadata ?? entry.metadata }
    }
    const inShape = Array.isArray(recipe.inShape)
      ? recipe.inShape.map(row => Array.isArray(row) ? row.map(remapEntry) : row)
      : recipe.inShape
    const ingredients = Array.isArray(recipe.ingredients)
      ? recipe.ingredients.map(remapEntry)
      : recipe.ingredients
    if (!changed) return recipe
    console.warn(`${tag} 配方输入按实时物品 ID 重映射: ${recipe.result && recipe.result.id}`)
    return Object.assign(Object.create(Object.getPrototypeOf(recipe)), recipe, { inShape, ingredients })
  }

  /**
   * 该步产物在**本地配方表**里的全部配方（与库存无关）。
   * 刻意直读 registry.recipes 而不用 recipesAll(id, null, null)：后者在 table=null 时只返回
   * 2x2 能做的，会把 3x3 配方的原料集合整片漏掉，收窄判据就会误伤。
   */
  function recipesForResultOf (step) {
    const id = resultItemId(step)
    if (id == null) return []
    const reg = bot.registry
    const table = reg && reg.recipes
    const list = table && table[id]
    return Array.isArray(list) ? list : []
  }

  // 判定该步是否需要 3x3 工作台（Req 14.5）：recipesAll 忽略库存，table=null 时只返回 2x2 配方；
  // 空则说明该产物只能靠 3x3 工作台合成。
  function stepRequiresTable (step) {
    const canonical = canonicalRecipeForStep(step, false)
    if (canonical) return Boolean(canonical.requiresTable)
    const id = resultItemId(step)
    if (id == null) return false
    let twoByTwo = []
    try { twoByTwo = bot.recipesAll(id, null, null) || [] } catch (_) { twoByTwo = [] }
    return twoByTwo.length === 0
  }

  // 取料到背包后解析当前可合成的具体配方（recipesFor 按库存过滤）。tableBlock 为 3x3 时的工作台方块引用。
  // 容器窗口刚关闭时 mineflayer 的 bot.inventory 计数可能落后于窗口真实槽位；在有界窗口内
  // 等待收敛，并以 recipesAll 作为同一配方的保守回退。最终点击仍由窗口 findInventoryItem
  // 按服务端真实槽位校验，缺料会明确变成 missing ingredient，而不是误报 recipe_unavailable。
  async function resolveCraftableRecipe (step, tableBlock, deadline) {
    // Prefer the planner's canonical 1.21.4 recipe.  The live 1.21.11 table
    // is retained only as a compatibility fallback for recipes absent from
    // the source registry (for example newly introduced server items).
    try {
      const canonical = canonicalRecipeForStep(step)
      if (canonical) return canonical
    } catch (error) {
      if (error instanceof CraftError) throw error
      console.warn(`${tag} canonical recipe lookup failed: ${error && error.message ? error.message : error}`)
    }
    const id = resultItemId(step)
    if (id == null) throw new CraftError('unknown_result_item')
    let recipes = []
    let fallback = []
    for (let attempt = 0; attempt < 12; attempt++) {
      try { recipes = bot.recipesFor(id, null, 1, tableBlock || null) || [] } catch (_) { recipes = [] }
      if (recipes.length > 0) break
      if (fallback.length === 0) {
        try { fallback = bot.recipesAll(id, null, tableBlock || null) || [] } catch (_) { fallback = [] }
      }
      if (fallback.length > 0 && attempt >= 2) {
        recipes = fallback
        console.warn(`${tag} 配方库存计数尚未收敛，使用本地已知配方回退: ${step.recipeId || id}`)
        break
      }
      if (deadline && Date.now() + 250 >= deadline) break
      await sleep(250)
    }
    if (recipes.length === 0) throw new CraftError('recipe_unavailable')
    const picked = remapRecipeIngredientsToLiveTypes(recipes[0])
    // 「本地乐观产出、服务端零消耗」时必须能分辨是配方本身选错还是窗口没开成。把实际选中的配方
    // 形状/材料如实打出来，避免只能靠猜。
    try {
      const shapeRows = Array.isArray(picked.inShape) ? picked.inShape.length : 0
      const shapeCols = Array.isArray(picked.inShape) && Array.isArray(picked.inShape[0])
        ? picked.inShape[0].length
        : 0
      const ingredients = Array.isArray(picked.ingredients)
        ? picked.ingredients.map(i => (i && i.id != null ? i.id : i)).join(',')
        : '-'
      console.log(
        `${tag} 配方选中 ${step.recipeId || id}: 候选=${recipes.length} ` +
        `requiresTable=${picked.requiresTable} inShape=${shapeRows}x${shapeCols} ` +
        `ingredients=[${ingredients}] resultCount=${picked.result && picked.result.count}`,
      )
    } catch (_) { /* 诊断不得打断合成 */ }
    return picked
  }

  // 前往工作台并返回其方块引用（Req 14.5 · 3x3 走登记 workstation）。
  async function navigateToWorkstation (workstation, deadline) {
    const bp = workstation && workstation.blockPos
    if (!bp || !Number.isFinite(bp.x)) throw new CraftError('workstation_missing')
    if (distTo(bp) > CONTAINER_INTERACT_DISTANCE) {
      await gotoNear(bp.x, bp.y, bp.z, 2, deadline)
    }
    throwIfTimedOut(deadline)
    const center = containerCenter(bp)
    try { await bot.lookAt(new Vec3(center.x, center.y, center.z)) } catch (_) { /* ignore */ }
    const block = bot.blockAt(new Vec3(bp.x, bp.y, bp.z))
    if (!block) throw new CraftError('workstation_block_missing')
    // 登记的工作台站位与 buffer 桶同源，存在 standResolvedBy:"server" 的推算假值（lastScanAt:null）。
    // 若坐标上其实不是工作台，bot.craft 会「本地乐观产出、服务端零消耗」，然后白烧 5 次重试才失败。
    // 这里按实测方块名判定并立即给出可读原因。
    const actualName = normalizeItemName(block.name || '')
    console.log(
      `${tag} 工作台实测: (${bp.x},${bp.y},${bp.z}) 方块=${actualName || 'unknown'} ` +
      `登记类型=${workstation.containerType || '-'} 距离=${distTo(bp).toFixed(2)}`,
    )
    if (actualName !== 'crafting_table') {
      throw new CraftError(`workstation_block_mismatch:crafting_table:${actualName || 'unknown'}`)
    }
    return block
  }

  // 统计某步每次配方触发会消耗的总输入数。候选 names 表示可替代物，不是并行输入，
  // 因此每个 input 只取其 count 一次。用于把乐观产物预测与真实输入消耗交叉确认。
  function stepInputCountPerTrigger (step) {
    const inputs = (step && Array.isArray(step.inputs)) ? step.inputs : []
    return inputs.reduce((sum, inp) => {
      const count = inp && Number.isFinite(inp.count) ? Math.max(1, Math.floor(inp.count)) : 1
      return sum + count
    }, 0)
  }

  // 统计某步全部候选输入物在背包中的当前总量。用于判断一次事务是否「真实消耗了输入」，
  // 从而区分「什么都没发生（可安全重试）」与「已消耗输入但产物慢同步（绝不重放）」。
  function countStepInputsInInventory (step) {
    const inputs = (step && Array.isArray(step.inputs)) ? step.inputs : []
    let total = 0
    for (const inp of inputs) {
      const names = (inp && Array.isArray(inp.names) ? inp.names : []).map(normalizeItemName).filter(Boolean)
      for (const nm of names) total += countInventoryItem(bot, nm)
    }
    return total
  }

  // 单次合成事务（Req 14.5）。mineflayer 原生 craft 会连续发送乐观窗口点击，真服可能只接受
  // 部分点击却在本地生成完整产物；事务期间临时包装 clickWindow，在每次后续点击前等待短间隔，
  // 并接管 putAway/putSelectedItemRange 堵死库内部的 -999 丢地上路径。
  // 返回值必带 trace（失败路径也要）：服务端产物槽回包是唯一权威产出信号，由调用方在结果确认期
  // 内持续读取，因此这里不 stop、也不再加固定尾延时。finally 只在仍是本包装时恢复。
  async function craftBatchOnce (recipe, count, tableBlock, deadline = null) {
    const originalClickWindow = bot.clickWindow
    const throttledClickWindow = createThrottledClickWindow(originalClickWindow, CRAFT_CLICK_DELAY_MS)
    // 2x2 就地合成不开新窗口，产物槽固定落在玩家背包窗口；3x3 的窗口号由开窗回包认领。
    const playerWindowId = Number.isInteger(bot.inventory && bot.inventory.id) ? bot.inventory.id : 0
    const trace = startCraftPacketTrace(bot, tableBlock ? null : playerWindowId)
    bot.clickWindow = throttledClickWindow
    const restoreLeftoverGuard = installCraftLeftoverGuard(bot, throttledClickWindow)
    let failure = null
    try {
      const remainingMs = Number.isFinite(deadline)
        ? Math.max(1, deadline - Date.now())
        : CRAFT_TRANSACTION_TIMEOUT_MS
      const transactionTimeoutMs = Math.min(CRAFT_TRANSACTION_TIMEOUT_MS, remainingMs)
      await runBoundedOperation(
        () => bot.craft(recipe, count, tableBlock || undefined),
        transactionTimeoutMs,
        'craft_transaction_timeout',
      )
      // 事务返回后窗口应已关闭。若仍留着窗口，说明 mineflayer 的点击序列没走完，
      // 「本地乐观产出、服务端零消耗」多半就出在这里。
      const win = bot.currentWindow
      if (win) {
        console.warn(
          `${tag} 合成事务返回后仍有打开窗口: type=${win.type || '-'} title=${JSON.stringify(win.title || '')} ` +
          `slots=${Array.isArray(win.slots) ? win.slots.length : '-'}`,
        )
      }
    } catch (e) {
      failure = new CraftError(`craft_transaction_failed:${(e && (e.reason || e.message)) || e}`)
      // 失败后的工作台 window revision 可能已与服务端失同步，继续点旧格子会被拒绝。
      // 放入格子的原料原本占用背包槽，关闭工作台后一定有同等槽位可原子退回；
      // 光标必须先安全停回背包，任何失败都不走 -999。
      const failedWindow = bot.currentWindow
      if (isCraftingTableWindow(failedWindow)) {
        try {
          await closeWindowAfterCursorPark(bot, failedWindow)
          await sleep(SYNC_SLEEP_MS)
        } catch (closeError) {
          failure = new CraftError(
            `craft_transaction_recovery_failed:${(e && (e.reason || e.message)) || e}:` +
            `${(closeError && (closeError.reason || closeError.message)) || closeError}`,
          )
        }
      }
    } finally {
      if (bot.clickWindow === throttledClickWindow) bot.clickWindow = originalClickWindow
      restoreLeftoverGuard()
    }
    return { trace, failure }
  }

  // 合成事务重试。真实产出 = 服务端合成窗口产物槽观测 ∩ 输入真实消耗；本地背包 delta 只做诊断，
  // 因为 bot.craft 无论服务端是否产出都会在本地伪造产物，且上一次失败留下的幻影会污染基线。
  // 每次尝试前后都清空合成格：滞留原料取回后 inputsConsumed 才是可信读数。
  async function craftBatchWithRetry (recipe, count, tableBlock, deadline, resultName, resultPer, step) {
    let remaining = Math.max(0, Math.floor(count))
    const per = Math.max(1, Math.floor(resultPer || 1))
    let producedTotal = 0
    let lastReason = null
    for (let attempt = 1; attempt <= MAX_CRAFT_RETRIES + 1 && remaining > 0; attempt++) {
      if (deadline != null) throwIfTimedOut(deadline)
      const reclaimedBefore = await reclaimCraftingGrid(bot)
      if (reclaimedBefore.length > 0) {
        console.warn(`${tag} 事务前合成格滞留已取回: ${reclaimedBefore.join(',')}`)
      }
      const before = countInventoryItem(bot, resultName)
      const inputsBefore = countStepInputsInInventory(step)
      const { trace, failure } = await craftBatchOnce(recipe, remaining, tableBlock, deadline)
      if (failure) lastReason = failure.reason

      const expectedNow = remaining * per
      const inputPerTrigger = stepInputCountPerTrigger(step)
      const expectedInputConsumption = remaining * inputPerTrigger
      const syncDeadline = Math.min(
        Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY,
        Date.now() + craftResultConfirmMs(remaining),
      )
      // 必须先取回滞留原料再进确认期，否则格子里的原料会被当成「已消耗」。
      let gridError = null
      try {
        const reclaimedAfter = await reclaimCraftingGrid(bot)
        if (reclaimedAfter.length > 0) {
          console.warn(`${tag} 事务后合成格滞留已取回: ${reclaimedAfter.join(',')}`)
        }
      } catch (e) {
        gridError = e
      }

      let serverTriggers = 0
      let producedNow = 0
      let inputsConsumed = 0
      let lastObservation = ''
      let stableSince = Date.now()
      do {
        await sleep(SYNC_SLEEP_MS)
        const nextServer = trace.resultTriggers(resultName)
        const nextConsumed = Math.max(0, inputsBefore - countStepInputsInInventory(step))
        const observation = `${nextServer}:${nextConsumed}`
        if (observation !== lastObservation) {
          lastObservation = observation
          stableSince = Date.now()
        }
        serverTriggers = nextServer
        inputsConsumed = nextConsumed
        producedNow = Math.max(0, countInventoryItem(bot, resultName) - before)

        // 服务端产物槽与输入消耗都足量且持续稳定，才可提前结束确认期。
        const fullyObserved = serverTriggers >= remaining &&
          (inputPerTrigger <= 0 || inputsConsumed >= expectedInputConsumption)
        if (fullyObserved && Date.now() - stableSince >= craftResultSettleMs(serverTriggers)) break
      } while (Date.now() < syncDeadline)
      trace.stop()
      if (CRAFT_PACKET_TRACE) console.log(`${tag} 合成回包追踪: ${trace.summary()}`)

      const { consumedTriggers, confirmedTriggers } = confirmedCraftTriggers({
        remaining, serverTriggers, inputsConsumed, inputPerTrigger,
      })
      if (serverTriggers !== consumedTriggers || producedNow !== confirmedTriggers * per) {
        console.warn(
          `${tag} 合成事务账实观察不一致: 服务端产物槽=${serverTriggers}/${remaining}, ` +
          `inputs=${inputsConsumed}/${expectedInputConsumption}, ` +
          `本地背包delta=${producedNow}/${expectedNow}, confirmedTriggers=${confirmedTriggers}/${remaining}`,
        )
      }
      if (confirmedTriggers > 0) {
        remaining -= confirmedTriggers
        producedTotal += confirmedTriggers * per
      }
      // 合成格取不回 = 物资卡死，必须明确失败；已确认产物随异常回传由上层入桶。
      if (gridError) {
        gridError.actualProduced = producedTotal
        throw gridError
      }
      if (remaining <= 0) {
        if (attempt > 1) console.log(`${tag} 合成事务在第 ${attempt} 次尝试完成真实产出确认`)
        return producedTotal
      }

      // 服务端确实产出过、但输入消耗覆盖了更多触发次数：不能把“多消耗的输入”当作安全剩余重放。
      if (serverTriggers > 0 && consumedTriggers > confirmedTriggers) {
        const error = new CraftError(
          `craft_result_ambiguous_inputs_consumed:${inputsConsumed}:${producedTotal}/${count * per}`,
        )
        error.actualProduced = producedTotal
        throw error
      }

      const action = classifyCraftAttempt({
        failure: !!failure,
        confirmedTriggers,
        inputsConsumed,
        serverObserved: serverTriggers,
      })
      if (action === 'ambiguous') {
        const error = new CraftError(`craft_result_ambiguous_inputs_consumed:${inputsConsumed}:${producedTotal}/${count * per}`)
        error.actualProduced = producedTotal
        throw error
      }
      if (attempt > MAX_CRAFT_RETRIES) break
      // no_effect_retry（输入未消耗）/ failure_retry（事务抛错）/ empty_result_retry（服务端产物槽
      // 全程为空＝服务端没凑成配方）都可安全补剩余次数，重放不会造成重复产出。
      const why = action === 'no_effect_retry'
        ? 'craft_no_effect'
        : (action === 'empty_result_retry' ? 'craft_server_result_slot_empty' : (lastReason || 'partial_result'))
      console.warn(`${tag} 合成事务未完整完成（第 ${attempt}/${MAX_CRAFT_RETRIES + 1} 次，已确认 ${producedTotal} 个产物）: ${why}，${CRAFT_RETRY_DELAY_MS}ms 后仅补剩余 ${remaining} 次`)
      await sleep(CRAFT_RETRY_DELAY_MS)
    }
    const error = new CraftError(`craft_transaction_failed_after_retries:${MAX_CRAFT_RETRIES}:${lastReason || 'partial_result'}:${producedTotal}/${count * per}`)
    error.actualProduced = producedTotal
    throw error
  }

  // 逐层自底向上：完整产出一个 craftStep 的全部触发次数。
  async function produceStep (
    step,
    barrels,
    workstations,
    deadline,
    knowledge,
    observedBufferSnapshots = null,
    baselineCounts = null,
    carryQuantity = 0,
  ) {
    const target = craftStepTriggerTarget(step)
    if (target <= 0) return
    const resultName = normalizeItemName(step.result && step.result.name)
    const resultPer = (step.result && Number.isFinite(step.result.count))
      ? Math.max(1, Math.floor(step.result.count))
      : 1
    const requiresTable = stepRequiresTable(step)

    // 物流批与事务批分离（关键性能修复）：
    //   - 物流批 haulBatch：一趟从 buffer 取多少次配方的原料、最后一次性把产物存回 buffer。
    //     只受背包槽位约束（输入槽 + 产物槽），可远大于单次事务上限。
    //   - 事务批 txBatch：单次 bot.craft 的触发数，仍严格受 MAX_CRAFT_BATCH_TRIGGERS 限制，
    //     把「部分输出已确认但输入已继续消耗」的真服风险边界压在一组内。
    // 旧实现两者是同一个数（16），于是 bamboo_mosaic 的 144 次要跑 9 趟 buffer↔工作台往返；
    // 现在同一趟原料可以连续跑多个事务，往返次数按背包容量成倍下降，事务安全性不变。
    let done = 0
    while (done < target) {
      throwIfTimedOut(deadline)
      const remaining = target - done
      const freeSlots = countFreeInventorySlots(bot)
      let haulBatch = computeHaulBatchSize(step, freeSlots, remaining, resultPer)
      haulBatch = Math.min(haulBatch, haulBatchCap(step, requiresTable))

      try {
        await withdrawInputsForBatch(
          step,
          haulBatch,
          barrels,
          deadline,
          knowledge,
          observedBufferSnapshots,
          baselineCounts,
        )
      } catch (e) {
        // buffer 里该原料略少于本趟计划量（上一步部分产出 / 其他任务占用）时不要整步判死：
        // 按背包里真实已取到的量降级继续跑，一次都凑不齐才失败。
        const reason = String((e && (e.reason || e.message)) || e)
        if (!reason.startsWith('insufficient_buffer_materials')) throw e
        const feasible = Math.min(
          remaining,
          feasibleBatchFromInventory(
            step,
            (name) => countInventoryAboveBaseline(bot, name, baselineCounts),
          ),
        )
        if (feasible <= 0) throw e
        console.warn(
          `${tag} craftStep ${step.recipeId || resultName} 本趟原料不足（${reason}），` +
          `按背包真实可行量降级为 ${feasible}/${haulBatch} 次继续`,
        )
        haulBatch = feasible
      }
      throwIfTimedOut(deadline)

      let tableBlock = null
      if (requiresTable) {
        // 3x3 需要工作台。登记坐标可能是服务端推算假值（standResolvedBy:"server"、lastScanAt:null），
        // 实体上未必是 crafting_table。首个候选 mismatch/缺失时换下一台，避免整单在坏坐标白烧
        // 重试；全部候选都不可用时才抛「无可用工作台」。
        // candidates 取 workstations 的**就地引用**：验证失败的坏台从数组中剔除（splice），
        // 这样本 step 的后续物流批不会重复导航到同一台坏台（此前每批都从 wi=0 重新试坏台）。
        const candidates = (Array.isArray(workstations) && workstations.length > 0)
          ? workstations
          : (await resolveWorkstations({}))
        if (candidates.length === 0) throw new CraftError('workstation_missing')
        let lastWsError = null
        for (let wi = 0; wi < candidates.length; wi++) {
          throwIfTimedOut(deadline)
          try {
            // 一趟原料只导航工作台一次；随后的多个事务批之间不再移动。
            tableBlock = await navigateToWorkstation(candidates[wi], deadline)
            break
          } catch (e) {
            const reason = String((e && (e.reason || e.message)) || e)
            if (!isWorkstationSwitchableReason(reason)) throw e
            lastWsError = e
            console.warn(
              `${tag} 工作台 ${wi + 1}/${candidates.length} 不可用（${reason}），换下一台`,
            )
            // 剔除坏台，避免本 step 后续物流批重复导航到它。
            candidates.splice(wi, 1)
            wi -= 1
          }
        }
        if (!tableBlock) throw lastWsError || new CraftError('workstation_missing')
      }
      const recipe = await resolveCraftableRecipe(step, tableBlock, deadline)

      let haulTriggers = 0
      let haulProduced = 0
      try {
        while (haulTriggers < haulBatch) {
          throwIfTimedOut(deadline)
          const txBatch = Math.min(haulBatch - haulTriggers, transactionBatchCap(requiresTable))
          const produced = await craftBatchWithRetry(
            recipe, txBatch, tableBlock, deadline, resultName, resultPer, step,
          )
          if (produced <= 0 || produced % resultPer !== 0) {
            throw new CraftError(`craft_quantity_mismatch:${produced}/${txBatch * resultPer}`)
          }
          haulTriggers += produced / resultPer
          haulProduced += produced
        }
      } catch (e) {
        // 本趟已真实产出的部分（含抛错事务里已确认的部分）必须先入 buffer，绝不留在背包。
        const partial = Number.isFinite(e && e.actualProduced) ? Math.max(0, Math.floor(e.actualProduced)) : 0
        const flushable = haulProduced + partial
        if (flushable > 0) {
          await depositItemToBuffer(
            resultName, flushable, barrels, deadline, knowledge, observedBufferSnapshots,
          )
        }
        throw e
      }
      throwIfTimedOut(deadline)

      const finalHaul = done + haulTriggers >= target
      const depositQuantity = bufferDepositQuantity(
        countInventoryAboveBaseline(bot, resultName, baselineCounts),
        carryQuantity,
        finalHaul,
        haulProduced,
      )
      if (depositQuantity > 0) {
        await depositItemToBuffer(
          resultName, depositQuantity, barrels, deadline, knowledge, observedBufferSnapshots,
        )
      }

      done += haulTriggers
      console.log(
        `${tag} craftStep ${step.recipeId || resultName} 进度 ${done}/${target}` +
        `（本趟真实产出 ${haulProduced}，触发 ${haulTriggers} 次，${requiresTable ? '3x3' : '2x2'}）`,
      )
    }
  }

  // ── craft_plan 主流程 ─────────────────────────────────────────────────────
  async function handleCraftPlan (cmd) {
    const requestId = cmd.requestId || cmd.id || `craft_plan:${cfg.id}:${Date.now()}`
    const craftSteps = Array.isArray(cmd.craftSteps) ? cmd.craftSteps : []

    const initialActive = longCommand.current()
    console.log(`${tag} craft_plan ${requestId} accepted mutex=${initialActive ? `${initialActive.kind}:${initialActive.requestId}` : 'idle'}`)

    // 占用中 → 拒绝新长命令，不中断进行中命令，上报 executor_busy（Req 13.2；收尾细化在 8.3）。
    if (!tryStartLongCommand('craft_plan', requestId)) {
      const predecessor = longCommand.current()
      const handedOff = await waitForLongCommandHandoff(longCommand)
      if (handedOff && tryStartLongCommand('craft_plan', requestId)) {
        console.log(`${tag} craft_plan ${requestId} waited for ${predecessor ? predecessor.kind : 'previous'} handoff`)
      } else {
        const active = longCommand.current()
        const kind = active && active.kind ? active.kind : 'unknown'
        console.warn(`${tag} craft_plan ${requestId} rejected: busy with ${kind}:${active && active.requestId ? active.requestId : '?'}`)
        reportEvent('craft_failed', preparationTerminalPayload(cmd, { requestId, reason: `executor_busy:${kind}` }))
        return
      }
    }

    // 动态预算：服务端按总触发次数与物流批数算出 budgetMs；缺失回退本地常量。
    activeBudgetMs = resolveCommandBudgetMs(cmd, CRAFT_TIMEOUT_MS)
    const deadline = Date.now() + activeBudgetMs
    const observedBufferSnapshots = new Map()
    const observedOutputSnapshots = new Map()
    const depositDeltas = []
    const baselineCounts = inventoryBaselineCounts(bot)
    let barrels = []
    let equipState = null
    const knowledge = createBufferKnowledge()
    try {
      console.log(`${tag} craft_plan ${requestId} entering full armor`)
      equipState = await enterFullArmor(bot)
      console.log(`${tag} craft_plan ${requestId} full armor ready`)
      if (craftSteps.length === 0) throw new CraftError('empty_craft_plan')

      // Req 14.1：材料全部堆入 buffer 桶前不开始合成 —— 由服务端在 hauling 阶段完成后才下发
      // craft_plan 保证；收到即视为「材料已全部入 buffer 桶」。这里解析可用的 buffer 桶 / 工作台。
      barrels = await resolveBufferBarrels(cmd)
      if (barrels.length === 0) throw new CraftError('no_buffer_barrel')
      const preferredBufferItems = craftSteps.flatMap(step =>
        (Array.isArray(step && step.inputs) ? step.inputs : [])
          .flatMap(input => Array.isArray(input && input.names) ? input.names : []),
      )
      barrels = await refreshBufferPriorities(barrels, preferredBufferItems)
      const workstations = await resolveWorkstations(cmd) // 可能为空，仅 3x3 步骤才需要

      // Req 14.2：按 craftSteps 拓扑序（叶子→成品）自底向上逐层合成。顺序处理即保证
      // 「先凑够本层全部产物再进上层」（下层步骤在前且完整产出后才轮到依赖它的上层步骤）。
      for (let stepIndex = 0; stepIndex < craftSteps.length; stepIndex++) {
        const step = craftSteps[stepIndex]
        throwIfTimedOut(deadline)
        const isFinalStep = stepIndex === craftSteps.length - 1
        const carryQuantity = stepResultCarryQuantity(
          step,
          isFinalStep ? null : craftSteps[stepIndex + 1],
          isFinalStep,
        )
        await produceStep(
          step,
          barrels,
          workstations,
          deadline,
          knowledge,
          observedBufferSnapshots,
          baselineCounts,
          carryQuantity,
        )
      }

      // 最终产物 = 最后一个 craftStep 的产物，此刻已落在 buffer 桶（各步 depositItemToBuffer）。
      const finalStep = craftSteps[craftSteps.length - 1]
      const finalName = normalizeItemName(finalStep && finalStep.result && finalStep.result.name)

      // 最终产物已落在 buffer。先解析并完成成品箱精确交付；只有交付成功后才上报
      // craft_completed / deposit_completed，避免交付失败时服务端短暂进入 depositing 再 failed。
      // 入队快照和开工时刷新只覆盖配方输入；最终产物可能同时来自本命令新合成与开工前旧库存。
      // 交付前按成品名再刷新一次，旧库存桶获得正提示，本命令新写入桶仍由 knowledge.locations 保留。
      barrels = await refreshBufferPriorities(barrels, [finalName])
      // 从 buffer 桶取出最终产物交付到成品容器（目标交付量 = 下单目标数量）。
      const deliverCount = finalDeliveryCount(cmd, finalStep)
      const outputContainer = await resolveOutputContainers(cmd, finalName, deliverCount)
      if (outputContainer.length === 0) throw new CraftError('no_output_container')
      const delivered = await deliverFinalProduct(
        finalName,
        deliverCount,
        barrels,
        outputContainer,
        deadline,
        knowledge,
        observedBufferSnapshots,
        observedOutputSnapshots,
        cmd.depositOperation,
        depositDeltas,
      )
      // A live recipe may consume the same item that it produces. Return any
      // command-scoped surplus (for example unused sugar inputs) after the
      // requested output is delivered, so strict closure never leaves residue.
      const surplusFailures = await flushTaskItemsToBuffer(
        taskItemNames(craftSteps, finalName),
        baselineCounts,
        barrels,
        Date.now() + FAILURE_CLEANUP_MS,
        knowledge,
        observedBufferSnapshots,
      )
      if (surplusFailures.length > 0) {
        throw new CraftError(`task_items_cleanup_failed:${surplusFailures.join(',')}`)
      }
      const completionEvents = craftCompletionEventTypes(delivered, deliverCount)
      if (completionEvents.length === 0) throw new CraftError(deliveryCompletionError(delivered, deliverCount))
      const depositPayload = buildDepositCompletionPayload(cmd, delivered, depositDeltas)
      if (!depositPayload) throw new CraftError('deposit_evidence_unavailable')

      // Req 16.3 / 16.4：成品入库成功 → 此时才上报 craft_completed，再用 deposit_completed
      // 完成任务。失败路径不会再产生短暂的 depositing 状态。
      reportEvent(completionEvents[0], preparationTerminalPayload(cmd, { requestId, finalItem: finalName }))
      const orderedBy = cmd.player || cmd.orderedBy || cmd.requester || null
      reportEvent(completionEvents[1], preparationTerminalPayload(cmd, {
        requestId,
        finalItem: finalName,
        delivered,
        ...depositPayload,
        ...observedPayload(observedBufferSnapshots, observedOutputSnapshots),
        ...(orderedBy ? { player: orderedBy } : {}),
      }))
      console.log(`${tag} craft_plan ${requestId} 完成: 最终产物 ${finalName} ×${delivered} 已交付 output 容器 ${outputContainer.containerId || '?'}`)
    } catch (err) {
      let reason = (err && err.isCraftError)
        ? err.reason
        : `executor_exception:${(err && err.message) || err}`
      console.warn(`${tag} craft_plan ${requestId} 失败: ${reason}`)
      // 已取出但尚未消耗/交付的命令增量必须回到 buffer；命令前基线永不参与回存。
      try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null) } catch (_) { /* ignore */ }
      if (barrels.length > 0) {
        const cleanupBudget = Number.isFinite(FAILURE_CLEANUP_MS)
          ? Math.max(5_000, Math.floor(FAILURE_CLEANUP_MS))
          : 90_000
        const cleanupFailures = await flushTaskItemsToBuffer(
          taskItemNames(craftSteps, cmd.target && cmd.target.name),
          baselineCounts,
          barrels,
          Date.now() + cleanupBudget,
          knowledge,
          observedBufferSnapshots,
        )
        if (cleanupFailures.length > 0) {
          reason += `;task_items_cleanup_failed:${cleanupFailures.join(',')}`
        }
      }
      // 已发生的物理取存即使最终失败也必须回传，服务端先校准再收敛任务。
      reportEvent('craft_failed', preparationTerminalPayload(cmd, {
        requestId,
        reason,
        ...(depositDeltas.length > 0 ? {
          finalItem: cmd.depositOperation && cmd.depositOperation.itemName,
          delivered: depositDeltas.reduce((sum, row) => sum + row.delta, 0),
        } : {}),
        ...(buildDepositCompletionPayload(cmd, depositDeltas.reduce((sum, row) => sum + row.delta, 0), depositDeltas) || {}),
        ...observedPayload(observedBufferSnapshots, observedOutputSnapshots),
      }))
    } finally {
      // 收尾：关仍打开的窗口 + 停止残留寻路 + 释放长命令占用（Req 13.3）。
      await closeOpenWindows(null)
      try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null) } catch (_) { /* ignore */ }
      await restoreEquipMode(bot, equipState, error => console.warn(`${tag} restore equip mode failed: ${error.message}`))
      finishLongCommand(requestId)
    }
  }

  // deliver_only：从缓冲桶取出目标产物直送成品箱（无合成步骤的纯库存交付订单）。
  async function handleDeliverOnly (cmd) {
    const requestId = cmd.requestId || cmd.id || `deliver_only:${cfg.id}:${Date.now()}`
    const targetName = normalizeItemName(cmd.target && cmd.target.name)
    const quantity = (cmd.target && Number.isFinite(cmd.target.quantity) && cmd.target.quantity > 0)
      ? Math.floor(cmd.target.quantity)
      : 0

    if (!tryStartLongCommand('deliver_only', requestId)) {
      const active = longCommand.current()
      console.warn(`${tag} deliver_only ${requestId} rejected: busy with ${active.kind}:${active.requestId}`)
      reportEvent('craft_failed', preparationTerminalPayload(cmd, { requestId, reason: `executor_busy:${active.kind}` }))
      return
    }

    // deliver_only 无合成步骤，服务端未下发 budgetMs 时沿用本地常量。
    activeBudgetMs = resolveCommandBudgetMs(cmd, CRAFT_TIMEOUT_MS)
    const deadline = Date.now() + activeBudgetMs
    const observedBufferSnapshots = new Map()
    const observedOutputSnapshots = new Map()
    const depositDeltas = []
    const baselineCounts = inventoryBaselineCounts(bot)
    let barrels = []
    let equipState = null
    const knowledge = createBufferKnowledge()
    try {
      equipState = await enterFullArmor(bot)
      if (!targetName || quantity <= 0) throw new CraftError('invalid_deliver_only_request')
      barrels = await resolveBufferBarrels(cmd)
      if (barrels.length === 0) throw new CraftError('no_buffer_barrel')
      barrels = await refreshBufferPriorities(barrels, [targetName])
      const outputContainer = await resolveOutputContainers(cmd, targetName, quantity)
      if (outputContainer.length === 0) throw new CraftError('no_output_container')

      const delivered = await deliverFinalProduct(
        targetName,
        quantity,
        barrels,
        outputContainer,
        deadline,
        knowledge,
        observedBufferSnapshots,
        observedOutputSnapshots,
        cmd.depositOperation,
        depositDeltas,
      )
      const deliveryError = deliveryCompletionError(delivered, quantity)
      if (deliveryError) throw new CraftError(deliveryError)
      const depositPayload = buildDepositCompletionPayload(cmd, delivered, depositDeltas)
      if (!depositPayload) throw new CraftError('deposit_evidence_unavailable')

      const orderedBy = cmd.player || cmd.orderedBy || cmd.requester || null
      reportEvent('deposit_completed', preparationTerminalPayload(cmd, {
        requestId,
        finalItem: targetName,
        delivered,
        ...depositPayload,
        ...observedPayload(observedBufferSnapshots, observedOutputSnapshots),
        ...(orderedBy ? { player: orderedBy } : {}),
      }))
      console.log(`${tag} deliver_only ${requestId} 完成: ${targetName} ×${delivered} 已交付 output 容器`)
    } catch (err) {
      let reason = (err && err.isCraftError)
        ? err.reason
        : `executor_exception:${(err && err.message) || err}`
      console.warn(`${tag} deliver_only ${requestId} 失败: ${reason}`)
      try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null) } catch (_) { /* ignore */ }
      if (barrels.length > 0 && targetName) {
        const cleanupBudget = Number.isFinite(FAILURE_CLEANUP_MS)
          ? Math.max(5_000, Math.floor(FAILURE_CLEANUP_MS))
          : 90_000
        const cleanupFailures = await flushTaskItemsToBuffer(
          [targetName],
          baselineCounts,
          barrels,
          Date.now() + cleanupBudget,
          knowledge,
          observedBufferSnapshots,
        )
        if (cleanupFailures.length > 0) {
          reason += `;task_items_cleanup_failed:${cleanupFailures.join(',')}`
        }
      }
      reportEvent('craft_failed', preparationTerminalPayload(cmd, {
        requestId,
        reason,
        ...(depositDeltas.length > 0 ? {
          finalItem: cmd.depositOperation && cmd.depositOperation.itemName,
          delivered: depositDeltas.reduce((sum, row) => sum + row.delta, 0),
        } : {}),
        ...(buildDepositCompletionPayload(cmd, depositDeltas.reduce((sum, row) => sum + row.delta, 0), depositDeltas) || {}),
        ...observedPayload(observedBufferSnapshots, observedOutputSnapshots),
      }))
    } finally {
      await closeOpenWindows(null)
      try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null) } catch (_) { /* ignore */ }
      await restoreEquipMode(bot, equipState, error => console.warn(`${tag} restore equip mode failed: ${error.message}`))
      finishLongCommand(requestId)
    }
  }

  // 显式运维恢复：只把事故前已记录基线以上、且不超过声明数量的真实背包物回存 buffer。
  // 使用正常开箱/窗口变化/快照事件链，不修改任务 JSON 或融合库存文件。
  async function runStartupBufferRecovery () {
    if (!recoveredBuffer) return
    const { itemName, quantity, expectedBaseline } = recoveredBuffer
    const current = countInventoryItem(bot, itemName)
    const recoverable = Math.min(quantity, Math.max(0, current - expectedBaseline))
    if (recoverable <= 0) {
      console.log(`${tag} buffer 恢复无需执行: ${itemName} 当前=${current},已记录旧基线=${expectedBaseline}`)
      return
    }
    const requestId = `buffer-recovery:${cfg.id}:${itemName}:${Date.now()}`
    if (!tryStartLongCommand('buffer_recovery', requestId)) {
      console.warn(`${tag} buffer 恢复暂缓: 执行器忙碌`)
      return
    }
    const observedSnapshots = new Map()
    let equipState = null
    try {
      equipState = await enterFullArmor(bot)
      const barrels = await resolveBufferBarrels({})
      if (barrels.length === 0) throw new CraftError('no_buffer_barrel')
      const knowledge = createBufferKnowledge()
      const cleanupBudget = Number.isFinite(FAILURE_CLEANUP_MS)
        ? Math.max(5_000, Math.floor(FAILURE_CLEANUP_MS))
        : 90_000
      await depositItemToBuffer(
        itemName,
        recoverable,
        barrels,
        Date.now() + cleanupBudget,
        knowledge,
        observedSnapshots,
        MAX_WITHDRAW_FALLBACK_BARRELS,
      )
      console.log(
        `${tag} buffer 恢复完成: ${itemName} ×${recoverable} 已按真实窗口变化回存，` +
        `旧基线保留 ${expectedBaseline}`,
      )
    } catch (error) {
      console.warn(
        `${tag} buffer 恢复失败: ${(error && (error.reason || error.message)) || error}；` +
        '未回存部分仍保留在背包，启动 readiness 拒绝注册',
      )
      throw error
    } finally {
      let index = 0
      let allReported = true
      for (const snapshot of observedSnapshots.values()) {
        // Ported from olela: snapshots go to the local sink (fire-and-forget, never
        // gates the task). The olela version retried HTTP posts to its preparation
        // server and failed the task when reporting failed.
        const entry = { requestId: `${requestId}:${index++}`, containerId: snapshot.containerId, snapshot }
        if (typeof craftSink.onEvent === 'function') {
          try { craftSink.onEvent('container_scanned', entry) } catch (_) { allReported = false }
        }
      }
      await closeOpenWindows(null)
      try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null) } catch (_) { /* ignore */ }
      await restoreEquipMode(bot, equipState, error => console.warn(`${tag} restore equip mode failed: ${error.message}`))
      finishLongCommand(requestId)
      if (!allReported) throw new CraftError('buffer_recovery_snapshot_report_failed')
    }
  }

  // station-executor 委派入口：按命令 type 分发（Req 13.1）。
  function handleCommand (cmd) {
    const type = cmd && cmd.type
    // 任务成品白名单：craft/deliver 要把成品（如 shears）存入 buffer/output，
    // 而 gear-guard 会把这类物品当受保护装备禁止入容器。命令期间登记成品名，
    // gear-guard 对白名单内物品放行入桶/入成品箱；命令结束清回。
    let taskTarget = null
    if (type === 'deliver_only' && cmd.target && cmd.target.name) {
      taskTarget = normalizeItemName(cmd.target.name)
    } else if (type === 'craft_plan' && Array.isArray(cmd.craftSteps) && cmd.craftSteps.length > 0) {
      const last = cmd.craftSteps[cmd.craftSteps.length - 1]
      taskTarget = last && last.result && last.result.name
        ? normalizeItemName(last.result.name)
        : null
    }
    const prevDeliverables = bot._taskDeliverables
    if (taskTarget) {
      const merged = new Set(prevDeliverables instanceof Set ? prevDeliverables : [])
      merged.add(taskTarget)
      bot._taskDeliverables = merged
    }
    const clearDeliverables = () => {
      if (taskTarget) bot._taskDeliverables = prevDeliverables
    }
    if (type === 'craft_plan') {
      return handleCraftPlan(cmd).catch(err => {
        console.warn(`${tag} handleCraftPlan 顶层异常:`, (err && err.message) || err)
      }).finally(clearDeliverables)
    }
    if (type === 'deliver_only') {
      return handleDeliverOnly(cmd).catch(err => {
        console.warn(`${tag} handleDeliverOnly 顶层异常:`, (err && err.message) || err)
      }).finally(clearDeliverables)
    }
    console.warn(`${tag} 未知命令 type=${type}`)
  }

  // 挂到共享 bot 对象，供 station-executor 轮询到 craft_plan 命令时委派（Req 13.1）。
  bot._craftingExecutor = {
    handleCommand,
    isBusy: () => longCommand.isBusy(),
  }

  if (recoveredBuffer) {
    // station-executor 在下一事件循环注册，并等待这条 readiness：恢复的真实容器快照被 API
    // 确认前 bot 不会进入可派单池，避免新任务拿到恢复前的旧优先级。
    const previousReadiness = bot._startupReadiness
    bot._startupReadiness = Promise.resolve(previousReadiness)
      .then(() => sleep(2_000))
      .then(() => runStartupBufferRecovery())
      .then(() => true)
      .catch((error) => {
        bot._startupReadinessError = `buffer_recovery_failed:${(error && (error.reason || error.message)) || error}`
        console.warn(`${tag} buffer 恢复顶层异常，保持未注册:`, bot._startupReadinessError)
        return false
      })
  }

  console.log(`${tag} 就绪（等待 station-executor 委派 craft_plan）`)
}

// 暴露纯函数供单元测试（不依赖真实 bot / mineflayer 会话，任务 8.4）。
module.exports._test = {
  CraftError,
  recordConfirmedDepositDelta,
  buildDepositCompletionPayload,
  craftableInputNames,
  rebindRecipeAlternatives,
  spillableInventoryCounts,
  runBoundedOperation,
  createThrottledClickWindow,
  confirmedMoveFromCounts,
  createWindowMoveConfirmer,
  parkWindowCursor,
  transferWindowItem,
  transferableWindowCount,
  isWindowTransferDestinationFull,
  outputItemCapacity,
  isCraftingTableWindow,
  reclaimCraftingGrid,
  installCraftLeftoverGuard,
  startCraftPacketTrace,
  closeWindowAfterCursorPark,
  createLongCommandMutex,
  isWorkstationSwitchableReason,
  commandContainerCandidates,
  safeCloseWindow,
  containerCenter,
  countInventoryItem,
  inventoryBaselineCounts,
  countInventoryAboveBaseline,
  taskItemNames,
  taskItemCountsAboveBaseline,
  parseRecoveredBufferArg,
  countWindowContainerItems,
  countWindowBackpackItems,
  findWindowBackpackItem,
  createBufferKnowledge,
  rememberBufferAvailable,
  rememberBufferAbsent,
  rememberBufferTouched,
  mergeLiveWithdrawPriorities,
  preferredConcreteInputName,
  orderBarrelsForWithdraw,
  orderBarrelsForDeposit,
  countFreeInventorySlots,
  craftStepTriggerTarget,
  stepConsumesItem,
  stepResultCarryQuantity,
  bufferDepositQuantity,
  inputSlotsForBatch,
  outputSlotsForBatch,
  computeBatchSize,
  computeHaulBatchSize,
  feasibleBatchFromInventory,
  transactionBatchCap,
  haulBatchCap,
  confirmedCraftTriggers,
  classifyCraftAttempt,
  finalDeliveryCount,
  deliveryCompletionError,
  finalDeliveryInventoryPlan,
  craftCompletionEventTypes,
  sortBarrelsByDistance,
  rankOutputContainers,
  loadOutputContainerRanks,
  CRAFT_TIMEOUT_MS,
  CRAFT_WINDOW_CLICK_TIMEOUT_MS,
  CRAFT_TRANSACTION_TIMEOUT_MS,
  CRAFT_RESULT_CONFIRM_MS,
  craftResultConfirmMs,
  CRAFT_RESULT_SETTLE_MS,
  CRAFT_AUTHORITATIVE_SETTLE_MS,
  craftResultSettleMs,
  DEFAULT_STACK_SIZE,
  TURNOVER_OUTPUT_RESERVE,
  MAX_CRAFT_RETRIES,
  MAX_CRAFT_BATCH_TRIGGERS,
  MAX_WITHDRAW_FALLBACK_BARRELS,
  FAILURE_CLEANUP_MS,
  CRAFT_RETRY_DELAY_MS,
  CRAFT_CLICK_DELAY_MS,
  CRAFT_WINDOW_MOVE_CONFIRM_MS,
  CRAFT_WINDOW_MOVE_SETTLE_MS,
}

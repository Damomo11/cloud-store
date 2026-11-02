'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// 备料终态事件的归属身份回传（Phase B · Task B3 fix，设计 §4.4 «Ownership fencing»）
//
// 为什么必须回传：API 侧的 epoch / generation 围栏**只在事件携带**
// assignmentEpoch / expectedBotGeneration 时才判定。执行器只回传 requestId + live
// botGeneration 时，stale_epoch / stale_generation 在生产里永远是 0 —— 而设计 §10
// Gate 3 把「旧 generation 接受 = 0」当晋级标准：没有数据流动会让这个指标空洞地为真，
// 在 8 小时真服窗口上造成假通过。
//
// 单一来源：所有执行器（collect / hunt / interact / container transfer·withdraw·scan /
// craft / deliver）的终态上报都经这里投影，未来加字段只改这一处而不是六处。
//
// 缺省语义（向后兼容硬约束）：命令不带归属字段（非 campaign 单）→ 投影为空对象，
// 终态载荷与今天逐字节相同、不新增键。live `botGeneration` 由各执行器的 reporter 注入，
// 本模块**不碰**它：既有的 live-generation 守卫必须保持原样。
// ─────────────────────────────────────────────────────────────────────────────

/** 终态事件必须回传的归属字段（顺序即载荷键序；新增字段只改这一处）。 */
const PREPARATION_AFFINITY_EVENT_FIELDS = Object.freeze([
  'runId',
  'laneId',
  'itemId',
  'assignmentEpoch',
  'expectedBotGeneration',
])

const NUMERIC_AFFINITY_FIELDS = new Set(['assignmentEpoch', 'expectedBotGeneration'])

/**
 * 把命令上的归属身份投影成事件载荷片段。
 *
 * 值取**命令上的分配时值**（服务端下发时写入），不是 bot 的 live 值：围栏要比的就是
 * 「这条活是按哪次归属派出去的」。缺失 / null / 非法数字一律视为未携带 → 该字段不出现。
 */
function preparationEventAffinity (command) {
  const fragment = {}
  if (!command || typeof command !== 'object') return fragment
  for (const field of PREPARATION_AFFINITY_EVENT_FIELDS) {
    const value = command[field]
    if (value === undefined || value === null) continue
    if (NUMERIC_AFFINITY_FIELDS.has(field)) {
      const n = Number(value)
      if (!Number.isFinite(n)) continue
      fragment[field] = n
      continue
    }
    const s = String(value)
    if (!s) continue
    fragment[field] = s
  }
  return fragment
}

/**
 * 终态事件载荷 = 归属片段 + 执行器自身载荷。
 *
 * 归属放前面：执行器字段永远覆盖同名归属键（不可能被归属投影改写既有语义），
 * 且无归属时键序与今天完全一致。
 */
function preparationTerminalPayload (command, payload) {
  return { ...preparationEventAffinity(command), ...payload }
}

function buildDepositCompletionPayload (command, delivered, rows) {
  const operation = command && command.depositOperation
  if (!operation || !operation.operationId || !operation.owner || !Array.isArray(rows) || rows.length === 0) return null
  const physicalDelta = rows.reduce((sum, row) => sum + Number(row && row.delta), 0)
  if (!Number.isFinite(physicalDelta) || physicalDelta !== Number(delivered)) return null
  return {
    operationId: operation.operationId,
    owner: { ...operation.owner },
    depositDeltas: rows.map(row => ({ ...row })),
  }
}

module.exports = {
  PREPARATION_AFFINITY_EVENT_FIELDS,
  preparationEventAffinity,
  preparationTerminalPayload,
  buildDepositCompletionPayload,
}

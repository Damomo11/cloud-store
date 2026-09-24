const fs = require('node:fs')
const path = require('node:path')

// 取货链路日志：每次存取/同步任务生成一个 traceId，全链路（定位木桶、开桶快照、
// 逐槽取物、拆盒、放回、扣账等决策）按时间顺序追加写入 logs/withdraw-trace-日期.jsonl。
// 物品取不出去时，把对应日志文件发回来即可按 traceId 复盘是哪个环节出了问题。

const state = {
  enabled: false,
  directory: path.resolve(process.cwd(), 'logs'),
  retentionDays: 14,
  dirEnsured: false,
  warned: false
}

const FILE_PREFIX = 'withdraw-trace-'

function configureTraceLog (options = {}) {
  state.enabled = options?.enabled !== false
  if (options?.directory) state.directory = path.resolve(String(options.directory))
  const retention = Number(options?.retentionDays)
  if (Number.isFinite(retention) && retention > 0) state.retentionDays = Math.floor(retention)
  state.dirEnsured = false
  if (state.enabled) pruneOldTraceFiles()
}

function isTraceEnabled () {
  return state.enabled
}

function ensureDirectory () {
  if (state.dirEnsured) return
  fs.mkdirSync(state.directory, { recursive: true })
  state.dirEnsured = true
}

function pruneOldTraceFiles () {
  try {
    ensureDirectory()
    const cutoff = Date.now() - state.retentionDays * 86400000
    for (const name of fs.readdirSync(state.directory)) {
      const match = name.match(new RegExp(`^${FILE_PREFIX}(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`))
      if (!match) continue
      const fileTime = Date.parse(`${match[1]}T00:00:00`) // 本地时区零点，与文件名口径一致
      if (Number.isFinite(fileTime) && fileTime < cutoff) {
        fs.rmSync(path.join(state.directory, name), { force: true })
      }
    }
  } catch (error) {
    warnOnce(`prune failed: ${error?.message || error}`)
  }
}

function warnOnce (message) {
  if (state.warned) return
  state.warned = true
  console.warn(`[trace-log] 链路日志写入失败（本次进程不再重复提醒）：${message}`)
}

function newTraceId (prefix = 'wd') {
  const random = Math.random().toString(36).slice(2, 6)
  return `${prefix}-${Date.now().toString(36)}-${random}`
}

function startTrace (meta = {}) {
  if (!state.enabled) return null
  const kind = String(meta.kind || 'withdraw')
  const prefix = kind === 'sync'
    ? 'sy'
    : (kind === 'recovery'
        ? 'rc'
        : (kind === 'barrel-debug' ? 'bd' : (kind === 'command' ? 'cmd' : 'wd')))
  const trace = {
    traceId: newTraceId(prefix),
    bot: String(meta.bot || ''),
    kind,
    startedAt: Date.now()
  }
  traceEvent(trace, 'start', 'trace_start', meta)
  return trace
}

// trace 为 null（未启用）时静默跳过；写入失败只告警一次，绝不影响业务流程。
function traceEvent (trace, phase, event, data = {}) {
  if (!trace || !state.enabled) return
  const entry = {
    ts: new Date().toISOString(),
    traceId: trace.traceId,
    kind: trace.kind,
    bot: trace.bot || undefined,
    phase,
    event,
    elapsed: Math.max(0, Date.now() - (trace.startedAt || Date.now())),
    ...data
  }
  try {
    ensureDirectory()
    fs.appendFileSync(traceFileFor(), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (error) {
    try {
      state.dirEnsured = false
      ensureDirectory()
      fs.appendFileSync(traceFileFor(), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (retryError) {
      warnOnce(retryError?.message || retryError)
    }
  }
}

function traceSummary (trace, data = {}) {
  traceEvent(trace, 'end', 'task_summary', data)
}

// 任务上下文之外的独立单条记录（如机器人空闲时的回复）：每条自带 traceId，只写一行。
function traceStandalone (kind, phase, event, data = {}) {
  if (!state.enabled) return null
  const prefix = kind === 'command' ? 'cmd' : 'rpl'
  const trace = {
    traceId: newTraceId(prefix),
    bot: String(data.bot || ''),
    kind,
    startedAt: Date.now()
  }
  traceEvent(trace, phase, event, data)
  return trace.traceId
}

function traceFileFor (date = new Date()) {
  // 文件名按本地日期切分，方便按“今天”找文件；时间戳字段仍是 UTC ISO 格式。
  const pad = value => String(value).padStart(2, '0')
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return path.join(state.directory, `${FILE_PREFIX}${stamp}.jsonl`)
}

// itemKey 形如 minecraft:diamond|<sha1>；取指纹末 6 位作为人类可读短码。
function shortKey (itemKey) {
  const parts = String(itemKey || '').split('|')
  return (parts[parts.length - 1] || '').slice(-6)
}

module.exports = {
  configureTraceLog,
  isTraceEnabled,
  startTrace,
  traceEvent,
  traceSummary,
  traceStandalone,
  traceFileFor,
  shortKey
}

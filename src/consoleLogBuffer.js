// 终端实时日志环形缓冲：包装 console.log/warn/error/info/debug，每条输出
// 在原样写回 stdout/stderr 的同时追加进内存环形缓冲（默认 5000 条滚动），
// 供 Web 管理面板的「运行日志」页轮询展示。未安装时零开销（不包装）。

const DEFAULT_LIMIT = 5000

const state = {
  installed: false,
  buffer: [],
  limit: DEFAULT_LIMIT,
  nextSeq: 1,
  startedAt: 0,
  wrapped: new Map(),
  original: new Map()
}

function formatArgument (value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || `${value.name || 'Error'}: ${value.message}`
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatArguments (args) {
  if (!args.length) return ''
  // Node 的 console 把首个 Error 参数格式化成多行堆栈；这里压成单行保持
  // “每次调用 = 一条日志”，堆栈各行以 · 分隔。
  return args.map(formatArgument).join(' ').replace(/\s*\n\s*/g, ' · ')
}

function appendEntry (level, text) {
  const entry = {
    seq: state.nextSeq++,
    ts: Date.now(),
    level,
    text
  }
  state.buffer.push(entry)
  if (state.buffer.length > state.limit) state.buffer.splice(0, state.buffer.length - state.limit)
  return entry
}

function wrapConsoleMethod (name, original, level) {
  return function wrapped (...args) {
    try {
      appendEntry(level, formatArguments(args))
    } catch {
      // 日志缓冲绝不能影响业务输出
    }
    return original.apply(console, args)
  }
}

// options.limit：环形缓冲条数上限（滚动窗口）。
function installConsoleLogBuffer (options = {}) {
  if (state.installed) {
    const limit = Number(options?.limit)
    if (Number.isFinite(limit) && limit > 0) state.limit = Math.floor(limit)
    return state
  }
  const limit = Number(options?.limit)
  state.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT
  state.startedAt = Date.now()
  for (const [name, level] of Object.entries({ log: 'log', info: 'info', warn: 'warn', error: 'error', debug: 'debug' })) {
    const original = console[name]
    if (typeof original !== 'function') continue
    const wrapped = wrapConsoleMethod(name, original, level)
    state.original.set(name, original)
    state.wrapped.set(name, wrapped)
    console[name] = wrapped
  }
  state.installed = true
  console.log(`[console-log] terminal ring buffer installed (limit ${state.limit} lines)`)
  return state
}

function uninstallConsoleLogBuffer () {
  if (!state.installed) return
  for (const name of state.wrapped.keys()) {
    const original = state.original.get(name)
    if (original && console[name] === state.wrapped.get(name)) console[name] = original
  }
  state.wrapped.clear()
  state.original.clear()
  state.buffer.length = 0
  state.installed = false
}

// 直接写入一条面板日志（不经终端），用于面板自身的说明性信息。
function pushPanelLog (level, text) {
  return appendEntry(level, String(text ?? ''))
}

// afterSeq 为 0/undefined 时返回全量（供面板首次进入）；否则只返回更新的行。
function snapshotConsoleLogs ({ afterSeq = 0, limit } = {}) {
  const rows = state.buffer.filter(row => row.seq > Number(afterSeq || 0))
  const requested = Number(limit)
  const sliced = Number.isFinite(requested) && requested > 0 ? rows.slice(-Math.floor(requested)) : rows
  return {
    rows: sliced,
    total: state.buffer.length,
    limit: state.limit,
    nextSeq: state.nextSeq,
    startedAt: state.startedAt
  }
}

function isConsoleLogBufferInstalled () {
  return state.installed
}

module.exports = {
  installConsoleLogBuffer,
  uninstallConsoleLogBuffer,
  snapshotConsoleLogs,
  pushPanelLog,
  isConsoleLogBufferInstalled,
  DEFAULT_LIMIT
}

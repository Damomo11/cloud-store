'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// command-budget.js — 长命令「动态执行预算」解析（采集 / 击杀 / 交互 / 合成共用）
//
// 服务端 executionBudget.ts 按真实工作量（采集数量 × method 单位成本、合成触发次数与
// 物流批数）算出 budgetMs 随 inbox 命令下发。固定墙钟对采 1 个和采 446 个都用同一个值，
// 两头都错：小单卡死要等满 30 分钟白占 bot，大单正常推进却被判超时。
//
// 这里只做「取命令预算，缺失回退本地常量」，并夹在安全区间内，避免异常/被篡改的
// budgetMs（0、负数、NaN、几天）直接变成执行器 deadline。
// 纯函数，便于在既有测试文件中断言。
// ─────────────────────────────────────────────────────────────────────────────

// 任何命令预算都不会低于/高于这两个界。下界保证极小单也有完整一次补给往返的余量；
// 上界防止异常大的预算让一个卡死的长命令长期占用 bot（真正卡死仍由各执行器看门狗兜底）。
const MIN_COMMAND_BUDGET_MS = 60_000
const MAX_COMMAND_BUDGET_MS = 2 * 60 * 60 * 1000

function resolveCommandBudgetMs (cmd, fallbackMs, opts = {}) {
  const min = Number.isFinite(opts.min) ? Math.max(1, Math.floor(opts.min)) : MIN_COMMAND_BUDGET_MS
  const max = Number.isFinite(opts.max) ? Math.max(min, Math.floor(opts.max)) : MAX_COMMAND_BUDGET_MS
  const fallback = Number.isFinite(fallbackMs) && fallbackMs > 0 ? Math.floor(fallbackMs) : min
  const raw = cmd && typeof cmd === 'object' ? Number(cmd.budgetMs) : NaN
  const chosen = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
  return Math.min(max, Math.max(min, chosen))
}

module.exports = {
  resolveCommandBudgetMs,
  MIN_COMMAND_BUDGET_MS,
  MAX_COMMAND_BUDGET_MS,
}

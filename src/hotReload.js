const path = require('node:path')
const { spawn } = require('node:child_process')

// 管理员命令 !热重载 的执行模块：
// 1. git pull 更新代码；2. 等所有 bot 空闲；3. 拉起新代码进程并让旧进程退出。
// 重启通过“新进程先启动、旧进程再退出”实现，不依赖 pm2/systemd 等外部守护。
// 各步骤都提供依赖注入口，测试里不跑真实 git、不真的退出进程。

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_IDLE_POLL_MS = 500
const RESTART_START_DELAY_MS = 3000

function defaultGitExec () {
  return process.platform === 'win32' ? ['git', 'pull'] : ['git', 'pull']
}

function gitPull ({ exec = defaultGitExec, cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const [command, ...args] = typeof exec === 'function' ? exec() : exec
    if (!command) {
      resolve({ updated: true, output: 'git 不可用，跳过代码更新' })
      return
    }
    let output = ''
    let settled = false
    let child
    try {
      child = spawn(command, args, { cwd, windowsHide: true })
    } catch (error) {
      reject(new Error(`git pull 启动失败：${error.message}`))
      return
    }
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.stderr?.on('data', chunk => { output += String(chunk) })
    child.on('error', error => {
      if (settled) return
      settled = true
      if (error?.code === 'ENOENT') {
        resolve({ updated: true, output: `${output}git 命令不存在，跳过代码更新` })
        return
      }
      reject(new Error(`git pull 执行失败：${error.message}`))
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      if (code === 0) resolve({ updated: true, output: output.trim() })
      else reject(new Error(`git pull 失败（退出码 ${code}）：${output.trim().slice(-400)}`))
    })
  })
}

// 所有 bot 空闲 = 没有 worker 正在执行任务、死亡恢复或急救，且任务池没有排队任务。
// worker 标志优先于 snapshot：snapshot 只反映 active 任务，看不到恢复中/急救中的 bot。
function isTaskPoolIdle (taskPool) {
  if (!taskPool) return true
  for (const worker of taskPool.workers || []) {
    if (worker?.active || worker?.recoveringFromDeath || worker?.emergencyRescueActive) return false
  }
  if (typeof taskPool.snapshot === 'function') {
    const snapshot = taskPool.snapshot()
    if (snapshot.active?.length || snapshot.queued?.length) return false
  }
  return true
}

function defaultSleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 等到空闲再返回 true；等不到（超时）返回 false。判定空闲后再多等 1 秒收尾。
// 轮询定时器保持 ref：热重载等待期间进程必须活着，不能被当成“空闲”退出。
function waitForIdle ({ taskPool, timeoutMs = DEFAULT_IDLE_TIMEOUT_MS, pollMs = DEFAULT_IDLE_POLL_MS, sleep = defaultSleep, now = Date.now } = {}) {
  if (isTaskPoolIdle(taskPool)) return sleep(1000).then(() => true)
  return new Promise(resolve => {
    const startedAt = now()
    const timer = setInterval(() => {
      if (isTaskPoolIdle(taskPool)) {
        clearInterval(timer)
        sleep(1000).then(() => resolve(true))
        return
      }
      if (now() - startedAt >= timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, pollMs)
  })
}

// 拉起接替进程：新进程先初始化，旧进程随后退出，避免 Web 面板长时间不可用。
// 返回 { start, cancel }：start 立即拉起；cancel 用于放弃重启（如 shutdown 阶段出错）。
// 延迟定时器保持 ref：它到期拉起新进程前，旧进程不能先被事件循环判定为空闲退出。
function scheduleSuccessorProcess ({
  entryFile = path.join(process.cwd(), 'src', 'index.js'),
  spawnImplementation = spawn,
  startDelayMs = RESTART_START_DELAY_MS
} = {}) {
  let child = null
  let cancelled = false
  const start = () => {
    if (cancelled) return null
    child = spawnImplementation(process.execPath, [entryFile], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child?.unref?.()
    return child
  }
  const timer = setTimeout(start, startDelayMs)
  return {
    start,
    cancel () {
      cancelled = true
      clearTimeout(timer)
      try { child?.kill?.() } catch {}
    }
  }
}

// 完整热重载流程。notify(message) 负责把进度私聊给管理员。
// shutdown 在退出前执行（收尾 db/订阅等）；exitProcessImplementation() 在 shutdown
// 完成后调用，用于真正退出进程（生产传 () => process.exit(0)）。
// gitPull/waitForIdle/scheduleSuccessorProcess 可注入以便测试。
async function runHotReload ({
  notify,
  taskPool,
  gitExec,
  cwd,
  idleTimeoutMs,
  pollMs,
  sleep,
  now,
  entryFile,
  spawnImplementation,
  shutdown,
  exitProcess,
  gitPull: runGitPull = gitPull,
  waitForIdle: runWaitForIdle = waitForIdle,
  scheduleSuccessorProcess: startSuccessor = scheduleSuccessorProcess
}) {
  notify('开始热重载：先 git pull 更新代码，然后等所有机器人空闲后重启程序。')

  let pullResult
  try {
    pullResult = await runGitPull({ exec: gitExec, cwd })
  } catch (error) {
    notify(`热重载中止：${error.message}`)
    return { status: 'pull_failed' }
  }

  notify('代码更新完成，等待机器人空闲……如果一直有任务在跑，超时后会直接重启（进行中的任务会在重启后自动恢复）。')
  const idle = await runWaitForIdle({ taskPool, timeoutMs: idleTimeoutMs, pollMs, sleep, now })
  if (!idle) {
    notify('等待超时：仍有任务未结束，现在直接重启（进行中的任务会在重启后自动恢复）。')
  }

  const successor = startSuccessor({ entryFile, spawnImplementation })
  notify('机器人已空闲，程序将在几秒后用新代码重启；如果几分钟后机器人没上线，请手动启动一次。')

  try {
    await shutdown?.()
  } catch (error) {
    successor.cancel()
    notify(`热重载中止：退出前收尾失败（${error.message}）。本次不重启。`)
    return { status: 'shutdown_failed', error }
  }

  await exitProcess?.()
  return { status: 'restarting', pullResult, successor }
}
module.exports = {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_IDLE_POLL_MS,
  RESTART_START_DELAY_MS,
  defaultGitExec,
  gitPull,
  isTaskPoolIdle,
  waitForIdle,
  scheduleSuccessorProcess,
  runHotReload
}

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { sanitizeChatText } = require('./utils')

// 管理员命令 !热重载 的执行模块：
// 1. git pull 更新代码；2. 等所有 bot 空闲；3. 拉起新代码进程并让旧进程退出。
// 重启通过“新进程先启动、旧进程再退出”实现，不依赖 pm2/systemd 等外部守护。
// 各步骤都提供依赖注入口，测试里不跑真实 git、不真的退出进程。
//
// 多 bot 多进程共用同一个仓库目录：git pull 用文件锁互斥（同一时刻只允许一个进程拉取，
// 其余进程排队等待后各自再拉一次），避免并发 fetch 抢 ref 锁互相失败。
// git pull 使用 --ff-only：只允许快进，遇到本地与远端分叉时明确报错，不自动合并。

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_IDLE_POLL_MS = 500
const RESTART_START_DELAY_MS = 3000
const PULL_LOCK_FILE = '.hotreload-pull.lock'
const PULL_LOCK_STALE_MS = 5 * 60 * 1000
const PULL_LOCK_WAIT_TIMEOUT_MS = 3 * 60 * 1000
const PULL_LOCK_POLL_MS = 500

function defaultGitExec () {
  return process.platform === 'win32' ? ['git', 'pull', '--ff-only'] : ['git', 'pull', '--ff-only']
}

// 尝试创建 pull 锁（O_EXCL 原子创建）。锁文件写入进程号与时间（供排查用）。
// 陈旧判定基于文件系统 mtime 而非文件内容：创建即有 mtime，
// 不存在“进程在写入内容前崩溃留下空锁被误判陈旧”的窗口。
// 超过 staleMs 的残锁（进程被强杀留下）允许抢占重建：unlink 前二次校验 mtime 仍过期，
// 把误删他人新锁的竞态窗口压缩到毫秒级（且后果只是回到并发 pull，不会更糟）。
function tryCreatePullLock (lockPath, staleMs = PULL_LOCK_STALE_MS) {
  const create = () => {
    const fd = fs.openSync(lockPath, 'wx')
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
    } finally {
      fs.closeSync(fd)
    }
    return true
  }
  const lockAgeMs = () => {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs
    } catch {
      return Infinity // 锁刚被别人删掉，视为可立即重建
    }
  }
  try {
    return create()
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (lockAgeMs() < staleMs) return false
    if (lockAgeMs() < staleMs) return false // 复核：两次 stat 之间若他人已重建新锁（mtime 变新），放弃抢占
    try { fs.unlinkSync(lockPath) } catch {}
    try {
      return create()
    } catch {
      return false
    }
  }
}

// 释放 pull 锁：只删除自己进程创建的锁（校验 pid），避免误删别人抢占后重建的新锁。
function releasePullLock (lockPath) {
  try {
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf8') || '{}')
    if (info?.pid === process.pid) fs.unlinkSync(lockPath)
  } catch {}
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
      else reject(new Error(`git pull 失败（退出码 ${code}）：${output.trim().slice(-200)}`))
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
// shutdown 在退出前执行（收尾 db/订阅等）；exitProcess 在 shutdown 完成后调用，
// 用于真正退出进程（生产传 () => process.exit(0)）。
// gitPull/waitForIdle/scheduleSuccessorProcess 可注入以便测试。
//
// spawnSuccessor（默认 false）：是否在退出前自己拉起新代码进程。
// 默认关闭——部署推荐在 screen 循环 / systemd 等外层守护里跑，进程退出后由守护重启，
// 新进程留在原会话里、日志可见。只有裸跑（无任何守护）时才需要置 true。
async function runHotReload ({
  notify,
  taskPool,
  gitExec,
  cwd = process.cwd(),
  idleTimeoutMs,
  pollMs,
  sleep = defaultSleep,
  now,
  spawnSuccessor = false,
  entryFile,
  spawnImplementation,
  shutdown,
  exitProcess,
  gitPull: runGitPull = gitPull,
  waitForIdle: runWaitForIdle = waitForIdle,
  scheduleSuccessorProcess: startSuccessor = scheduleSuccessorProcess,
  pullLockPath = path.join(cwd, PULL_LOCK_FILE),
  pullLockStaleMs = PULL_LOCK_STALE_MS,
  pullLockWaitTimeoutMs = PULL_LOCK_WAIT_TIMEOUT_MS,
  pullLockPollMs = PULL_LOCK_POLL_MS
}) {
  // 所有进度通知先过聊天字符白名单清洗，git 输出里的特殊符号不会再触发服务器踢人。
  const safeNotify = message => notify(sanitizeChatText(message))

  safeNotify('开始热重载：先 git pull 更新代码，然后等所有机器人空闲后重启程序。')

  // 跨进程文件锁互斥：同一时刻只允许一个进程执行 git pull，
  // 其余进程排队等待后各自再拉一次（多进程部署下每个进程都要完成自己的 pull+重启）。
  let locked = tryCreatePullLock(pullLockPath, pullLockStaleMs)
  if (!locked) {
    safeNotify('检测到其他机器人进程正在更新代码，排队等待中……')
    const waitStartedAt = Date.now()
    while (!locked) {
      await sleep(pullLockPollMs)
      locked = tryCreatePullLock(pullLockPath, pullLockStaleMs)
      if (!locked && Date.now() - waitStartedAt >= pullLockWaitTimeoutMs) break
    }
    if (!locked) {
      safeNotify('等待其他进程更新代码超时，本次热重载中止。若刚才的热重载进程异常退出，残锁约 5 分钟后自动失效可再试；紧急时可删除仓库目录下的 .hotreload-pull.lock 后重试。')
      return { status: 'pull_lock_timeout' }
    }
  }

  let pullResult
  try {
    pullResult = await runGitPull({ exec: gitExec, cwd })
  } catch (error) {
    safeNotify(`热重载中止：${error.message}`)
    return { status: 'pull_failed' }
  } finally {
    releasePullLock(pullLockPath)
  }

  safeNotify('代码更新完成，等待机器人空闲……如果一直有任务在跑，超时后会直接重启（进行中的任务会在重启后自动恢复）。')
  const idle = await runWaitForIdle({ taskPool, timeoutMs: idleTimeoutMs, pollMs, sleep, now })
  if (!idle) {
    safeNotify('等待超时：仍有任务未结束，现在直接重启（进行中的任务会在重启后自动恢复）。')
  }

  // 内部拉继任者时，新进程延迟几秒启动再退旧进程，让新进程完成初始化（绑端口等），
  // 避免热重载期间 Web 面板长时间不可用。
  let successor = null
  if (spawnSuccessor) {
    successor = startSuccessor({ entryFile, spawnImplementation })
    safeNotify('机器人已空闲，程序将在几秒后用新代码重启；如果几分钟后机器人没上线，请手动启动一次。')
  } else {
    safeNotify('机器人已空闲，程序即将退出并由外层守护用新代码重新拉起。')
  }

  try {
    await shutdown?.()
  } catch (error) {
    successor?.cancel()
    safeNotify(`热重载中止：退出前收尾失败（${error.message}）。本次不重启。`)
    return { status: 'shutdown_failed', error }
  }

  await exitProcess?.()
  return { status: 'restarting', pullResult, successor }
}
module.exports = {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_IDLE_POLL_MS,
  RESTART_START_DELAY_MS,
  PULL_LOCK_FILE,
  PULL_LOCK_STALE_MS,
  PULL_LOCK_WAIT_TIMEOUT_MS,
  PULL_LOCK_POLL_MS,
  defaultGitExec,
  gitPull,
  tryCreatePullLock,
  releasePullLock,
  isTaskPoolIdle,
  waitForIdle,
  scheduleSuccessorProcess,
  runHotReload
}

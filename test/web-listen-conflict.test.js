const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const localErrorLog = require('../src/localErrorLog')
const CloudStoreWebServer = require('../src/webServer')

// Web 端口被占（EADDRINUSE）= 已有另一实例在跑。此前进程会带着 uncaught-exception
// 继续运行（面板死了但 bot 还在接单，和别的实例抢命令）；
// 现在监听失败必须记录错误并 process.exit(1)，由外层守护决定重试或告警。

function createWebServer (port) {
  // 最小 db 桩：GET / 会走 session 清理/加载的 this.db.db.prepare，桩掉即可拿到 200 首页。
  const db = {
    db: {
      prepare: () => ({ run: () => {}, get: () => null, all: () => [] })
    }
  }
  const config = { web: { enabled: true, host: '127.0.0.1', port } }
  return new CloudStoreWebServer(db, config, () => null)
}

async function waitFor (predicate, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('web server exits the process when the listen port is already in use', async () => {
  const blocker = http.createServer(() => {})
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
  const busyPort = blocker.address().port

  const exits = []
  const originalExit = process.exit
  const originalLog = console.error
  // logLocalError 真实落盘到 logs/errors.jsonl（项目已有该行为），这里只压掉终端输出。
  process.exit = code => { exits.push(code) }
  console.error = () => {}

  try {
    const server = createWebServer(busyPort)
    server.start()
    await waitFor(() => exits.length > 0, 3000)
  } finally {
    process.exit = originalExit
    console.error = originalLog
    await new Promise(resolve => blocker.close(resolve))
  }

  assert.equal(exits.length, 1, 'process.exit called exactly once')
  assert.equal(exits[0], 1, 'exit code 1')
})

test('web server keeps serving when the port is free', async () => {
  const server = createWebServer(0)
  server.start()
  await waitFor(() => Boolean(server.server?.address()), 3000)
  const address = server.server.address()
  assert.ok(address?.port > 0, 'listening on a free port')

  const body = await new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: address.port, path: '/' }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, data }))
    })
    request.on('error', reject)
  })
  // 首页 HTML 正常返回（GET / 无 cookie 会先建 session，但页面仍 200）
  assert.equal(body.status, 200)
  assert.ok(body.data.length > 0, 'panel HTML served')
  await new Promise(resolve => server.server.close(resolve))
})

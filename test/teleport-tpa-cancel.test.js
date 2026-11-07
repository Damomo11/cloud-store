const test = require('node:test')
const assert = require('node:assert/strict')

const CloudStoreService = require('../src/service')
const { DEFAULT_CONFIG } = require('../src/config')

// 最小 service mock：只铺 teleportToPlayer 的依赖（沿用 teleport-cross-dimension.test.js 的形态）。
// 覆盖目标：15 秒传送超时后必须补发 tpacancel 撤回服务端挂着的过期 tpa 请求。
function makeService () {
  const sent = []
  const msgs = []
  const service = Object.create(CloudStoreService.prototype)
  service.config = structuredClone(DEFAULT_CONFIG)
  service.bot = {
    username: 'TestBot',
    // 记录实际发出的聊天指令，断言撤回顺序与内容
    chat: text => sent.push(text),
    entity: { position: { x: 0, y: 64, z: 0 } }
  }
  service.msg = (username, text) => msgs.push({ username, text })
  service.waitForTeleportChunksReady = async () => true
  service.resolvePlayerEntity = () => ({ entity: null, source: 'none' })
  service.describePosition = () => '0,64,0'
  return { service, sent, msgs }
}

test('传送超时：先发 tpa，超时后补发 tpacancel 撤回请求', async () => {
  const { service, sent, msgs } = makeService()
  service.waitForPlayerNearby = async () => false // 15 秒内玩家没接受，走超时分支
  const ok = await service.teleportToPlayer('Away')
  assert.equal(ok, false)
  // 先请求、后撤回，顺序不能反
  assert.deepEqual(sent, ['/tpa Away', '/tpa cancel'])
  // 提示要告诉玩家已撤回，且保留兜底告诫（插件可能已过期导致撤回失败）
  const last = msgs.at(-1)
  assert.equal(last.username, 'Away')
  assert.match(last.text, /传送请求已撤回/)
  assert.match(last.text, /请不要再接受/)
})

test('传送成功：不补发撤回指令', async () => {
  const { service, sent } = makeService()
  service.waitForPlayerNearby = async () => true // 玩家及时接受，传送到位
  const ok = await service.teleportToPlayer('Near')
  assert.equal(ok, true)
  assert.deepEqual(sent, ['/tpa Near']) // 只有请求本身，没有多余的 cancel
})

test('tpacancel 支持自定义模板（{player} 占位可选）', async () => {
  const { service, sent } = makeService()
  service.config.commands.tpacancel = '/tpacancel {player}'
  service.waitForPlayerNearby = async () => false
  await service.teleportToPlayer('Alex')
  assert.deepEqual(sent, ['/tpa Alex', '/tpacancel Alex'])
})

test('notify:false 的静默调用方（如取货交付）超时同样撤回', async () => {
  const { service, sent, msgs } = makeService()
  service.waitForPlayerNearby = async () => false
  const ok = await service.teleportToPlayer('Quiet', { notify: false })
  assert.equal(ok, false)
  assert.deepEqual(sent, ['/tpa Quiet', '/tpa cancel'])
  // notify:false 只免掉"已向你发送传送请求"的预告，撤回后的告知仍要发
  assert.equal(msgs.filter(m => m.text.includes('已向你发送传送请求')).length, 0)
  assert.match(msgs.at(-1).text, /传送请求已撤回/)
})

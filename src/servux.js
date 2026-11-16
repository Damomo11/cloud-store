// Servux litematics 通道客户端：隔空查方块实体 NBT，代替 bot 逐个跑路开木桶同步仓库。
// 协议（通道 servux:litematics，PROTOCOL_VERSION=2，参考 sakura-ryoko/servux 的
// LitematicsDataProvider / ServuxLitematicaPacket）：
//   C2S type=2 注册（named NBT {version:2}）      → S2C type=1 metadata（握手完成）
//   C2S type=3 + BlockPos（8字节大端 long，FriendlyByteBuf.writeBlockPos/asLong 位布局）
//                                                → S2C type=5 + BlockPos + int32长度 + [GZIP]named NBT
// 服务端对查不到的方块（区块未加载/权限不足）不回包，靠单包超时兜底。
const zlib = require('node:zlib')
const nbt = require('prismarine-nbt')

const SERVUX_CHANNEL = 'servux:litematics'
const PROTOCOL_VERSION = 2
const S2C_METADATA = 1
const C2S_METADATA_REQUEST = 2
const C2S_BLOCK_ENTITY_REQUEST = 3
const S2C_BLOCK_NBT_RESPONSE_SIMPLE = 5

function writeVarInt (value) {
  let val = Number(value)
  const bytes = []
  while (true) {
    const byte = val & 0x7F
    val = Math.floor(val / 128)
    if (val === 0) { bytes.push(byte); break }
    bytes.push(byte | 0x80)
  }
  return Buffer.from(bytes)
}

// BlockPos 线上格式 = FriendlyByteBuf.writeBlockPos：固定 8 字节大端 long，
// 位布局与 vanilla asLong 一致：val = (x & 0x3FFFFFF) << 38 | (z & 0x3FFFFFF) << 12 | (y & 0xFFF)
// 注意不是 varlong——sakura 26.3 参考实现两侧都走 FriendlyByteBuf 的定长 long，
// varlong 编码会被服务器解出垃圾坐标（区块未加载 → 不回包 → 全部超时）。
function encodeBlockPos (x, y, z) {
  const val = (BigInt(x & 0x3FFFFFF) << 38n) | (BigInt(z & 0x3FFFFFF) << 12n) | BigInt(y & 0xFFF)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(val)
  return buf
}

// 注册包：varint(2) + FriendlyByteBuf.writeNbt 格式的 NBT。
// 1.21.11 与 26.3 官方字节码一致：readNbt 直接以首字节为 tag 类型（无长度前缀），
// 即 [0x0A][条目...][0x00]。此前多塞的 varint 长度头（0x10）被服务器当成非法
// tag 类型，Servux 的 try/catch 吞掉后静默——这就是线上全超时的根因。
function buildRegisterPacket () {
  const nbtBytes = Buffer.from([
    0x0A, // TAG_Compound（无名根，直接条目）
    0x03, 0x00, 0x07, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6F, 0x6E, 0x00, 0x00, 0x00, 0x02, // TAG_Int "version" = 2
    0x00 // TAG_End
  ])
  return Buffer.concat([
    writeVarInt(C2S_METADATA_REQUEST),
    nbtBytes
  ])
}

function buildBlockEntityRequest (x, y, z) {
  return Buffer.concat([writeVarInt(C2S_BLOCK_ENTITY_REQUEST), encodeBlockPos(x, y, z)])
}

function readVarIntFrom (buffer, offset) {
  let value = 0
  let shift = 0
  while (offset < buffer.length) {
    const byte = buffer[offset++]
    value |= (byte & 0x7F) << shift
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset }
    shift += 7
    if (shift > 35) return { value, offset }
  }
  return { value, offset }
}

function signExtend (value, bits) {
  const half = 1 << (bits - 1)
  const full = 1 << bits
  let num = Number(value)
  if (num >= half) num -= full
  return num
}

function readBlockPosFrom (buffer, offset) {
  const raw = buffer.readBigUInt64BE(offset)
  return {
    x: signExtend((raw >> 38n) & 0x3FFFFFFn, 26),
    y: signExtend(raw & 0xFFFn, 12),
    z: signExtend((raw >> 12n) & 0x3FFFFFFn, 26),
    offset: offset + 8
  }
}

// 发包：nmp 没有 writeChannel API，用原生 custom_payload 包写。
function writePayload (client, data) {
  client.write('custom_payload', { channel: SERVUX_CHANNEL, data })
}

// 回包负载：先试 GZIP 解压，失败回退裸 NBT（对齐 Servux 的 DataByteBufUtils.fromByteBuf）。
// 1.20.5+ 网络回包是「无名根」NBT，而 prismarine-nbt.parse 只认 named 根。
// 用字节特征确定性区分两种根（不猜）：
//   unnamed 非空：0A + 条目tagId(≠00)…；unnamed 空：0A 00（仅 2 字节）
//   named：0A + 根名长度（高位恒 00，标准实现根名极短）
// unnamed 就在 0A 后补空根名（00 00）转 named 再解析。
async function decodeBlockNbt (payload) {
  let buffer = payload
  try {
    buffer = zlib.gunzipSync(payload)
  } catch {
    // 非压缩数据，直接当裸 NBT 用
  }
  if (buffer.length < 2 || buffer[0] !== 0x0A) {
    throw new Error(`非 compound 根 NBT（首字节 0x${(buffer[0] ?? -1).toString(16)}，长度 ${buffer.length}）`)
  }
  const isUnnamed = buffer.length === 2 || buffer[1] !== 0x00
  if (isUnnamed) {
    buffer = Buffer.concat([buffer.subarray(0, 1), Buffer.from([0x00, 0x00]), buffer.subarray(1)])
  }
  // 显式 big endian（Java 版网络 NBT）；不传格式时空 compound（0A 00 00 00）
  // 会被 prismarine-nbt 误判成基岩版 level.dat 头，空箱子必踩。
  const { parsed } = await nbt.parse(buffer, 'big')
  return nbt.simplify(parsed)
}

class ServuxClient {
  // client = mineflayer 的 bot._client；options 见 config.servux。
  constructor (client, options = {}) {
    this.client = client
    this.options = {
      handshakeTimeoutMs: 5000,
      perTick: 4,
      tickMs: 50,
      maxInFlight: 100,
      requestTimeoutMs: 5000,
      ...options
    }
    this.available = null // null = 尚未握手；true/false = 握手结果
    this.metadata = null
    // 同一坐标可能被并发查询多次（如测速循环取样同一批桶），按坐标挂 FIFO 队列，
    // 回包/超时都对队首结算，避免后来的请求把先来的顶掉导致 Promise 悬挂。
    this.pending = new Map() // 'x,y,z' -> [{ resolve, timer, sentAt }]
    this.inFlight = 0
    this.queue = [] // { posKey, x, y, z, resolve }
    this.pumpTimer = null
    this.payloadHandler = null
    this.handshakeWaiter = null
    this.destroyed = false
  }

  attach () {
    if (this.payloadHandler || this.destroyed) return
    this.payloadHandler = packet => this.handlePayload(packet)
    this.client.on('custom_payload', this.payloadHandler)
  }

  destroy () {
    this.destroyed = true
    if (this.payloadHandler) {
      this.client.removeListener('custom_payload', this.payloadHandler)
      this.payloadHandler = null
    }
    this.stopPump()
    for (const jobs of this.pending.values()) {
      for (const job of jobs) {
        clearTimeout(job.timer)
        job.resolve({ ok: false, reason: 'destroyed' })
      }
    }
    this.pending.clear()
    this.inFlight = 0
    for (const job of this.queue) job.resolve({ ok: false, reason: 'destroyed' })
    this.queue = []
  }

  // 注册握手：服务器没有 Servux（或该功能没启用）时超时返回 false，调用方回退开箱同步。
  async handshake () {
    if (this.destroyed) return false
    if (this.available !== null) return this.available
    this.attach()
    const timeoutMs = this.options.handshakeTimeoutMs
    const outcome = await new Promise(resolve => {
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.handshakeWaiter = null
        this.available = value
        resolve(value)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref?.()
      this.handshakeWaiter = finish
      try {
        // 1.21.6+ 的 payload 协商：客户端需先通过 minecraft:register 声明支持的
        // 通道（\0 分隔），否则协议转换/注册表环节会静默丢弃该通道双向的包。
        // bot（mineflayer）不会替 mod 声明，这里自己发；老版本服务器会忽略它。
        this.client.write('custom_payload', {
          channel: 'minecraft:register',
          data: Buffer.from(`${SERVUX_CHANNEL}\0`, 'utf8')
        })
        // 2. 再发 servux 握手请求
        writePayload(this.client, buildRegisterPacket())
      } catch {
        finish(false)
      }
    })
    return outcome
  }

  handlePayload (packet) {
    if (this.destroyed || packet?.channel !== SERVUX_CHANNEL) return
    const data = packet.data
    if (!Buffer.isBuffer(data) || data.length === 0) return
    const { value: type, offset } = readVarIntFrom(data, 0)
    if (type === S2C_METADATA) {
      this.handshakeWaiter?.(true)
      return
    }
    if (type !== S2C_BLOCK_NBT_RESPONSE_SIMPLE) return
    const pos = readBlockPosFrom(data, offset)
    let length = 0
    let cursor = pos.offset
    if (cursor + 4 <= data.length) {
      length = data.readInt32BE(cursor)
      cursor += 4
    }
    const payload = data.subarray(cursor, length > 0 ? cursor + length : undefined)
    const posKey = `${pos.x},${pos.y},${pos.z}`
    const jobs = this.pending.get(posKey)
    const job = jobs?.shift()
    if (!job) return
    if (!jobs.length) this.pending.delete(posKey)
    this.inFlight--
    clearTimeout(job.timer)
    const rttMs = job.sentAt ? Date.now() - job.sentAt : null
    decodeBlockNbt(payload)
      .then(compound => job.resolve({ ok: true, compound, rttMs }))
      .catch(error => job.resolve({ ok: false, reason: `nbt_decode:${error.message}`, rttMs }))
    this.maybeStopPump()
  }

  // 批量查询：返回 { map, list }。map 按坐标索引（同坐标重复查询时保留最后结果），
  // list 按请求顺序给每个查询的完整结果（测速统计用，含重复）。
  // 发包节奏：每 tick（50ms）最多 perTick 个；在途（已发未回）达到 maxInFlight 就暂停
  // 发包等回包腾位置；每个请求最多等 requestTimeoutMs，超时按失败处理。
  async queryBlocks (positions) {
    this.attach()
    const map = new Map()
    const list = []
    if (!positions.length) return { map, list }
    const jobs = positions.map(position => {
      const posKey = `${position.x},${position.y},${position.z}`
      const promise = new Promise(resolve => {
        this.queue.push({ posKey, x: position.x, y: position.y, z: position.z, resolve })
      })
      return { posKey, promise }
    })
    this.startPump()
    await Promise.all(jobs.map(async job => {
      const outcome = await job.promise
      map.set(job.posKey, outcome)
      list.push(outcome)
    }))
    this.maybeStopPump()
    return { map, list }
  }

  startPump () {
    if (this.pumpTimer || this.destroyed) return
    this.pumpTimer = setInterval(() => this.pump(), this.options.tickMs)
    this.pumpTimer.unref?.()
  }

  stopPump () {
    if (!this.pumpTimer) return
    clearInterval(this.pumpTimer)
    this.pumpTimer = null
  }

  maybeStopPump () {
    if (!this.queue.length && this.inFlight === 0) this.stopPump()
  }

  pump () {
    let budget = this.options.perTick
    while (budget > 0 && this.queue.length) {
      if (this.inFlight >= this.options.maxInFlight) break // 在途满员：本 tick 停发，等回包
      const job = this.queue.shift()
      const entry = {
        resolve: job.resolve,
        timer: null,
        sentAt: Date.now()
      }
      entry.timer = setTimeout(() => {
        const jobs = this.pending.get(job.posKey)
        const at = jobs ? jobs.indexOf(entry) : -1
        if (at < 0) return // 已被回包结算
        jobs.splice(at, 1)
        if (!jobs.length) this.pending.delete(job.posKey)
        this.inFlight--
        job.resolve({ ok: false, reason: 'timeout', rttMs: this.options.requestTimeoutMs })
        this.maybeStopPump()
      }, this.options.requestTimeoutMs)
      entry.timer.unref?.()
      let jobs = this.pending.get(job.posKey)
      if (!jobs) {
        jobs = []
        this.pending.set(job.posKey, jobs)
      }
      jobs.push(entry)
      this.inFlight++
      try {
        writePayload(this.client, buildBlockEntityRequest(job.x, job.y, job.z))
      } catch (error) {
        const at = jobs.indexOf(entry)
        if (at >= 0) jobs.splice(at, 1)
        if (!jobs.length) this.pending.delete(job.posKey)
        this.inFlight--
        clearTimeout(entry.timer)
        job.resolve({ ok: false, reason: `send:${error.message}` })
        continue
      }
      budget--
    }
    this.maybeStopPump()
  }
}

// 早期取证记录：configuration/play 阶段收到的全部 custom_payload（ring buffer），
// 供 !servux探测 打印——判断服务器/Via 有没有把 S2C 的 register 等通道包转回来。
const earlyPayloadLog = []
const EARLY_LOG_LIMIT = 120

// minecraft:register 声明（fabric 客户端由 loader 自动完成），否则 play 阶段
// 该通道的包会被服务器/协议转换层静默丢弃——与线上「探测 6 秒 0 个包」吻合。
// 实战参照：1.21.11 fabric + servux bridge 经 Via 连 26.3 服务器可用。
// 必须在 createBot 之后立即调用（configuration 在 login 后转瞬即逝）。
function hookEarlyChannelRegister (bot) {
  const client = bot?._client
  if (!client || typeof client.write !== 'function') return
  // 取证监听：尽早挂上，configuration 期的 S2C custom_payload 也逃不掉
  client.on('custom_payload', packet => {
    if (earlyPayloadLog.length >= EARLY_LOG_LIMIT) earlyPayloadLog.shift()
    earlyPayloadLog.push({
      at: new Date().toISOString().slice(11, 19),
      state: client.state,
      channel: packet?.channel || '?',
      bytes: Buffer.isBuffer(packet.data) ? packet.data.length : -1,
      head: Buffer.isBuffer(packet.data) ? packet.data.subarray(0, 24).toString('hex') : ''
    })
  })
  let sent = false
  const sendRegister = () => {
    if (sent || client.state !== 'configuration') return
    sent = true
    try {
      client.write('custom_payload', {
        channel: 'minecraft:register',
        data: Buffer.from(`${SERVUX_CHANNEL}\0`, 'utf8')
      })
      console.log('[servux] configuration 阶段已声明通道（minecraft:register）')
    } catch (error) {
      console.log(`[servux] configuration 阶段声明通道失败: ${error.message}`)
    }
  }
  // nmp 内部的 login handler 先把 state 切到 configuration，监听器按注册顺序
  // 依次执行，所以我们的 login 回调里 state 已就绪
  client.once('login', sendRegister)
  // 兜底挂点：configuration 的必经包（服务器下发 select_known_packs）
  client.once('select_known_packs', sendRegister)
}

function getEarlyPayloadLog () {
  return earlyPayloadLog.slice()
}

module.exports = {
  SERVUX_CHANNEL,
  getEarlyPayloadLog,
  ServuxClient,
  hookEarlyChannelRegister,
  // 以下导出仅供建议单元测试 / 协议对照使用
  buildRegisterPacket,
  buildBlockEntityRequest,
  encodeBlockPos
}

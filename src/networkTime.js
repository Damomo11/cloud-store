const dgram = require('node:dgram')

const NTP_UNIX_EPOCH_SECONDS = 2208988800

class NetworkTime {
  constructor (options = {}) {
    this.sources = this.normalizeSources(options.sources)
    this.intervalMs = this.normalizeInterval(options.intervalMs)
    this.timeoutMs = Math.max(500, Number.parseInt(options.timeoutMs, 10) || 2500)
    this.loadPersisted = options.loadPersisted || (() => null)
    this.savePersisted = options.savePersisted || (() => {})
    this.offsetMs = 0
    this.trusted = false
    this.source = ''
    this.lastSyncedAt = 0
    this.lastError = ''
    this.timer = null
    this.syncing = null
    this.restore()
  }

  normalizeSources (sources) {
    const values = Array.isArray(sources) ? sources : String(sources || '').split(',')
    const cleaned = values.map(value => String(value || '').trim()).filter(Boolean)
    return cleaned.length ? cleaned : ['ntp.aliyun.com', 'ntp.tencent.com']
  }

  normalizeInterval (value) {
    return Math.max(60 * 1000, Number.parseInt(value, 10) || 60 * 60 * 1000)
  }

  restore () {
    const saved = this.loadPersisted() || {}
    const offsetMs = Number(saved.offsetMs)
    if (!Number.isFinite(offsetMs) || !Number(saved.lastSyncedAt)) return
    this.offsetMs = offsetMs
    this.source = String(saved.source || 'persisted')
    this.lastSyncedAt = Number(saved.lastSyncedAt)
    this.trusted = true
  }

  start () {
    this.schedule()
    this.sync().catch(() => {})
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  configure ({ sources, intervalMs } = {}) {
    if (sources !== undefined) this.sources = this.normalizeSources(sources)
    if (intervalMs !== undefined) this.intervalMs = this.normalizeInterval(intervalMs)
    this.schedule()
  }

  schedule () {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => this.sync().catch(() => {}), this.intervalMs)
    this.timer.unref?.()
  }

  now () {
    return Date.now() + this.offsetMs
  }

  assertTrusted () {
    if (this.trusted) return this.now()
    const error = new Error('网络时间尚未同步，暂时不能购买、续费或自动注册。')
    error.code = 'NETWORK_TIME_UNAVAILABLE'
    throw error
  }

  status () {
    return {
      trusted: this.trusted,
      now: this.now(),
      offsetMs: Math.round(this.offsetMs),
      source: this.source,
      sources: [...this.sources],
      intervalMs: this.intervalMs,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError
    }
  }

  async sync () {
    if (this.syncing) return this.syncing
    this.syncing = this.performSync().finally(() => { this.syncing = null })
    return this.syncing
  }

  async performSync () {
    const errors = []
    for (const source of this.sources) {
      try {
        const sample = await this.query(source)
        this.offsetMs = sample.networkNow - sample.receivedAt
        this.trusted = true
        this.source = source
        this.lastSyncedAt = sample.receivedAt
        this.lastError = ''
        this.savePersisted({
          offsetMs: this.offsetMs,
          source: this.source,
          lastSyncedAt: this.lastSyncedAt
        })
        return this.status()
      } catch (error) {
        errors.push(`${source}: ${error.message}`)
      }
    }
    this.lastError = errors.join('; ') || '没有可用的网络时间源'
    throw new Error(this.lastError)
  }

  query (host) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4')
      const packet = Buffer.alloc(48)
      packet[0] = 0x1b
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.close()
        if (error) reject(error)
        else resolve(value)
      }
      const timer = setTimeout(() => finish(new Error('同步超时')), this.timeoutMs)
      socket.once('error', finish)
      socket.once('message', response => {
        if (response.length < 48) return finish(new Error('NTP 响应无效'))
        const seconds = response.readUInt32BE(40)
        const fraction = response.readUInt32BE(44)
        const networkNow = ((seconds - NTP_UNIX_EPOCH_SECONDS) * 1000) + Math.round(fraction * 1000 / 0x100000000)
        if (!Number.isFinite(networkNow) || networkNow <= 0) return finish(new Error('NTP 时间无效'))
        finish(null, { networkNow, receivedAt: Date.now() })
      })
      socket.send(packet, 123, host, error => {
        if (error) finish(error)
      })
    })
  }
}

module.exports = NetworkTime

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function terminateBotTransport (bot, reason) {
  if (!bot) return
  try { bot.end?.(reason) } catch {}
  try { bot._client?.socket?.destroy?.() } catch {}
}

function isFatalProtocolReadError (error) {
  const message = String(error?.message || error || '')
  return /SlotComponent|array size is abnormally large|Read error.*(?:intArray|longArray|byteArray)|play\.toClient/i.test(message)
}

function releaseBotConnection (state, bot, service, taskPool, reason, options = {}) {
  if (!state || state.bot !== bot) return false
  taskPool?.unregister?.(service)
  state.bot = null
  if (state.service === service) state.service = null
  state.deviceCode = null
  if (options.terminate !== false) terminateBotTransport(bot, reason)
  return true
}

function installFatalProtocolPacketCapture (bot, options = {}) {
  const client = bot?._client
  if (!client) return { dump: () => null }

  const maxPacketBytes = Math.max(1024, Number(options.maxPacketBytes || 8 * 1024 * 1024))
  let source = null
  let latestPacket = null
  const capture = chunk => {
    if (!Buffer.isBuffer(chunk) || chunk.length > maxPacketBytes) return
    latestPacket = Buffer.from(chunk)
  }
  const attach = () => {
    const next = client.decompressor || client.splitter
    if (!next || next === source || typeof next.prependListener !== 'function') return
    source?.removeListener?.('data', capture)
    source = next
    source.prependListener('data', capture)
  }

  attach()
  client.on?.('set_compression', attach)

  return {
    dump: (error, context = {}) => {
      const packet = Buffer.isBuffer(error?.buffer) ? error.buffer : latestPacket
      if (!packet?.length) return null
      const directory = path.resolve(options.directory || path.join(process.cwd(), 'logs'))
      fs.mkdirSync(directory, { recursive: true })
      const botName = String(context.botName || bot.username || 'bot').replace(/[^A-Za-z0-9_-]/g, '_')
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
      const base = `fatal-protocol-${botName}-${stamp}`
      const packetPath = path.join(directory, `${base}.bin`)
      const metadataPath = path.join(directory, `${base}.json`)
      fs.writeFileSync(packetPath, packet)
      fs.writeFileSync(metadataPath, JSON.stringify({
        botName: context.botName || bot.username || '',
        version: context.version || client.version || '',
        bytes: packet.length,
        sha256: crypto.createHash('sha256').update(packet).digest('hex'),
        error: String(error?.message || error || ''),
        openingChest: context.openingChest || null
      }, null, 2))
      return packetPath
    }
  }
}

module.exports = { installFatalProtocolPacketCapture, isFatalProtocolReadError, releaseBotConnection, terminateBotTransport }

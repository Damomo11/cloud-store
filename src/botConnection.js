const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const FAILED_PROTOCOL_PACKET = Symbol('failedProtocolPacket')
const WINDOW_ITEMS_PACKET_ID_1_21_11 = 0x12
const MALFORMED_BEE_NBT_PREFIX = Buffer.from('0b0a08001150617065722e537061776e526561736f6e', 'hex')

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
  service?.invalidateConnection?.(reason)
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
  const maxRecentPackets = Math.max(1, Number(options.maxRecentPackets || 8))
  const wrappedDeserializers = new WeakSet()
  let source = null
  let latestPacket = null
  let recentPackets = []
  const capture = chunk => {
    if (!Buffer.isBuffer(chunk) || chunk.length > maxPacketBytes) return
    latestPacket = Buffer.from(chunk)
    recentPackets.push(latestPacket)
    if (recentPackets.length > maxRecentPackets) recentPackets = recentPackets.slice(-maxRecentPackets)
  }

  const wrapDeserializer = () => {
    const deserializer = client.deserializer
    if (!deserializer || wrappedDeserializers.has(deserializer) || typeof deserializer.parsePacketBuffer !== 'function') return
    const parsePacketBuffer = deserializer.parsePacketBuffer.bind(deserializer)
    deserializer.parsePacketBuffer = buffer => {
      const repairedBuffer = repairMalformedBeeContainerPacket(buffer)
      const sourceBuffer = Buffer.isBuffer(buffer) ? Buffer.from(buffer) : buffer
      try {
        if (repairedBuffer) {
          const repairedCount = buffer.length - repairedBuffer.length
          console.warn(`[protocol:${bot.username || 'bot'}] repaired ${repairedCount} malformed bee NBT prefix byte(s) before SlotComponent decoding`)
        }
        return parsePacketBuffer(repairedBuffer || buffer)
      } catch (error) {
        if (Buffer.isBuffer(sourceBuffer) && sourceBuffer.length <= maxPacketBytes) {
          Object.defineProperty(error, FAILED_PROTOCOL_PACKET, {
            value: sourceBuffer,
            configurable: true
          })
        }
        throw error
      }
    }
    wrappedDeserializers.add(deserializer)
  }

  const attach = () => {
    const next = client.decompressor || client.splitter
    if (next && next !== source && typeof next.prependListener === 'function') {
      source?.removeListener?.('data', capture)
      source = next
      source.prependListener('data', capture)
    }
    wrapDeserializer()
  }

  attach()
  client.on?.('set_compression', attach)
  client.on?.('state', attach)

  return {
    dump: (error, context = {}) => {
      const exactPacket = error?.[FAILED_PROTOCOL_PACKET]
      const errorPacket = Buffer.isBuffer(error?.buffer) ? error.buffer : null
      const packet = exactPacket || errorPacket || latestPacket
      if (!packet?.length) return null
      const directory = path.resolve(options.directory || path.join(process.cwd(), 'logs'))
      fs.mkdirSync(directory, { recursive: true })
      const botName = String(context.botName || bot.username || 'bot').replace(/[^A-Za-z0-9_-]/g, '_')
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
      const base = `fatal-protocol-${botName}-${stamp}`
      const packetPath = path.join(directory, `${base}.bin`)
      const metadataPath = path.join(directory, `${base}.json`)
      fs.writeFileSync(packetPath, packet)
      const contextPackets = recentPackets.map((recentPacket, index) => {
        const file = `${base}-context-${String(index + 1).padStart(2, '0')}.bin`
        fs.writeFileSync(path.join(directory, file), recentPacket)
        return {
          file,
          bytes: recentPacket.length,
          packetId: readPacketId(recentPacket),
          sha256: crypto.createHash('sha256').update(recentPacket).digest('hex')
        }
      })
      fs.writeFileSync(metadataPath, JSON.stringify({
        botName: context.botName || bot.username || '',
        version: context.version || client.version || '',
        source: exactPacket ? 'deserializer' : (errorPacket ? 'error' : 'latest'),
        bytes: packet.length,
        packetId: readPacketId(packet),
        sha256: crypto.createHash('sha256').update(packet).digest('hex'),
        error: String(error?.message || error || ''),
        openingChest: context.openingChest || null,
        contextPackets
      }, null, 2))
      return packetPath
    }
  }
}

// Some server plugin paths prepend an int-array tag byte to bee entity NBT
// inside a 1.21.11 bees component. The following compound is the real payload.
function repairMalformedBeeContainerPacket (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer[0] !== WINDOW_ITEMS_PACKET_ID_1_21_11) return null

  const parts = []
  let from = 0
  let matches = 0
  while (true) {
    const offset = buffer.indexOf(MALFORMED_BEE_NBT_PREFIX, from)
    if (offset < 0) break
    parts.push(buffer.subarray(from, offset))
    parts.push(buffer.subarray(offset + 1, offset + MALFORMED_BEE_NBT_PREFIX.length))
    from = offset + MALFORMED_BEE_NBT_PREFIX.length
    matches += 1
  }
  if (!matches) return null
  parts.push(buffer.subarray(from))
  return Buffer.concat(parts)
}

function readPacketId (packet) {
  let value = 0
  for (let index = 0; index < Math.min(packet.length, 5); index++) {
    const byte = packet[index]
    value |= (byte & 0x7f) << (index * 7)
    if ((byte & 0x80) === 0) return value >>> 0
  }
  return null
}

module.exports = { installFatalProtocolPacketCapture, isFatalProtocolReadError, releaseBotConnection, terminateBotTransport }

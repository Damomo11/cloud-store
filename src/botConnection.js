const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const FAILED_PROTOCOL_PACKET = Symbol('failedProtocolPacket')
const LEGACY_MALFORMED_BEE_NBT_PREFIX = Buffer.from('0b0a08001150617065722e537061776e526561736f6e', 'hex')

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
      const sourceBuffer = Buffer.isBuffer(buffer) ? Buffer.from(buffer) : buffer
      try {
        const { packet, repairedCount } = parseBeeContainerPacket(client, deserializer, parsePacketBuffer, buffer)
        if (repairedCount) {
          console.warn(`[protocol:${bot.username || 'bot'}] repaired ${repairedCount} malformed bee NBT prefix byte(s) before SlotComponent decoding`)
        }
        return packet
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

  // State changes create and pipe a new parser before emitting 'state'. Wrap
  // it as soon as it is created, including when piping drains buffered data.
  if (typeof client.setSerializer === 'function') {
    const setSerializer = client.setSerializer
    client.setSerializer = function (...args) {
      const result = setSerializer.apply(this, args)
      wrapDeserializer()
      return result
    }
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

// Repair only when the protocol decoder reaches a real bees component, never
// by scanning arbitrary packet bytes (which may belong to custom_data or lore).
// The extra byte is TAG_Int_Array (11); 11,10 at an NBT root would declare an
// impossibly large array. The following TAG_Compound is the entity data.
function parseBeeContainerPacket (client, deserializer, parsePacketBuffer, buffer) {
  const ctx = deserializer.proto?.readCtx
  if (client.version !== '1.21.11' || client.state !== 'play' ||
      typeof ctx?.SlotComponent !== 'function' || typeof ctx.anonymousNbt !== 'function') {
    const legacy = repairLegacyBeePrefix(buffer)
    return { packet: parsePacketBuffer(legacy?.packet || buffer), repairedCount: legacy?.repairedCount || 0 }
  }

  let repairedCount = 0
  const readComponent = ctx.SlotComponent
  ctx.SlotComponent = (buffer, offset) => {
    const type = ctx.SlotComponentType(buffer, offset)
    if (type.value !== 'bees') return readComponent(buffer, offset)

    const count = ctx.varint(buffer, offset + type.size)
    // Let the original reader enforce its own array bounds and error behavior.
    if (count.value < 0 || count.value > 0xffffff) return readComponent(buffer, offset)
    let cursor = offset + type.size + count.size
    const bees = []
    for (let index = 0; index < count.value; index++) {
      if (buffer[cursor] === 0x0b && buffer[cursor + 1] === 0x0a) {
        cursor += 1
        repairedCount += 1
      }
      const nbtData = ctx.anonymousNbt(buffer, cursor)
      cursor += nbtData.size
      const ticksInHive = ctx.varint(buffer, cursor)
      cursor += ticksInHive.size
      const minTicksInHive = ctx.varint(buffer, cursor)
      cursor += minTicksInHive.size
      bees.push({ nbtData: nbtData.value, ticksInHive: ticksInHive.value, minTicksInHive: minTicksInHive.value })
    }
    // Include skipped bytes in size: packet boundaries and following Slots
    // still use the original wire buffer and its offsets.
    return { value: { type: type.value, data: { bees } }, size: cursor - offset }
  }

  // Compiled protocols are cached and shared by clients. Reading is synchronous;
  // restore immediately on success or failure so another bot is unaffected.
  try {
    return { packet: parsePacketBuffer(buffer), repairedCount }
  } finally {
    ctx.SlotComponent = readComponent
  }
}

function repairLegacyBeePrefix (buffer) {
  if (!Buffer.isBuffer(buffer)) return null
  const parts = []
  let from = 0
  let repairedCount = 0
  while (true) {
    const offset = buffer.indexOf(LEGACY_MALFORMED_BEE_NBT_PREFIX, from)
    if (offset < 0) break
    parts.push(buffer.subarray(from, offset))
    from = offset + 1
    repairedCount += 1
  }
  if (!repairedCount) return null
  parts.push(buffer.subarray(from))
  return { packet: Buffer.concat(parts), repairedCount }
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

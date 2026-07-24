function terminateBotTransport (bot, reason) {
  if (!bot) return
  try { bot.end?.(reason) } catch {}
  try { bot._client?.socket?.destroy?.() } catch {}
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

module.exports = { releaseBotConnection, terminateBotTransport }

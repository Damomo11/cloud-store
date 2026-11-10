const { deliverHotReloadNotify } = require('../../src/hotReload')

process.once('message', async () => {
  await deliverHotReloadNotify({ msg: target => process.send({ target }) }, {
    pendingNotifyPath: process.argv[2], log: () => {}
  })
  process.disconnect()
})
process.send('ready')

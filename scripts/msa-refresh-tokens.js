// 在能直连 Minecraft 认证接口（api.minecraftservices.com）的机器上刷新机器人账号令牌，
// 产物写入指定 profilesFolder，然后把生成的 *_cache.json 拷回服务器同名目录即可。
// 用法：node scripts/msa-refresh-tokens.js <微软账号邮箱> <profilesFolder相对路径>
//   示例（生产 bot_accounts 表里的账号）：
//     node scripts/msa-refresh-tokens.js 202499405@qq.com auth-cache
// 认证参数与 src/index.js 里 minecraft-protocol 的配置保持一致（Switch title + live flow）。
const path = require('node:path')
const { Authflow, Titles } = require(path.join(__dirname, '..', 'node_modules', 'prismarine-auth'))

const [username, profilesFolderArg] = process.argv.slice(2)
if (!username || !profilesFolderArg) {
  console.error('用法: node scripts/msa-refresh-tokens.js <微软账号邮箱> <profilesFolder相对路径>')
  process.exit(1)
}
const profilesFolder = path.resolve(__dirname, '..', profilesFolderArg)

const flow = new Authflow(username, profilesFolder, {
  authTitle: Titles.MinecraftNintendoSwitch,
  deviceType: 'Nintendo',
  flow: 'live'
}, code => {
  console.log('请在浏览器打开:', code.verification_uri || 'https://www.microsoft.com/link', '并输入验证码:', code.user_code)
})

flow.getMinecraftJavaToken({ fetchProfile: true, fetchCertificates: false })
  .then(result => {
    console.log('LOGIN_OK minecraftName=' + (result.profile?.name || '?'))
    console.log('令牌已写入 ' + profilesFolder + '，请将 *_cache.json 拷回服务器同目录。')
  })
  .catch(error => {
    console.error('LOGIN_FAIL', error?.stack || error?.message || String(error))
    process.exit(1)
  })

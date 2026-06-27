const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')
const { loadConfig } = require('../src/config')

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

function readConfig () {
  return loadConfig(path.resolve(process.cwd(), 'config.json'))
}

function getJson (url) {
  return new Promise((resolve, reject) => {
    https.get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        resolve(getJson(response.headers.location))
        return
      }
      if (response.statusCode !== 200) {
        reject(new Error(`GET ${url} failed: ${response.statusCode}`))
        return
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve(JSON.parse(body)))
    }).on('error', reject)
  })
}

function getText (url) {
  return new Promise((resolve, reject) => {
    https.get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        resolve(getText(response.headers.location))
        return
      }
      if (response.statusCode !== 200) {
        reject(new Error(`GET ${url} failed: ${response.statusCode}`))
        return
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve(body))
    }).on('error', reject)
  })
}

async function main () {
  const config = readConfig()
  const version = config.server.version
  const langFile = path.resolve(process.cwd(), config.language?.file || 'data/zh_cn.json')

  const manifest = await getJson(MANIFEST_URL)
  const versionInfo = manifest.versions.find(item => item.id === version)
  if (!versionInfo) throw new Error(`Mojang manifest 中找不到版本：${version}`)

  const versionMeta = await getJson(versionInfo.url)
  const assetIndex = await getJson(versionMeta.assetIndex.url)
  const langAsset = assetIndex.objects['minecraft/lang/zh_cn.json']
  if (!langAsset) throw new Error(`版本 ${version} 的 assets 中找不到 minecraft/lang/zh_cn.json`)

  const hash = langAsset.hash
  const url = `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`
  const text = await getText(url)

  fs.mkdirSync(path.dirname(langFile), { recursive: true })
  fs.writeFileSync(langFile, text)
  console.log(`Downloaded zh_cn language file for ${version}: ${langFile}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

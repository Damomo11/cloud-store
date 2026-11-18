// 服务器资源包语言提取：mineflayer 收到资源包只会回状态包，并不真的下载，
// 服务器自定义内容（dnt 系附魔等）的中文翻译客户端是从资源包 lang 文件里拿的。
// 这里真下载 zip（按 sha1 缓存到 data/pack-cache/），解出 assets/*/lang/zh_cn.json，
// 合并进当前物品字典的 language 表，供附魔注册表 describe 翻译使用。

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const crypto = require('node:crypto')

const CACHE_DIR = path.join(process.cwd(), 'data', 'pack-cache')

function sha1Hex (buf) {
  return crypto.createHash('sha1').update(buf).digest('hex')
}

// 读 zip32 全部条目 → Map(路径 → 解压后 Buffer)。资源包无 zip64/加密，够用。
function readZipEntries (buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('zip EOCD 未找到')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip 本地头损坏：${name}`)
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const comp = buf.subarray(dataStart, dataStart + compSize)
    out.set(name, method === 0 ? comp : zlib.inflateRawSync(comp))
  }
  return out
}

// 收集所有 lang/zh_cn.json 条目并合并成一个字典（多命名空间平铺，键全局唯一）。
function pickMergedLanguage (entries) {
  const merged = {}
  let files = 0
  for (const [name, data] of entries) {
    if (!/(^|\/)lang\/zh_cn\.json$/.test(name)) continue
    try {
      Object.assign(merged, JSON.parse(data.toString('utf8')))
      files++
    } catch (error) {
      console.warn(`[packLang] 语言文件解析失败 ${name}：${error.message}`)
    }
  }
  return { merged, files }
}

async function fetchPackBuffer (url, expectedSha1, log) {
  const sha1 = String(expectedSha1 || '').toLowerCase()
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const cachePath = sha1 ? path.join(CACHE_DIR, `${sha1}.zip`) : null
  if (cachePath && fs.existsSync(cachePath)) {
    log(`[packLang] 命中缓存 ${cachePath}`)
    return fs.readFileSync(cachePath)
  }
  log(`[packLang] 下载资源包 ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const actual = sha1Hex(buf)
  if (sha1 && actual !== sha1) throw new Error(`sha1 不匹配：期望 ${sha1}，实际 ${actual}`)
  if (cachePath) fs.writeFileSync(cachePath, buf)
  return buf
}

// 每只 bot 挂一次：监听两路资源包事件（26.x add_resource_pack 包 / 通用 resourcePack 事件，
// 实测 26.3 两路都会触发），按 url 去重，下载解析成功后回调 onLang(合并后的语言字典)。
function watchPackLanguage (bot, { log = console.log, onLang }) {
  const seen = new Set()
  const handle = async (url, hash) => {
    const key = String(url || '')
    if (!key || key.startsWith('file:') || seen.has(key)) return
    seen.add(key)
    try {
      const buf = await fetchPackBuffer(url, hash, log)
      const { merged, files } = pickMergedLanguage(readZipEntries(buf))
      if (!files) {
        log('[packLang] 资源包里没有 zh_cn.json 语言文件')
        return
      }
      log(`[packLang] 从资源包 ${files} 个语言文件解析出 ${Object.keys(merged).length} 条翻译`)
      onLang?.(merged)
    } catch (error) {
      log(`[packLang] 资源包语言提取失败：${error.message}`)
    }
  }
  bot.on('resourcePack', (url, hashOrUuid) => handle(url, hashOrUuid))
  bot._client?.on('add_resource_pack', data => handle(data?.url, data?.hash))
}

module.exports = { watchPackLanguage, readZipEntries, pickMergedLanguage }

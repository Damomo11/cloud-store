// Withdrawal-only fallback: never add phonetic names to the shared alias map.
const indexes = new WeakMap()

function buildIndex (catalog) {
  const { pinyin } = require('pinyin-pro')
  const index = new Map()
  const names = [
    ...[...(catalog.localizedNames || [])].map(([itemId, name]) => [name, itemId]),
    ...(catalog.aliases || [])
  ]
  for (const [name, itemId] of names) {
    if (!/^\p{Script=Han}+$/u.test(name)) continue
    const spelling = pinyin(name, { toneType: 'none', type: 'array', v: true }).join('')
    if (!/^[a-z]+$/.test(spelling)) continue
    if (!index.has(spelling)) index.set(spelling, new Set())
    index.get(spelling).add(itemId)
  }
  return index
}

function findWithdrawPinyinItems (catalog, name) {
  const query = String(name || '').trim().toLowerCase()
  if (!/^[a-z]{2,128}$/.test(query)) return []
  if (!indexes.has(catalog)) indexes.set(catalog, buildIndex(catalog))
  return [...(indexes.get(catalog).get(query) || [])].map(itemId => catalog.resolveName(itemId))
}

module.exports = { findWithdrawPinyinItems }

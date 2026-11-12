// Withdrawal-only fallback: never add phonetic names to the shared alias map.
const indexes = new WeakMap()

function buildIndex (catalog) {
  const { polyphonic } = require('pinyin-pro')
  const index = []
  const seen = new Set()
  const names = [
    ...[...(catalog.localizedNames || [])].map(([itemId, name]) => [name, itemId]),
    ...(catalog.aliases || [])
  ]
  for (const [name, itemId] of names) {
    if (!/^\p{Script=Han}+$/u.test(name)) continue
    const key = `${itemId}:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    // Contextual defaults misread game words such as 风弹、镐 and 云杉.
    const syllables = polyphonic(name, { toneType: 'none', type: 'array', v: true })
      .map(readings => [...new Set(readings.filter(reading => /^[a-z]+$/.test(reading)))])
    if (syllables.every(readings => readings.length)) index.push({ itemId, syllables })
  }
  return index
}

function matchesSyllables (syllables, query, allowInitials = false) {
  if (query.length < syllables.length) return false
  let offsets = new Set([0])
  for (const readings of syllables) {
    const next = new Set()
    for (const offset of offsets) {
      for (const reading of readings) {
        if (query.startsWith(reading, offset)) next.add(offset + reading.length)
        if (allowInitials && query.startsWith(reading[0], offset)) next.add(offset + 1)
      }
    }
    if (!next.size) return false
    offsets = next
  }
  return offsets.has(query.length)
}

function findWithdrawPinyinItems (catalog, name) {
  const query = String(name || '').trim().toLowerCase()
  if (!/^[a-z]{2,128}$/.test(query)) return []
  if (!indexes.has(catalog)) indexes.set(catalog, buildIndex(catalog))
  const index = indexes.get(catalog)
  const full = index.filter(entry => matchesSyllables(entry.syllables, query))
  // Full spellings take precedence over initials and mixed spellings.
  const matches = full.length ? full : index.filter(entry => matchesSyllables(entry.syllables, query, true))
  const itemIds = new Set(matches.map(entry => entry.itemId))
  return [...itemIds].map(itemId => catalog.resolveName(itemId))
}

module.exports = { findWithdrawPinyinItems }

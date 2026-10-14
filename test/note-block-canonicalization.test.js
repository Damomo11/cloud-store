// 回归测试：服务器 mod（CraftEngine）会给音符盒附加波动的自定义数据，
// 同一个音符盒在不同时间/来源可能带不同的 craftengine:network_data /
// craftengine:network_modifiers 字段和不同顺序的 block_state 属性。
// 指纹归一化必须忽略这些字段，让所有音符盒都落到同一个 itemKey（f17058...）。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ItemCatalog = require('../src/itemCatalog')

const variants = JSON.parse(fs.readFileSync(path.join(__dirname, 'note-block-variants.json'), 'utf8'))

const networkModifiersPayload = {
  type: 'compound',
  value: {
    'minecraft:block_state': {
      type: 'compound',
      value: {
        type: { type: 'byte', value: 0 },
        value: {
          type: 'compound',
          value: {
            instrument: { type: 'string', value: 'harp' },
            note: { type: 'string', value: '0' },
            powered: { type: 'string', value: 'false' }
          }
        }
      }
    }
  }
}

function withModifiers (meta) {
  return JSON.parse(JSON.stringify(meta, (key, value) =>
    key === 'craftengine:network_data' ? { ...value, 'craftengine:network_modifiers': networkModifiersPayload } : value
  ))
}

function fingerprintMeta (catalog, meta) {
  return catalog.normalizeMetaForFingerprint('minecraft:note_block', meta)
}

function createCatalog () {
  return new ItemCatalog('1.21.11')
}

test('all live note_block variants canonicalize to the f17058 itemKey', () => {
  const catalog = createCatalog()
  const keys = new Set()
  for (const variant of Object.values(variants)) {
    const out = catalog.canonicalizeStoredItem({
      itemId: 'minecraft:note_block',
      displayName: '音符盒',
      metaJson: JSON.stringify(variant.meta),
      nbtJson: JSON.stringify(variant.nbt),
      amount: 0
    })
    keys.add(out.itemKey)
  }
  assert.equal(keys.size, 1)
  assert.equal([...keys][0], 'minecraft:note_block|f170588c66daf6574abeeddf6bc690d9a0465296')
})

test('block_state property order does not affect note_block fingerprint', () => {
  const catalog = createCatalog()
  const base = variants.f170588c.meta
  const reordered = JSON.parse(JSON.stringify(base))
  const blockState = reordered.components.find(c => c.type === 'block_state')
  blockState.data.properties = [...blockState.data.properties].reverse()
  assert.deepEqual(fingerprintMeta(catalog, reordered), fingerprintMeta(catalog, base))
})

test('craftengine:network_modifiers does not affect note_block fingerprint', () => {
  const catalog = createCatalog()
  const base = variants.f170588c.meta
  const withMod = withModifiers(base)
  assert.deepEqual(fingerprintMeta(catalog, withMod), fingerprintMeta(catalog, base))
})

test('craftengine-only custom_data component is dropped entirely for note_block', () => {
  const catalog = createCatalog()
  const canonical = fingerprintMeta(catalog, variants.b4f3f4ac.meta)
  const types = (canonical.components || []).map(c => c.type)
  assert.deepEqual(types, ['block_state'])
})

test('non-craftengine custom_data still participates in note_block fingerprint', () => {
  const catalog = createCatalog()
  const base = variants.f170588c.meta
  const extra = JSON.parse(JSON.stringify(base))
  extra.components[0].data.value['some:other_data'] = { type: 'int', value: 7 }
  assert.notDeepEqual(fingerprintMeta(catalog, extra), fingerprintMeta(catalog, base))
})

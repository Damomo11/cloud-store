const { Client } = require('ssh2')

const nodeScript = `
const Database = require('better-sqlite3')
const db = new Database('/root/cloud-store-2.0/data/cloud-store.sqlite', { readonly: true })
const rows = db.prepare(\`
  SELECT c.chest_id AS cid, c.x, c.y, c.z, c.block_name AS bn, cs.slot, cs.item_key AS ik, cs.amount
  FROM chest_slots cs JOIN chests c ON c.chest_id = cs.chest_id
  WHERE cs.item_key LIKE 'minecraft:potion|%' OR cs.item_key LIKE 'minecraft:splash_potion|%' OR cs.item_key LIKE 'minecraft:lingering_potion|%'
  ORDER BY c.y, c.x, c.z, cs.slot
\`).all()
console.log('== 药水槽位记录 共' + rows.length + '行 ==')
for (const r of rows) console.log([r.cid, r.x, r.y, r.z, r.bn, r.slot, r.amount, r.ik].join('|'))
`
const b64 = Buffer.from(nodeScript).toString('base64')
const CMD = `echo ${b64} | base64 -d | NODE_PATH=/root/cloud-store-2.0/node_modules /root/.nvm/versions/node/v22.23.1/bin/node -`
const conn = new Client()
conn.on('error', e => { console.error('ERR:', e.message); process.exit(1) })
conn.on('ready', () => {
  conn.exec(CMD, (err, stream) => {
    if (err) { console.error(err); conn.end(); return }
    let out = ''
    stream.on('data', d => { out += d })
    stream.stderr.on('data', d => { out += d })
    stream.on('close', () => { console.log(out); conn.end() })
  })
}).connect({ host: '103.79.186.209', port: 25595, username: 'root', password: 'PmtZ7vQwm@2L', readyTimeout: 20000, keepaliveInterval: 5000 })

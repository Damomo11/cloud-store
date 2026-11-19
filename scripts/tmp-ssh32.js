const { Client } = require('ssh2')

const nodeScript = `
const Database = require('better-sqlite3')
const db = new Database('/root/cloud-store-2.0/data/cloud-store.sqlite', { readonly: true })
const rows = db.prepare("select item_key, display_name, meta_json from items where item_key like 'minecraft:potion|%' or item_key like 'minecraft:splash_potion|%' or item_key like 'minecraft:lingering_potion|%' order by item_key").all()
console.log('== items 药水档案 共' + rows.length + '条 ==')
for (const row of rows) {
  let pcj = 'NONE'
  let extra = ''
  try {
    const meta = JSON.parse(row.meta_json)
    const comps = meta.components || []
    const pc = comps.find(c => c.type === 'potion_contents')
    if (pc) pcj = JSON.stringify(pc.data)
    const cname = comps.find(c => c.type === 'custom_name')
    if (cname) extra = ' custom_name=' + JSON.stringify(cname.data).slice(0, 60)
  } catch (e) { pcj = 'PARSE_ERR ' + e.message }
  console.log([row.item_key, row.display_name, pcj.slice(0, 160), extra].join(' || '))
}
console.log('== balances 药水在库 ==')
for (const row of db.prepare("select owner_uuid, item_key, amount from balances where item_key like 'minecraft:potion|%' or item_key like 'minecraft:splash_potion|%' or item_key like 'minecraft:lingering_potion|%' order by amount desc").all()) console.log(JSON.stringify(row))
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

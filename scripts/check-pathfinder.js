'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')

function filesUnder (directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return []
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(file) : entry.name.endsWith('.js') ? [file] : []
  })
}

const files = ['src/path', 'vendor/mineflayer-pathfinder'].flatMap(directory => filesUnder(path.join(root, directory)))
files.push(path.join(root, 'src/warehouseMovements.js'))
let failed = false
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.error) console.error(result.error.message)
  if (result.error || result.status !== 0) failed = true
}
console.log(`Checked ${files.length} pathfinder JavaScript files.`)
process.exitCode = failed ? 1 : 0

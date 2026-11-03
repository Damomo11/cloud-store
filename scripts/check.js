'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const extensions = new Set(['.js', '.cjs', '.mjs'])

function javascriptFiles (directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) return javascriptFiles(file)
      return entry.isFile() && extensions.has(path.extname(entry.name)) ? [file] : []
    })
}

const files = ['src', 'scripts'].flatMap(directory => javascriptFiles(path.join(root, directory)))
let failed = false
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.error) console.error(result.error.message)
  if (result.error || result.status !== 0) failed = true
}
console.log(`Checked ${files.length} JavaScript files in src/ and scripts/.`)
process.exitCode = failed ? 1 : 0

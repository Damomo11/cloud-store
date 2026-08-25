const fs = require('node:fs')
const path = require('node:path')

function logLocalError (category, error, context = {}, options = {}) {
  const directory = path.resolve(options.directory || path.join(process.cwd(), 'logs'))
  const fileName = String(options.fileName || 'errors.jsonl').replace(/[^A-Za-z0-9_.-]/g, '_')
  const entry = {
    timestamp: new Date().toISOString(),
    category: String(category || 'error'),
    ...context,
    error: String(error?.message || error || ''),
    stack: error?.stack || ''
  }
  try {
    fs.mkdirSync(directory, { recursive: true })
    fs.appendFileSync(path.join(directory, fileName), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (logError) {
    console.warn(`[local-error-log] failed to write ${category || 'error'}: ${logError.message}`)
  }
  return entry
}

module.exports = { logLocalError }

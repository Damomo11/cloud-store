'use strict'

// A modern Slot with zero count has no payload. Do not hide malformed or
// populated records behind a zero count when validating physical evidence.
function isEmptySlot (entry) {
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) &&
    entry.itemCount === 0 && Object.keys(entry).length === 1
}

module.exports = { isEmptySlot }

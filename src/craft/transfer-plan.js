'use strict'

// One click plan for both cost estimation and execution. A populated target
// cannot use the empty-cell trim shortcut, including later sources for a cell.
function planTransfer (available, amount, targetCount = 0) {
  if (![available, amount, targetCount].every(Number.isSafeInteger) || amount <= 0 || available < amount || targetCount < 0) {
    throw new Error('invalid craft stack transfer')
  }
  const actions = []
  const add = (target, button) => actions.push({ target, button })
  let remaining = amount
  while (remaining > 0) {
    if (available === remaining) {
      add(false, 0)
      add(true, 0)
      return actions
    }
    const picked = Math.ceil(available / 2)
    add(false, 1)
    available -= picked
    if (picked <= remaining) {
      add(true, 0)
      remaining -= picked
      targetCount += picked
      continue
    }
    if (!targetCount) {
      const trim = []
      let count = picked
      let excess = picked - remaining
      while (excess > 0) {
        const removed = Math.ceil(count / 2)
        trim.push({ target: true, button: 1 })
        if (removed <= excess) {
          trim.push({ target: false, button: 0 })
          count -= removed
          excess -= removed
        } else {
          for (let n = excess; n < removed; n++) trim.push({ target: true, button: 1 })
          trim.push({ target: false, button: 0 })
          excess = 0
        }
      }
      if (trim.length < remaining) {
        add(true, 0)
        return actions.concat(trim)
      }
    }
    for (let n = 0; n < remaining; n++) add(true, 1)
    add(false, 0)
    return actions
  }
  return actions
}

module.exports = { planTransfer }

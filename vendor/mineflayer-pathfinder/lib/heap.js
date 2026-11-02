class BinaryHeapOpenSet {
  constructor () {
    // Initialing the array heap and adding a dummy element at index 0
    this.heap = [null]
    // A* performs a decrease-key for many equal-cost alternative routes.
    // Track object positions so update remains O(log n) without changing the
    // heap's comparison or tie ordering.
    this.indices = new Map()
  }

  swap (left, right) {
    const leftValue = this.heap[left]
    const rightValue = this.heap[right]
    this.heap[left] = rightValue
    this.heap[right] = leftValue
    this.indices.set(rightValue, left)
    this.indices.set(leftValue, right)
  }

  size () {
    return this.heap.length - 1
  }

  isEmpty () {
    return this.heap.length === 1
  }

  push (val) {
    // Inserting the new node at the end of the heap array
    this.heap.push(val)
    this.indices.set(val, this.heap.length - 1)

    // Finding the correct position for the new node
    let current = this.heap.length - 1
    let parent = current >>> 1

    // Traversing up the parent node until the current node is greater than the parent
    while (current > 1 && this.heap[parent].f > this.heap[current].f) {
      this.swap(parent, current)
      current = parent
      parent = current >>> 1
    }
  }

  update (val) {
    let current = this.indices.get(val)
    // Preserve the legacy no-op behavior for an unknown value. The fallback
    // also keeps this heap compatible with callers that populated heap[]
    // directly before calling update.
    if (current === undefined) current = this.heap.indexOf(val)
    if (current < 1) return
    let parent = current >>> 1

    // Traversing up the parent node until the current node is greater than the parent
    while (current > 1 && this.heap[parent].f > this.heap[current].f) {
      this.swap(parent, current)
      current = parent
      parent = current >>> 1
    }
  }

  pop () {
    // Smallest element is at the index 1 in the heap array
    const smallest = this.heap[1]

    this.heap[1] = this.heap[this.heap.length - 1]
    this.heap.splice(this.heap.length - 1)
    this.indices.delete(smallest)

    const size = this.heap.length - 1

    if (size < 2) {
      if (size === 1) this.indices.set(this.heap[1], 1)
      return smallest
    }

    const val = this.heap[1]
    this.indices.set(val, 1)
    let index = 1
    let smallerChild = 2
    const cost = val.f
    do {
      let smallerChildNode = this.heap[smallerChild]
      if (smallerChild < size - 1) {
        const rightChildNode = this.heap[smallerChild + 1]
        if (smallerChildNode.f > rightChildNode.f) {
          smallerChild++
          smallerChildNode = rightChildNode
        }
      }
      if (cost <= smallerChildNode.f) {
        break
      }
      this.heap[index] = smallerChildNode
      this.heap[smallerChild] = val
      this.indices.set(smallerChildNode, index)
      this.indices.set(val, smallerChild)
      index = smallerChild

      smallerChild *= 2
    } while (smallerChild <= size)

    return smallest
  }
}

module.exports = BinaryHeapOpenSet

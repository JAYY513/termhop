export interface FuzzyResult {
  score: number
  indices: number[]
}

const BOUNDARY = /[\s\-_./\\:[\]()\-+@]/

/**
 * Subsequence matcher with a bias towards early, contiguous and
 * word-boundary matches. Returns null when the query is not a subsequence.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  if (!query) return { score: 0, indices: [] }
  if (!target) return null

  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const indices: number[] = []
  let cursor = 0
  let score = 0
  let streak = 0

  for (const ch of q) {
    if (ch === ' ') continue
    let found = -1
    for (let k = cursor; k < t.length; k++) {
      if (t[k] === ch) {
        found = k
        break
      }
    }
    if (found === -1) return null

    const previous = indices[indices.length - 1]
    if (previous !== undefined && found === previous + 1) {
      streak += 1
      score += 8 + streak * 2
    } else {
      streak = 0
      score += 1
    }

    if (found === 0 || BOUNDARY.test(target[found - 1] ?? '')) score += 6
    score -= Math.min(found - cursor, 6) * 0.5

    indices.push(found)
    cursor = found + 1
  }

  // Slightly prefer shorter targets so exact names win over long ones.
  score += Math.max(0, 14 - target.length) * 0.25
  return { score, indices }
}

export interface EntryMatch {
  score: number
  titleIndices: number[]
  pathIndices: number[]
}

/** Title matches are weighted well above path matches: the title is the label. */
export function matchEntry(query: string, title: string, path: string): EntryMatch | null {
  if (!query.trim()) return { score: 0, titleIndices: [], pathIndices: [] }

  const onTitle = fuzzyMatch(query, title)
  const onPath = fuzzyMatch(query, path)

  if (onTitle && onPath) {
    return {
      score: onTitle.score * 1.6 + onPath.score * 0.4,
      titleIndices: onTitle.indices,
      pathIndices: onPath.indices
    }
  }
  // A title-only match is the strongest signal, so it gets a flat bonus.
  if (onTitle) {
    return { score: onTitle.score + 12, titleIndices: onTitle.indices, pathIndices: [] }
  }
  if (onPath) {
    return { score: onPath.score * 0.45, titleIndices: [], pathIndices: onPath.indices }
  }
  return null
}

export function highlight(text: string, indices: number[]): (string | { hit: string })[] {
  if (!indices.length) return [text]
  const hits = new Set(indices)
  const out: (string | { hit: string })[] = []
  let buffer = ''
  for (let i = 0; i < text.length; i++) {
    if (hits.has(i)) {
      if (buffer) {
        out.push(buffer)
        buffer = ''
      }
      out.push({ hit: text[i] })
    } else {
      buffer += text[i]
    }
  }
  if (buffer) out.push(buffer)
  return out
}

/**
 * The characters of `text` a search matched, as [start, end) ranges: the query
 * itself when it is a substring, else its characters in order. Empty when
 * neither, since cmdk also keeps entries this cannot explain, by keyword.
 */
export function matchedRanges(text: string, query: string): [number, number][] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const haystack = text.toLowerCase()
  const at = haystack.indexOf(needle)
  if (at >= 0) return [[at, at + needle.length]]

  const ranges: [number, number][] = []
  let from = 0
  for (const char of needle) {
    const index = haystack.indexOf(char, from)
    if (index < 0) return []
    const last = ranges.at(-1)
    if (last?.[1] === index) last[1] = index + 1
    else ranges.push([index, index + 1])
    from = index + 1
  }
  return ranges
}

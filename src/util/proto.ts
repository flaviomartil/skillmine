export type ProtoString = { path: number[]; text: string }

function varint(b: Uint8Array, i: number): [number, number] {
  let r = 0
  let shift = 0
  while (i < b.length) {
    const c = b[i]!
    i++
    r += (c & 0x7f) * 2 ** shift
    shift += 7
    if (c < 0x80) return [r, i]
    if (shift > 63) break
  }
  throw new RangeError('bad varint')
}

const decoder = new TextDecoder('utf-8', { fatal: true })

function printable(t: string): boolean {
  for (const ch of t) {
    const c = ch.codePointAt(0)!
    if (c < 0x20 && c !== 0x0a && c !== 0x09 && c !== 0x0d) return false
    if (c === 0xfffd) return false
  }
  return true
}

export function protoStrings(b: Uint8Array, minLen = 20, path: number[] = [], out: ProtoString[] = []): ProtoString[] {
  let i = 0
  while (i < b.length) {
    let key: number
    try {
      ;[key, i] = varint(b, i)
    } catch {
      return out
    }
    const field = Math.floor(key / 8)
    const wire = key & 7
    if (wire === 0) {
      try {
        ;[, i] = varint(b, i)
      } catch {
        return out
      }
    } else if (wire === 1) i += 8
    else if (wire === 5) i += 4
    else if (wire === 2) {
      let len: number
      try {
        ;[len, i] = varint(b, i)
      } catch {
        return out
      }
      if (i + len > b.length) return out
      const sub = b.subarray(i, i + len)
      i += len
      const next = [...path, field]
      let text: string | undefined
      try {
        text = decoder.decode(sub)
      } catch {
        text = undefined
      }
      if (text !== undefined && text.length >= minLen && printable(text)) out.push({ path: next, text })
      else if (sub.length > 1) protoStrings(sub, minLen, next, out)
    } else return out
  }
  return out
}

export function longestAt(strings: ProtoString[], prefix: number[]): string | undefined {
  let best: string | undefined
  for (const s of strings) {
    if (prefix.length > s.path.length) continue
    let ok = true
    for (let k = 0; k < prefix.length; k++) if (s.path[k] !== prefix[k]) ok = false
    if (ok && (!best || s.text.length > best.length)) best = s.text
  }
  return best
}

export function longest(strings: ProtoString[]): string | undefined {
  let best: string | undefined
  for (const s of strings) if (!best || s.text.length > best.length) best = s.text
  return best
}

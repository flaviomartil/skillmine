export type ProtoString = { path: number[]; text: string }

let varintNext = 0

function readVarint(b: Uint8Array, i: number): number {
  const len = b.length
  if (i >= len) return -1
  const c0 = b[i]!
  if (c0 < 0x80) {
    varintNext = i + 1
    return c0
  }
  if (i + 1 < len) {
    const c1 = b[i + 1]!
    if (c1 < 0x80) {
      varintNext = i + 2
      return (c0 & 0x7f) + ((c1 & 0x7f) << 7)
    }
  }
  let r = 0
  let shift = 0
  while (i < len) {
    const c = b[i++]!
    r += (c & 0x7f) * 2 ** shift
    shift += 7
    if (c < 0x80) {
      varintNext = i
      return r
    }
    if (shift > 63) break
  }
  return -1
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

function collectProtoStrings(b: Uint8Array, minLen: number, path: number[], out: ProtoString[]): void {
  let i = 0
  const blen = b.length
  while (i < blen) {
    const key = readVarint(b, i)
    if (key < 0) return
    i = varintNext
    const field = Math.floor(key / 8)
    const wire = key & 7
    if (wire === 0) {
      if (readVarint(b, i) < 0) return
      i = varintNext
    } else if (wire === 1) i += 8
    else if (wire === 5) i += 4
    else if (wire === 2) {
      const len = readVarint(b, i)
      if (len < 0) return
      i = varintNext
      if (i + len > blen) return
      const sub = b.subarray(i, i + len)
      i += len
      path.push(field)
      let matched = false
      if (len >= minLen) {
        let ascii = true
        let asciiPrintable = true
        for (let k = 0; k < len; k++) {
          const byte = sub[k]!
          if (byte >= 0x80) {
            ascii = false
            break
          }
          if (byte < 0x20 && byte !== 0x0a && byte !== 0x09 && byte !== 0x0d) {
            asciiPrintable = false
          }
        }
        if (ascii) {
          if (asciiPrintable) {
            out.push({ path: path.slice(), text: decoder.decode(sub) })
            matched = true
          }
        } else {
          let text: string | undefined
          try {
            text = decoder.decode(sub)
          } catch {
            text = undefined
          }
          if (text !== undefined && text.length >= minLen && printable(text)) {
            out.push({ path: path.slice(), text })
            matched = true
          }
        }
      }
      if (!matched && len > 1) collectProtoStrings(sub, minLen, path, out)
      path.pop()
    } else return
  }
}

export function protoStrings(b: Uint8Array, minLen = 20, path: number[] = [], out: ProtoString[] = []): ProtoString[] {
  const workPath = path.length ? [...path] : []
  collectProtoStrings(b, minLen, workPath, out)
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

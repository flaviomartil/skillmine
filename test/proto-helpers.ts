function varint(n: number): number[] {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}

export function field(num: number, payload: Uint8Array | string | number): Uint8Array {
  if (typeof payload === 'number') return new Uint8Array([...varint(num * 8), ...varint(payload)])
  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
  return new Uint8Array([...varint(num * 8 + 2), ...varint(bytes.length), ...bytes])
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(len)
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

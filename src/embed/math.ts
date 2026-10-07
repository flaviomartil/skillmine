export function normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!
  const norm = Math.sqrt(sum) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm
  return out
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d === 0 ? 0 : dot / d
}

export function mean(vs: Float32Array[]): Float32Array {
  const first = vs[0]
  if (!first) return new Float32Array(0)
  const out = new Float32Array(first.length)
  for (const v of vs) for (let i = 0; i < out.length; i++) out[i] = out[i]! + (v[i] ?? 0)
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / vs.length
  return out
}

export function chunkText(text: string, max = 1500, overlap = 200): string[] {
  const clean = text.replace(/\r/g, '').trim()
  if (clean.length <= max) return clean ? [clean] : []
  const out: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + max, clean.length)
    if (end < clean.length) {
      const nl = clean.lastIndexOf('\n', end)
      if (nl > start + max / 2) end = nl
    }
    out.push(clean.slice(start, end).trim())
    if (end >= clean.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return out.filter(Boolean)
}

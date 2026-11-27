import { describe, expect, test } from 'bun:test'
import { protoStrings, longestAt, longest } from '../src/util/proto.ts'
import { field, concat } from './proto-helpers.ts'

describe('protoStrings', () => {
  test('finds nested strings with their field path', () => {
    const inner = concat(field(2, 'Translate this repository description to English please'), field(3, 7))
    const msg = concat(field(1, 42), field(19, inner), field(5, 'short'))
    const strings = protoStrings(msg)
    expect(strings).toHaveLength(1)
    expect(strings[0]!.path).toEqual([19, 2])
    expect(longestAt(strings, [19])).toContain('Translate')
    expect(longestAt(strings, [20])).toBeUndefined()
    expect(longest(strings)).toContain('Translate')
  })

  test('survives garbage without throwing', () => {
    const junk = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])
    expect(() => protoStrings(junk)).not.toThrow()
    expect(protoStrings(new Uint8Array([]))).toEqual([])
  })

  test('ignores binary blobs that happen to decode', () => {
    const blob = new Uint8Array(30).fill(0x01)
    const msg = field(4, blob)
    expect(protoStrings(msg)).toEqual([])
  })

  test('preserves UTF-16 length, BOM stripping, control filtering, and caller path isolation', () => {
    const utf16TenEmojis = '\u{1F600}'.repeat(10)
    const bomAscii = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('1234567890123456789')])
    const bomValid = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('12345678901234567890')])
    const prefix = [9]
    const msg = concat(
      field(2, utf16TenEmojis),
      field(3, bomAscii),
      field(4, bomValid),
      field(5, 'valid ascii string with\ttab\nand cr\r ok'),
    )
    const out = protoStrings(msg, 20, prefix)
    expect(prefix).toEqual([9])
    expect(out.map((s) => s.path)).toEqual([[9, 2], [9, 4], [9, 5]])
    expect(out[0]!.text).toBe(utf16TenEmojis)
    expect(out[1]!.text).toBe('12345678901234567890')
  })
})

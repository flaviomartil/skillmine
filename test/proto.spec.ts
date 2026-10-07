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
})

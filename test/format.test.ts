/**
 * Numbers as text, on a page where the text is the product.
 *
 * `formatPrice` exists because a price that renders as `6e-8` in one browser and
 * `0.00000006` in another is a support ticket — and it was itself producing
 * `6.00e-7` for every price below a millionth, which is the range a coin trades
 * in for as long as anybody is still deciding about it. The tests below are
 * mostly that one regression, held down at both ends of the scale.
 *
 * `rawOfKei` is the other direction and matters for a different reason: it is
 * what decides whether the Buy button believes you can afford a row. Getting it
 * wrong by a factor of anything offers people trades the ledger will refuse.
 */

import { expect, test } from 'bun:test'

import {
  coinNote,
  formatAge,
  formatCoins,
  formatKei,
  formatPrice,
  KEI_RAW,
  parseCoins,
  parseKei,
  rawOfKei,
  shortAddress,
} from '../shared/format.js'

// ----------------------------------------------------------------------- tests

test('a price below a millionth is written out rather than put in exponent form', () => {
  // The regression. `toPrecision(3)` switches to exponent notation here, which
  // is the exact rendering this function exists to prevent.
  expect(formatPrice(6e-7)).toBe('0.0000006')
  expect(formatPrice(1.2e-8)).toBe('0.000000012')
  expect(formatPrice(9.99e-10)).toBe('0.000000000999')
})

test('no price renders with an "e" in it, at any scale a coin can reach', () => {
  const scales = [1e-18, 1e-12, 6e-7, 0.0002, 0.5, 1, 999.5, 12_345.678, 1e9]
  for (const price of scales) {
    expect(formatPrice(price)).not.toContain('e')
  }
})

test('a price keeps three significant figures under one Kei and four places over it', () => {
  expect(formatPrice(0.0002)).toBe('0.0002')
  expect(formatPrice(0.000123456)).toBe('0.000123')
  expect(formatPrice(0.5)).toBe('0.5')
  expect(formatPrice(1234.5678)).toBe('1234.5678')
})

test('a price with nothing after the point does not keep the point', () => {
  expect(formatPrice(1)).toBe('1')
  expect(formatPrice(100)).toBe('100')
  expect(formatPrice(2.5)).toBe('2.5')
})

test('a price that is not one reads as zero rather than as NaN', () => {
  expect(formatPrice(0)).toBe('0')
  expect(formatPrice(-1)).toBe('0')
  expect(formatPrice(Number.NaN)).toBe('0')
  expect(formatPrice(Number.POSITIVE_INFINITY)).toBe('0')
})

test('a Kei amount that arrived as a double survives the trip back to raw', () => {
  expect(rawOfKei(1)).toBe(KEI_RAW)
  expect(rawOfKei(0.5)).toBe(KEI_RAW / 2n)
  expect(rawOfKei(2.25)).toBe((9n * KEI_RAW) / 4n)
})

test('a total that cannot be afforded does not become one that can', () => {
  // The comparison the Buy button makes. The double nearest 1.1 is a hair above
  // it, so this lands at 1.1 plus 89 attoKei rather than on it — the drift is
  // in the eighteenth decimal place, which is far below anything a balance is
  // quoted in and cannot round an unaffordable row into an affordable one.
  const total = rawOfKei(1.1)
  const exact = parseKei('1.1')
  const drift = total > exact ? total - exact : exact - total

  expect(drift).toBeLessThan(1_000n)
  expect(formatKei(total, 8)).toBe('1.1')
})

test('an amount that is not one converts to nothing rather than throwing', () => {
  expect(rawOfKei(0)).toBe(0n)
  expect(rawOfKei(-5)).toBe(0n)
  expect(rawOfKei(Number.NaN)).toBe(0n)
})

test('an amount past the point where toFixed gives up still converts', () => {
  // `toFixed` returns exponent notation at 1e21, which `parseKei` refuses.
  // Nothing trades there, but a total is a product of two numbers a stranger
  // chose, so it is not the formatter's place to assume.
  expect(rawOfKei(1e21)).toBe(BigInt(1e21) * KEI_RAW)
})

test('raw Kei and decimal Kei are the same number in both directions', () => {
  expect(formatKei(parseKei('1.1'), 18)).toBe('1.1')
  expect(formatKei(KEI_RAW * 25n, 4)).toBe('25')
  expect(parseKei(formatKei(1_234_567_890_123_456_789n, 18))).toBe(1_234_567_890_123_456_789n)
})

test('coins are counted, never rounded up', () => {
  expect(formatCoins(1_234_567)).toBe('1,234,567')
  expect(formatCoins(999.9)).toBe('999')
  expect(formatCoins(0)).toBe('0')
})

test('an age is coarse everywhere except the first minute', () => {
  const now = 1_000_000_000_000
  expect(formatAge(now - 5_000, now)).toBe('5s')
  expect(formatAge(now - 90_000, now)).toBe('1m')
  expect(formatAge(now - 3 * 60 * 60_000, now)).toBe('3h')
  expect(formatAge(now - 2 * 24 * 60 * 60_000, now)).toBe('2d')
})

test('a shortened address keeps both ends, because the prefix is shared', () => {
  const address = `kei_${'a'.repeat(20)}${'z'.repeat(20)}`
  const short = shortAddress(address, 6)

  expect(short.startsWith('kei_aa')).toBe(true)
  expect(short.endsWith('zzzzzz')).toBe(true)
  expect(short).toContain('…')
})

// ------------------------------------------------- parseCoins, the money one

/**
 * The Amount field, over the raw strings rather than over parsed numbers.
 *
 * `wholeCoins()` used to delete every non-digit and call it truncation, so the
 * separator vanished and its digits were promoted into the integer: `2.5` was
 * listed as 25 coins and a bid of `100.00` locked Kei for 10,000 (#16). Nothing
 * downstream could have caught it — `lib/refusals.ts` only ever saw the number
 * after it was already wrong, so every total on screen agreed with a quantity
 * nobody had typed.
 *
 * These assert the strings, because the string is where the bug was.
 */
test('a fraction of a coin truncates to the whole part and never promotes its digits', () => {
  // The bug, both directions. 25 and 10,000 are what the old parse answered.
  expect(parseCoins('2.5')).toEqual({ count: 2, malformed: false, truncated: true })
  expect(parseCoins('100.00')).toEqual({ count: 100, malformed: false, truncated: false })
  expect(parseCoins('0.1')).toEqual({ count: 0, malformed: false, truncated: true })
  expect(parseCoins('1.999')).toEqual({ count: 1, malformed: false, truncated: true })
})

test('trailing zeroes are not a fraction, so they are not reported as one', () => {
  // `100.00` is a hundred exactly. Saying "that is 100" to somebody who typed a
  // hundred would be noise, and noise is how a real notice gets ignored.
  expect(parseCoins('100.00').truncated).toBe(false)
  expect(parseCoins('7.0').truncated).toBe(false)
  expect(parseCoins('7.01').truncated).toBe(true)
})

test('an integer with no point at all is unchanged', () => {
  expect(parseCoins('1000')).toEqual({ count: 1000, malformed: false, truncated: false })
  expect(parseCoins('0')).toEqual({ count: 0, malformed: false, truncated: false })
  expect(parseCoins(' 42 ')).toEqual({ count: 42, malformed: false, truncated: false })
})

test('an empty field is not an error, because that is how the field starts', () => {
  expect(parseCoins('')).toEqual({ count: 0, malformed: false, truncated: false })
  expect(parseCoins('   ')).toEqual({ count: 0, malformed: false, truncated: false })
})

test('anything that is not a plain decimal is refused rather than guessed at', () => {
  // `1,5` is the case that makes stripping separators unsafe: it is one and a
  // half in most of Europe and fifteen if the comma is grouping. Refusing is
  // the only answer that is not wrong for somebody.
  for (const text of ['1,5', '1,234', '-5', '1e3', '0x10', 'Infinity', 'NaN', '1.2.3', '.5', '5.', 'ten', '1 000']) {
    expect(parseCoins(text)).toEqual({ count: 0, malformed: true, truncated: false })
  }
})

test('a quantity past the safe integer range is refused, not silently rounded', () => {
  // 2^53 + 1 does not survive a `number`, and a lot that is off by one unit is
  // off by one unit on somebody's own chain.
  expect(parseCoins('9007199254740993').malformed).toBe(true)
  expect(parseCoins('99999999999999999999').malformed).toBe(true)
  expect(parseCoins('9007199254740991')).toEqual({
    count: 9_007_199_254_740_991,
    malformed: false,
    truncated: false,
  })
})

test('what the old parse answered, held down so it cannot come back', () => {
  // Not a behaviour test — a bug test. Each of these was the wrong answer, and
  // the two on the money path were wrong by two orders of magnitude.
  expect(parseCoins('2.5').count).not.toBe(25)
  expect(parseCoins('100.00').count).not.toBe(10_000)
  expect(parseCoins('1,5').count).not.toBe(15)
  expect(parseCoins('-5').count).not.toBe(5)
})

/**
 * The sentence a fractional Amount puts on screen, before the button.
 *
 * Asserted here rather than in a render because `test/dom.ts` cannot deliver an
 * event to a text input — React's change plugin throws on one — so no test in
 * this repository can type into a field. That gap is most of why #16 reached
 * `main`: the parse was wrong and the panel faithfully printed a total that
 * agreed with it, and nothing checked either.
 */
test('a truncated amount says what will actually be listed, in coins', () => {
  expect(coinNote(parseCoins('2.5'), 'CARPET')).toBe('CARPET has no decimal places, so that is 2 CARPET.')
  // Grouped, because 1234 coins is unreadable at the width the note renders at.
  expect(coinNote(parseCoins('1234.9'), 'KILIM')).toContain('1,234 KILIM')
  // Half a coin is none of one, and saying so is the point: the trade is not the
  // one that was typed.
  expect(coinNote(parseCoins('0.4'), 'CARPET')).toContain('0 CARPET')
})

test('an amount that needed no truncating gets no note', () => {
  // Silence is the signal. A note on every keystroke is a note nobody reads.
  expect(coinNote(parseCoins('100'), 'CARPET')).toBeNull()
  expect(coinNote(parseCoins('100.00'), 'CARPET')).toBeNull()
  expect(coinNote(parseCoins(''), 'CARPET')).toBeNull()
  // A refused amount is refused by name in `lib/refusals.ts`; there is no
  // quantity here to make a note about.
  expect(coinNote(parseCoins('1,5'), 'CARPET')).toBeNull()
})

/**
 * The first-buy path as a state machine, checked transition by transition.
 *
 * Issue #14 asks for a deterministic state map and for regression coverage of
 * each required transition, and the regression it is guarding against is a step
 * quietly collapsing: a confirmation removed to save a click, a pending phase
 * folded into a spinner, an empty book rendered as a price of zero. Every one of
 * those is a test here rather than something somebody notices in a screenshot.
 *
 * The rule the file is really pinning: there is no path from a row to a
 * signature that skips the terms.
 */

import { describe, expect, test } from 'bun:test'

import {
  FUNNEL,
  FUNNEL_OPENING,
  chose,
  confirmed,
  dropped,
  landed,
  position,
  quoted,
  reached,
  refused,
  reopened,
  says,
  unsigned,
  type Funnel,
  type Quote,
} from '../lib/funnel'

const SELLER = 'kei_3seller00000000000000000000000000000000000000000000000000xyz'

/**
 * Both legs of the rendered row, as `accept` asserts them against the chain.
 *
 * The formatted figures on the quote are for a person to read and are lossy.
 * This is the part that has to survive every transition intact, because it is
 * what stops a book that went stale between the poll and the click changing what
 * the key agrees to (#6).
 */
const EXPECT: Quote['expect'] = {
  hash: 'offer-1',
  seller: SELLER,
  give: { asset: 'carpet', amount: 40_000 },
  want: { asset: 'kei', amount: 16 },
  to: null,
}

const QUOTE: Quote = {
  offer: 'offer-1',
  coins: 40_000,
  kei: 16,
  unitPrice: 0.0004,
  from: SELLER,
  expect: EXPECT,
}

/** The board answered with one ask, which is the ordinary case. */
const open = (): Funnel => quoted(FUNNEL_OPENING, 1)

test('the five steps are in the order the issue names', () => {
  expect(FUNNEL).toEqual(['empty', 'quote', 'intent', 'pending', 'settled'])
  expect(FUNNEL.map(position)).toEqual([1, 2, 3, 4, 5])
})

describe('the path a first buy takes', () => {
  test('a board with nothing for sale is the empty step, not a loading one', () => {
    expect(FUNNEL_OPENING.step).toBe('empty')
    expect(quoted(FUNNEL_OPENING, 0).step).toBe('empty')
  })

  test('an ask moves it to the book, and the book is where a quote is picked', () => {
    expect(open().step).toBe('quote')
    expect(chose(open(), QUOTE).step).toBe('intent')
  })

  test('confirming is the only way into pending, and it carries the terms', () => {
    const intent = chose(open(), QUOTE)
    const pending = confirmed(intent)
    expect(pending.step).toBe('pending')
    expect(pending.quote).toEqual(QUOTE)
  })

  test('settled is reachable only from pending, and only that step is a fact', () => {
    const settled = landed(confirmed(chose(open(), QUOTE)))
    expect(settled.step).toBe('settled')
    expect(reached(settled, 'pending')).toBe(true)
  })
})

describe('the steps that cannot be skipped', () => {
  test('the book cannot sign — confirming from quote does nothing', () => {
    expect(confirmed(open())).toEqual(open())
  })

  test('a chosen quote cannot land without being confirmed', () => {
    const intent = chose(open(), QUOTE)
    expect(landed(intent)).toEqual(intent)
  })

  test('an empty book cannot choose anything', () => {
    expect(chose(FUNNEL_OPENING, QUOTE)).toEqual(FUNNEL_OPENING)
  })

  test('confirming with no terms is refused by the machine, not by the panel', () => {
    expect(confirmed({ step: 'intent', quote: null, problem: null }).step).toBe('intent')
  })
})

describe('the terms that reach the signature', () => {
  test('the expectation picked off the row is the one confirm carries', () => {
    const pending = confirmed(chose(open(), QUOTE))
    expect(pending.quote?.expect).toEqual(EXPECT)
  })

  test('a poll during the confirmation cannot swap the terms underneath it', () => {
    const intent = chose(open(), QUOTE)
    expect(quoted(intent, 0).quote?.expect).toEqual(EXPECT)
    expect(quoted(intent, 9).quote?.expect).toEqual(EXPECT)
  })

  test('a wallet that was busy keeps the same expectation for the retry', () => {
    const stalled = unsigned(confirmed(chose(open(), QUOTE)))
    expect(stalled.quote?.expect).toEqual(EXPECT)
  })

  test('a refusal drops the terms rather than re-offering them unchecked', () => {
    const back = refused(confirmed(chose(open(), QUOTE)), 'gone')
    expect(back.quote).toBeNull()
  })
})

describe('what the poll is not allowed to do', () => {
  test('an ask filled by somebody else does not rewind a confirmation', () => {
    const intent = chose(open(), QUOTE)
    expect(quoted(intent, 0)).toEqual(intent)
  })

  test('nor a block in flight, nor a settled trade', () => {
    const pending = confirmed(chose(open(), QUOTE))
    expect(quoted(pending, 0)).toEqual(pending)
    const settled = landed(pending)
    expect(quoted(settled, 5)).toEqual(settled)
  })

  test('an empty book that gains an ask does move, because nothing is at stake', () => {
    expect(quoted(FUNNEL_OPENING, 3).step).toBe('quote')
  })
})

describe('what happens when it does not settle', () => {
  test('a refusal goes back to the book carrying the ledger’s own sentence', () => {
    const pending = confirmed(chose(open(), QUOTE))
    const back = refused(pending, 'That offer has already been accepted.')
    expect(back.step).toBe('quote')
    expect(back.quote).toBeNull()
    expect(back.problem).toBe('That offer has already been accepted.')
  })

  test('a refusal can only arrive at a block that was actually in flight', () => {
    const intent = chose(open(), QUOTE)
    expect(refused(intent, 'anything')).toEqual(intent)
  })

  test('nothing signed keeps the terms on screen rather than losing them', () => {
    const pending = confirmed(chose(open(), QUOTE))
    const stalled = unsigned(pending)
    expect(stalled.step).toBe('intent')
    expect(stalled.quote).toEqual(QUOTE)
  })

  test('backing out of the terms signs nothing and clears the quote', () => {
    const back = dropped(chose(open(), QUOTE))
    expect(back).toEqual({ step: 'quote', quote: null, problem: null })
  })

  test('picking a new quote clears the previous refusal', () => {
    const back = refused(confirmed(chose(open(), QUOTE)), 'gone')
    expect(chose(back, QUOTE).problem).toBeNull()
  })

  test('only a settled funnel reopens', () => {
    const settled = landed(confirmed(chose(open(), QUOTE)))
    expect(reopened(settled)).toEqual(FUNNEL_OPENING)
    expect(reopened(open())).toEqual(open())
  })
})

describe('the copy, which is the part somebody reads', () => {
  test('the empty step says there are no trades and no reserve', () => {
    const said = says(FUNNEL_OPENING, 'KILIM')
    expect(said.sentence).toContain('No trades yet')
    expect(said.sentence).toContain('nobody is selling KILIM')
    expect(said.sentence).toContain('no reserve')
  })

  test('the terms are restated in full before anything is signed', () => {
    const said = says(chose(open(), QUOTE), 'KILIM')
    expect(said.sentence).toContain('40,000 KILIM')
    expect(said.sentence).toContain('16 Kei')
    expect(said.sentence).toContain('0.0004 each')
    expect(said.sentence).toContain('Nothing has been signed yet')
  })

  test('pending says settling rather than done', () => {
    const said = says(confirmed(chose(open(), QUOTE)), 'KILIM')
    expect(said.sentence).toContain('settling')
    expect(said.sentence).not.toContain('bought')
  })

  test('settled names what is now on this wallet’s own chain', () => {
    const said = says(landed(confirmed(chose(open(), QUOTE))), 'KILIM')
    expect(said.sentence).toContain('40,000 KILIM')
    expect(said.sentence).toContain('your own chain')
  })

  test('every step has a label and a sentence, so none of them renders as blank', () => {
    for (const step of FUNNEL) {
      const said = says({ step, quote: QUOTE, problem: null }, 'KILIM')
      expect(said.label.length).toBeGreaterThan(0)
      expect(said.sentence.length).toBeGreaterThan(0)
    }
  })
})

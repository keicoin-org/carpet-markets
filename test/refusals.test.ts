/**
 * Criterion 2 of SPEC §9.6, as assertions.
 *
 * "Every state that can refuse a trade is named on screen before the action, not
 * surfaced as a failure after it." The three states that bite on a block-lattice
 * are an unsigned-for receivable, units locked into an open offer, and a
 * spendable balance below the ask — and the whole point is that each one gets
 * its *own* sentence. A single "not enough" covering all three is the bug: it is
 * false for the first, unhelpful for the second, and only correct for the third.
 */

import { expect, test } from 'bun:test'

import { NO_FUNDS, type Funds, type InFlight } from '../lib/balance.js'
import { bidBlocker, buyBlocker, fillBidBlocker, launchBlocker, sellBlocker } from '../lib/refusals.js'
import { FAUCET_KEI } from '../shared/faucet.js'
import { KEI_RAW } from '../shared/format.js'
import type { Listing, TransferPolicy } from '../shared/listing.js'

const YOU = 'kei_you'
const THEM = 'kei_them'
const ASSET = 'asset-carpet'

function listing(transfer: TransferPolicy = 'open'): Listing {
  return {
    asset: ASSET,
    symbol: 'CARPET',
    name: 'Carpet',
    blurb: '',
    issuer: 'kei_issuer',
    creator: THEM,
    transfer,
    supply: 1_000_000,
    launchedAt: 0,
  }
}

const funds = (over: Partial<Funds> = {}): Funds => ({ ...NO_FUNDS, ...over })

const outbound = (kei: bigint, coins: Iterable<readonly [string, number]> = []): InFlight => ({
  id: 1,
  what: 'test',
  kei,
  coins: new Map(coins),
})

// ------------------------------------------------------------------ policy first

test('a soulbound coin says the market cannot exist, not that you are short', () => {
  const blocked = buyBlocker({
    listing: listing('none'),
    funds: funds({ confirmed: 100n * KEI_RAW }),
    total: KEI_RAW,
    from: THEM,
    you: YOU,
    busy: false,
  })

  expect(blocked?.code).toBe('policy')
  expect(blocked?.sentence).toMatch(/cannot move/i)
  // Nothing changes this, so it must not suggest anything might.
  expect(blocked?.fix).toBeNull()
})

test('an issuer-only coin says why no offer between holders is valid', () => {
  const blocked = sellBlocker({
    listing: listing('issuer-only'),
    funds: funds(),
    held: 5_000,
    amount: 100,
    unitPrice: 1,
    locked: 0,
    you: YOU,
    busy: false,
  })

  expect(blocked?.code).toBe('policy')
  expect(blocked?.sentence).toMatch(/only to or from its issuing account/i)
})

// ------------------------------------------------------ the three states that bite

test('money that has arrived and is not signed for reads as settling, not as short', () => {
  // The one that is actively false if it says "not enough Kei". The Kei is
  // there, it is owed, and it is spendable in about two seconds.
  const blocked = buyBlocker({
    listing: listing(),
    funds: funds({ confirmed: KEI_RAW / 2n, incoming: 5n * KEI_RAW, arrivals: 1 }),
    total: 2n * KEI_RAW,
    from: THEM,
    you: YOU,
    busy: false,
  })

  expect(blocked?.code).toBe('settling')
  expect(blocked?.sentence).toMatch(/has not been signed for yet/i)
  expect(blocked?.fix).toMatch(/automatically/i)
})

test('a genuinely empty wallet is told it is short and where to get more', () => {
  const blocked = buyBlocker({
    listing: listing(),
    funds: funds({ confirmed: KEI_RAW / 10n }),
    total: 2n * KEI_RAW,
    from: THEM,
    you: YOU,
    busy: false,
  })

  expect(blocked?.code).toBe('short')
  expect(blocked?.sentence).toMatch(/0\.1 is spendable/)
  expect(blocked?.fix).toMatch(/faucet/i)
})

/**
 * The shortfall the demo board used to walk a stranger into (#18).
 *
 * A first-time wallet holds one faucet grant, and the fix for a lot that costs
 * more than that is to press the faucet again — which is only a fix if the page
 * says so and says how many times. "The faucet hands out 25 Kei" next to a 66 Kei
 * lot leaves the arithmetic to somebody who has been on the site for ten seconds.
 */
test('a shortfall says how many faucet presses cover it', () => {
  const short = (total: bigint) =>
    buyBlocker({
      listing: listing(),
      funds: NO_FUNDS,
      total,
      from: THEM,
      you: YOU,
      busy: false,
    })

  const grant = BigInt(FAUCET_KEI) * KEI_RAW

  // Inside one grant, and exactly one grant, are both a single press.
  expect(short(grant / 2n)?.fix).toMatch(/press it once/)
  expect(short(grant)?.fix).toMatch(/press it once/)

  // A hair over one grant is two, because the faucet does not pay fractions.
  expect(short(grant + 1n)?.fix).toMatch(/press it 2 times/)

  // The lot from the issue: 66 Kei against a 25 Kei grant.
  expect(short(66n * KEI_RAW)?.fix).toMatch(/press it 3 times/)
})

test('coins locked in your own offers are named as locked, with the cancel as the fix', () => {
  const blocked = sellBlocker({
    listing: listing(),
    funds: funds(),
    held: 0,
    amount: 100,
    unitPrice: 1,
    locked: 4_000,
    you: YOU,
    busy: false,
  })

  expect(blocked?.code).toBe('all-listed')
  expect(blocked?.sentence).toMatch(/locked into your own open offers/i)
  expect(blocked?.fix).toMatch(/cancel one below/i)
})

test('holding none and having listed it all are different sentences', () => {
  const nothing = sellBlocker({
    listing: listing(),
    funds: funds(),
    held: 0,
    amount: 100,
    unitPrice: 1,
    locked: 0,
    you: YOU,
    busy: false,
  })

  expect(nothing?.code).toBe('holds-none')
  expect(nothing?.sentence).toMatch(/you hold no carpet/i)
  expect(nothing?.fix).toMatch(/buy some|launch a coin/i)
})

test('an offer signed a second ago is subtracted before the next one is checked', () => {
  // Two clicks in the same second must not both be checked against the same
  // coins. `spendableCoins` takes the in-flight listing off the confirmed
  // balance, so the second attempt is refused rather than double-spending.
  const blocked = sellBlocker({
    listing: listing(),
    funds: funds({ inFlight: [outbound(0n, [[ASSET, -900]])] }),
    held: 1_000,
    amount: 500,
    unitPrice: 1,
    locked: 0,
    you: YOU,
    busy: false,
  })

  expect(blocked?.code).toBe('over-held')
  expect(blocked?.sentence).toMatch(/can list 100/i)
})

// ------------------------------------------------------------------- the own-offer

test('your own offer says a swap needs two parties', () => {
  const blocked = buyBlocker({
    listing: listing(),
    funds: funds({ confirmed: 100n * KEI_RAW }),
    total: KEI_RAW,
    from: YOU,
    you: YOU,
    busy: false,
  })

  expect(blocked?.code).toBe('own-offer')
  expect(blocked?.fix).toMatch(/cancel it/i)
})

test('a fillable ask with the money there is not blocked at all', () => {
  expect(
    buyBlocker({
      listing: listing(),
      funds: funds({ confirmed: 100n * KEI_RAW }),
      total: KEI_RAW,
      from: THEM,
      you: YOU,
      busy: false,
    }),
  ).toBeNull()
})

// -------------------------------------------------------------------- the bid side

test('filling somebody’s bid is refused on coins, not on Kei', () => {
  const blocked = fillBidBlocker({
    listing: listing(),
    funds: funds({ confirmed: 0n }),
    held: 10,
    want: 500,
    from: THEM,
    you: YOU,
    busy: false,
  })

  expect(blocked?.code).toBe('over-held')
  expect(blocked?.sentence).toMatch(/handing over 500 carpet/i)
})

test('writing a bid says what it locks, because the Kei stops being spendable', () => {
  const blocked = bidBlocker({
    listing: listing(),
    funds: funds({ confirmed: KEI_RAW }),
    amount: 1_000,
    unitPrice: 0.01,
    total: 10n * KEI_RAW,
    you: YOU,
    busy: false,
  })

  expect(blocked?.code).toBe('short')
  expect(blocked?.sentence).toMatch(/locks 10 kei/i)
  expect(blocked?.fix).toMatch(/holds your kei until/i)
})

test('a bid with no price is refused before it is priced at zero', () => {
  expect(
    bidBlocker({
      listing: listing(),
      funds: funds({ confirmed: 100n * KEI_RAW }),
      amount: 1_000,
      unitPrice: 0,
      total: 0n,
      you: YOU,
      busy: false,
    })?.code,
  ).toBe('no-price')
})

// ----------------------------------------------------------------------- launching

test('a launch is refused on the fee with the same settling distinction', () => {
  const settling = launchBlocker({
    funds: funds({ confirmed: KEI_RAW / 2n, incoming: 25n * KEI_RAW, arrivals: 1 }),
    fee: 11n * KEI_RAW / 10n,
    identity: null,
    you: YOU,
    busy: false,
  })
  expect(settling?.code).toBe('settling')

  const short = launchBlocker({
    funds: funds({ confirmed: KEI_RAW / 2n }),
    fee: (11n * KEI_RAW) / 10n,
    identity: null,
    you: YOU,
    busy: false,
  })
  expect(short?.code).toBe('short')
})

test('a launch before the registry has quoted a fee says so rather than guessing', () => {
  expect(
    launchBlocker({ funds: funds({ confirmed: 100n * KEI_RAW }), fee: null, identity: null, you: YOU, busy: false })
      ?.sentence,
  ).toMatch(/not quoted the fee yet/i)
})

test('a valid launch with the money there is not blocked', () => {
  expect(
    launchBlocker({
      funds: funds({ confirmed: 25n * KEI_RAW }),
      fee: (11n * KEI_RAW) / 10n,
      identity: null,
      you: YOU,
      busy: false,
    }),
  ).toBeNull()
})

// -------------------------------------------------------------------- every sentence

test('every refusal is a sentence, not a code', () => {
  const cases = [
    buyBlocker({ listing: listing('none'), funds: funds(), total: 1n, from: THEM, you: YOU, busy: false }),
    buyBlocker({ listing: listing(), funds: funds(), total: 1n, from: THEM, you: null, busy: false }),
    buyBlocker({ listing: listing(), funds: funds(), total: 1n, from: THEM, you: YOU, busy: true }),
    sellBlocker({
      listing: listing(),
      funds: funds(),
      held: 10,
      amount: 0,
      unitPrice: 1,
      locked: 0,
      you: YOU,
      busy: false,
    }),
  ]

  for (const blocked of cases) {
    expect(blocked).not.toBeNull()
    expect(blocked!.sentence).toMatch(/[.!]$/)
    expect(blocked!.sentence.length).toBeGreaterThan(20)
  }
})

/**
 * A field holding something that is not a quantity is a refusal, not a zero.
 *
 * Before #16 there was no such state: the parse deleted whatever it did not
 * recognise and handed the blockers a number that had already been changed, so
 * `1,5` reached the ledger as fifteen coins with nothing on screen dissenting.
 */
test('an unreadable amount is refused by name, on both sides of the book', () => {
  const sell = sellBlocker({
    listing: listing(),
    funds: funds(),
    held: 5_000,
    amount: 0,
    malformed: true,
    unitPrice: 1,
    locked: 0,
    you: YOU,
    busy: false,
  })
  expect(sell?.code).toBe('bad-amount')
  expect(sell?.sentence).toMatch(/not a number of CARPET/i)
  // The fix has to say what is allowed, or it is a dead end.
  expect(sell?.fix).toMatch(/decimal point/i)

  const bid = bidBlocker({
    listing: listing(),
    funds: funds(),
    amount: 0,
    malformed: true,
    unitPrice: 1,
    total: 0n,
    you: YOU,
    busy: false,
  })
  expect(bid?.code).toBe('bad-amount')
})

test('a readable amount is not refused as unreadable', () => {
  const sell = sellBlocker({
    listing: listing(),
    funds: funds(),
    held: 5_000,
    amount: 2,
    malformed: false,
    unitPrice: 1,
    locked: 0,
    you: YOU,
    busy: false,
  })
  expect(sell).toBeNull()
})

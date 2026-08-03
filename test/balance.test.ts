/**
 * The rule that a balance on screen is never a balance you can spend.
 *
 * A block-lattice wallet has three numbers where a bank account has one, and the
 * interesting failures are all in the gap between them: money that has arrived
 * but has not been signed for, and money this browser has signed away that the
 * next poll has not reported yet. Show only the confirmed number and the page
 * looks broken for two seconds after every trade; add them together and the page
 * offers money the ledger will refuse to move, which reads like a bug in the
 * market rather than the market working.
 *
 * So these tests are mostly one assertion in different clothes: whatever else
 * changes, `spendable` never counts anything the chain has not confirmed.
 */

import { expect, test } from 'bun:test'

import { KEI_RAW } from '../shared/format.js'
import {
  canSpend,
  committed,
  committedCoins,
  NO_FUNDS,
  projected,
  settling,
  spendable,
  spendableCoins,
  type Funds,
  type InFlight,
} from '../lib/balance.js'

const ASSET = 'A'.repeat(64)
const OTHER = 'B'.repeat(64)

// --------------------------------------------------------------------- helpers

/** One signed, unconfirmed change. Kei in whole units, for legibility. */
function change(id: number, kei: number, coins: readonly (readonly [string, number])[] = []): InFlight {
  return { id, what: `change ${id}`, kei: BigInt(kei) * KEI_RAW, coins: new Map(coins) }
}

function funds(partial: Partial<Funds> = {}): Funds {
  return { ...NO_FUNDS, ...partial }
}

// ----------------------------------------------------------------------- tests

test('an untouched wallet can spend nothing and is not settling', () => {
  expect(spendable(NO_FUNDS)).toBe(0n)
  expect(projected(NO_FUNDS)).toBe(0n)
  expect(settling(NO_FUNDS)).toBe(false)
})

test('money on its way is shown and is not spendable', () => {
  // The whole point of the split. Twenty-five Kei from the faucet is real, and
  // it is a receivable until this wallet's own key signs for it (SPEC §5.6.3).
  const wallet = funds({ confirmed: 2n * KEI_RAW, incoming: 25n * KEI_RAW, arrivals: 1 })

  expect(spendable(wallet)).toBe(2n * KEI_RAW)
  expect(projected(wallet)).toBe(27n * KEI_RAW)
  expect(canSpend(wallet, 3n * KEI_RAW)).toBe(false)
  expect(settling(wallet)).toBe(true)
})

test('a spend is a debt the moment it is signed, before the chain reports it', () => {
  const wallet = funds({ confirmed: 10n * KEI_RAW, inFlight: [change(1, -4)] })

  expect(committed(wallet)).toBe(4n * KEI_RAW)
  expect(spendable(wallet)).toBe(6n * KEI_RAW)
  expect(projected(wallet)).toBe(6n * KEI_RAW)
})

test('two spends in the same second cannot both be checked against the same Kei', () => {
  // Without this, a second click while the first is in flight is validated
  // against a balance the first already claimed.
  const wallet = funds({ confirmed: 10n * KEI_RAW, inFlight: [change(1, -6), change(2, -3)] })

  expect(spendable(wallet)).toBe(1n * KEI_RAW)
  expect(canSpend(wallet, 2n * KEI_RAW)).toBe(false)
})

test('a credit in flight is displayed but does not fund the next spend', () => {
  // Selling into an offer pays this wallet, and the payment is a receivable
  // like any other. It moves `projected` and must not move `spendable`.
  const wallet = funds({ confirmed: 1n * KEI_RAW, inFlight: [change(1, 8)] })

  expect(spendable(wallet)).toBe(1n * KEI_RAW)
  expect(projected(wallet)).toBe(9n * KEI_RAW)
  expect(canSpend(wallet, 5n * KEI_RAW)).toBe(false)
})

test('committing more than is confirmed floors at zero rather than going negative', () => {
  // Reachable when the poll lands between the render and the click.
  const wallet = funds({ confirmed: 1n * KEI_RAW, inFlight: [change(1, -5)] })

  expect(spendable(wallet)).toBe(0n)
  expect(projected(wallet)).toBe(0n)
  expect(canSpend(wallet, 1n)).toBe(false)
})

test('spending nothing is not a spend', () => {
  expect(canSpend(funds({ confirmed: 10n * KEI_RAW }), 0n)).toBe(false)
})

test('coins listed a moment ago are gone from what can be listed again', () => {
  // The `swap_offer` block locks them on the chain; this covers only the gap
  // before the poll shows that having happened.
  const wallet = funds({ inFlight: [change(1, 0, [[ASSET, -400]])] })

  expect(committedCoins(wallet, ASSET)).toBe(400)
  expect(spendableCoins(wallet, ASSET, 1_000)).toBe(600)
})

test('coins arriving from a purchase are not listable before they arrive', () => {
  const wallet = funds({ inFlight: [change(1, 0, [[ASSET, 500]])] })

  expect(committedCoins(wallet, ASSET)).toBe(0)
  expect(spendableCoins(wallet, ASSET, 100)).toBe(100)
})

test('one coin in flight does not touch another coin', () => {
  const wallet = funds({ inFlight: [change(1, 0, [[ASSET, -900]])] })

  expect(spendableCoins(wallet, OTHER, 50)).toBe(50)
})

test('listing more than is held floors at zero rather than going negative', () => {
  const wallet = funds({ inFlight: [change(1, 0, [[ASSET, -900]])] })

  expect(spendableCoins(wallet, ASSET, 100)).toBe(0)
})

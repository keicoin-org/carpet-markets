/**
 * Every reason a trade will not go through, worked out before it is attempted.
 *
 * This file exists because of one rule: a state that can refuse an action must
 * be *named on screen before the action*, not surfaced as a failure after it
 * (SPEC §9.6, criterion 2). A disabled button with no explanation and a red
 * toast two seconds later are the same bug wearing different clothes — in both
 * cases the person had to try in order to find out.
 *
 * The three states that actually bite here are the three a block-lattice has and
 * a bank account does not:
 *
 *   - money that has arrived and has not been signed for yet, so it is real and
 *     unspendable (SPEC §5.6.3);
 *   - coins locked into an open offer, which left the spendable balance when the
 *     `swap_offer` block was written and come back on a cancel (SPEC §9.2);
 *   - a transfer policy that makes the whole trade an invalid block (SPEC §5.4).
 *
 * Each one gets a sentence that says what it is and what to do about it, and
 * each sentence is asserted in `test/refusals.test.ts` rather than trusted.
 */

import { FAUCET_GRANT_RAW, FAUCET_KEI } from '../shared/faucet'
import { formatCoins, formatKei } from '../shared/format'
import type { Listing } from '../shared/listing'
import { spendable, spendableCoins, type Funds } from './balance'

export type BlockerCode =
  | 'no-wallet'
  | 'policy'
  | 'own-offer'
  | 'settling'
  | 'short'
  | 'holds-none'
  | 'all-listed'
  | 'over-held'
  | 'no-price'
  | 'no-amount'
  | 'bad-amount'
  | 'busy'

export interface Blocker {
  code: BlockerCode
  /** What is true right now, in one sentence. */
  sentence: string
  /** What makes it stop being true, or null when nothing does. */
  fix: string | null
}

const blocker = (code: BlockerCode, sentence: string, fix: string | null = null): Blocker => ({
  code,
  sentence,
  fix,
})

/**
 * The Amount field holds something that is not a quantity.
 *
 * Refusing rather than guessing is the whole point. The bug this replaces
 * guessed — it deleted the separator out of `2.5` and listed 25 coins (#16) —
 * and a field that silently reinterprets a number is one nobody can check
 * before they sign.
 */
const badAmount = (listing: Listing): Blocker =>
  blocker(
    'bad-amount',
    `That is not a number of ${listing.symbol}.`,
    'Digits, and at most one decimal point. No commas, spaces or minus signs — a separator that means a thousand here means a half somewhere else, so this asks rather than assumes.',
  )

/**
 * How to cover a shortfall from the bar, counted in presses.
 *
 * The gap used to be reported with a flat "the faucet hands out 25 Kei", which
 * left somebody looking at a 66 Kei lot to work out on their own that the answer
 * was to press it three times (#18). Naming the count is the same rule the rest
 * of this file follows: say what the state is and say what to do about it, before
 * the click rather than after it.
 *
 * Rounded up, because two thirds of a grant is not something the faucet pays.
 */
function fromTheFaucet(short: bigint): string {
  const presses = (short + FAUCET_GRANT_RAW - 1n) / FAUCET_GRANT_RAW
  const count = presses <= 1n ? 'once' : `${presses} times`
  return `The faucet in the bar hands out ${FAUCET_KEI} Kei a press, and this chain is one where that is free — press it ${count}.`
}

/**
 * Why this coin has no market at all, or null when it has one.
 *
 * Deliberately first in every check below. It is not a temporary condition and
 * no amount of balance fixes it — the coin was issued this way and the chain has
 * enforced it since the issuance block.
 */
export function policyBlocker(listing: Listing): Blocker | null {
  if (listing.transfer === 'open') return null
  if (listing.transfer === 'none') {
    return blocker(
      'policy',
      `${listing.symbol} is soulbound. Its units cannot move, so no offer for it is a valid block and no market can exist.`,
      null,
    )
  }
  return blocker(
    'policy',
    `${listing.symbol} moves only to or from its issuing account, so an offer between two holders is an invalid block.`,
    null,
  )
}

export interface BuyContext {
  listing: Listing
  funds: Funds
  /** Total ask for the lot, in raw Kei. */
  total: bigint
  /** The offer's author. */
  from: string
  /** This browser's wallet, or null before it opens. */
  you: string | null
  busy: boolean
}

/**
 * Why this particular offer cannot be accepted, or null when it can.
 *
 * The order matters and is the order somebody would discover them in: is there a
 * market, is this even somebody else's offer, is the money here, is it *here*
 * here. The distinction between the last two is the one that matters — a wallet
 * with the Kei arriving and a wallet with no Kei look identical in a total and
 * need completely different sentences.
 */
export function buyBlocker(context: BuyContext): Blocker | null {
  const { listing, funds, total, from, you, busy } = context

  const policy = policyBlocker(listing)
  if (policy) return policy

  if (!you) {
    return blocker('no-wallet', 'This browser has not opened a wallet yet.', 'It appears on its own in a moment.')
  }
  if (from === you) {
    return blocker(
      'own-offer',
      'This is your own offer, and a swap needs two parties.',
      'Cancel it to take the coins back, or wait for somebody to accept it.',
    )
  }
  if (busy) {
    return blocker('busy', 'Another action from this wallet is still settling.', 'One at a time, so two of them cannot be checked against the same coins.')
  }

  const now = spendable(funds)
  if (total <= now) return null

  // Everything owed and everything signed, if it all lands. If that clears the
  // ask, the wallet is not short — it is early, and saying "not enough Kei"
  // would be false in a way somebody would reasonably call a bug.
  const arriving = funds.incoming
  if (arriving > 0n && total <= now + arriving) {
    return blocker(
      'settling',
      `${formatKei(arriving, 4)} Kei has arrived and has not been signed for yet, so ${formatKei(now, 4)} is spendable against an ask of ${formatKei(total, 4)}.`,
      'It is collected automatically within a couple of seconds. The button turns on by itself.',
    )
  }

  return blocker(
    'short',
    `That costs ${formatKei(total, 4)} Kei and ${formatKei(now, 4)} is spendable.`,
    fromTheFaucet(total - now),
  )
}

export interface SellContext {
  listing: Listing
  funds: Funds
  /** Confirmed units on this wallet's chain — already net of anything locked. */
  held: number
  /** Whole units being listed. */
  amount: number
  /** The Amount field holds something that is not a quantity (#16). */
  malformed?: boolean
  /** Asking price per unit, in Kei. */
  unitPrice: number
  /** Units this wallet has sitting in its own open offers for this coin. */
  locked: number
  you: string | null
  busy: boolean
}

/** Why this listing cannot be written, or null when it can. */
export function sellBlocker(context: SellContext): Blocker | null {
  const { listing, funds, held, amount, malformed, unitPrice, locked, you, busy } = context

  const policy = policyBlocker(listing)
  if (policy) return policy

  if (!you) {
    return blocker('no-wallet', 'This browser has not opened a wallet yet.', 'It appears on its own in a moment.')
  }
  if (busy) {
    return blocker('busy', 'Another action from this wallet is still settling.', 'One at a time, so two of them cannot be checked against the same coins.')
  }

  const available = spendableCoins(funds, listing.asset, held)

  if (available <= 0) {
    // Held nothing and held-it-all-in-offers are different situations with the
    // same zero, and only one of them is fixed by cancelling something.
    if (locked > 0) {
      return blocker(
        'all-listed',
        `All ${formatCoins(locked)} ${listing.symbol} you hold are locked into your own open offers.`,
        'Cancel one below and the coins come straight back to your spendable balance.',
      )
    }
    return blocker(
      'holds-none',
      `You hold no ${listing.symbol}.`,
      'Buy some from the book, or launch a coin of your own and be minted the supply.',
    )
  }

  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    return blocker('no-price', 'Set a price above zero.', 'The price is yours to choose — there is no curve quoting one for you.')
  }
  if (malformed) return badAmount(listing)
  if (!Number.isFinite(amount) || amount <= 0) {
    return blocker('no-amount', 'Set a whole number of coins above zero.', null)
  }
  if (amount > available) {
    return blocker(
      'over-held',
      `You can list ${formatCoins(available)} ${listing.symbol}, not ${formatCoins(amount)}.`,
      locked > 0
        ? `${formatCoins(locked)} of yours are locked into offers you have already written.`
        : 'The chain checks a `swap_offer` against the confirmed balance and nothing else.',
    )
  }

  return null
}

export interface FillBidContext {
  listing: Listing
  funds: Funds
  /** Confirmed units on this wallet's chain. */
  held: number
  /** Units the bidder wants, which is what filling it costs. */
  want: number
  /** The bidder. */
  from: string
  you: string | null
  busy: boolean
}

/**
 * Why somebody else's bid cannot be filled, or null when it can.
 *
 * A bid is the same block as an ask with the legs the other way up — Kei locked,
 * coins wanted — so filling one is the same `swap_accept` a buy is, signed by
 * whoever holds the coins. It is worth having in the interface because a market
 * with only one side is not a market: without bids, a holder who wants out has
 * to write an offer and wait, and the page has nothing to show them but their
 * own patience.
 */
export function fillBidBlocker(context: FillBidContext): Blocker | null {
  const { listing, funds, held, want, from, you, busy } = context

  const policy = policyBlocker(listing)
  if (policy) return policy

  if (!you) {
    return blocker('no-wallet', 'This browser has not opened a wallet yet.', 'It appears on its own in a moment.')
  }
  if (from === you) {
    return blocker(
      'own-offer',
      'This is your own bid, and a swap needs two parties.',
      'Cancel it to take the Kei back, or wait for a holder to fill it.',
    )
  }
  if (busy) {
    return blocker('busy', 'Another action from this wallet is still settling.', null)
  }

  const available = spendableCoins(funds, listing.asset, held)
  if (want > available) {
    return blocker(
      'over-held',
      `Filling that means handing over ${formatCoins(want)} ${listing.symbol} and you can move ${formatCoins(available)}.`,
      available < held
        ? 'The rest of yours are locked into offers you have already written.'
        : 'Buy some from the asks above, or wait for a smaller bid.',
    )
  }

  return null
}

export interface BidContext {
  listing: Listing
  funds: Funds
  /** Whole units wanted. */
  amount: number
  /** The Amount field holds something that is not a quantity (#16). */
  malformed?: boolean
  /** What to pay per unit, in Kei. */
  unitPrice: number
  /** Total in raw Kei, which is what actually gets locked. */
  total: bigint
  you: string | null
  busy: boolean
}

/** Why a bid cannot be written, or null when it can. The Kei is locked, so it has to be there. */
export function bidBlocker(context: BidContext): Blocker | null {
  const { listing, funds, amount, malformed, unitPrice, total, you, busy } = context

  const policy = policyBlocker(listing)
  if (policy) return policy

  if (!you) {
    return blocker('no-wallet', 'This browser has not opened a wallet yet.', 'It appears on its own in a moment.')
  }
  if (busy) {
    return blocker('busy', 'Another action from this wallet is still settling.', null)
  }
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    return blocker('no-price', 'Set a price above zero.', 'What you will pay is yours to choose — nothing is quoting it.')
  }
  if (malformed) return badAmount(listing)
  if (!Number.isFinite(amount) || amount <= 0) {
    return blocker('no-amount', 'Set a whole number of coins above zero.', null)
  }

  const now = spendable(funds)
  if (total <= now) return null

  if (funds.incoming > 0n && total <= now + funds.incoming) {
    return blocker(
      'settling',
      `That bid locks ${formatKei(total, 4)} Kei and ${formatKei(now, 4)} is spendable — the rest has arrived and has not been signed for yet.`,
      'It is collected automatically within a couple of seconds.',
    )
  }

  return blocker(
    'short',
    `That bid locks ${formatKei(total, 4)} Kei and ${formatKei(now, 4)} is spendable.`,
    'A bid holds your Kei until somebody fills it or you cancel — so it has to be there first.',
  )
}

export interface LaunchContext {
  funds: Funds
  /** The launch fee in raw Kei, or null before the registry has answered. */
  fee: bigint | null
  /** Whatever is wrong with the name and symbol as typed, or null. */
  identity: string | null
  you: string | null
  busy: boolean
}

export function launchBlocker(context: LaunchContext): Blocker | null {
  const { funds, fee, identity, you, busy } = context

  if (!you) {
    return blocker('no-wallet', 'This browser has not opened a wallet yet.', 'It appears on its own in a moment.')
  }
  if (identity) return blocker('no-amount', identity, null)
  if (busy) return blocker('busy', 'Another action from this wallet is still settling.', null)
  if (fee === null) return blocker('no-price', 'The registry has not quoted the fee yet.', 'It arrives with the board.')

  const now = spendable(funds)
  if (fee <= now) return null

  if (funds.incoming > 0n && fee <= now + funds.incoming) {
    return blocker(
      'settling',
      `${formatKei(funds.incoming, 4)} Kei has arrived and has not been signed for yet, so ${formatKei(now, 4)} is spendable against a fee of ${formatKei(fee, 4)}.`,
      'It is collected automatically within a couple of seconds.',
    )
  }

  return blocker(
    'short',
    `Launching costs ${formatKei(fee, 4)} Kei and ${formatKei(now, 4)} is spendable.`,
    fromTheFaucet(fee - now),
  )
}

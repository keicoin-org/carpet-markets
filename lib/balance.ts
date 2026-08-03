/**
 * Money that is here, money that is owed, and money that is halfway.
 *
 * A block-lattice has three balances where a bank account has one, and a market
 * page that shows only the first is confusing at exactly the moments that matter
 * — right after a trade, which is every moment somebody is paying attention.
 *
 *   confirmed  Signed for, on this wallet's chain, spendable this instant. The
 *              ledger checks a spend against this and nothing else.
 *   incoming   Sent to this wallet and not yet received by it. Real, owed, and
 *              not spendable, because a receivable becomes a balance only when
 *              the holder's own key signs for it (SPEC §5.6.3).
 *   in flight  Signed by this browser in the last second and not yet visible in
 *              a balance read. Nothing on the chain disagrees with it; the poll
 *              simply has not come back.
 *
 * Displaying only `confirmed` makes the page look broken for two seconds after
 * every action. Adding the other two into it makes the page offer money that
 * cannot be spent, and the ledger then refuses the spend with "balance is 0",
 * which reads like a bug in the market rather than the market working. So they
 * are carried separately all the way to the screen, and only `spendable` is ever
 * allowed near a decision about whether an action can proceed.
 *
 * Nothing here touches React or the network. It is arithmetic, so it is tested
 * as arithmetic.
 */

/** A change this browser has signed and the chain has not shown back yet. */
export interface InFlight {
  id: number
  /** What was done, in the same words the status line used. */
  what: string
  /** Signed raw Kei. Negative for a spend. */
  kei: bigint
  /** Signed whole units, by asset. Negative for coins leaving. */
  coins: ReadonlyMap<string, number>
}

export interface Funds {
  /** What the chain says can be spent right now. */
  confirmed: bigint
  /** Raw Kei owed to this wallet and not yet signed for. */
  incoming: bigint
  /** How many separate arrivals are waiting, Kei or coin. */
  arrivals: number
  inFlight: readonly InFlight[]
}

export const NO_FUNDS: Funds = { confirmed: 0n, incoming: 0n, arrivals: 0, inFlight: [] }

/**
 * Kei this browser has already committed and the chain has not yet taken.
 *
 * Counted as a debt the moment it is signed, so that two actions started in the
 * same second cannot each be checked against the same coins. Credits in flight
 * are deliberately not netted off — money arriving does not fund a spend until
 * it has arrived.
 */
export function committed(funds: Funds): bigint {
  return funds.inFlight.reduce((total, change) => (change.kei < 0n ? total - change.kei : total), 0n)
}

/** The only number a spend may be checked against. */
export function spendable(funds: Funds): bigint {
  const left = funds.confirmed - committed(funds)
  return left > 0n ? left : 0n
}

/** What the balance becomes if everything owed and everything signed lands. */
export function projected(funds: Funds): bigint {
  const moving = funds.inFlight.reduce((total, change) => total + change.kei, 0n)
  const total = funds.confirmed + funds.incoming + moving
  return total > 0n ? total : 0n
}

/** Whether an amount can be spent now, which is not the same as afterwards. */
export function canSpend(funds: Funds, amount: bigint): boolean {
  return amount > 0n && amount <= spendable(funds)
}

/** Whole units of one coin this browser has committed and not yet had taken. */
export function committedCoins(funds: Funds, asset: string): number {
  return funds.inFlight.reduce((total, change) => {
    const moving = change.coins.get(asset) ?? 0
    return moving < 0 ? total - moving : total
  }, 0)
}

/**
 * Whole units of one coin that can be listed right now.
 *
 * `held` is the confirmed balance, which already has anything locked into an
 * open offer taken out of it — the `swap_offer` block did that, on the chain,
 * and not as bookkeeping here. What this subtracts is only the offer signed a
 * moment ago that the next poll has not returned yet.
 */
export function spendableCoins(funds: Funds, asset: string, held: number): number {
  return Math.max(0, held - committedCoins(funds, asset))
}

/** Whether anything is on its way or halfway out, for the places that say so. */
export function settling(funds: Funds): boolean {
  return funds.arrivals > 0 || funds.inFlight.length > 0
}

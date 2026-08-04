/**
 * What happened to the thing you just signed, and what to do if it did not work.
 *
 * A trade on a block-lattice has more states than a button has looks. The key
 * signs, the block goes out, the network cements it, and a poll notices — and
 * the gap between the second and the fourth is a second or two in which the
 * balance on screen is stale and the page has to say something true. Worse, some
 * failures here are not failures at all: "this coin cannot be transferred" is the
 * ledger enforcing the thing this whole demo is about, and it must not be dressed
 * as an outage with a retry button under it.
 *
 * So every signed action becomes a record with a phase and, when it goes wrong,
 * a *recovery*: the one next move that is actually available. The classification
 * below is the interesting part, because it is the difference between "try that
 * again" and "somebody else took it, here is the book again" and "the chain will
 * never allow this, and that is the point".
 *
 * No React, no network, no clock unless one is passed in. It is a state machine,
 * so it is tested as one.
 */

/**
 * Signed by this browser, and how far it has got.
 *
 *   signing   The key is producing a block. Nothing is on the network yet, so
 *             nothing has happened and cancelling costs nothing.
 *   settling  The block is out. The ledger has it or is about to; the poll has
 *             not come back. Balances on screen are behind reality here.
 *   done      Seen in a read. This is the only phase in which a trade is a fact.
 *   failed    Refused or unreachable. `recovery` says which.
 */
export type TxPhase = 'signing' | 'settling' | 'done' | 'failed'

/** What kind of thing the record is about, for the icon and for the grouping. */
export type TxKind = 'buy' | 'sell' | 'cancel' | 'launch' | 'faucet' | 'reply'

export type RecoveryKind =
  /** Nothing was wrong with the request; the same action can be repeated. */
  | 'retry'
  /** Money or coins are owed to this wallet and have not been signed for yet. */
  | 'sync'
  /** The wallet is genuinely short. More has to arrive before this can work. */
  | 'fund'
  /** Somebody else consumed the offer first. Read the book again and pick another. */
  | 'gone'
  /** The ledger will never allow this. There is no version of trying harder. */
  | 'refused'
  /** The money already left. Repeating it would spend again, so nothing offers to. */
  | 'paid'
  /** Not classifiable. Say so rather than inventing a fix. */
  | 'unknown'

export interface Recovery {
  kind: RecoveryKind
  /** A sentence naming the next move, in the second person. */
  hint: string
  /** Whether offering a retry button is honest. */
  retryable: boolean
}

export interface Tx {
  id: number
  kind: TxKind
  /** What it is, in the words the button used. "Buying 1,000 CARPET". */
  what: string
  phase: TxPhase
  /** When it entered its current phase. */
  at: number
  /** The ledger's own words, verbatim, when it refused. */
  problem: string | null
  recovery: Recovery | null
  /** How many times this has been tried, including the first. */
  attempts: number
}

const RECOVERIES: Record<RecoveryKind, (message: string) => Recovery> = {
  retry: () => ({
    kind: 'retry',
    hint: 'The node did not answer. Nothing was signed away — try it again.',
    retryable: true,
  }),
  sync: () => ({
    kind: 'sync',
    hint: 'Some of what you are spending has arrived but has not been signed for yet. It settles on its own within a couple of seconds; try again then.',
    retryable: true,
  }),
  fund: () => ({
    kind: 'fund',
    hint: 'Your spendable balance is short. Use the faucet in the bar, or wait for what is arriving to settle.',
    retryable: true,
  }),
  gone: () => ({
    kind: 'gone',
    hint: 'Somebody else took that offer first. Nothing left your wallet — the book below has already refreshed.',
    retryable: false,
  }),
  refused: () => ({
    kind: 'refused',
    hint: 'The chain refuses this, permanently, because of the policy the coin was issued under. This is the ledger working rather than the page failing.',
    retryable: false,
  }),
  paid: () => ({
    kind: 'paid',
    hint: 'The fee has already left your wallet, so nothing here offers to send it again. Watch the board — a launch that is slow is still a launch.',
    retryable: false,
  }),
  unknown: (message) => ({
    kind: 'unknown',
    hint: message,
    retryable: true,
  }),
}

/**
 * Which of the six failures this is, from the sentence the SDK produced.
 *
 * Matching on message text is not lovely and it is the honest option: `KeiError`
 * codes cover the SDK's own refusals and the interesting ones here come back
 * from the node as prose inside a `node-error`. The rule that keeps it safe is
 * the fallback — an unrecognised message is reported verbatim as `unknown`
 * rather than guessed into a category, so a wrong classification is a missing
 * one rather than a misleading one.
 */
export function classify(message: string): Recovery {
  const text = message.toLowerCase()

  if (/transfer policy|cannot be transferred|soulbound|issuer-only|not permitted/.test(text)) {
    return RECOVERIES.refused(message)
  }
  // Checked before the network rules below, because "was paid for and has not
  // appeared" contains words that would otherwise read as a retryable timeout —
  // and a retried launch is a second fee.
  if (/was paid for|already paid|not refundable/.test(text)) {
    return RECOVERIES.paid(message)
  }
  if (/already (been )?(accepted|cancelled|settled|consumed)|no longer open|not open|unknown offer/.test(text)) {
    return RECOVERIES.gone(message)
  }
  if (/receivable|not yet received|sync/.test(text)) {
    return RECOVERIES.sync(message)
  }
  if (/not enough|insufficient|balance is|too little/.test(text)) {
    return RECOVERIES.fund(message)
  }
  if (/could not reach|unreachable|network|timed out|timeout|fetch failed|answered 5\d\d/.test(text)) {
    return RECOVERIES.retry(message)
  }
  return RECOVERIES.unknown(message)
}

/** A new record, in the only phase a signature starts in. */
export function begin(id: number, kind: TxKind, what: string, now: number, attempts = 1): Tx {
  return { id, kind, what, phase: 'signing', at: now, problem: null, recovery: null, attempts }
}

/**
 * Advance a record, without letting it go backwards.
 *
 * `done` and `failed` are terminal: a late poll landing after a failure must not
 * repaint it as settling, which is exactly what happens when the refresh that
 * follows an error is allowed to write a phase.
 */
export function advance(tx: Tx, phase: TxPhase, now: number): Tx {
  if (tx.phase === 'done' || tx.phase === 'failed') return tx
  if (tx.phase === phase) return tx
  return { ...tx, phase, at: now }
}

export function fail(tx: Tx, message: string, now: number): Tx {
  return { ...tx, phase: 'failed', at: now, problem: message, recovery: classify(message) }
}

/** True while this browser is waiting on something it signed. */
export function pending(tx: Tx): boolean {
  return tx.phase === 'signing' || tx.phase === 'settling'
}

/**
 * Whether offering a "try again" is honest for this record.
 *
 * Two conditions, and the second is the one that is easy to forget: a launch is
 * never retryable from here whatever went wrong, because the first half of it
 * sends a fee and the second half waits for a coin. Re-running that pays twice,
 * and the fee buys a burn, which is not reversible. Every other action on this
 * site either signs one block or signs none.
 */
export function retryable(tx: Tx): boolean {
  return tx.phase === 'failed' && tx.recovery?.retryable === true && tx.kind !== 'launch'
}

/**
 * How long a finished record stays in the tray.
 *
 * A failure outlives a success by a factor of five, because a success is
 * confirmed by the balance moving and a failure is only ever confirmed by
 * somebody reading it. A refusal that scrolled away in four seconds is a demo
 * that looks like it silently did nothing.
 */
export const KEEP_DONE_MS = 6_000
export const KEEP_FAILED_MS = 30_000

export function expired(tx: Tx, now: number): boolean {
  if (tx.phase === 'done') return now - tx.at > KEEP_DONE_MS
  if (tx.phase === 'failed') return now - tx.at > KEEP_FAILED_MS
  return false
}

/** Drop what has been on screen long enough, keeping the rest in order. */
export function prune(log: readonly Tx[], now: number): Tx[] {
  return log.filter((tx) => !expired(tx, now))
}

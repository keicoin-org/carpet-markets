/**
 * Whether the numbers on screen are still being read, said out loud.
 *
 * The page polls every two seconds and every panel renders the last good answer.
 * That is the right behaviour — a book that blanks for one failed read and comes
 * back is worse than one that is two seconds old — but on its own it is also the
 * quietest possible failure: a page that has stopped reading the chain entirely
 * looks *exactly* like a page where nothing is happening, and on a market screen
 * those are opposite facts. Until this file existed the only record of a failed
 * poll was a `console.warn` nobody has open.
 *
 * So the feed has a state, it is derived from what actually came back, and the
 * bar renders it beside the chain badge. The badge answers "which ledger is this"
 * and this answers "and are we still talking to it" — both are chain truth and
 * neither is guessable from the figures themselves.
 *
 * The levels are thresholds on one number, the age of the last good read, plus a
 * consecutive-failure count so that three refusals in a row are called out
 * before the age alone would notice.
 *
 * Nothing here touches React, the network, or the clock unless it is handed one.
 */

const POLL_MS = 2_000

/** Two missed polls is a blip; this is where it stops being one. */
const LAGGING_AFTER = 3 * POLL_MS

/** Consecutive failures that mean the connection rather than the request. */
const DOWN_AFTER_FAILURES = 3

/** No good read for this long is down whatever the failure count says. */
const DOWN_AFTER = 12 * POLL_MS

export interface FeedState {
  /** When a read last came back whole. Null before the first one. */
  lastGoodAt: number | null
  /** Reads that have failed since the last good one. */
  failures: number
  /** What the most recent failure said, for the sentence. Null if none since. */
  lastError: string | null
}

export const FEED_OPENING: FeedState = { lastGoodAt: null, failures: 0, lastError: null }

/** A read came back whole. */
export function fed(state: FeedState, at: number): FeedState {
  return { lastGoodAt: at, failures: 0, lastError: null }
}

/**
 * A read did not come back.
 *
 * `lastGoodAt` is deliberately untouched: the figures on screen are still the
 * ones from that moment, and the age the bar reports has to be the age of what
 * is being *shown*, not of the last attempt to replace it.
 */
export function starved(state: FeedState, why: string): FeedState {
  return { lastGoodAt: state.lastGoodAt, failures: state.failures + 1, lastError: why }
}

export type FeedLevel = 'opening' | 'live' | 'lagging' | 'down'

export interface FeedStatus {
  level: FeedLevel
  /** Milliseconds since the last whole read, or null before the first one. */
  ageMs: number | null
  /** The bar's label. Two or three words. */
  label: string
  /** One sentence, complete on its own, for the tooltip and the tests. */
  sentence: string
}

/**
 * What to say about the feed right now.
 *
 * `opening` is separated from `down` on purpose. A page that has never had an
 * answer and a page that has stopped getting them need different sentences, and
 * calling the first one down for the two seconds before the first poll lands
 * would make every cold load flash a failure.
 */
export function feedStatus(state: FeedState, now: number): FeedStatus {
  if (state.lastGoodAt === null) {
    if (state.failures >= DOWN_AFTER_FAILURES) {
      return {
        level: 'down',
        ageMs: null,
        label: 'not reading',
        sentence: `Nothing has been read from the chain yet — ${state.failures} attempts have failed${
          state.lastError ? `, most recently: ${state.lastError}` : ''
        }. Every figure on this page is missing rather than zero.`,
      }
    }
    return {
      level: 'opening',
      ageMs: null,
      label: 'opening',
      sentence: 'Opening a wallet and reading the board for the first time.',
    }
  }

  const ageMs = Math.max(0, now - state.lastGoodAt)

  if (state.failures >= DOWN_AFTER_FAILURES || ageMs >= DOWN_AFTER) {
    return {
      level: 'down',
      ageMs,
      label: 'not reading',
      sentence: `The chain has not answered for ${seconds(ageMs)}. Everything on screen is from then, and nothing you have signed is affected by a failed read — the poll keeps trying.${
        state.lastError ? ` Last error: ${state.lastError}` : ''
      }`,
    }
  }

  if (state.failures > 0 || ageMs >= LAGGING_AFTER) {
    return {
      level: 'lagging',
      ageMs,
      label: 'lagging',
      sentence: `The last whole read was ${seconds(ageMs)} ago${
        state.failures > 0 ? ` and ${state.failures} since then did not come back` : ''
      }. These figures are that old.`,
    }
  }

  return {
    level: 'live',
    ageMs,
    label: 'live',
    sentence: `Read from the chain ${seconds(ageMs)} ago, and again every two seconds.`,
  }
}

/** "just now", "4s", "2m" — the age of a figure, not a duration to reason about. */
function seconds(ms: number): string {
  const whole = Math.round(ms / 1000)
  if (whole <= 1) return 'a moment'
  if (whole < 90) return `${whole}s`
  return `${Math.round(whole / 60)}m`
}

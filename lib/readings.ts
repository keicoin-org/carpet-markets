/**
 * A number that might not exist, and the difference between the ways it might not.
 *
 * SPEC §9.6 criterion 4 asks for an explicit "no trades yet" rather than a zero
 * or an empty chart, because a coin nobody has traded has no price and printing
 * `0` for it is a claim about the market rather than a gap in it. The rule is
 * easy to state and impossible to hold by hand: every panel that renders a
 * figure has to remember, at its own call site, which of its figures are counts
 * that can honestly be zero and which are absences wearing a zero's clothes.
 * This repository already got that wrong twice — trades and holders both read a
 * bare `0` on a coin that had never traded, on a page whose whole argument is
 * that it does not invent numbers.
 *
 * So the distinction is a type rather than a discipline. A reading is one of
 * three things and a renderer has to handle all three:
 *
 *   pending  the chain has not answered yet. Not zero, not absent — unknown, and
 *            two seconds old at most.
 *   absent   the chain answered and there is nothing there. Carries the sentence
 *            saying why, because "no trades yet" and "nobody is selling" are
 *            different facts and a shared em-dash would tell you neither.
 *   known    a real value, read off a block somebody signed.
 *
 * Nothing here touches React, the network, or the clock. It is a union and four
 * constructors, so it is tested as arithmetic.
 */

export type Reading<T> =
  | { readonly state: 'pending' }
  | { readonly state: 'absent'; readonly why: string }
  | { readonly state: 'known'; readonly value: T }

/** The chain has not answered yet. */
export const pending = <T>(): Reading<T> => ({ state: 'pending' })

/**
 * The chain answered and there is nothing there.
 *
 * `why` is a sentence rather than a code because it is rendered as one. A panel
 * that has to translate an enum into prose is a panel where the prose lives at
 * the call site, which is the arrangement this file exists to prevent.
 */
export const absent = <T>(why: string): Reading<T> => ({ state: 'absent', why })

export const known = <T>(value: T): Reading<T> => ({ state: 'known', value })

/**
 * A count that is allowed to be zero, and one that is not.
 *
 * The honest test for which is whether zero is an observation or the absence of
 * one. "Two people hold this" and "nobody holds this" are both observations of a
 * chain that answered; "this has never traded" is not an observation of zero
 * trades, it is the reason the price panel has nothing to say. Pass the sentence
 * for the second case and this picks.
 */
export function counted(value: number, whenZero: string): Reading<number> {
  return value > 0 ? known(value) : absent(whenZero)
}

/** Map a known reading, leaving pending and absent alone. */
export function mapReading<T, U>(reading: Reading<T>, project: (value: T) => U): Reading<U> {
  return reading.state === 'known' ? known(project(reading.value)) : reading
}

/** The value, or a fallback. For sorting and arithmetic, never for display. */
export function valueOr<T>(reading: Reading<T>, fallback: T): T {
  return reading.state === 'known' ? reading.value : fallback
}

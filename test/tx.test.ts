/**
 * What a signature does after it leaves, and what the page offers about it.
 *
 * Two things here would cost somebody money if they were wrong.
 *
 * The first is classification. A ledger refusal is not an outage — "this coin
 * cannot be transferred" is the demo working — and offering a retry button under
 * it would teach people that the policy is a glitch. The second is the launch
 * rule: a launch pays a fee and then waits for a coin, so re-running it pays
 * twice, and the fee buys a burn that cannot be reversed.
 */

import { expect, test } from 'bun:test'
import { assertMatches, type Offer } from 'kei-transaction'

import {
  advance,
  begin,
  classify,
  expired,
  fail,
  KEEP_DONE_MS,
  KEEP_FAILED_MS,
  pending,
  prune,
  retryable,
  type Tx,
} from '../lib/tx.js'

const NOW = 1_700_000_000_000

const started = (kind: Tx['kind'] = 'buy'): Tx => begin(1, kind, 'Buying 1,000 CARPET', NOW)

// ------------------------------------------------------------------- the phases

test('a signature starts as signing and nothing has left the browser', () => {
  const tx = started()
  expect(tx.phase).toBe('signing')
  expect(pending(tx)).toBe(true)
  expect(tx.attempts).toBe(1)
})

test('settling is not done, because only a read makes a trade a fact', () => {
  const out = advance(started(), 'settling', NOW + 10)
  expect(out.phase).toBe('settling')
  expect(pending(out)).toBe(true)

  const seen = advance(out, 'done', NOW + 20)
  expect(seen.phase).toBe('done')
  expect(pending(seen)).toBe(false)
})

test('a terminal record cannot be repainted by a late poll', () => {
  // The refresh that follows an error is allowed to land after it. If it could
  // write a phase, a refusal would flicker back to "settling" and then sit there
  // forever, which reads as a trade that is still going through.
  const broken = fail(started(), 'The asset’s transfer policy does not permit this move', NOW)
  expect(advance(broken, 'settling', NOW + 5)).toBe(broken)
  expect(advance(broken, 'done', NOW + 5)).toBe(broken)

  const settled = advance(advance(started(), 'settling', NOW), 'done', NOW + 1)
  expect(advance(settled, 'signing', NOW + 2)).toBe(settled)
})

// ------------------------------------------------------------- classifying them

test('a policy refusal is permanent and never offers a retry', () => {
  for (const message of [
    'The asset’s transfer policy does not permit this move',
    'This coin cannot be transferred.',
    'transfer: none — soulbound',
    'Moving this is not permitted by the issuer-only policy.',
  ]) {
    const recovery = classify(message)
    expect(recovery.kind).toBe('refused')
    expect(recovery.retryable).toBe(false)
  }
})

test('a lost accept/cancel race is somebody else winning, not a failure to try harder', () => {
  const recovery = classify('That offer has already been accepted.')
  expect(recovery.kind).toBe('gone')
  expect(recovery.retryable).toBe(false)
  expect(recovery.hint).toMatch(/nothing left your wallet/i)
})

test('an offer that is not the one on screen is named, and never offers a retry', () => {
  // The SDK's own sentence rather than one this test wrote, so a change to its
  // wording fails here instead of quietly falling through to `unknown` — which
  // would put a "Try again" button under the one refusal that must not have one.
  const message = refusal({ want: { asset: 'kei', symbol: 'KEI', name: 'Kei', decimals: 18, amount: 40 } })

  const recovery = classify(message)
  expect(recovery.kind).toBe('changed')
  expect(recovery.retryable).toBe(false)
  expect(recovery.hint).toMatch(/nothing was signed/i)
  // Both numbers, which is what makes it a refusal somebody can act on.
  expect(message).toContain('shown as 4')
  expect(message).toContain('the chain says 40')
})

/** The message `market.accept` throws when the chain disagrees with the screen. */
function refusal(chain: Partial<Offer>): string {
  const shown = {
    hash: 'F'.repeat(64),
    from: 'kei_seller',
    give: { asset: 'asset-carpet', symbol: 'CARPET', name: 'Carpet', decimals: 0, amount: 1_000 },
    want: { asset: 'kei', symbol: 'KEI', name: 'Kei', decimals: 18, amount: 4 },
    to: null,
  } as Offer

  try {
    assertMatches({ ...shown, ...chain }, { ...shown, seller: shown.from })
    throw new Error('The SDK accepted terms that had moved.')
  } catch (error) {
    return (error as Error).message
  }
}

test('an unsettled receivable is told apart from an empty wallet', () => {
  expect(classify('That is still a receivable and has not been received yet.').kind).toBe('sync')
  expect(classify('Not enough Kei — balance is 0.4, tried to send 1.2.').kind).toBe('fund')
})

test('an unreachable node is the one failure that is purely retryable', () => {
  const recovery = classify('Could not reach the Kei node at https://testnet.keicoin.org/rpc.')
  expect(recovery.kind).toBe('retry')
  expect(recovery.retryable).toBe(true)
})

test('an unrecognised message is reported verbatim rather than guessed at', () => {
  const recovery = classify('Something nobody has seen before happened.')
  expect(recovery.kind).toBe('unknown')
  expect(recovery.hint).toBe('Something nobody has seen before happened.')
})

test('"was paid for" is classified as paid before it can look like a timeout', () => {
  // It contains none of the network words on purpose, but it is the message a
  // slow launch produces and a retry of it is a second, unrefundable fee.
  const recovery = classify('WAGMI was paid for and has not appeared on the board yet.')
  expect(recovery.kind).toBe('paid')
  expect(recovery.retryable).toBe(false)
})

// ----------------------------------------------------------------- the retry rule

test('a failed launch is never retryable, whatever went wrong', () => {
  // The half that already ran sent the fee. Every other action here signs one
  // block or none, so this is the only kind that needs the extra guard.
  const broken = fail(started('launch'), 'Could not reach the Kei node.', NOW)
  expect(broken.recovery?.retryable).toBe(true)
  expect(retryable(broken)).toBe(false)
})

test('a failed buy on an unreachable node is retryable', () => {
  expect(retryable(fail(started('buy'), 'Could not reach the Kei node.', NOW))).toBe(true)
})

test('nothing that is still running offers a retry', () => {
  expect(retryable(started())).toBe(false)
  expect(retryable(advance(started(), 'settling', NOW))).toBe(false)
  expect(retryable(advance(advance(started(), 'settling', NOW), 'done', NOW))).toBe(false)
})

// -------------------------------------------------------------- what stays on screen

test('a refusal outlives a success, because only one of them is confirmed elsewhere', () => {
  const settled = advance(advance(started(), 'settling', NOW), 'done', NOW)
  const broken = fail(started(), 'Nope.', NOW)

  expect(expired(settled, NOW + KEEP_DONE_MS - 1)).toBe(false)
  expect(expired(settled, NOW + KEEP_DONE_MS + 1)).toBe(true)
  expect(expired(broken, NOW + KEEP_DONE_MS + 1)).toBe(false)
  expect(expired(broken, NOW + KEEP_FAILED_MS + 1)).toBe(true)
  expect(KEEP_FAILED_MS).toBeGreaterThan(KEEP_DONE_MS)
})

test('nothing in flight is ever pruned, however long it takes', () => {
  const waiting = advance(started(), 'settling', NOW)
  expect(expired(waiting, NOW + KEEP_FAILED_MS * 10)).toBe(false)
  expect(prune([waiting], NOW + KEEP_FAILED_MS * 10)).toHaveLength(1)
})

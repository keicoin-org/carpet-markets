/**
 * The demo's known holes, as a registry, so each one can be shown where it bites.
 *
 * SPEC §9.6 criterion 9: *each of the demo's known holes — the account-list-bounded
 * book, one open quote per address, off-chain replies — is stated on the screen
 * where it bites, not only in the README.* The README states all of them well and
 * nobody reading the order book is reading the README, which is the point of the
 * criterion.
 *
 * A registry rather than a paragraph in each component, for the reason every
 * other registry here exists: a caveat written inline is a caveat that drifts
 * from the one in the README and from the one two panels over, and there is no
 * way to check that the set is complete. Here the set is a list,
 * `test/caveats.test.ts` asserts that every entry has a render site in the
 * client, and the honest failure mode is a test going red rather than a hole
 * quietly losing its sentence.
 *
 * These are limits of *this demo*, not of the chain. Where a limit is the chain's
 * — no indexer, no consensus clock — the entry says which spec section decided it,
 * because "we did not build that" and "that is deliberately not there" are
 * different admissions and only one of them is a defect.
 */

export type CaveatId =
  | 'account-list'
  | 'one-quote'
  | 'off-chain-replies'
  | 'node-local-time'
  | 'ephemeral-ledger'
  | 'unmatched-payments'

export interface Caveat {
  id: CaveatId
  /** The screen or panel this belongs beside. For the reader, and for the test. */
  bites: string
  /** The inline sentence. Complete on its own; this is what actually renders. */
  says: string
  /** Which decision it follows from, or null where it is this demo's own limit. */
  spec: string | null
}

export const CAVEATS: readonly Caveat[] = [
  {
    id: 'account-list',
    bites: 'the board, the order book, the holders table and the activity strip',
    says:
      'This book is as complete as the registry’s list of accounts to read. An offer written by a wallet that never announced itself is perfectly valid, settles perfectly well, and is not here — which is what it means for a chain to ship no indexer.',
    spec: 'SPEC §9.4',
  },
  {
    id: 'one-quote',
    bites: 'the launch screen',
    says:
      'The registry holds one open quote per address, because a Kei transfer carries no memo and an arriving payment says only who sent it and how much. Two tabs launching at once is a thing you can do to yourself; the honest fix is a memo field in the wire format, not a cleverer guess on this side.',
    spec: null,
  },
  {
    id: 'off-chain-replies',
    bites: 'the replies tab',
    says:
      'Replies are the only thing here that is not on the chain. The registry stores them and the registry can lose them. What they carry is a signature from the same key that signs their author’s blocks — so nobody can post as the creator — which is a strictly weaker claim than a block makes.',
    spec: null,
  },
  {
    id: 'node-local-time',
    bites: 'the price chart and the trade log',
    says:
      'The times on these are the node’s own first-seen clock, not consensus. A block-lattice has no clock, so every figure derived from the blocks themselves — median, range, volume, count — is identical on every node, and the order they are drawn in is not.',
    spec: 'SPEC §5.5',
  },
  {
    id: 'ephemeral-ledger',
    bites: 'the empty board and the network panel',
    says:
      'On the mock chain the whole ledger lives in the process serving this page. Stop it and every coin on it is gone, so an empty board usually means it restarted rather than that nobody has been here.',
    spec: null,
  },
  {
    id: 'unmatched-payments',
    bites: 'the launch screen',
    says:
      'Kei sent to the registry answering no quote stays there. Reflexively refunding whoever sends money would make it return its own working capital to the faucet on startup.',
    spec: null,
  },
]

const BY_ID = new Map(CAVEATS.map((caveat) => [caveat.id, caveat]))

export function caveat(id: CaveatId): Caveat {
  const found = BY_ID.get(id)
  if (!found) throw new Error(`No caveat is registered as "${id}".`)
  return found
}

/**
 * Replies, and the one thing that keeps them honest.
 *
 * Everything else in this example is on the chain, and saying so is most of the
 * point. This is not. A reply thread is a comment box: the registry stores it,
 * and on the deployed mock its signed input is replayed with the rest of the
 * Durable Object event log. No block is written and no consensus is reached about whether
 * somebody thinks a coin is going to zero.
 *
 * What *is* worth having is authorship. A launchpad where anybody can post as
 * anybody is a launchpad where the creator's "I am not selling" was written by
 * somebody else, so a reply carries a signature from the same key that signs the
 * poster's blocks. The registry verifies it before storing and refuses the rest.
 * That is a strictly weaker claim than a block — it proves who wrote it, not
 * that the network agreed it happened — and the UI says so rather than letting
 * the signature imply more than it is.
 *
 * The scheme copies `hashBlock`'s local-preamble shape from `@keicoin/core`: a
 * domain string, a newline, and the canonical JSON of the fields being covered.
 * The preamble is what stops a signature collected here from ever being replayed
 * as something else, which is the entire reason it is not just the body bytes.
 */

import { blake2b, bytesToHex, canonicalJson, utf8 } from '@keicoin/core'

/** Bumped if the covered fields ever change, so old signatures stop verifying. */
const PREAMBLE = 'carpet-reply-v1'

export const REPLY_MAX = 500

export interface Reply {
  id: string
  asset: string
  /** A `kei_` address, proven by the signature — not claimed. */
  author: string
  body: string
  /** Milliseconds since the epoch, chosen by the author and covered by the hash. */
  at: number
}

/** What a reply's signature covers. Identical on both sides or nothing verifies. */
export function replyHash(input: { asset: string; body: string; at: number }): string {
  const covered = { asset: input.asset, at: input.at, body: input.body }
  return bytesToHex(blake2b(utf8(`${PREAMBLE}\n${canonicalJson(covered)}`), 32))
}

export class ReplyError extends Error {}

/**
 * A reply's text, cleaned, or an error a person can act on.
 *
 * Run before the signature is checked on the server and before it is made on the
 * client, so both sides hash the same string. Trimming after signing would be a
 * signature over text nobody stored.
 */
export function cleanReply(input: unknown): string {
  const body = String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (body.length === 0) throw new ReplyError('A reply needs some text in it.')
  if (body.length > REPLY_MAX) {
    throw new ReplyError(`A reply is ${REPLY_MAX} characters at most; that one is ${body.length}.`)
  }
  return body
}

/**
 * How far out of step with the registry a reply's own timestamp may be.
 *
 * The timestamp is the author's, because it is covered by their signature and
 * the registry's clock is not. Bounding it stops a stored reply from claiming to
 * have been written next year, which is the only thing the freedom buys an
 * attacker.
 */
export const REPLY_CLOCK_SKEW_MS = 5 * 60_000

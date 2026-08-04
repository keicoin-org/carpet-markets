/**
 * The reply threads. The only state in this project that is not a block.
 *
 * `server/registry.ts` goes to some trouble to be an index rather than an
 * oracle: everything it reports about a coin is read back off the chain and
 * would be identical if you read it yourself. This file is the exception, and
 * keeping it in a file of its own is the point — a reader who wants to know what
 * Carpet Markets is trusted for can read this one and stop.
 *
 * It is trusted for exactly two things: remembering the text, and putting it in
 * order. It is not trusted for authorship, because it verifies that
 * (`shared/social.ts` explains the scheme), and it is not trusted for anything
 * about a price, because it never sees one.
 *
 * They are in-memory here. The Worker persists their validated inputs in its
 * event log and rebuilds them after eviction; the local Bun server does not.
 */

import { publicKeyFromAddress, verifyHash } from '@keicoin/core'

import {
  cleanReply,
  replyHash,
  ReplyError,
  REPLY_CLOCK_SKEW_MS,
  type Reply,
} from '../shared/social.js'

/**
 * How many replies a coin keeps.
 *
 * A cap rather than a rate limit, because the thing being defended is a Durable
 * Object's memory and not anybody's feelings. Oldest go first, so a thread reads
 * as the last hundred things said rather than the first hundred.
 */
const PER_COIN = 100

/**
 * How long a signed reply stays acceptable.
 *
 * Signatures do not expire on their own, so without this a reply captured from
 * the wire could be posted again forever. Together with the id check below it
 * makes a replay either a duplicate the store already has or too old to take.
 */
const FRESH_MS = 10 * 60_000

export interface PostReply {
  asset: string
  author: string
  body: string
  at: number
  signature: string
}

export class Threads {
  readonly #byAsset = new Map<string, Reply[]>()
  readonly #seen = new Set<string>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Newest last, which is the order a thread is read in. */
  list(asset: string): Reply[] {
    return [...(this.#byAsset.get(asset) ?? [])]
  }

  count(asset: string): number {
    return this.#byAsset.get(asset)?.length ?? 0
  }

  /**
   * Verify a reply and keep it, or refuse it with a reason.
   *
   * The body is cleaned *before* the hash is checked because the client cleaned
   * it before signing. Cleaning after would hash a different string than the one
   * that was signed and reject every honest reply, which is a bug worth naming
   * because it looks exactly like a broken signature when it happens.
   */
  async add(input: PostReply): Promise<Reply> {
    const body = cleanReply(input.body)
    const author = String(input.author ?? '')
    if (!author.startsWith('kei_')) throw new ReplyError('A reply needs the address that signed it.')

    const at = Number(input.at)
    if (!Number.isFinite(at)) throw new ReplyError('That reply has no timestamp.')

    const age = this.now() - at
    if (age > FRESH_MS) throw new ReplyError('That reply was signed too long ago to post now.')
    if (age < -REPLY_CLOCK_SKEW_MS) throw new ReplyError('That reply is dated in the future.')

    const hash = replyHash({ asset: input.asset, body, at })

    let ok = false
    try {
      ok = await verifyHash(hash, String(input.signature ?? ''), publicKeyFromAddress(author))
    } catch {
      // A malformed address or signature lands here rather than throwing out of
      // the request. Both mean the same thing to whoever posted it.
      ok = false
    }
    if (!ok) throw new ReplyError('That reply is not signed by the account it claims to be from.')

    // The hash covers the author's own timestamp, so two identical replies a
    // millisecond apart are two ids and a resend of one is caught here.
    const id = `${hash.slice(0, 32)}`
    if (this.#seen.has(id)) throw new ReplyError('That reply has already been posted.')
    this.#seen.add(id)

    const reply: Reply = { id, asset: input.asset, author, body, at }
    const thread = this.#byAsset.get(input.asset) ?? []
    thread.push(reply)
    thread.sort((a, b) => a.at - b.at)
    while (thread.length > PER_COIN) {
      const dropped = thread.shift()
      if (dropped) this.#seen.delete(dropped.id)
    }
    this.#byAsset.set(input.asset, thread)
    return reply
  }
}

export { ReplyError }

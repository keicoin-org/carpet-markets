/**
 * The reply threads, and the one claim they make.
 *
 * Replies are the only state in this project that is not a block, so the thing
 * worth testing is exactly what the panel in the UI says it is: not that a reply
 * happened — the registry is simply trusted to remember that — but that the
 * account named on one actually wrote it.
 *
 * A launchpad is the specific place where that matters. "dev said he's not
 * selling" is load-bearing in this genre, and a comment box where anybody can
 * type any address is a comment box where the creator's promise can be authored
 * by whoever wants the price to move. Every test below is a way of trying to
 * post as somebody else.
 */

import { beforeAll, expect, test } from 'bun:test'
import { keyPairFromSeed, signHash, type KeyPair } from '@keicoin/core'
import { randomSeed } from 'kei-transaction'

import { cleanReply, replyHash, REPLY_MAX, ReplyError } from '../shared/social.js'
import { Threads } from '../server/social.js'

const ASSET = 'A'.repeat(64)

let alice: KeyPair
let mallory: KeyPair

beforeAll(async () => {
  alice = await keyPairFromSeed(randomSeed(), 0)
  mallory = await keyPairFromSeed(randomSeed(), 0)
})

/** What an honest client sends. */
async function signed(keys: KeyPair, body: string, at = Date.now(), asset = ASSET) {
  const text = cleanReply(body)
  return {
    asset,
    author: keys.address,
    body: text,
    at,
    signature: await signHash(keys.privateKey, replyHash({ asset, body: text, at })),
  }
}

test('a reply signed by its author is kept, and comes back in the thread', async () => {
  const threads = new Threads()
  const posted = await threads.add(await signed(alice, 'holding, for now'))

  expect(posted.author).toBe(alice.address)
  expect(posted.body).toBe('holding, for now')
  expect(threads.list(ASSET)).toHaveLength(1)
  expect(threads.count(ASSET)).toBe(1)
})

test('a reply claiming somebody else’s address is refused', async () => {
  const threads = new Threads()
  const forged = { ...(await signed(mallory, 'I am definitely not selling')), author: alice.address }

  await expect(threads.add(forged)).rejects.toThrow(ReplyError)
  expect(threads.count(ASSET)).toBe(0)
})

test('editing the body after signing invalidates it', async () => {
  const threads = new Threads()
  const tampered = { ...(await signed(alice, 'selling everything today')), body: 'never selling' }

  await expect(threads.add(tampered)).rejects.toThrow(ReplyError)
})

test('moving a signed reply onto another coin invalidates it', async () => {
  // The asset is covered by the hash precisely so a reply cannot be lifted from
  // one thread and replayed under a coin its author never mentioned.
  const threads = new Threads()
  const moved = { ...(await signed(alice, 'this one looks fine')), asset: 'B'.repeat(64) }

  await expect(threads.add(moved)).rejects.toThrow(ReplyError)
})

test('the same reply cannot be posted twice', async () => {
  const threads = new Threads()
  const once = await signed(alice, 'first')

  await threads.add(once)
  await expect(threads.add(once)).rejects.toThrow(ReplyError)
  expect(threads.count(ASSET)).toBe(1)
})

test('a reply signed long ago is too old to post now', async () => {
  const threads = new Threads()
  const stale = await signed(alice, 'yesterday', Date.now() - 60 * 60_000)

  await expect(threads.add(stale)).rejects.toThrow(ReplyError)
})

test('a reply dated in the future is refused', async () => {
  const threads = new Threads()
  const ahead = await signed(alice, 'next week', Date.now() + 60 * 60_000)

  await expect(threads.add(ahead)).rejects.toThrow(ReplyError)
})

test('an empty reply is refused, and an oversized one is refused', () => {
  expect(() => cleanReply('   ')).toThrow(ReplyError)
  expect(() => cleanReply('x'.repeat(REPLY_MAX + 1))).toThrow(ReplyError)
})

test('cleaning collapses whitespace, and both sides hash the cleaned text', async () => {
  // The server cleans before it verifies. If a client signed the raw text
  // instead, every reply with a double space in it would look like a forgery.
  const threads = new Threads()
  const posted = await threads.add(await signed(alice, '  spaced   out  '))

  expect(posted.body).toBe('spaced out')
})

test('threads are kept apart by coin', async () => {
  const threads = new Threads()
  const other = 'C'.repeat(64)

  await threads.add(await signed(alice, 'about the first'))
  await threads.add(await signed(alice, 'about the second', Date.now(), other))

  expect(threads.count(ASSET)).toBe(1)
  expect(threads.count(other)).toBe(1)
  expect(threads.list(other)[0]?.body).toBe('about the second')
})

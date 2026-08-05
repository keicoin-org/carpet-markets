/**
 * Fill a fresh board, so there is something to look at.
 *
 * The mock chain starts empty every run, and an empty launchpad is a bad way to
 * find out what a launchpad looks like — the interesting states here are a coin
 * mid-distribution, a book with two sides, and a creator visibly working through
 * their position. None of those exist until somebody makes them.
 *
 * This is not a fixture and nothing it writes is special: it opens ordinary
 * wallets, pays ordinary launch fees, and writes ordinary `swap_offer` blocks
 * that anybody could have written. The registry cannot tell these apart from a
 * visitor, which is the point — if it could, the board would be showing
 * something other than what it claims to show.
 *
 *   bun run seed                       # against `bun run dev` on :7788
 *   bun run scripts/seed.ts --api http://localhost:7788
 */

import { keyPairFromSeed, signHash } from '@keicoin/core'
import { Kei, randomSeed } from 'kei-transaction'

import { cleanReply, replyHash } from '../shared/social.js'
import { DEMO_BOARD } from '../shared/demo-board.js'
import type { LaunchQuote, MarketFacts } from '../shared/listing.js'

const argv = Bun.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

const API = (flag('api') ?? 'http://localhost:7788').replace(/\/$/, '')
const RPC = `${API}/rpc`

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const answer = (await response.json()) as { error?: string } & T
  if (!response.ok) throw new Error(answer.error ?? `${path} answered ${response.status}`)
  return answer
}

async function wallet(kei = 60): Promise<Kei> {
  const seed = randomSeed()
  const opened = await Kei.server({ seed, node: RPC, network: 'mock' })
  await opened.faucet(kei)
  await opened.sync()
  await api('/market/watch', { address: opened.address })
  return opened
}

/** Sign a reply the way the client does, so the registry accepts it. */
async function say(who: Kei, seed: string, asset: string, text: string): Promise<void> {
  const body = cleanReply(text)
  const at = Date.now()
  const pair = await keyPairFromSeed(seed, 0)
  const signature = await signHash(pair.privateKey, replyHash({ asset, body, at }))
  await api('/market/reply', { asset, author: who.address, body, at, signature })
}

async function listedAs(symbol: string): Promise<string> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const facts = await api<MarketFacts>('/market/facts')
    const found = facts.listings.find((listing) => listing.symbol === symbol)
    if (found) return found.asset
    if (Date.now() > deadline) throw new Error(`${symbol} never appeared on the board.`)
    await Bun.sleep(250)
  }
}

console.log(`\n  Seeding ${API} — six coins, and a market between them.\n`)

// One creator per coin, so the board is not one account's diary, and two traders
// who take the other side of everything.
const buyerSeed = randomSeed()
const buyer = await Kei.server({ seed: buyerSeed, node: RPC, network: 'mock' })
await buyer.faucet(400)
await buyer.sync()
await api('/market/watch', { address: buyer.address })

for (const plan of DEMO_BOARD) {
  const creatorSeed = randomSeed()
  const creator = await Kei.server({ seed: creatorSeed, node: RPC, network: 'mock' })
  await creator.faucet(60)
  await creator.sync()
  await api('/market/watch', { address: creator.address })

  const quote = await api<LaunchQuote>('/market/launch', {
    address: creator.address,
    symbol: plan.symbol,
    name: plan.name,
    blurb: plan.blurb,
    transfer: plan.transfer,
  })
  await creator.pay({ to: quote.to, amount: quote.fee })

  const asset = await listedAs(plan.symbol)
  await creator.sync()

  const written: string[] = []
  for (const ask of plan.asks) {
    const offer = await creator.market.sell({ asset, amount: ask.units, price: ask.units * ask.each })
    written.push(offer.hash)
  }

  for (const hash of written.slice(0, plan.filled)) {
    await buyer.market.accept(hash)
    await buyer.sync()
  }

  for (const bid of plan.bids) {
    await buyer.market.bid({ asset, amount: bid.units, price: bid.units * bid.each })
  }

  for (const text of plan.replies) {
    // Half from the creator, half from the buyer, so the "creator" badge on the
    // thread has something to distinguish itself from.
    const fromCreator = plan.replies.indexOf(text) % 2 === 0
    await say(fromCreator ? creator : buyer, fromCreator ? creatorSeed : buyerSeed, asset, text)
  }

  console.log(
    `  ${plan.symbol.padEnd(9)} ${plan.transfer.padEnd(12)} ${written.length} ask(s), ${plan.filled} filled, ${plan.bids.length} bid(s)`,
  )
  creator.close()
}

buyer.close()

const facts = await api<MarketFacts>('/market/facts')
console.log(`\n  ${facts.listings.length} coins listed on ${facts.chain.mode}. Open the client and look at it.\n`)

/** Deterministic public-demo bootstrap, replayed from Durable Object storage. */

import { keyPairFromSeed, signHash, type KeiNode } from '@keicoin/core'
import { Kei } from 'kei-transaction'

import type { Registry } from './registry.js'
import { Threads } from './social.js'
import type { TransferPolicy } from '../shared/listing.js'
import { cleanReply, replyHash } from '../shared/social.js'

export const DEMO_REGISTRY_SEED = 'A1'.repeat(32)

interface DemoPlan {
  symbol: string
  name: string
  blurb: string
  transfer: TransferPolicy
  asks: { units: number; each: number }[]
  filled: number
  bids: { units: number; each: number }[]
  replies: string[]
}

const DEMO_PLANS: DemoPlan[] = [
  {
    symbol: 'KILIM',
    name: 'Kilim',
    blurb: 'Flat-woven, reversible, and so is the position.',
    transfer: 'open',
    asks: [
      { units: 40_000, each: 0.0004 },
      { units: 25_000, each: 0.0006 },
      { units: 60_000, each: 0.0011 },
    ],
    filled: 2,
    bids: [{ units: 20_000, each: 0.0003 }],
    replies: ['weaving, not selling', 'the creator has moved 65k units. it is on the chart.'],
  },
  {
    symbol: 'UNDERLAY',
    name: 'Underlay',
    blurb: 'Nobody thinks about it until they are standing on nothing.',
    transfer: 'open',
    asks: [{ units: 300_000, each: 0.00008 }],
    filled: 1,
    bids: [{ units: 50_000, each: 0.00005 }],
    replies: ['300k in one clip. that is a third of the supply.'],
  },
  {
    symbol: 'FRINGE',
    name: 'Fringe',
    blurb: 'The part that frays first.',
    transfer: 'open',
    asks: [{ units: 5_000, each: 0.002 }],
    filled: 0,
    bids: [],
    replies: [],
  },
  {
    symbol: 'WARP',
    name: 'Warp',
    blurb: 'Traded once, and nobody is offering since.',
    transfer: 'open',
    asks: [{ units: 10_000, each: 0.00035 }],
    filled: 1,
    bids: [],
    replies: [],
  },
  {
    symbol: 'HEIRLOOM',
    name: 'Heirloom',
    blurb: 'Soulbound. It cannot be sold, by anybody, including whoever made it.',
    transfer: 'none',
    asks: [],
    filled: 0,
    bids: [],
    replies: ['this one genuinely cannot be dumped on you. the ledger says so.'],
  },
  {
    symbol: 'BAZAAR',
    name: 'Bazaar Credit',
    blurb: 'Issuer-only. Whatever market it has, the issuer is the whole of it.',
    transfer: 'issuer-only',
    asks: [],
    filled: 0,
    bids: [],
    replies: [],
  },
]

const BUYER_SEED = 'B2'.repeat(32)
const CREATOR_SEEDS = ['C3', 'D4', 'E5', 'F6', '07', '18'].map((pair) => pair.repeat(32))

/**
 * Build the same six-coin board from ordinary wallet operations every time.
 * Nothing here bypasses the ledger; deterministic keys only make replay exact.
 */
export async function seedDemo(options: {
  node: KeiNode
  registry: Registry
  threads: Threads
  now: number
}): Promise<void> {
  const buyer = await Kei.server({ seed: BUYER_SEED, node: options.node, network: 'mock' })
  await buyer.faucet(400)
  await buyer.sync()
  options.registry.watch(buyer.address)

  try {
    for (const [index, plan] of DEMO_PLANS.entries()) {
      const seed = CREATOR_SEEDS[index]!
      const creator = await Kei.server({ seed, node: options.node, network: 'mock' })
      try {
        await creator.faucet(60)
        await creator.sync()
        options.registry.watch(creator.address)

        const quote = await options.registry.quoteLaunch(creator.address, plan)
        await creator.pay({ to: quote.to, amount: quote.fee })
        await options.registry.flush()

        const listing = (await options.registry.facts()).listings.find((entry) => entry.symbol === plan.symbol)
        if (!listing) throw new Error(`Deterministic demo launch ${plan.symbol} did not settle.`)

        const asks: string[] = []
        for (const ask of plan.asks) {
          const offer = await creator.market.sell({
            asset: listing.asset,
            amount: ask.units,
            price: ask.units * ask.each,
          })
          asks.push(offer.hash)
        }
        for (const hash of asks.slice(0, plan.filled)) {
          await buyer.market.accept(hash)
          await buyer.sync()
        }
        for (const bid of plan.bids) {
          await buyer.market.bid({ asset: listing.asset, amount: bid.units, price: bid.units * bid.each })
        }

        for (const [replyIndex, text] of plan.replies.entries()) {
          const fromCreator = replyIndex % 2 === 0
          const authorSeed = fromCreator ? seed : BUYER_SEED
          const author = fromCreator ? creator : buyer
          const body = cleanReply(text)
          const at = options.now + index * 100 + replyIndex
          const keys = await keyPairFromSeed(authorSeed, 0)
          const signature = await signHash(keys.privateKey, replyHash({ asset: listing.asset, body, at }))
          await options.threads.add({ asset: listing.asset, author: author.address, body, at, signature })
        }
      } finally {
        creator.close()
      }
    }
  } finally {
    buyer.close()
    options.registry.invalidate()
  }
}

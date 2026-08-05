/** Deterministic public-demo bootstrap, replayed from Durable Object storage. */

import { keyPairFromSeed, signHash, type KeiNode } from '@keicoin/core'
import { Kei } from 'kei-transaction'

import type { Registry } from './registry.js'
import { Threads } from './social.js'
import { DEMO_BOARD } from '../shared/demo-board.js'
import { cleanReply, replyHash } from '../shared/social.js'

export const DEMO_REGISTRY_SEED = 'A1'.repeat(32)

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
    for (const [index, plan] of DEMO_BOARD.entries()) {
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

/**
 * Can a stranger with no prior Kei actually complete a first buy?
 *
 * The board offers "buyable now — somebody has written an offer you could accept
 * this second". That sentence was false on the seeded board: the faucet hands a
 * fresh wallet 25 Kei and the only lot left open on the first buyable coin cost
 * 66, so the affordance the page leads with ended in a refusal (#18). Nothing in
 * the code was wrong — `lib/refusals.ts` reported the shortfall correctly. The
 * two numbers were simply written in different files by different hands and
 * nothing held them together.
 *
 * So this holds them together, at the ledger rather than at the plan. It seeds
 * the real demo board through `seedDemo`, opens a wallet with exactly what the
 * faucet gives, and buys. A test over the plan's arithmetic would have caught
 * the original defect too, but it would not have caught a launch fee or a
 * settlement cost eating the grant on the way, and "the stranger can buy" is a
 * claim about the money that actually leaves the wallet.
 */

import { afterAll, expect, test } from 'bun:test'
import { Kei, MockNode, randomSeed } from 'kei-transaction'

import { seedDemo } from '../server/demo.js'
import { startRegistry, type Registry } from '../server/registry.js'
import { Threads } from '../server/social.js'
import { DEMO_BOARD, lotCost, openAsks } from '../shared/demo-board.js'
import { FAUCET_KEI } from '../shared/faucet.js'
import { KEI_RAW, rawOfKei } from '../shared/format.js'
import { arrange, DEFAULT_QUERY } from '../lib/board.js'
import { coinAmount, keiAmount, type Listing } from '../shared/listing.js'

/**
 * The seeded board, built once.
 *
 * In the test rather than in a `beforeAll` because six launches and their
 * settlements take longer than a hook's timeout, and bun's `beforeAll` takes no
 * timeout to raise.
 */
let built: Promise<{ node: MockNode; registry: Registry }> | undefined

function board(): Promise<{ node: MockNode; registry: Registry }> {
  built ??= (async () => {
    // The grant a visitor gets, not a comfortable test number. That is the whole
    // subject of this file.
    const node = await MockNode.create({ faucetAmount: FAUCET_KEI })
    const registry = await startRegistry({ seed: randomSeed(), node, network: 'mock' })
    await seedDemo({ node, registry, threads: new Threads(), now: Date.now() })
    await registry.flush()
    return { node, registry }
  })()
  return built
}

afterAll(async () => {
  if (built) (await built).registry.close()
})

/**
 * The board as a visitor pressing "buyable now" sees it.
 *
 * Through `arrange` rather than a filter written here, so this is the same set
 * the chip shows. Every coin in it is asserted below, rather than only whichever
 * sorts first: the walk in #18 landed on KILIM, and which coin lands under a
 * first click depends on the order six launches happen to settle in. A promise
 * that holds for the top card and not the second one is not a promise.
 */
const buyable = (listings: readonly Listing[]): Listing[] =>
  arrange(listings, { ...DEFAULT_QUERY, filter: 'buyable' }, new Map())

// ------------------------------------------------------------- the plan itself

test('every coin the board calls buyable has a lot one faucet grant covers', () => {
  // Over the plan, so a future edit to the board's asks is refused here rather
  // than in a browser. A coin with nothing open is not the subject: the chip
  // does not claim it is buyable.
  const offering = DEMO_BOARD.filter((plan) => openAsks(plan).length > 0)
  expect(offering.length).toBeGreaterThan(0)

  for (const plan of offering) {
    const cheapest = Math.min(...openAsks(plan).map(lotCost))
    expect(cheapest).toBeLessThanOrEqual(FAUCET_KEI)
  }
})

// -------------------------------------------------------------- and the ledger

test(
  'one faucet press buys the cheapest lot on every coin the board calls buyable',
  async () => {
    const { node, registry } = await board()
    const listings = buyable((await registry.facts()).listings)
    expect(listings.length).toBeGreaterThan(0)

    for (const listing of listings) {
      // A wallet per coin, each holding exactly one grant, because that is the
      // state the claim is about: no prior Kei, one press, one buy. Reusing a
      // wallet would spend the first purchase's change on the second.
      const stranger = await Kei.start({ node, network: 'mock', seed: randomSeed() })
      try {
        await stranger.faucet(FAUCET_KEI)
        await stranger.sync()
        registry.watch(stranger.address)

        const spendable = BigInt((await node.accountInfo(stranger.address))?.balance ?? '0')
        expect(spendable).toBe(BigInt(FAUCET_KEI) * KEI_RAW)

        const asks = (await registry.book(listing.asset)).asks
        expect(asks.length).toBeGreaterThan(0)

        // Cheapest first, which is the order the panel lists them in, so this is
        // the lot the Buy button is pointing at.
        const lot = asks[0]!
        const cost = rawOfKei(keiAmount(lot, listing.asset))
        if (cost > spendable) {
          throw new Error(
            `${listing.symbol} is on the board as buyable now, and its cheapest lot costs ` +
              `${cost / KEI_RAW} Kei against a ${FAUCET_KEI} Kei faucet grant.`,
          )
        }

        const wanted = coinAmount(lot, listing.asset)
        await stranger.market.accept(lot.hash)
        await stranger.sync()

        expect(await stranger.token(listing.asset).then((token) => token.balance())).toBe(wanted)
      } finally {
        stranger.close()
      }
    }
  },
  180_000,
)

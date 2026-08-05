/**
 * A seller's own open orders, from the click that writes one.
 *
 * SPEC §9.6 criterion 6 wants launch, sell, buy and cancel completable by
 * keyboard, and `bun run walk` stopped at the third of those: after a settled
 * sell the coin screen still read `no open orders`. On the sell side the units
 * in that order are locked by the `swap_offer` block until a cancel block lands
 * (SPEC §9.2), and this panel is the only route to that cancel — so a seller who
 * cannot see the order has funds committed and no button, which is the worst
 * state a market demo can leave somebody in.
 *
 * The first two tests are that loop, sell to cancel, and they pass on the code
 * that reported the bug: the post-write refresh does set `mine`, and the panel
 * does appear. What does not hold is everything *around* it — a poll used to be
 * all-or-nothing, so one unrelated read failing emptied this panel along with
 * the rest. The remaining tests are that.
 *
 * `test/screen.test.tsx` cannot show any of it: it renders panels against a
 * fixed `MarketStateProvider`, so the fixture decides what `mine` holds and the
 * panel always agrees with it. This file runs the real `MarketProvider` — its
 * poll, its `act`, its post-write refresh — over a `Trader` stub that behaves
 * the way `lib/market.ts` does against a chain. The clicks are the real
 * buttons'.
 */

import { afterEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import type { ReactNode } from 'react'
import type { Offer } from 'kei-transaction'

import type { Book, Listing, MarketFacts } from '../shared/listing'
import type { Rendered } from './dom'

mock.module('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : ''} {...rest}>
      {children}
    </a>
  ),
}))

const ASSET = 'ASSET-CARPET'
const YOU = 'kei_you'
const KEI_RAW = 10n ** 18n

const LISTING: Listing = {
  asset: ASSET,
  symbol: 'CARPET',
  name: 'Carpet',
  blurb: '',
  issuer: 'kei_issuer',
  creator: YOU,
  transfer: 'open',
  supply: 1_000_000,
  launchedAt: 1_000,
  stats: { last: null, trades: 0, holders: 1, replies: 0, asks: 0, bestAsk: null, creatorHolds: 1_000_000 },
}

/**
 * A chain, as far as this page can tell one apart from a stub.
 *
 * `sell` writes an offer and takes the units out of the balance, which is what
 * the block does; `mine` answers with the offers that are open, which is what
 * `market.mine({ state: 'open' })` answers with. Nothing here is a shortcut past
 * the thing under test — the panel reads through the provider either way.
 */
function chain() {
  let held = 5_000
  const offers: Offer[] = []
  let sells = 0

  const offerOf = (amount: number, unitPrice: number): Offer =>
    ({
      hash: `offer-${(sells += 1)}`,
      from: YOU,
      give: { asset: ASSET, symbol: 'CARPET', name: 'Carpet', decimals: 0, amount },
      want: { asset: 'kei', symbol: 'KEI', name: 'Kei', decimals: 18, amount: amount * unitPrice },
      price: unitPrice,
      to: null,
      expiresAt: null,
      expired: false,
      state: 'open',
      mine: true,
      acceptedBy: null,
      settledBy: null,
      seenAt: 1,
      settledAt: null,
    }) as Offer

  const facts: MarketFacts = {
    address: 'kei_registry',
    chain: { mode: 'mock', sdkNetwork: 'mock', node: null, ephemeral: true },
    launchFee: '1',
    launchFeeParts: { burn: '0.9', margin: '0.1' },
    listings: [LISTING],
  } as MarketFacts

  const book: Book = { asset: ASSET, asks: [], bids: [], trades: [], price: null }

  return {
    trader: {
      address: YOU,
      network: 'mock',
      sync: async () => {},
      keiBalance: async () => 100n * KEI_RAW,
      incoming: async () => ({ kei: 0n, arrivals: 0 }),
      facts: async () => facts,
      assetInfo: async () => null,
      activity: async () => [],
      book: async () => book,
      holders: async () => [],
      holdings: async () => new Map([[ASSET, held]]),
      launch: async () => {
        throw new Error('not used')
      },
      async sell(asset: string, amount: number, unitPrice: number) {
        const written = offerOf(amount, unitPrice)
        offers.push(written)
        held -= amount
        return written
      },
      bid: async () => {
        throw new Error('not used')
      },
      accept: async () => {
        throw new Error('not used')
      },
      async cancel(hash: string) {
        const at = offers.findIndex((written) => written.hash === hash)
        if (at === -1) return
        held += offers[at]!.give.amount
        offers.splice(at, 1)
      },
      mine: async () => [...offers],
      replies: async () => [],
      reply: async () => {
        throw new Error('not used')
      },
      topUp: async () => {},
    },
    offers,
  }
}

let world = chain()

mock.module('../lib/market.js', () => ({
  connect: async () => world.trader,
  explain: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

const { render } = await import('./dom.js')
const { MarketProvider, useMarket } = await import('../lib/use-market.js')
const { MyOffers, TradePanel } = await import('../components/TradePanel.js')
const { formatCoins } = await import('../shared/format.js')

/**
 * Unmounted here rather than at the end of each test, so that a failing
 * assertion costs one failure instead of leaving happy-dom's globals installed
 * for the rest of the process — `Kei.server()` refuses to start a registry in
 * anything that looks like a browser (SPEC §6.3), and `test/terms.test.ts` does.
 */
let showing: Rendered | null = null
afterEach(() => {
  showing?.unmount()
  showing = null
})

/** The two panels the coin screen puts side by side, and nothing else. */
function CoinPanels() {
  const { holdings } = useMarket()
  const held = holdings.get(ASSET) ?? 0
  const book: Book = { asset: ASSET, asks: [], bids: [], trades: [], price: null }
  return (
    <>
      <TradePanel listing={LISTING} book={book} held={held} loading={false} onTraded={() => {}} />
      <MyOffers listing={LISTING} onTraded={() => {}} />
    </>
  )
}

/** Let the provider's effects, its connect and one poll all settle. */
async function flush(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await act(async () => {})
}

/** The Sell tab, chosen the way somebody chooses it. */
function sellTab(view: Rendered): HTMLElement {
  const found = view.all('[role="tab"]').find((node) => view.name(node).startsWith('Sell'))
  if (!found) throw new Error('No Sell tab rendered.')
  return found
}

function button(view: Rendered, label: string): HTMLElement {
  const found = view.all('button').find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`No button reading "${label}".`)
  return found
}

test('a sell the seller just signed is listed under "Your open orders", with a cancel', async () => {
  world = chain()
  const view = (showing = render(
    <MarketProvider>
      <CoinPanels />
    </MarketProvider>,
  ))
  // The wallet opens in an effect, and the first poll follows it.
  await flush()
  view.click(sellTab(view))
  expect(view.text()).toContain('Lock them into an offer')

  // `Shares` sets the Amount without a keystroke, so this test does not wait on
  // the typing harness. The price field opens at 0.0002, which is a real ask.
  view.click(button(view, 'all of it'))
  await flush()
  view.click(button(view, 'Lock them into an offer'))
  await flush()

  // The chain has it. That is the half that was never in doubt.
  expect(world.offers).toHaveLength(1)
  expect(world.offers[0]?.give.amount).toBe(5_000)

  // And the seller can see it, which is the half that decides whether the units
  // are recoverable by anybody looking at this page.
  expect(view.text()).toContain('Your open orders')
  const cancel = view.all('button').find((node) => node.getAttribute('aria-label')?.startsWith('Cancel your offer'))
  expect(cancel).toBeTruthy()
  expect(view.focusables()).toContain(cancel!)
})

test('cancelling from that list gives the units back and empties it', async () => {
  world = chain()
  const view = (showing = render(
    <MarketProvider>
      <CoinPanels />
    </MarketProvider>,
  ))
  await flush()
  view.click(sellTab(view))
  view.click(button(view, 'all of it'))
  await flush()
  view.click(button(view, 'Lock them into an offer'))
  await flush()

  const cancel = view.all('button').find((node) => node.getAttribute('aria-label')?.startsWith('Cancel your offer'))
  expect(cancel).toBeTruthy()
  view.click(cancel!)
  await flush()

  expect(world.offers).toHaveLength(0)
  expect(view.text()).not.toContain('Your open orders')
})

/**
 * The two figures a failed poll must not invent, and a handle on the poll.
 *
 * `refresh` is the provider's own, taken from context rather than simulated, so
 * these tests drive the same function the two-second interval drives.
 */
let poll: (() => Promise<void>) | null = null

function Probe() {
  const { holdings, activity, feed, refresh } = useMarket()
  poll = refresh
  return (
    <p>
      held {formatCoins(holdings.get(ASSET) ?? 0)} · activity {activity.length} · missed {feed.lastError ?? 'nothing'}
    </p>
  )
}

async function refreshed(): Promise<void> {
  if (!poll) throw new Error('The provider has not rendered yet.')
  await poll()
}

test('one failing read does not hide the orders every other read agrees exist', async () => {
  world = chain()
  const view = (showing = render(
    <MarketProvider>
      <CoinPanels />
    </MarketProvider>,
  ))
  await flush()
  view.click(sellTab(view))
  view.click(button(view, 'all of it'))
  await flush()

  // The holders read starts failing at the moment of the sell. Nothing else
  // does: `mine()` answers, and the offer is on the chain.
  world.trader.holdings = async () => {
    throw new Error('the node did not answer')
  }
  view.click(button(view, 'Lock them into an offer'))
  await flush()

  expect(world.offers).toHaveLength(1)
  expect(view.text()).toContain('Your open orders')
})

test('the feed names the read that did not come back, rather than the whole poll', async () => {
  world = chain()
  const view = (showing = render(
    <MarketProvider>
      <Probe />
    </MarketProvider>,
  ))
  await flush()
  expect(view.text()).toContain('missed nothing')

  world.trader.holdings = async () => {
    throw new Error('the node did not answer')
  }
  await act(async () => {
    await refreshed()
  })

  // Not "a read failed". Which one — the bar carries this into the sentence a
  // person reads, and "the chain is down" and "one figure is old" are different
  // things to be told.
  expect(view.text()).toContain('missed could not read what you hold (the node did not answer)')
})

test('a failed activity read keeps the last settled trades instead of printing none', async () => {
  world = chain()
  const settled = [{ hash: 'trade-1' }] as never[]
  world.trader.activity = async () => settled
  const view = (showing = render(
    <MarketProvider>
      <Probe />
    </MarketProvider>,
  ))
  await flush()
  expect(view.text()).toContain('activity 1')

  world.trader.activity = async () => {
    throw new Error('the node did not answer')
  }
  await act(async () => {
    await refreshed()
  })
  // `.catch(() => [])` used to turn "we could not ask" into "nothing has
  // settled", which is the substitution `lib/metrics.ts` exists to prevent.
  expect(view.text()).toContain('activity 1')
})

test('a board that cannot be read leaves holdings alone rather than zeroing them', async () => {
  world = chain()
  const view = (showing = render(
    <MarketProvider>
      <Probe />
    </MarketProvider>,
  ))
  await flush()
  expect(view.text()).toContain('held 5,000')

  world.trader.facts = async () => {
    throw new Error('the registry did not answer')
  }
  await act(async () => {
    await refreshed()
  })
  // Holdings are keyed off the board's asset list. Asking for none of them
  // answers "you hold nothing", which is a different claim from "we could not
  // read the board" — and on this page it is the one that greys out Sell.
  expect(view.text()).toContain('held 5,000')
})

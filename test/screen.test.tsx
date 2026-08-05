/**
 * What actually reaches the screen.
 *
 * `test/refusals.test.ts` asserts that every state which can stop a trade
 * produces its own sentence, and asserted nothing about whether a panel prints
 * it. `lib/metrics.ts` cannot type a bare zero into existence, and could still
 * be rendered by a component that ignores the absent case. SPEC §9.6's criteria
 * 2, 4, 6 and 7 are all claims about what a person sees, and until this file
 * existed none of them was checkable without a browser and a pair of eyes.
 *
 * The harness is `test/dom.ts` — happy-dom and React's own `act`, no testing
 * library. `next/link` is mocked to a plain anchor because these are assertions
 * about markup and the router is not part of any of them.
 */

import { expect, mock, test } from 'bun:test'
import type { ReactNode } from 'react'
import type { Expectation, Offer } from 'kei-transaction'

mock.module('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={hrefOf(href)} {...rest}>
      {children}
    </a>
  ),
}))

function hrefOf(href: unknown): string {
  if (typeof href === 'string') return href
  const target = href as { pathname?: string; query?: Record<string, string>; hash?: string }
  const query = new URLSearchParams(target.query ?? {}).toString()
  return `${target.pathname ?? ''}${query ? `?${query}` : ''}${target.hash ? `#${target.hash}` : ''}`
}

const { render } = await import('./dom.js')
const { Caveat } = await import('../components/Caveat.js')
const { CoinCard } = await import('../components/CoinCard.js')
const { PolicyBadge } = await import('../components/PolicyBadge.js')
const { Readout } = await import('../components/Readout.js')
const { Tabs } = await import('../components/Tabs.js')
const { Ladder } = await import('../components/OrderBook.js')
const { METRICS, metric } = await import('../lib/metrics.js')
const { NO_FUNDS } = await import('../lib/balance.js')
const { FEED_OPENING } = await import('../lib/feed.js')
const { caveat } = await import('../shared/caveats.js')
const { KEI_RAW } = await import('../shared/format.js')
const { MarketStateProvider } = await import('../lib/use-market.js')

import type { MetricContext } from '../lib/metrics'
import type { Book, Listing } from '../shared/listing'

const ASSET = 'asset-CARPET'
const YOU = 'kei_you'

const LISTING: Listing = {
  asset: ASSET,
  symbol: 'CARPET',
  name: 'Carpet',
  blurb: '',
  issuer: 'kei_issuer',
  creator: 'kei_creator',
  transfer: 'open',
  supply: 1_000_000,
  launchedAt: 1_000,
  stats: { last: null, trades: 0, holders: 0, replies: 0, asks: 0, bestAsk: null, creatorHolds: 1_000_000 },
}

const EMPTY_BOOK: Book = { asset: ASSET, asks: [], bids: [], trades: [], price: null }

const READINGS: MetricContext = {
  listing: LISTING,
  book: EMPTY_BOOK,
  holders: [],
  held: 0,
  loading: false,
  problem: null,
}

/** Enough market state to render a panel. Nothing here opens a wallet. */
function market(over: Record<string, unknown> = {}) {
  return {
    trader: { address: YOU } as never,
    fatal: null,
    facts: null,
    activity: [],
    loading: false,
    feed: FEED_OPENING,
    funds: NO_FUNDS,
    holdings: new Map<string, number>(),
    mine: [],
    busy: false,
    log: [],
    act: async () => {},
    retry: async () => {},
    dismiss: () => {},
    refresh: async () => {},
    ...over,
  } as never
}

function offer(over: Partial<{ from: string; give: number; want: number }> = {}): Offer {
  const give = over.give ?? 1_000
  const want = over.want ?? 0.5
  return {
    hash: `offer-${over.from ?? 'x'}-${give}`,
    from: over.from ?? 'kei_seller',
    give: { asset: ASSET, symbol: 'CARPET', name: 'Carpet', decimals: 0, amount: give },
    want: { asset: 'kei', symbol: 'KEI', name: 'Kei', decimals: 18, amount: want },
    price: want / give,
    to: null,
    expiresAt: null,
    expired: false,
    state: 'open',
    mine: false,
    acceptedBy: null,
    settledBy: null,
    seenAt: 1,
    settledAt: null,
  } as Offer
}

// ------------------------------------------------- criterion 4, on the screen

test('an untraded coin renders "never traded" and no zero, for every metric', () => {
  const view = render(
    <dl>
      {METRICS.map((entry) => (
        <Readout key={entry.id} metric={entry} context={READINGS} />
      ))}
    </dl>,
  )

  const text = view.text()
  expect(text).toContain('never traded')
  expect(text).toContain('none we can read')
  expect(text).toContain('nobody is selling')

  // The two figures that used to print a bare zero. `Trades` and `Holders` are
  // still labels on screen; what must not appear is a `0` under either.
  for (const id of ['trades', 'holders'] as const) {
    const cell = view.all('dl > div').find((node) => node.textContent?.startsWith(metric(id).label))
    expect([id, cell?.textContent]).not.toEqual([id, expect.stringContaining('0')])
  }
  view.unmount()
})

test('volume is on the screen, which is the half of criterion 4 that was missing', () => {
  const priced: Book = {
    ...EMPTY_BOOK,
    price: {
      asset: ASSET,
      quote: 'kei',
      median: 5e-4,
      last: 6e-4,
      low: 4e-4,
      high: 8e-4,
      trades: 3,
      volume: 4_500,
      coverage: null,
    },
  }
  const view = render(<Readout metric={metric('volume')} context={{ ...READINGS, book: priced }} />)
  expect(view.text()).toBe('Volume4,500 CARPET')
  view.unmount()
})

test('a book that has not answered is busy, not empty and not zero', () => {
  const view = render(<Readout metric={metric('last')} context={{ ...READINGS, book: null, loading: true }} />)
  expect(view.find('[aria-busy="true"]')).toBeTruthy()
  expect(view.text()).toContain('still reading')
  view.unmount()
})

// ------------------------------------------------- criterion 7, on the screen

test('the policy badge is a link to the ledger record, not a span with a tooltip', () => {
  const view = render(<PolicyBadge listing={LISTING} />)
  const badge = view.find<HTMLAnchorElement>('a')
  expect(badge.getAttribute('href')).toBe('#ledger')
  expect(view.name(badge)).toContain('Read the ledger record')
  view.unmount()
})

test('on a card the badge links to the coin page, landing on the ledger panel', () => {
  const view = render(<PolicyBadge listing={LISTING} target="card" />)
  expect(view.find<HTMLAnchorElement>('a').getAttribute('href')).toBe(`/coin?asset=${ASSET}#ledger`)
  view.unmount()
})

test('the launch preview badge links nowhere, because the coin has no record yet', () => {
  const view = render(<PolicyBadge listing={LISTING} target="static" />)
  expect(view.all('a')).toHaveLength(0)
  expect(view.text()).toContain('CAN BE DUMPED')
  view.unmount()
})

test('a coin card nests no anchor inside another, and both of its links are reachable', () => {
  const view = render(<CoinCard listing={LISTING} />)
  const links = view.all<HTMLAnchorElement>('a')
  expect(links).toHaveLength(2)
  for (const link of links) expect(link.querySelector('a')).toBeNull()

  const [primary, badge] = links as [HTMLAnchorElement, HTMLAnchorElement]
  expect(primary.getAttribute('href')).toBe(`/coin?asset=${ASSET}`)
  expect(badge.getAttribute('href')).toBe(`/coin?asset=${ASSET}#ledger`)
  expect(view.focusables()).toHaveLength(2)
  view.unmount()
})

test('the policy badge is read before any number on a card', () => {
  const view = render(<CoinCard listing={LISTING} />)
  const text = view.text()
  expect(text.indexOf('CAN BE DUMPED')).toBeLessThan(text.indexOf('never traded'))
  view.unmount()
})

// ------------------------------------------------- criterion 2, on the screen

test('a row somebody cannot afford stays focusable and says why in its own name', () => {
  const view = render(
    <MarketStateProvider value={market()}>
      <Ladder side="ask" listing={LISTING} offers={[offer()]} held={0} loading={false} onTraded={() => {}} />
    </MarketStateProvider>,
  )

  const button = view.find<HTMLButtonElement>('tbody button')
  expect(button.getAttribute('aria-disabled')).toBe('true')
  // `disabled` would take it out of the tab order and the reason with it.
  expect(button.hasAttribute('disabled')).toBe(false)
  expect(view.focusables()).toContain(button)
  expect(view.name(button)).toContain('unavailable')
  expect(view.name(button)).toContain('spendable')
  view.unmount()
})

test('your own offer says so rather than offering you your own coins back', () => {
  const view = render(
    <MarketStateProvider value={market()}>
      <Ladder side="ask" listing={LISTING} offers={[offer({ from: YOU })]} held={0} loading={false} onTraded={() => {}} />
    </MarketStateProvider>,
  )
  expect(view.name(view.find('tbody button'))).toContain('your own offer')
  view.unmount()
})

test('a soulbound coin renders no trade controls at all, rather than disabled ones', () => {
  const view = render(
    <MarketStateProvider value={market()}>
      <Ladder
        side="ask"
        listing={{ ...LISTING, transfer: 'none' }}
        offers={[offer()]}
        held={0}
        loading={false}
        onTraded={() => {}}
      />
    </MarketStateProvider>,
  )
  expect(view.name(view.find('tbody button'))).toContain('soulbound')
  view.unmount()
})

test('the Buy button hands the wallet the terms the row rendered, not just a hash', () => {
  const row = offer()
  const taken: { hash?: string; expect?: Expectation } = {}

  const view = render(
    <MarketStateProvider
      value={market({
        funds: { ...NO_FUNDS, confirmed: 100n * KEI_RAW },
        trader: {
          address: YOU,
          accept: (hash: string, expected: Expectation) => {
            taken.hash = hash
            taken.expect = expected
            return Promise.resolve()
          },
        },
        act: (_kind: unknown, _what: unknown, job: () => Promise<void>) => job(),
      })}
    >
      <Ladder side="ask" listing={LISTING} offers={[row]} held={0} loading={false} onTraded={() => {}} />
    </MarketStateProvider>,
  )

  const button = view.find<HTMLButtonElement>('tbody button')
  expect(button.getAttribute('aria-disabled')).toBe('false')
  view.click(button)

  // The two numbers the row printed, carried into the signature. Without them
  // the wallet signs whatever the registry attached that hash to.
  expect(view.name(button)).toContain('1,000 CARPET')
  expect(taken.hash).toBe(row.hash)
  expect(taken.expect?.hash).toBe(row.hash)
  expect(taken.expect?.seller).toBe(row.from)
  expect(taken.expect?.give?.amount).toBe(1_000)
  expect(taken.expect?.want?.amount).toBe(0.5)
  view.unmount()
})

test('an empty side says nobody is selling rather than showing a price with nothing behind it', () => {
  const view = render(
    <MarketStateProvider value={market()}>
      <Ladder side="ask" listing={LISTING} offers={[]} held={0} loading={false} onTraded={() => {}} />
    </MarketStateProvider>,
  )
  expect(view.text()).toContain('Nobody is selling CARPET')
  expect(view.all('button')).toHaveLength(0)
  view.unmount()
})

// ------------------------------------------------- criterion 6, on the screen

function TabHarness() {
  return (
    <Tabs
      label="Buy or sell"
      active="buy"
      onPick={() => {}}
      tabs={[
        { key: 'buy', label: 'buy' },
        { key: 'sell', label: 'sell' },
      ]}
    >
      <p>the panel</p>
    </Tabs>
  )
}

test('a tablist is one tab stop, and its panel is the next one', () => {
  const view = render(<TabHarness />)
  const tabs = view.all<HTMLButtonElement>('[role="tab"]')
  expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['0', '-1'])
  expect(view.find('[role="tabpanel"]').getAttribute('tabindex')).toBe('0')
  view.unmount()
})

test('every tab points aria-controls at a panel that exists', () => {
  const view = render(<TabHarness />)
  for (const tab of view.all('[role="tab"]')) {
    const id = tab.getAttribute('aria-controls')
    expect(id).toBeTruthy()
    expect(view.container.querySelector(`#${CSS.escape(id!)}`)).toBeTruthy()
  }
  view.unmount()
})

test('the tablist owns tabs and nothing else', () => {
  const view = render(<TabHarness />)
  const strip = view.find('[role="tablist"]')
  for (const child of [...strip.children]) expect(child.getAttribute('role')).toBe('tab')
  view.unmount()
})

test('the arrow keys move the selection, and wrap', () => {
  const picked: string[] = []
  const view = render(
    <Tabs
      label="Buy or sell"
      active="buy"
      onPick={(key) => picked.push(key)}
      tabs={[
        { key: 'buy', label: 'buy' },
        { key: 'sell', label: 'sell' },
      ]}
    >
      <p>the panel</p>
    </Tabs>,
  )

  const strip = view.find('[role="tablist"]')
  view.press(strip, 'ArrowRight')
  view.press(strip, 'ArrowLeft')
  view.press(strip, 'End')
  view.press(strip, 'Home')
  // From `buy`: right wraps forward to sell, left wraps back to sell, End is
  // sell, Home is buy.
  expect(picked).toEqual(['sell', 'sell', 'sell', 'buy'])
  view.unmount()
})

test('a key the tablist does not handle is left alone', () => {
  const picked: string[] = []
  const view = render(
    <Tabs
      label="Buy or sell"
      active="buy"
      onPick={(key) => picked.push(key)}
      tabs={[
        { key: 'buy', label: 'buy' },
        { key: 'sell', label: 'sell' },
      ]}
    >
      <p>the panel</p>
    </Tabs>,
  )
  view.press(view.find('[role="tablist"]'), 'a')
  expect(picked).toEqual([])
  view.unmount()
})

// ------------------------------------------------- criterion 9, on the screen

test('a caveat renders the registry’s sentence and cites its section', () => {
  const view = render(<Caveat id="account-list" />)
  expect(view.text()).toContain(caveat('account-list').says)
  expect(view.text()).toContain('SPEC §9.4')
  view.unmount()
})

test('a caveat with no section cites none rather than inventing one', () => {
  const view = render(<Caveat id="one-quote" />)
  expect(view.text()).not.toContain('SPEC §')
  view.unmount()
})

test('the DOM harness gives server tests their plain runtime back', () => {
  const view = render(<span>temporary browser</span>)
  view.unmount()
  expect('document' in globalThis).toBe(false)
})

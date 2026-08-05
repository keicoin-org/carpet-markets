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
import { act, useState } from 'react'
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
const { BuyFunnel } = await import('../components/BuyFunnel.js')
const { Caveat } = await import('../components/Caveat.js')
const { CoinCard } = await import('../components/CoinCard.js')
const { KingOfTheHill } = await import('../components/KingOfTheHill.js')
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
import type { Rendered } from './dom'

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
    act: async () => ({ signed: true, problem: null }),
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

test('the king card nests no anchor inside another, and both of its links are reachable', () => {
  const view = render(<KingOfTheHill listing={LISTING} />)
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

// ---------------------------------------- criterion 1, the funnel, on the screen

/** Let the click's own promise run, so the step after it is on screen. */
async function flush(): Promise<void> {
  await act(async () => {})
}

function Funnel({ asks, over = {} }: { asks: Offer[]; over?: Record<string, unknown> }) {
  return (
    <MarketStateProvider value={market(over)}>
      <BuyFunnel listing={LISTING} asks={asks} held={0} loading={false} onTraded={() => {}}>
        <p>the bid form</p>
      </BuyFunnel>
    </MarketStateProvider>
  )
}

/**
 * The panel under a parent that owns the book, which is where the funnel got stuck.
 *
 * `asks` is state here because it is state on the coin page: `onTraded` triggers
 * the read that drops the ask which was just filled. A fixture that passes a
 * frozen array can never show what happens once the book *stops* changing, and
 * that is the only condition under which "Back to the book" went wrong.
 */
function FillableFunnel({ asks: opening, over = {} }: { asks: Offer[]; over?: Record<string, unknown> }) {
  const [asks, setAsks] = useState(opening)
  return (
    <MarketStateProvider value={market(over)}>
      <BuyFunnel
        listing={LISTING}
        asks={asks}
        held={0}
        loading={false}
        onTraded={() => setAsks((rows) => rows.slice(1))}
      >
        <p>the bid form</p>
      </BuyFunnel>
    </MarketStateProvider>
  )
}

/** Enough state to take a row, and a provider that actually runs the job. */
const CAN_BUY: Record<string, unknown> = {
  funds: { confirmed: 10n ** 18n, incoming: 0n, arrivals: 0, inFlight: [] },
  trader: { address: YOU, accept: async () => {} },
  act: async (_kind: string, _what: string, job: () => Promise<void>) => {
    await job()
    return { signed: true, problem: null }
  },
}

/** Buy the top row and settle it. Leaves the panel on `settled`. */
async function buyTheTopRow(view: Rendered): Promise<void> {
  view.click(view.find('tbody button'))
  await flush()
  view.click(view.all('button').find((node) => node.textContent === 'Confirm the buy')!)
  await flush()
}

/** The step the indicator is announcing, as it prints it. */
function currentStep(view: Rendered): string | undefined {
  return view.all('ol li').find((node) => node.getAttribute('aria-current') === 'step')?.textContent ?? undefined
}

test('the five steps are named in order, and the current one is announced as a step', () => {
  const view = render(<Funnel asks={[offer()]} />)
  const steps = view.all('ol li')
  expect(steps.map((node) => node.textContent)).toEqual([
    '1. nothing for sale',
    '2. pick a quote',
    '3. confirm the terms',
    '4. settling',
    '5. settled',
  ])
  expect(steps[1]?.getAttribute('aria-current')).toBe('step')
  view.unmount()
})

test('a coin nobody is selling opens on the empty step and says there are no trades yet', () => {
  const view = render(<Funnel asks={[]} />)
  expect(view.find('ol li')?.getAttribute('aria-current')).toBe('step')
  expect(view.text()).toContain('No trades yet and nobody is selling CARPET')
  expect(view.text()).toContain('the bid form')
  view.unmount()
})

test('confirming signs for the terms of the row that was on screen, not for a bare hash', async () => {
  const row = offer()
  const accepts: unknown[][] = []
  const view = render(
    <Funnel
      asks={[row]}
      over={{
        funds: { confirmed: 10n ** 18n, incoming: 0n, arrivals: 0, inFlight: [] },
        trader: {
          address: YOU,
          accept: async (...args: unknown[]) => {
            accepts.push(args)
          },
        },
        // The real provider runs the job; this mock has to as well, or the
        // assertion below passes against a signature that never happened.
        act: async (_kind: string, _what: string, job: () => Promise<void>) => {
          await job()
          return { signed: true, problem: null }
        },
      }}
    />,
  )

  view.click(view.find('tbody button'))
  await flush()
  view.click(view.all('button').find((node) => node.textContent === 'Confirm the buy')!)
  await flush()

  expect(accepts).toHaveLength(1)
  const [hash, expected] = accepts[0] as [string, Record<string, unknown>]
  expect(hash).toBe(row.hash)
  // Not `accept(hash)`. Every leg the ladder drew is asserted at the chain
  // before anything is signed (#6), so a book that moved between the poll and
  // this click cannot change what the key agreed to.
  expect(expected).toMatchObject({
    hash: row.hash,
    seller: row.from,
    give: { asset: ASSET, amount: 1_000 },
    want: { asset: 'kei', amount: 0.5 },
  })
  view.unmount()
})

test('a row cannot sign — picking one shows the terms and writes nothing', async () => {
  const signed: string[] = []
  const view = render(
    <Funnel
      asks={[offer()]}
      over={{
        funds: { confirmed: 10n ** 18n, incoming: 0n, arrivals: 0, inFlight: [] },
        act: async (_kind: string, what: string) => {
          signed.push(what)
          return { signed: true, problem: null }
        },
      }}
    />,
  )

  view.click(view.find('tbody button'))
  await flush()

  expect(signed).toEqual([])
  expect(view.text()).toContain('Take this offer?')
  expect(view.text()).toContain('1,000 CARPET')
  expect(view.text()).toContain('Nothing has left it yet')
  view.unmount()
})

test('the confirmation takes the focus, so a keyboard visitor is still somewhere', async () => {
  const view = render(
    <Funnel asks={[offer()]} over={{ funds: { confirmed: 10n ** 18n, incoming: 0n, arrivals: 0, inFlight: [] } }} />,
  )
  view.click(view.find('tbody button'))
  await flush()
  expect(document.activeElement?.textContent).toContain('Confirm the buy')
  view.unmount()
})

test('pending is on screen before settled, rather than a flicker inside the button', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  const view = render(
    <Funnel
      asks={[offer()]}
      over={{
        funds: { confirmed: 10n ** 18n, incoming: 0n, arrivals: 0, inFlight: [] },
        act: async () => {
          await gate
          return { signed: true, problem: null }
        },
      }}
    />,
  )

  view.click(view.find('tbody button'))
  await flush()
  view.click(view.all('button').find((node) => node.textContent === 'Confirm the buy')!)
  await flush()

  expect(view.text()).toContain('Signed — waiting for a read')
  expect(view.text()).toContain('settling rather than done')
  expect(view.text()).not.toContain('Settled')

  release()
  await flush()

  expect(view.text()).toContain('Settled')
  expect(view.text()).toContain('are on your own chain')
  view.unmount()
})

test('a refusal goes back to the book with the ledger’s own words', async () => {
  const view = render(
    <Funnel
      asks={[offer()]}
      over={{
        funds: { confirmed: 10n ** 18n, incoming: 0n, arrivals: 0, inFlight: [] },
        act: async () => ({ signed: true, problem: 'That offer has already been accepted.' }),
      }}
    />,
  )

  view.click(view.find('tbody button'))
  await flush()
  view.click(view.all('button').find((node) => node.textContent === 'Confirm the buy')!)
  await flush()

  expect(view.find('[role="alert"]').textContent).toBe('That offer has already been accepted.')
  expect(view.find('tbody button')).toBeTruthy()
  view.unmount()
})

test('Back to the book after a partial fill lands on the rows that are still there', async () => {
  const view = render(
    <FillableFunnel asks={[offer({ from: 'kei_first' }), offer({ from: 'kei_second' })]} over={CAN_BUY} />,
  )

  await buyTheTopRow(view)
  expect(view.text()).toContain('Settled')

  view.click(view.all('button').find((node) => node.textContent === 'Back to the book')!)
  await flush()

  // The second seller's offer is still open, and still rendered. Nothing about
  // this click changes `asks.length` or `loading`, which were the only things
  // that re-derived the step — so the panel announced "nothing for sale" with a
  // takeable row directly underneath it, and only came right if a third party
  // traded.
  expect(view.all('tbody button')).toHaveLength(1)
  expect(currentStep(view)).toBe('2. pick a quote')
  expect(view.text()).not.toContain('No trades yet and nobody is selling CARPET')
  view.unmount()
})

test('Back to the book after the last offer goes says nothing is for sale, and means it', async () => {
  const view = render(<FillableFunnel asks={[offer({ from: 'kei_only' })]} over={CAN_BUY} />)

  await buyTheTopRow(view)
  view.click(view.all('button').find((node) => node.textContent === 'Back to the book')!)
  await flush()

  // The other half of the same claim: the step follows the book, so an empty
  // book must not be re-derived into `quote` by a fix that just forces it.
  expect(view.all('tbody button')).toHaveLength(0)
  expect(currentStep(view)).toBe('1. nothing for sale')
  expect(view.text()).toContain('No trades yet and nobody is selling CARPET')
  view.unmount()
})

test('a book that empties under a confirmation does not rewind it', async () => {
  const view = render(<FillableFunnel asks={[offer({ from: 'kei_first' }), offer({ from: 'kei_second' })]} over={CAN_BUY} />)

  view.click(view.find('tbody button'))
  await flush()
  expect(currentStep(view)).toBe('3. confirm the terms')

  // `quoted`'s own guard is what forbids rewinding, not the effect's dependency
  // list. Re-deriving the step on every step change must not drag a
  // confirmation back onto the book when the poll finds fewer rows.
  view.click(view.all('button').find((node) => node.textContent === 'Confirm the buy')!)
  await flush()
  expect(currentStep(view)).toBe('5. settled')
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

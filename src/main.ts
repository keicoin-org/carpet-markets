/**
 * The market floor.
 *
 * State is one object and a poll. Every action on the page ends in a signature
 * from the wallet in this browser, which is why there is no login: the address
 * is the account, and the key never leaves.
 *
 * Nothing on this page asks a server what anything is worth. The order book and
 * the trade history are `swap_offer` and `swap_accept` blocks, read back off the
 * chains of accounts the registry knows about — so every number here is one two
 * people signed, and a reader with the same account list gets the same answer
 * without this site being involved at all.
 */

import type { Offer } from 'kei-transaction'

import { formatCoins, formatKei, formatPrice, parseKei } from '../shared/format.js'
import type { Book, Listing, MarketFacts, TransferPolicy } from '../shared/listing.js'
import { connect, explain, type Trader } from './market-client.js'
import { chart, clear, el, policyBadge, summarise } from './ui.js'

const POLL_MS = 2_000

interface State {
  facts: MarketFacts | null
  selected: string | null
  kei: bigint
  holdings: Map<string, number>
  books: Map<string, Book>
  mine: Offer[]
  busy: boolean
  message: { text: string; tone: 'ok' | 'bad' } | null
}

const state: State = {
  facts: null,
  selected: null,
  kei: 0n,
  holdings: new Map(),
  books: new Map(),
  mine: [],
  busy: false,
  message: null,
}

const mount = document.querySelector('#app')
if (!(mount instanceof HTMLElement)) throw new Error('The page is missing its #app element.')
const root: HTMLElement = mount

let trader: Trader

void (async () => {
  try {
    trader = await connect()
  } catch (error) {
    root.append(el('p.fatal', {}, `Could not open a wallet: ${explain(error)}`))
    return
  }
  await refresh()
  render()
  setInterval(() => void refresh().then(render), POLL_MS)
})()

// ---------------------------------------------------------------------- state

async function refresh(): Promise<void> {
  try {
    const facts = await trader.facts()
    state.facts = facts
    state.selected ??= facts.listings[0]?.asset ?? null

    // Before reading balances, not after. Coins bought through a settlement are
    // a receivable until this wallet signs for them (SPEC §5.6.3), and reading
    // first shows a holder nothing, correctly, about the wrong moment.
    await trader.sync()

    const [kei, holdings, mine] = await Promise.all([
      trader.keiBalance(),
      trader.holdings(facts.listings.map((listing) => listing.asset)),
      trader.mine(),
    ])
    state.kei = kei
    state.holdings = holdings
    state.mine = mine

    // Only the coin being looked at. A book is several chain reads per coin, and
    // polling all of them every two seconds would make the page the busiest
    // client on the network for no benefit.
    if (state.selected) {
      state.books.set(state.selected, await trader.book(state.selected))
    }
  } catch (error) {
    say(explain(error), 'bad')
  }
}

function say(text: string, tone: 'ok' | 'bad'): void {
  state.message = { text, tone }
}

/** Run one signed action, keeping the page honest about what is happening. */
async function act(what: string, job: () => Promise<void>): Promise<void> {
  if (state.busy) return
  state.busy = true
  say(`${what}…`, 'ok')
  render()
  try {
    await job()
    say(`${what} — done.`, 'ok')
  } catch (error) {
    say(explain(error), 'bad')
  } finally {
    state.busy = false
    await refresh()
    render()
  }
}

const book = (asset: string): Book | undefined => state.books.get(asset)

// --------------------------------------------------------------------- render

function render(): void {
  clear(root)
  root.append(header(), board(), detail())
  if (state.message) {
    root.append(el('div', { class: `toast toast-${state.message.tone}` }, state.message.text))
  }
}

function header(): HTMLElement {
  const facts = state.facts
  return el(
    'header.top',
    {},
    el(
      'div.brand',
      {},
      el('h1', {}, 'Carpet Markets'),
      el('p', {}, 'Launch a coin. Sell it to somebody. Read the transfer policy before you buy.'),
    ),
    el(
      'div.wallet',
      {},
      el('span.addr', { title: trader?.address ?? '' }, trader ? `${trader.address.slice(0, 14)}…` : '—'),
      el('strong', {}, `${formatKei(state.kei, 6)} Kei`),
      el(
        'button.ghost',
        { onclick: () => void act('Topping up', () => trader.topUp()), disabled: state.busy },
        'Faucet',
      ),
      facts && el('span.network', {}, `${facts.network} · ${facts.listings.length} coins`),
    ),
  )
}

function board(): HTMLElement {
  const listings = [...(state.facts?.listings ?? [])].sort((a, b) => b.launchedAt - a.launchedAt)

  return el(
    'section.board',
    {},
    el('div.board-head', {}, el('h2', {}, 'Listed'), launchButton()),
    listings.length === 0
      ? el('p.empty', {}, 'Nothing is listed yet. Launch the first one.')
      : el('div.cards', {}, ...listings.map(card)),
  )
}

function card(listing: Listing): HTMLElement {
  const held = state.holdings.get(listing.asset) ?? 0
  return el(
    'button.card',
    {
      class: `card ${listing.asset === state.selected ? 'card-on' : ''}`,
      onclick: () => {
        state.selected = listing.asset
        void refresh().then(render)
      },
    },
    el('div.card-top', {}, el('strong', {}, listing.symbol), policyBadge(listing)),
    el('div.card-name', {}, listing.name),
    el(
      'div.card-foot',
      {},
      summarise(listing, book(listing.asset)),
      held > 0 ? el('span.held', {}, `you: ${formatCoins(held)}`) : null,
    ),
  )
}

// --------------------------------------------------------------------- detail

function detail(): HTMLElement {
  const listing = state.facts?.listings.find((entry) => entry.asset === state.selected)
  if (!listing) return el('section.detail', {}, el('p.empty', {}, 'Pick a coin.'))

  const current = book(listing.asset)
  const held = state.holdings.get(listing.asset) ?? 0
  const canvas = el('canvas.chart', { width: 640, height: 180 })
  queueMicrotask(() => chart(canvas, current?.trades ?? []))

  return el(
    'section.detail',
    {},
    el('div.detail-head', {}, el('h2', {}, `${listing.symbol} — ${listing.name}`), policyBadge(listing)),
    listing.blurb ? el('p.blurb', {}, listing.blurb) : null,
    canvas,
    stats(listing, current, held),
    listing.transfer === 'open' ? asks(listing, current) : noMarket(listing),
    listing.transfer === 'open' ? sellForm(listing, held) : null,
    myOffers(listing),
    provenance(listing),
  )
}

function stats(listing: Listing, current: Book | undefined, held: number): HTMLElement {
  const price = current?.price
  return el(
    'dl.stats',
    {},
    stat('Last', price ? `${formatPrice(price.last)} Kei` : 'never traded'),
    stat('Median', price ? `${formatPrice(price.median)} Kei` : '—'),
    stat('Range', price ? `${formatPrice(price.low)} – ${formatPrice(price.high)}` : '—'),
    stat('Trades', price ? String(price.trades) : '0'),
    stat('Supply', formatCoins(listing.supply)),
    stat('You hold', formatCoins(held)),
  )
}

const stat = (label: string, value: string): HTMLElement =>
  el('div.stat', {}, el('dt', {}, label), el('dd', {}, value))

/**
 * The offers, cheapest first, each one a button that settles it.
 *
 * Accepting is one block that moves both legs (SPEC §9.2). There is no window in
 * which this wallet has paid and not been paid — the ledger has no state in
 * which half of it happened.
 */
function asks(listing: Listing, current: Book | undefined): HTMLElement {
  const open = (current?.asks ?? []).filter((offer) => !offer.mine)
  const own = (current?.asks ?? []).filter((offer) => offer.mine)

  return el(
    'div.book',
    {},
    el('h3', {}, 'For sale'),
    open.length === 0
      ? el(
          'p.empty',
          {},
          own.length > 0
            ? 'Only your own offers are open. Somebody else has to take them.'
            : 'Nobody is selling. Whoever holds this can list some at a price of their choosing.',
        )
      : el(
          'table.asks',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Amount'),
            el('th', {}, 'Price each'),
            el('th', {}, 'Total'),
            el('th', {}, ''),
          ),
          ...open.map((offer) => askRow(listing, offer)),
        ),
  )
}

function askRow(listing: Listing, offer: Offer): HTMLElement {
  return el(
    'tr',
    {},
    el('td', {}, formatCoins(offer.give.amount)),
    el('td', {}, `${formatPrice(offer.price)} Kei`),
    el('td', {}, `${formatPrice(offer.want.amount)} Kei`),
    el(
      'td',
      {},
      el(
        'button.buy',
        {
          disabled: state.busy,
          onclick: () =>
            void act(`Buying ${formatCoins(offer.give.amount)} ${listing.symbol}`, async () => {
              await trader.accept(offer.hash)
            }),
        },
        'Buy',
      ),
    ),
  )
}

function noMarket(listing: Listing): HTMLElement {
  return el(
    'div.closed',
    {},
    listing.transfer === 'none'
      ? 'Soulbound. These units cannot move, so there is no offer anybody could write and no market that could exist. That is not this site declining to host one — it is an invalid block.'
      : 'Issuer-only. Units move only to or from the issuing account, so no offer between two holders is valid. Whatever market this coin has, the issuer is the whole of it.',
  )
}

/**
 * List some for sale: how many, and what to ask for each.
 *
 * Both numbers belong to the seller, which is the entire difference from the
 * bonding curve this used to have. Somebody holding the supply can put out a
 * thousand at a time and keep the price up, or all of it at once and not — and
 * the point of the example is that a buyer can watch them choose.
 */
function sellForm(listing: Listing, held: number): HTMLElement {
  const amount = el('input.amount', { type: 'text', value: '1000', inputmode: 'numeric' })
  const unit = el('input.amount', { type: 'text', value: '0.0002', inputmode: 'decimal' })
  const preview = el('p.preview', {})

  const update = (): void => {
    const count = Number(amount.value.replace(/[^\d]/g, '') || '0')
    const each = Number(unit.value)
    preview.textContent =
      count > 0 && Number.isFinite(each) && each > 0
        ? `Asking ${formatPrice(count * each)} Kei for the lot.`
        : 'Pick a whole number of coins and a price above zero.'
  }
  amount.addEventListener('input', update)
  unit.addEventListener('input', update)
  queueMicrotask(update)

  return el(
    'div.trade',
    {},
    el('div.side', {}, el('label', {}, `Sell (${listing.symbol})`), amount),
    el('div.side', {}, el('label', {}, 'Price each (Kei)'), unit),
    el(
      'div.side',
      {},
      preview,
      el('p.preview', {}, `You hold ${formatCoins(held)}.`),
      el(
        'button.sell',
        {
          disabled: state.busy || held <= 0,
          onclick: () =>
            void act(`Listing ${listing.symbol}`, async () => {
              const count = Number(amount.value.replace(/[^\d]/g, '') || '0')
              const each = Number(unit.value)
              if (count <= 0) throw new Error('Sell a whole number of coins, more than zero.')
              if (count > held) throw new Error(`You hold ${formatCoins(held)}, so you cannot list ${formatCoins(count)}.`)
              if (!Number.isFinite(each) || each <= 0) throw new Error('Price each has to be above zero.')
              await trader.sell(listing.asset, count, each)
            }),
        },
        'List them',
      ),
    ),
  )
}

/**
 * This wallet's own open offers.
 *
 * Worth showing because the coins in them are gone from the spendable balance
 * until the offer settles or is cancelled — locked by the `swap_offer` block,
 * not by bookkeeping here. A holder who cannot find their coins is looking at
 * this list.
 */
function myOffers(listing: Listing): HTMLElement | null {
  const mine = state.mine.filter((offer) => offer.give.asset === listing.asset)
  if (mine.length === 0) return null

  return el(
    'div.mine',
    {},
    el('h3', {}, 'Your open offers'),
    ...mine.map((offer) =>
      el(
        'div.offer',
        {},
        el('span', {}, `${formatCoins(offer.give.amount)} at ${formatPrice(offer.price)} Kei each`),
        el(
          'button.ghost',
          {
            disabled: state.busy,
            onclick: () => void act('Cancelling', () => trader.cancel(offer.hash)),
          },
          'Cancel',
        ),
      ),
    ),
  )
}

function provenance(listing: Listing): HTMLElement {
  const policy: Record<TransferPolicy, string> = {
    open: 'open — anybody can send it to anybody, including all of it to you',
    'issuer-only': 'issuer-only — units move only to or from the issuing account',
    none: 'none — soulbound, nothing moves',
  }
  return el(
    'details.provenance',
    {},
    el('summary', {}, 'What the chain says'),
    el(
      'dl',
      {},
      stat('Coin asset', listing.asset),
      stat('Issued by', listing.issuer),
      stat('Transfer policy', policy[listing.transfer]),
      stat('Launched by', listing.creator),
    ),
    el(
      'p',
      {},
      'The transfer policy is fixed at issuance and enforced by consensus, not by this site. It is the reason the badge above is a fact rather than a promise. Every coin here is issued by an account of its own, so the burn one launch pays is its own first one and never anybody else’s.',
    ),
  )
}

// --------------------------------------------------------------------- launch

function launchButton(): HTMLElement {
  const fee = state.facts?.launchFee ?? '0'
  return el(
    'button.launch',
    { disabled: state.busy, onclick: () => openLaunch(fee) },
    `Launch a coin — ${formatKei(parseKei(fee), 2)} Kei`,
  )
}

function openLaunch(fee: string): void {
  const symbol = el('input', { type: 'text', placeholder: 'WAGMI', maxlength: 10 })
  const name = el('input', { type: 'text', placeholder: 'We Are All Gonna Make It' })
  const blurb = el('input', { type: 'text', placeholder: 'One line. 140 characters.', maxlength: 140 })
  let transfer: TransferPolicy = 'open'

  const choice = (value: TransferPolicy, title: string, body: string): HTMLElement =>
    el(
      'button',
      {
        class: `choice ${transfer === value ? 'choice-on' : ''}`,
        onclick: (event: Event) => {
          transfer = value
          for (const other of dialog.querySelectorAll('.choice')) other.classList.remove('choice-on')
          ;(event.currentTarget as HTMLElement).classList.add('choice-on')
        },
      },
      el('strong', {}, title),
      el('span', {}, body),
    )

  const dialog = el(
    'div.sheet',
    {},
    el('h2', {}, 'Launch a coin'),
    el(
      'p.fee',
      {},
      `This costs ${formatKei(parseKei(fee), 4)} Kei and almost all of it is burned, not collected. `,
      'It is the same for everybody and does not go up as more coins are listed: each one is issued by a fresh account, so a launch pays that account’s first burn and nothing else.',
    ),
    el('label', {}, 'Symbol'),
    symbol,
    el('label', {}, 'Name'),
    name,
    el('label', {}, 'Blurb'),
    blurb,
    el('label', {}, 'Who may move it'),
    el(
      'div.choices',
      {},
      choice(
        'open',
        'Open',
        'Anybody can trade it, so it has a real order book. You are minted the whole supply and nothing stops you selling it into that book at any pace you like. Buyers can see this before they buy.',
      ),
      choice(
        'issuer-only',
        'Issuer only',
        'Units move only to or from the issuing account. No offer between two holders is a valid block, so there is no player-to-player market and cannot be one.',
      ),
      choice(
        'none',
        'Soulbound',
        'Nothing moves, ever. It cannot be sold, by you or by anybody. Enforced by the chain, immutably, from issuance.',
      ),
    ),
    el(
      'div.sheet-foot',
      {},
      el('button.ghost', { onclick: () => dialog.remove() }, 'Cancel'),
      el(
        'button.launch',
        {
          onclick: () =>
            void act('Launching', async () => {
              await trader.launch({
                symbol: symbol.value,
                name: name.value,
                blurb: blurb.value,
                transfer,
              })
              dialog.remove()
            }),
        },
        'Pay the fee and launch',
      ),
    ),
  )

  root.append(dialog)
  symbol.focus()
}

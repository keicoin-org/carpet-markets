/**
 * The market floor.
 *
 * State is one object and a poll. Every action on the page ends in a signature
 * from the wallet in this browser, which is why there is no login: the address
 * is the account, and the key never leaves.
 */

import { CURVE_SUPPLY, coinsFor, formatCoins, formatKei, parseKei, spotPrice } from '../shared/curve.js'
import type { Listing, MarketFacts, ReserveLock } from '../shared/listing.js'
import { connect, explain, type Trader } from './market-client.js'
import { chart, clear, el, lockBadge, multiple, price, progress, stateBadge, summarise } from './ui.js'

const POLL_MS = 2_000

interface State {
  facts: MarketFacts | null
  selected: string | null
  kei: bigint
  holdings: Map<string, bigint>
  deeds: Set<string>
  busy: boolean
  message: { text: string; tone: 'ok' | 'bad' } | null
}

const state: State = {
  facts: null,
  selected: null,
  kei: 0n,
  holdings: new Map(),
  deeds: new Set(),
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

    // Both before reading the wallet, not after. A graduation badge sitting as
    // an uncollected proof is not in the wallet yet, and coins the market just
    // minted are a receivable until this wallet signs for them — read first and
    // the page shows a holder nothing, correctly, about the wrong moment.
    await trader.collect()
    await trader.sync()

    const [kei, holdings, items] = await Promise.all([
      trader.keiBalance(),
      trader.holdings(facts.listings.map((listing) => listing.asset)),
      trader.items(),
    ])
    state.kei = kei
    state.holdings = holdings
    state.deeds = new Set(items.map((item) => item.id))
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
    say(`${what} — signed. Waiting for the market to settle it.`, 'ok')
  } catch (error) {
    say(explain(error), 'bad')
  } finally {
    state.busy = false
    await refresh()
    render()
  }
}

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
      el('p', {}, 'Launch a coin. Watch it go up. Read the deed before you buy.'),
    ),
    el(
      'div.wallet',
      {},
      el('span.addr', { title: trader?.address ?? '' }, trader ? `${trader.address.slice(0, 14)}…` : '—'),
      el('strong', {}, `${formatKei(state.kei, 6)} Kei`),
      el(
        'button.ghost',
        {
          onclick: () => void act('Topping up', () => trader.topUp()),
          disabled: state.busy,
        },
        'Faucet',
      ),
      facts && el('span.network', {}, `${facts.network} · ${facts.issued} assets issued`),
    ),
  )
}

function board(): HTMLElement {
  const facts = state.facts
  const listings = [...(facts?.listings ?? [])].sort((a, b) => Number(BigInt(b.reserve) - BigInt(a.reserve)))

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
  const sold = BigInt(listing.sold)
  const held = state.holdings.get(listing.asset) ?? 0n
  return el(
    'button.card',
    {
      class: `card ${listing.asset === state.selected ? 'card-on' : ''}`,
      onclick: () => {
        state.selected = listing.asset
        render()
      },
    },
    el(
      'div.card-top',
      {},
      el('strong', {}, listing.symbol),
      lockBadge(listing),
      stateBadge(listing) ?? el('span.mult', {}, multiple(sold)),
    ),
    el('div.card-name', {}, listing.name),
    el('div.bar', {}, el('div.bar-fill', { style: `width:${Math.min(100, progress(sold))}%` })),
    el('div.card-foot', {}, summarise(listing), held > 0n ? el('span.held', {}, `you: ${formatCoins(held)}`) : null),
  )
}

// --------------------------------------------------------------------- detail

function detail(): HTMLElement {
  const listing = state.facts?.listings.find((entry) => entry.asset === state.selected)
  if (!listing) return el('section.detail', {}, el('p.empty', {}, 'Pick a coin.'))

  const sold = BigInt(listing.sold)
  const held = state.holdings.get(listing.asset) ?? 0n
  const canvas = el('canvas.chart', { width: 640, height: 180 })
  queueMicrotask(() => chart(canvas, listing.history, listing.state))

  return el(
    'section.detail',
    {},
    el(
      'div.detail-head',
      {},
      el('h2', {}, `${listing.symbol} — ${listing.name}`),
      lockBadge(listing),
      stateBadge(listing),
    ),
    listing.blurb ? el('p.blurb', {}, listing.blurb) : null,
    canvas,
    stats(listing, sold, held),
    listing.state === 'trading' ? trade(listing, held) : closed(listing),
    deedRow(listing),
    provenance(listing),
  )
}

function stats(listing: Listing, sold: bigint, held: bigint): HTMLElement {
  const graduation = BigInt(state.facts?.graduation ?? '0')
  const reserve = BigInt(listing.reserve)
  const toGo = graduation > reserve ? graduation - reserve : 0n
  return el(
    'dl.stats',
    {},
    stat('Price', `${price(spotPrice(sold))} Kei`),
    stat('Multiple', multiple(sold)),
    stat('Sold', `${formatCoins(sold)} / ${formatCoins(CURVE_SUPPLY)}`),
    stat('Reserve', `${formatKei(reserve, 6)} Kei`),
    stat('You hold', formatCoins(held)),
    stat('To graduation', listing.state === 'trading' ? `${formatKei(toGo, 4)} Kei` : '—'),
  )
}

const stat = (label: string, value: string): HTMLElement =>
  el('div.stat', {}, el('dt', {}, label), el('dd', {}, value))

function trade(listing: Listing, held: bigint): HTMLElement {
  const spend = el('input.amount', { type: 'text', value: '1', inputmode: 'decimal' })
  const sell = el('input.amount', { type: 'text', value: held > 0n ? held.toString() : '0', inputmode: 'numeric' })
  const sold = BigInt(listing.sold)

  const preview = el('p.preview', {})
  const updatePreview = (): void => {
    try {
      const count = coinsFor(sold, parseKei(spend.value))
      preview.textContent =
        count > 0n ? `≈ ${formatCoins(count)} ${listing.symbol}` : `Not enough for one ${listing.symbol}.`
    } catch {
      preview.textContent = 'That is not an amount of Kei.'
    }
  }
  spend.addEventListener('input', updatePreview)
  queueMicrotask(updatePreview)

  return el(
    'div.trade',
    {},
    el(
      'div.side',
      {},
      el('label', {}, 'Spend (Kei)'),
      spend,
      preview,
      el(
        'button.buy',
        {
          disabled: state.busy,
          onclick: () =>
            void act(`Buying ${listing.symbol}`, async () => {
              await trader.buy(listing.asset, parseKei(spend.value))
            }),
        },
        'Buy',
      ),
    ),
    el(
      'div.side',
      {},
      el('label', {}, `Sell (${listing.symbol})`),
      sell,
      el('p.preview', {}, `You hold ${formatCoins(held)}.`),
      el(
        'button.sell',
        {
          disabled: state.busy || held <= 0n,
          onclick: () =>
            void act(`Selling ${listing.symbol}`, async () => {
              const count = BigInt(sell.value.replace(/[^\d]/g, '') || '0')
              if (count <= 0n) throw new Error('Sell a whole number of coins, more than zero.')
              await trader.sell(listing.asset, count > held ? held : count)
            }),
        },
        'Sell',
      ),
    ),
  )
}

function closed(listing: Listing): HTMLElement {
  return el(
    'div.closed',
    {},
    listing.state === 'graduated'
      ? 'Graduated. The curve is closed and the reserve is locked for good — nobody can empty it, including whoever holds the deed. It trades between players now, because its transfer policy always said it could.'
      : 'Rugged. Someone sent the deed back and the market paid them the entire reserve, exactly as the deed said it would. The coins still exist and are still yours. Nothing will buy them.',
  )
}

function deedRow(listing: Listing): HTMLElement | null {
  if (!state.deeds.has(listing.deed)) return null

  const dead = listing.state !== 'trading'
  return el(
    'div.deed',
    {},
    el('span', {}, 'You hold the deed to this coin.'),
    listing.lock === 'carpet'
      ? el(
          'button.rug',
          {
            disabled: state.busy || dead,
            onclick: () =>
              void act(`Pulling the carpet on ${listing.symbol}`, async () => {
                await trader.rug(listing.deed)
              }),
          },
          dead ? 'Nothing left to pull' : `Pull the carpet — take ${formatKei(BigInt(listing.reserve), 4)} Kei`,
        )
      : el(
          'button.rug',
          {
            // Left enabled on purpose. The refusal is worth seeing, and it comes
            // from the ledger rather than from this button being greyed out.
            disabled: state.busy,
            onclick: () =>
              void act(`Trying to pull the carpet on ${listing.symbol}`, async () => {
                await trader.rug(listing.deed)
              }),
          },
          'Try to pull the carpet',
        ),
  )
}

function provenance(listing: Listing): HTMLElement {
  return el(
    'details.provenance',
    {},
    el('summary', {}, 'What the chain says'),
    el(
      'dl',
      {},
      stat('Coin asset', listing.asset),
      stat('Deed asset', listing.deed),
      stat('Deed transfer policy', listing.lock === 'carpet' ? 'open — the reserve can leave' : 'none — soulbound'),
      stat('Launched by', listing.creator),
    ),
    el(
      'p',
      {},
      'The transfer policy is fixed at issuance and enforced by consensus, not by this market. It is the reason the badge above is a fact rather than a promise.',
    ),
  )
}

// --------------------------------------------------------------------- launch

function launchButton(): HTMLElement {
  const fee = BigInt(state.facts?.launchFee ?? '0')
  return el(
    'button.launch',
    { disabled: state.busy, onclick: () => openLaunch(fee) },
    `Launch a coin — ${formatKei(fee, 2)} Kei`,
  )
}

function openLaunch(fee: bigint): void {
  const symbol = el('input', { type: 'text', placeholder: 'WAGMI', maxlength: 10 })
  const name = el('input', { type: 'text', placeholder: 'We Are All Gonna Make It' })
  const blurb = el('input', { type: 'text', placeholder: 'One line. 140 characters.', maxlength: 140 })
  let lock: ReserveLock = 'nailed-down'

  const choice = (value: ReserveLock, title: string, body: string): HTMLElement => {
    const button = el(
      'button',
      {
        class: `choice ${lock === value ? 'choice-on' : ''}`,
        onclick: () => {
          lock = value
          for (const other of dialog.querySelectorAll('.choice')) other.classList.remove('choice-on')
          button.classList.add('choice-on')
        },
      },
      el('strong', {}, title),
      el('span', {}, body),
    )
    return button
  }

  const dialog = el(
    'div.sheet',
    {},
    el('h2', {}, 'Launch a coin'),
    el(
      'p.fee',
      {},
      `This costs ${formatKei(fee, 4)} Kei and most of it is burned, not collected. `,
      `The market has issued ${String(state.facts?.issued ?? 0)} assets and the nth burns n Kei, so the next coin always costs more than the last one. That is what stops this place filling with junk.`,
    ),
    el('label', {}, 'Symbol'),
    symbol,
    el('label', {}, 'Name'),
    name,
    el('label', {}, 'Blurb'),
    blurb,
    el('label', {}, 'The deed'),
    el(
      'div.choices',
      {},
      choice(
        'nailed-down',
        'Nailed down',
        'The deed is soulbound. The reserve cannot be taken by anyone, ever, including you. Enforced by the chain.',
      ),
      choice(
        'carpet',
        'Carpet',
        'The deed transfers. Send it back to the market and the whole reserve is yours. Buyers can see this before they buy.',
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
                lock,
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

'use client'

/**
 * The board. Everything listed, what has settled lately, and the one that has
 * traded most on top.
 *
 * There is no marketing above this. The page's job is to let somebody judge a
 * coin and then trade it, so the first thing on screen is the coins — a hero
 * paragraph explaining what a launchpad is would push the only useful content
 * below the fold to say something the board says better.
 *
 * Every control here sorts or filters something the registry already sent, and
 * `lib/board.ts` is where the rule that keeps that true lives: a chip is only
 * allowed to exist if there is a field behind it. There is no search box for a
 * field that does not exist and no "volume, 24h" chip over a number nobody
 * computes, because this list is the coins one registry has been told about and
 * a control implying it is the whole network would be the same lie as a market
 * cap.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Activity } from '../components/Activity'
import { CoinCard } from '../components/CoinCard'
import { crown, KingOfTheHill } from '../components/KingOfTheHill'
import { Caveat } from '../components/Caveat'
import { arrange, DEFAULT_QUERY, FILTERS, narrowed, pulse, SORTS, type BoardQuery } from '../lib/board'
import { useMarket } from '../lib/use-market'

export default function Board() {
  const { facts, activity, holdings, trader, fatal, loading } = useMarket()
  const [query, setQuery] = useState<BoardQuery>(DEFAULT_QUERY)
  const search = useRef<HTMLInputElement>(null)

  const listings = useMemo(() => facts?.listings ?? [], [facts])
  const king = useMemo(() => crown(listings), [listings])
  const shown = useMemo(() => arrange(listings, query, holdings), [listings, query, holdings])
  const counts = useMemo(() => pulse(listings), [listings])

  // `/` focuses the search, the way it does in every list this page is competing
  // with. Guarded on the target so it does not steal the key from a field
  // somebody is already typing in.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return
      if (target?.isContentEditable) return
      event.preventDefault()
      search.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const update = useCallback((patch: Partial<BoardQuery>) => setQuery((current) => ({ ...current, ...patch })), [])

  if (fatal) {
    return (
      <section className="panel border-down/50 p-5" role="alert">
        <h2 className="text-sm font-semibold text-[#ffd9d9]">Could not open a wallet in this browser</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-dim">{fatal}</p>
        <p className="mt-3 text-xs leading-relaxed text-fainter">
          The wallet is created here and its key never leaves, so there is nothing to sign in to and nothing to
          restore. A browser with storage disabled cannot hold a seed, which is the usual cause.
        </p>
      </section>
    )
  }

  if (loading && !facts) return <Skeleton />

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Coins listed on Carpet Markets</h1>

      {king && <KingOfTheHill listing={king} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">Search coins by ticker, name, blurb, or address</span>
                <input
                  ref={search}
                  type="search"
                  value={query.text}
                  onChange={(event) => update({ text: event.target.value })}
                  placeholder="Search ticker, name, blurb, or paste an address"
                  className="field w-full px-3 py-2 pr-8 text-sm placeholder:text-fainter"
                />
                <kbd aria-hidden className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line px-1 font-mono text-[10px] text-fainter sm:block">
                  /
                </kbd>
              </label>
              <Chips
                label="Sort by"
                options={SORTS}
                active={query.sort}
                onPick={(sort) => update({ sort })}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Chips
                label="Filter by"
                options={FILTERS}
                active={query.filter}
                onPick={(filter) => update({ filter })}
              />
              <p className="ml-auto font-mono text-[10px] text-fainter tabular" aria-live="polite">
                {shown.length} of {listings.length}
              </p>
            </div>
          </div>

          {shown.length === 0 ? (
            <Empty listed={listings.length} narrowed={narrowed(query)} onClear={() => setQuery(DEFAULT_QUERY)} />
          ) : (
            <ul className="grid list-none gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((listing) => (
                // `min-w-0`, because a grid item's default minimum is its
                // content and one long figure in a card would otherwise push
                // the whole column past the viewport at 360 px.
                <li key={listing.asset} className="min-w-0">
                  <CoinCard listing={listing} held={holdings.get(listing.asset) ?? 0} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside className="min-w-0 space-y-3">
          {/* Counts, not a market cap. Every one of these is a number of things
              that exist rather than a valuation of them. */}
          <dl className="panel grid grid-cols-2 gap-x-3 gap-y-2 p-3 lg:grid-cols-2">
            <Count label="Listed" value={counts.listed} />
            <Count label="Buyable now" value={counts.buyable} accent={counts.buyable > 0} />
            <Count label="Have traded" value={counts.traded} />
            <Count label="Trades" value={counts.trades} />
          </dl>

          <Activity trades={activity} listings={listings} you={trader?.address ?? null} />
        </aside>
      </div>

      <div className="border-t border-line pt-4">
        <Caveat id="account-list" />
      </div>
    </div>
  )
}

function Count({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className={`mt-0.5 font-mono text-lg tabular ${accent ? 'text-gold' : 'text-ink'}`}>{value}</dd>
    </div>
  )
}

/**
 * One choice out of several, which is what these always were.
 *
 * They carried `aria-pressed`, which announces N independent toggles: picking
 * one silently un-presses another, with no "3 of 7" and no relationship between
 * them. The launch screen already met this problem and solved it with real
 * radios (`app/launch/page.tsx`); this is the same fix where the styling makes
 * real inputs awkward — `radiogroup`/`radio`/`aria-checked`, one tab stop, and
 * the arrow keys moving the selection.
 *
 * The hint is a `title` *and* a visually-hidden sentence, because the chip's own
 * text is a two-word label and the hint says which field it sorts on. A tooltip
 * alone is pointer-only.
 */
function Chips<T extends string>({
  label,
  options,
  active,
  onPick,
}: {
  label: string
  options: readonly { key: T; label: string; hint: string }[]
  active: T
  onPick: (key: T) => void
}) {
  const strip = useRef<HTMLDivElement>(null)

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const at = options.findIndex((option) => option.key === active)
    if (at < 0) return
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (at + 1) % options.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (at - 1 + options.length) % options.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? options.length - 1
              : -1
    if (next < 0) return
    event.preventDefault()
    const key = options[next]!.key
    onPick(key)
    strip.current?.querySelector<HTMLButtonElement>(`[data-chip="${key}"]`)?.focus()
  }

  return (
    <div
      ref={strip}
      className="flex flex-wrap items-center gap-1"
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          role="radio"
          data-chip={option.key}
          title={option.hint}
          aria-checked={active === option.key}
          tabIndex={active === option.key ? 0 : -1}
          onClick={() => onPick(option.key)}
          className={`rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors ${
            active === option.key
              ? 'border-gold/60 bg-gold/10 text-gold'
              : 'border-line bg-panel text-fainter hover:border-line-bright hover:text-dim'
          }`}
        >
          {option.label}
          <span className="sr-only"> — {option.hint}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * The board before the first read comes back.
 *
 * Shaped like the cards it is standing in for, because a spinner in the middle
 * of a page says only that something is happening, and this says what.
 */
function Skeleton() {
  return (
    <div className="space-y-3" role="status">
      <span className="sr-only">Reading the board.</span>
      <div className="panel h-32 animate-pulse motion-reduce:animate-none" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((slot) => (
            <div key={slot} className="panel h-28 animate-pulse motion-reduce:animate-none" />
          ))}
        </div>
        <div className="panel hidden h-64 animate-pulse motion-reduce:animate-none lg:block" />
      </div>
    </div>
  )
}

/**
 * The empty board, which is what a visitor sees most often.
 *
 * Two different empties, because they need two different sentences and one of
 * them is not the visitor's fault. A filtered-to-nothing board offers the way
 * back; a genuinely empty one explains that the chain under this page resets.
 */
function Empty({ listed, narrowed, onClear }: { listed: number; narrowed: boolean; onClear: () => void }) {
  if (narrowed) {
    return (
      <div className="panel p-8 text-center">
        <p className="text-sm text-dim">
          Nothing matches that. {listed} {listed === 1 ? 'coin is' : 'coins are'} listed.
        </p>
        <button type="button" onClick={onClear} className="btn-quiet mt-3 px-2.5 py-1 text-xs">
          Clear the filters
        </button>
      </div>
    )
  }
  return (
    <div className="panel p-8 text-center">
      <p className="text-sm text-ink">Nothing is listed yet.</p>
      <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-fainter">
        Launching costs a little over one Kei, almost all of which is burned rather than collected — and the faucet in
        the bar above hands out twenty-five.
      </p>
      <Caveat id="ephemeral-ledger" className="mx-auto mt-3 max-w-md text-left" />
    </div>
  )
}

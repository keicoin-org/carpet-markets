'use client'

/**
 * The board. Everything listed, and the one that has traded most on top.
 *
 * There is no marketing above this. The page's job is to let somebody judge a
 * coin and then trade it, so the first thing on screen is the coins — a hero
 * paragraph explaining what a launchpad is would push the only useful content
 * below the fold to say something the board says better.
 *
 * Every control here sorts or filters something the registry already sent. There
 * is no search box for a field that does not exist and no "volume, 24h" chip
 * over a number nobody computes: this list is the coins one registry has been
 * told about, and a control implying it is the whole network would be the same
 * lie as a market cap.
 */

import { useMemo, useState } from 'react'

import { CoinCard } from '../components/CoinCard'
import { crown, KingOfTheHill } from '../components/KingOfTheHill'
import type { Listing, TransferPolicy } from '../shared/listing'
import { useMarket } from '../lib/use-market'

type Sort = 'new' | 'traded' | 'holders' | 'price' | 'dumped'
type Filter = 'all' | TransferPolicy | 'held'

const SORTS: { key: Sort; label: string; of(listing: Listing): number }[] = [
  { key: 'new', label: 'newest', of: (listing) => listing.launchedAt },
  { key: 'traded', label: 'most traded', of: (listing) => listing.stats?.trades ?? 0 },
  { key: 'holders', label: 'most holders', of: (listing) => listing.stats?.holders ?? 0 },
  { key: 'price', label: 'highest price', of: (listing) => listing.stats?.last ?? -1 },
  {
    key: 'dumped',
    // The one sort the launchpads this is shaped like do not offer.
    label: 'most sold off',
    of: (listing) => -(listing.stats?.creatorHolds ?? listing.supply) / (listing.supply || 1),
  },
]

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'everything' },
  { key: 'open', label: 'tradable' },
  { key: 'issuer-only', label: 'issuer only' },
  { key: 'none', label: 'soulbound' },
  { key: 'held', label: 'you hold' },
]

export default function Board() {
  const { facts, holdings, fatal, loading } = useMarket()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('new')
  const [filter, setFilter] = useState<Filter>('all')

  const listings = facts?.listings
  const king = useMemo(() => (listings ? crown(listings) : null), [listings])

  const shown = useMemo(() => {
    if (!listings) return []
    const needle = query.trim().toLowerCase()
    const matched = listings.filter((listing) => {
      if (filter === 'held' && (holdings.get(listing.asset) ?? 0) <= 0) return false
      if (filter !== 'all' && filter !== 'held' && listing.transfer !== filter) return false
      if (!needle) return true
      return (
        listing.symbol.toLowerCase().includes(needle) ||
        listing.name.toLowerCase().includes(needle) ||
        listing.blurb.toLowerCase().includes(needle)
      )
    })
    const by = SORTS.find((entry) => entry.key === sort) ?? SORTS[0]
    return matched.sort((a, b) => by!.of(b) - by!.of(a))
  }, [listings, holdings, query, sort, filter])

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
    <div className="space-y-5">
      {king && <KingOfTheHill listing={king} />}

      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search ticker, name, or blurb"
            aria-label="Search coins by ticker, name, or blurb"
            className="min-w-0 flex-1 rounded-md border border-line bg-panel px-3 py-2 text-sm placeholder:text-fainter focus:border-line-bright"
          />
          <Chips label="Sort by" options={SORTS} active={sort} onPick={setSort} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Chips label="Filter by policy" options={FILTERS} active={filter} onPick={setFilter} />
          <p className="ml-auto font-mono text-[10px] text-fainter tabular" aria-live="polite">
            {shown.length} of {listings?.length ?? 0}
          </p>
        </div>
      </div>

      {shown.length === 0 ? (
        <Empty listed={listings?.length ?? 0} narrowed={query.trim().length > 0 || filter !== 'all'} />
      ) : (
        <ul className="grid list-none gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((listing) => (
            <li key={listing.asset}>
              <CoinCard listing={listing} held={holdings.get(listing.asset) ?? 0} />
            </li>
          ))}
        </ul>
      )}

      <p className="border-t border-line pt-4 text-[11px] leading-relaxed text-fainter">
        This is the list of coins one registry has been told about, not the network. An offer written by a wallet that
        never announced itself is perfectly valid, settles perfectly well, and is not on this page — which is what it
        means for a chain to ship no indexer.
      </p>
    </div>
  )
}

/** A row of toggles, which is what a segmented control is when it is honest. */
function Chips<T extends string>({
  label,
  options,
  active,
  onPick,
}: {
  label: string
  options: readonly { key: T; label: string }[]
  active: T
  onPick: (key: T) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          aria-pressed={active === option.key}
          onClick={() => onPick(option.key)}
          className={`rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors ${
            active === option.key
              ? 'border-gold/60 bg-gold/10 text-gold'
              : 'border-line bg-panel text-fainter hover:border-line-bright hover:text-dim'
          }`}
        >
          {option.label}
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
    <div className="space-y-2.5" role="status" aria-label="Loading the board">
      <div className="panel h-28 animate-pulse motion-reduce:animate-none" />
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((slot) => (
          <div key={slot} className="panel h-24 animate-pulse motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  )
}

/**
 * The empty board, which is what a visitor sees most often.
 *
 * The chain is a mock in one Durable Object, so it resets whenever that object
 * is evicted and the list goes empty on its own. Saying that here is better than
 * letting somebody conclude the demo is broken, and it is the same paragraph the
 * examples page carries.
 */
function Empty({ listed, narrowed }: { listed: number; narrowed: boolean }) {
  if (narrowed) {
    return (
      <p className="panel p-8 text-center text-sm text-dim">
        Nothing matches that. {listed} {listed === 1 ? 'coin is' : 'coins are'} listed.
      </p>
    )
  }
  return (
    <div className="panel p-8 text-center">
      <p className="text-sm text-ink">Nothing is listed yet.</p>
      <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-fainter">
        Launching costs a little over one Kei, almost all of which is burned rather than collected — and the faucet in
        the bar above hands out twenty-five. The chain under this page lives in memory, so an empty board usually means
        it restarted rather than that nobody has been here.
      </p>
    </div>
  )
}

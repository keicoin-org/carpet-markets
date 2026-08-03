'use client'

/**
 * The board. Everything listed, and the one that has traded most on top.
 *
 * There is no marketing above this. The page's job is to let somebody judge a
 * coin and then trade it, so the first thing on screen is the coins — a hero
 * paragraph explaining what a launchpad is would push the only useful content
 * below the fold to say something the board says better.
 */

import { useMemo, useState } from 'react'

import { CoinCard } from '../components/CoinCard'
import { crown, KingOfTheHill } from '../components/KingOfTheHill'
import type { Listing } from '../shared/listing'
import { useMarket } from '../lib/use-market'

type Sort = 'new' | 'traded' | 'holders' | 'price' | 'dumped'

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

export default function Board() {
  const { facts, holdings, fatal, trader } = useMarket()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('new')

  const listings = facts?.listings
  const king = useMemo(() => (listings ? crown(listings) : null), [listings])

  const shown = useMemo(() => {
    if (!listings) return []
    const needle = query.trim().toLowerCase()
    const matched = needle
      ? listings.filter(
          (listing) =>
            listing.symbol.toLowerCase().includes(needle) ||
            listing.name.toLowerCase().includes(needle) ||
            listing.blurb.toLowerCase().includes(needle),
        )
      : [...listings]
    const by = SORTS.find((entry) => entry.key === sort) ?? SORTS[0]
    return matched.sort((a, b) => by!.of(b) - by!.of(a))
  }, [listings, query, sort])

  if (fatal) {
    return (
      <p className="panel border-down/50 p-5 text-sm text-[#ffd9d9]">
        Could not open a wallet in this browser: {fatal}
      </p>
    )
  }

  if (!trader || !facts) {
    return <p className="py-16 text-center text-sm text-fainter">Opening a wallet…</p>
  }

  return (
    <div className="space-y-5">
      {king && <KingOfTheHill listing={king} />}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search ticker, name, or blurb"
          aria-label="Search coins"
          className="min-w-0 flex-1 rounded-md border border-line bg-panel px-3 py-2 text-sm placeholder:text-fainter focus:border-line-bright focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-1">
          {SORTS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setSort(entry.key)}
              className={`rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors ${
                sort === entry.key
                  ? 'border-gold/60 bg-gold/10 text-gold'
                  : 'border-line bg-panel text-fainter hover:border-line-bright hover:text-dim'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <Empty listed={facts.listings.length} searching={query.trim().length > 0} />
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((listing) => (
            <CoinCard key={listing.asset} listing={listing} held={holdings.get(listing.asset) ?? 0} />
          ))}
        </div>
      )}
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
function Empty({ listed, searching }: { listed: number; searching: boolean }) {
  if (searching) {
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

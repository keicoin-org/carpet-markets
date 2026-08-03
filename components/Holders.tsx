'use client'

/**
 * Who holds it.
 *
 * The percentages are of the coin's supply and never of the rows, and the table
 * says so at the bottom when they do not add up. That is not a rounding
 * disclaimer — the registry can only ask about accounts it has heard of
 * (SPEC §9.4 ships no indexer), so a holder who has never touched this page is
 * missing from the list and present on the chain. A table normalised to 100%
 * would be quietly inventing the denominator.
 */

import { formatCoins, shortAddress } from '../shared/format'
import type { Holder, Listing } from '../shared/listing'

export function Holders({ listing, holders, you }: { listing: Listing; holders: Holder[]; you: string | null }) {
  const seen = holders.reduce((total, holder) => total + holder.amount, 0)
  const covered = listing.supply > 0 ? seen / listing.supply : 0

  return (
    <section className="panel p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="eyebrow">Holders</h3>
        <span className="font-mono text-[10px] text-fainter tabular">{holders.length}</span>
      </div>

      {holders.length === 0 ? (
        <p className="py-4 text-center text-xs text-fainter">Nobody the registry knows about holds any.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {holders.map((holder) => {
            const share = listing.supply > 0 ? (holder.amount / listing.supply) * 100 : 0
            return (
              <li key={holder.address} className="grid grid-cols-[1fr_auto] items-center gap-x-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    title={holder.address}
                    className={`truncate font-mono text-[11px] ${
                      holder.address === you ? 'text-gold' : 'text-dim'
                    }`}
                  >
                    {shortAddress(holder.address, 5)}
                  </span>
                  {holder.creator && (
                    <span className="shrink-0 rounded border border-line px-1 font-mono text-[9px] uppercase tracking-[0.08em] text-fainter">
                      creator
                    </span>
                  )}
                  {holder.address === you && (
                    <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] text-gold">you</span>
                  )}
                </span>
                <span className="font-mono text-[11px] text-dim tabular">
                  {formatCoins(holder.amount)}
                  <span className="ml-1.5 text-fainter">{share.toFixed(share < 1 && share > 0 ? 2 : 0)}%</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {covered < 0.995 && holders.length > 0 && (
        <p className="mt-2 border-t border-line pt-2 text-[10px] leading-relaxed text-fainter">
          These rows cover {(covered * 100).toFixed(0)}% of the supply. The rest is held by accounts this registry has
          never been told to read — which is what it means for a chain to ship no indexer.
        </p>
      )}
    </section>
  )
}

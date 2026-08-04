/**
 * How much of the supply the launcher is still holding.
 *
 * The launchpads this page is shaped like put a bonding-curve progress bar in
 * this spot: how close a coin is to graduating, which is a countdown to good
 * news. This is the same bar pointed the other way. It starts full, because the
 * creator was minted everything, and it empties as they sell — so the bar going
 * down is the distribution happening, and a full bar under a rising chart is a
 * rally nobody has sold into yet.
 *
 * It is gold rather than red at every level. A creator holding their own supply
 * is not misconduct and colouring it as an alarm would be editorialising; what
 * the page owes a reader is the number, prominently, next to the price.
 */

import { formatCoins } from '../shared/format'
import type { Listing } from '../shared/listing'

export function SupplyMeter({ listing, compact = false }: { listing: Listing; compact?: boolean }) {
  const held = listing.stats?.creatorHolds ?? listing.supply
  const share = listing.supply > 0 ? Math.min(1, Math.max(0, held / listing.supply)) : 0
  const percent = share * 100

  // Two significant figures near the ends, none in the middle: "99.4%" and
  // "0.2%" are both news, "43.7%" is not more useful than "44%".
  const label = percent > 0 && percent < 1 ? percent.toFixed(1) : percent.toFixed(percent > 99 && percent < 100 ? 1 : 0)

  return (
    <div className={compact ? '' : 'panel p-3'}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="eyebrow">Creator still holds</span>
        <span className="font-mono text-sm tabular">{label}%</span>
      </div>
      <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-gold transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </div>
      {!compact && (
        <p className="mt-2 font-mono text-[10px] text-fainter tabular">
          {formatCoins(held)} of {formatCoins(listing.supply)}
          {listing.transfer !== 'open' && ' · and cannot move'}
        </p>
      )}
    </div>
  )
}

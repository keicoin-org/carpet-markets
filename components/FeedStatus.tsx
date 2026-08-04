'use client'

/**
 * How old the numbers are, in the bar, beside which chain they came from.
 *
 * The badge next to this answers "which ledger is this" and never guesses. This
 * answers the other half — "and are we still reading it" — which was previously
 * answered nowhere. A page whose poll has been failing for a minute renders
 * exactly like a page where nothing has happened for a minute, and on a market
 * screen those are opposite facts: one means the market is quiet and the other
 * means you are looking at a photograph.
 *
 * It is deliberately quiet while everything is fine. A "live" dot that pulses in
 * the corner of a trading page is the kind of thing that teaches people to stop
 * seeing it, and then it is not there when it matters — so `live` is one small
 * word and the two failing states are the ones that gain colour.
 *
 * The age ticks on its own second, independent of the poll, because a feed that
 * has stopped answering is precisely the case where nothing else re-renders.
 */

import { useEffect, useState } from 'react'

import { feedStatus, type FeedLevel } from '../lib/feed'
import { useMarket } from '../lib/use-market'

const LOOK: Record<FeedLevel, string> = {
  opening: 'text-fainter',
  live: 'text-fainter',
  lagging: 'text-gold',
  down: 'text-down',
}

const DOT: Record<FeedLevel, string> = {
  opening: 'bg-line-bright',
  live: 'bg-up/70',
  lagging: 'bg-gold',
  down: 'bg-down',
}

export function FeedStatus() {
  const { feed } = useMarket()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])

  const status = feedStatus(feed, now)

  return (
    <span
      title={status.sentence}
      className={`inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] ${
        LOOK[status.level]
      }`}
    >
      <span className={`inline-block size-1.5 rounded-full ${DOT[status.level]}`} aria-hidden />
      {status.label}
      {/* Only the two failing levels are announced. A polite region that says
          "live" every second is a region somebody turns off. */}
      <span className="sr-only" aria-live="polite">
        {status.level === 'lagging' || status.level === 'down' ? status.sentence : ''}
      </span>
    </span>
  )
}

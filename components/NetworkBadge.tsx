'use client'

/**
 * Which chain this is, in the bar, on every page.
 *
 * It is a link rather than a tooltip because the honest version of this fact
 * does not fit in a tooltip, and it is in the header rather than the footer
 * because a person deciding whether to spend money reads the top of the page.
 * The three looks are deliberately not interchangeable: a mock chain gets a
 * dashed border because it is a stand-in, a live network gets a solid one and a
 * pulse because blocks are actually going somewhere, and mainnet gets struck
 * through because it is refused rather than pending.
 *
 * The mode comes off `/market/facts`, so this badge cannot disagree with the
 * server it is talking to. That is the whole reason it is not a build constant.
 */

import Link from 'next/link'

import { NETWORKS, type NetworkFacts } from '../shared/network'

const LOOKS = {
  mock: 'border-dashed border-line-bright bg-raised text-dim',
  live: 'border-up/50 bg-up/10 text-up',
  refused: 'border-down/60 bg-down/10 text-down line-through',
} as const

export function NetworkBadge({ chain, compact = false }: { chain: NetworkFacts | null; compact?: boolean }) {
  if (!chain) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-fainter">
        connecting…
      </span>
    )
  }

  const network = NETWORKS[chain.mode]

  return (
    <Link
      href="/network"
      title={network.summary}
      className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] transition-opacity hover:opacity-80 ${LOOKS[network.tone]}`}
    >
      <span
        aria-hidden
        className={`inline-block size-1.5 rounded-full ${
          network.tone === 'live' ? 'bg-up motion-safe:animate-pulse' : network.tone === 'mock' ? 'bg-dim' : 'bg-down'
        }`}
      />
      {network.label}
      {!compact && chain.node && (
        <span className="hidden text-fainter normal-case tracking-normal md:inline">{hostOf(chain.node)}</span>
      )}
      <span className="sr-only">. {network.summary} Select for the full explanation.</span>
    </Link>
  )
}

/** The host, because the path is `/rpc` on every node and says nothing. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

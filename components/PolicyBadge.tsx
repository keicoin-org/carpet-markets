/**
 * The one thing on the page a player has to read before they buy.
 *
 * It says what the *chain* will permit, not what the site promises. All three
 * are honest and only one of them is safe, and the unsafe one is unsafe in the
 * ordinary way markets are: whoever is holding the most of something can sell
 * it, whenever they like, in whatever size they like, to you.
 *
 * This is the loudest element on a coin card, which is the deliberate inversion
 * of the launchpads this page is shaped like. There, the market cap is set in
 * the biggest type on the card and the thing that decides whether you can be
 * dumped on is a line of grey text somewhere below the fold, if it is anywhere.
 * Here the risk is the headline and the price is a footnote, because the risk is
 * the only number on the card that consensus actually enforces.
 *
 * **It is also a link, and that is the half of criterion 7 that was missing.**
 * The badge used to be a `<span title=…>`: unreachable by keyboard, invisible on
 * a phone, and — worse — sourced from the same registry JSON as everything else
 * on the card, so it restated a claim rather than evidencing one. It now goes to
 * `components/LedgerFact.tsx`, which reads the asset record off the node and
 * says whether the two agree. A badge you can check is a different object from a
 * badge you are asked to believe.
 */

import Link from 'next/link'

import type { Listing, TransferPolicy } from '../shared/listing'

interface Look {
  label: string
  /** The short form, for a tooltip. The long form lives at the destination. */
  title: string
  className: string
  dot: string
}

const LOOKS: Record<TransferPolicy, Look> = {
  open: {
    label: 'CAN BE DUMPED',
    title:
      'transfer: open. Anybody can send this coin to anybody, so a real order book exists — and so does the creator, who was minted the entire supply and can sell it into that book at any pace they choose. Consensus permits that. Nothing here will stop it.',
    className: 'border-down/60 bg-down/10 text-down hover:bg-down/20',
    dot: 'bg-down',
  },
  'issuer-only': {
    title:
      'transfer: issuer-only, immutably, from issuance. Units move only to or from the issuing account, so no offer between two holders is a valid block. There is no player-to-player market for this coin and there cannot be one.',
    label: 'ISSUER ONLY',
    className: 'border-line-bright bg-raised text-dim hover:border-line-bright hover:text-ink',
    dot: 'bg-dim',
  },
  none: {
    label: 'SOULBOUND',
    title:
      'transfer: none, immutably, from issuance. These units cannot move at all, so they cannot be locked into an offer and cannot be sold. Nobody can dump this on you, including whoever made it.',
    className: 'border-up/50 bg-up/10 text-up hover:bg-up/20',
    dot: 'bg-up',
  },
}

/**
 * Where the badge goes.
 *
 *   card    to the coin's own page, landing on the ledger panel. Used on the
 *           board, where the fact is one navigation away.
 *   anchor  down the page to the same panel, which is already rendered. Used on
 *           the coin page, where it is a scroll rather than a load.
 *   static  nowhere. Used on the launch screen's preview, where the coin does
 *           not exist yet and so has no ledger record to link to — a badge
 *           promising evidence that cannot exist would be the one dishonest
 *           thing on a page about what the chain will and will not enforce.
 */
export type BadgeTarget = 'card' | 'anchor' | 'static'

export function PolicyBadge({
  listing,
  large = false,
  target = 'anchor',
}: {
  listing: Listing
  large?: boolean
  target?: BadgeTarget
}) {
  const look = LOOKS[listing.transfer]
  const className = `relative z-10 inline-flex items-center gap-1.5 rounded border font-mono uppercase tracking-[0.12em] transition-colors ${
    look.className
  } ${large ? 'px-2.5 py-1 text-[11px]' : 'px-1.5 py-0.5 text-[9px]'}`

  // The visible text is a policy, not a destination, so the destination is said
  // to a screen reader rather than left to be inferred from a link that reads
  // "CAN BE DUMPED" and goes somewhere unannounced.
  const inner = (
    <>
      <span className={`inline-block size-1.5 rounded-full ${look.dot}`} aria-hidden />
      {look.label}
      {target === 'static' ? (
        <span className="sr-only"> — transfer policy {listing.transfer}, chosen now and immutable after issuance.</span>
      ) : (
        <span className="sr-only"> — transfer policy {listing.transfer}. Read the ledger record that backs it.</span>
      )}
    </>
  )

  if (target === 'static') {
    return (
      <span title={look.title} className={className}>
        {inner}
      </span>
    )
  }

  if (target === 'anchor') {
    return (
      <a href="#ledger" title={look.title} className={className}>
        {inner}
      </a>
    )
  }

  return (
    <Link
      href={{ pathname: '/coin', query: { asset: listing.asset }, hash: 'ledger' }}
      title={look.title}
      className={className}
    >
      {inner}
    </Link>
  )
}

/** The same fact as a sentence, for the places a badge is too terse. */
export function policySentence(transfer: TransferPolicy): string {
  return LOOKS[transfer].title
}

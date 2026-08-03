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
 */

import type { Listing, TransferPolicy } from '../shared/listing'

interface Look {
  label: string
  title: string
  className: string
  dot: string
}

const LOOKS: Record<TransferPolicy, Look> = {
  open: {
    label: 'CAN BE DUMPED',
    title:
      'transfer: open. Anybody can send this coin to anybody, so a real order book exists — and so does the creator, who was minted the entire supply and can sell it into that book at any pace they choose. Consensus permits that. Nothing here will stop it.',
    className: 'border-down/60 bg-down/10 text-down',
    dot: 'bg-down',
  },
  'issuer-only': {
    label: 'ISSUER ONLY',
    title:
      'transfer: issuer-only, immutably, from issuance. Units move only to or from the issuing account, so no offer between two holders is a valid block. There is no player-to-player market for this coin and there cannot be one.',
    className: 'border-line-bright bg-raised text-dim',
    dot: 'bg-dim',
  },
  none: {
    label: 'SOULBOUND',
    title:
      'transfer: none, immutably, from issuance. These units cannot move at all, so they cannot be locked into an offer and cannot be sold. Nobody can dump this on you, including whoever made it.',
    className: 'border-up/50 bg-up/10 text-up',
    dot: 'bg-up',
  },
}

export function PolicyBadge({ listing, large = false }: { listing: Listing; large?: boolean }) {
  const look = LOOKS[listing.transfer]
  return (
    <span
      title={look.title}
      className={`inline-flex cursor-help items-center gap-1.5 rounded border font-mono uppercase tracking-[0.12em] ${look.className} ${
        large ? 'px-2.5 py-1 text-[11px]' : 'px-1.5 py-0.5 text-[9px]'
      }`}
    >
      <span className={`inline-block size-1.5 rounded-full ${look.dot}`} aria-hidden />
      {look.label}
    </span>
  )
}

/** The same fact as a sentence, for the places a badge is too terse. */
export function policySentence(transfer: TransferPolicy): string {
  return LOOKS[transfer].title
}

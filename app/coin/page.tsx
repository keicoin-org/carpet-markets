/** The route and its title. See `app/launch/page.tsx` for why these are split. */

import type { Metadata } from 'next'

import { CoinScreen } from './coin-screen'

export const metadata: Metadata = {
  // The coin is a query parameter read in the browser, so the title cannot name
  // it at build time. It names the screen, which is what changed.
  title: 'Coin',
  description: 'One coin: its order book, what it has settled for, who holds it, and the ledger record behind its transfer policy.',
}

export default function CoinPage() {
  return <CoinScreen />
}

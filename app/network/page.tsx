/** The route and its title. See `app/launch/page.tsx` for why these are split. */

import type { Metadata } from 'next'

import { NetworkScreen } from './network-screen'

export const metadata: Metadata = {
  title: 'Which chain is under this',
  description:
    'Mock, public testnet, and the mainnet this demo refuses by name. What each one is, what the readiness probe found, and the five gates that are not a schedule.',
}

export default function NetworkPage() {
  return <NetworkScreen />
}

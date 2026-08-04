import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { Header } from '../components/Header'
import { TxTray } from '../components/TxTray'
import { MarketProvider } from '../lib/use-market'
import './globals.css'

export const metadata: Metadata = {
  title: 'Carpet Markets — launch a coin on Kei',
  description:
    'A coin launchpad where the difference between a rug and a real one is a transfer policy the chain enforces. A Kei example. Nothing here is worth anything.',
  icons: { icon: './favicon.ico' },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        {/* The bar is sticky and holds the faucet and the launch button, so a
            keyboard visitor otherwise tabs through them on every page before
            reaching anything. */}
        <a
          href="#board"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:border focus:border-gold focus:bg-floor focus:px-3 focus:py-2 focus:text-sm"
        >
          Skip to the coins
        </a>

        <MarketProvider>
          <Header />
          <main id="board" className="mx-auto w-full max-w-7xl flex-1 px-3 py-4 sm:px-4 sm:py-5">
            {children}
          </main>

          <footer className="mx-auto w-full max-w-7xl border-t border-line px-3 py-6 text-xs leading-relaxed text-fainter sm:px-4">
            A worked example for{' '}
            <a href="https://keicoin.org" className="text-gold hover:underline">
              Kei
            </a>
            . The rug is a mechanic rather than a warning, which is the only setting in which it is safe to show you
            exactly how one works — every coin here is worthless by construction, on{' '}
            {/* A `Link`, not an `<a>`: the deployed copy lives under a base path
                and a root-relative href would 404 there. */}
            <Link href="/network" className="text-gold hover:underline">
              a chain that says so
            </Link>
            . The order book and the price history are read off that chain; the reply threads are not, and say so.{' '}
            <a href="https://github.com/keicoin-org/carpet-markets" className="text-gold hover:underline">
              Source
            </a>
            .
          </footer>

          <TxTray />
        </MarketProvider>
      </body>
    </html>
  )
}

import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { Header } from '../components/Header'
import { Toast } from '../components/Toast'
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
        <MarketProvider>
          <Header />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5">{children}</main>

          <footer className="mx-auto w-full max-w-6xl border-t border-line px-4 py-6 text-xs leading-relaxed text-fainter">
            A worked example for{' '}
            <a href="https://keicoin.org" className="text-gold hover:underline">
              Kei
            </a>
            . The chain under this page is a mock, every coin on it is worthless by construction, and the rug is a
            mechanic rather than a warning — which is the only setting in which it is safe to show you exactly how one
            works. The order book and the price history are read off the chain; the reply threads are not, and say so.{' '}
            <a href="https://github.com/keicoin-org/carpet-markets" className="text-gold hover:underline">
              Source
            </a>
            .
          </footer>

          <Toast />
        </MarketProvider>
      </body>
    </html>
  )
}

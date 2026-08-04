/**
 * The route, so it can have a title of its own.
 *
 * Every screen here shared one `<title>` — four different pages announcing
 * "Carpet Markets" on a client-routed app, where the title is the only thing a
 * screen reader says when the URL changes (WCAG 2.4.2). `metadata` can only be
 * exported from a server component, and the screen holds state and a wallet, so
 * the two are separated: this file is the route and the title, and
 * `launch-screen.tsx` is the page.
 */

import type { Metadata } from 'next'

import { LaunchScreen } from './launch-screen'

export const metadata: Metadata = {
  title: 'Launch a coin',
  description:
    'Name a coin, choose who may ever move it, and pay a flat fee to be minted the whole supply. The transfer policy is fixed at issuance and enforced by consensus.',
}

export default function LaunchPage() {
  return <LaunchScreen />
}

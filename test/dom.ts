/**
 * A DOM, and the smallest thing that renders React into it.
 *
 * The repository had no way to assert that anything reached the screen. 93 of
 * its 118 tests were pure functions, `lib/refusals.ts` was checked sentence by
 * sentence and never checked to be *rendered*, and SPEC §9.6's criteria 2, 4, 6
 * and 9 are all claims about what a person sees. A test that asserts a blocker
 * returns the right sentence and never asserts the panel prints it is testing
 * half of the thing the criterion is about.
 *
 * `happy-dom` and React's own `act` rather than a testing library, because the
 * whole surface needed is: put a tree in a document, flush its effects, read the
 * text, dispatch a key. Three functions. A library that wraps them would be more
 * dependency than assertion.
 *
 * Registered per-file rather than by a `bunfig.toml` preload, so the ledger
 * tests keep running in a plain Bun process with no globals they did not ask
 * for — a `document` in scope changes what `Kei.start()` believes it is running
 * inside, and `Kei.server()` is required to refuse a browser (SPEC §6.3).
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'

let registered = false

/** Install `window`, `document` and friends. Idempotent. */
export function useDom(): void {
  if (registered) return
  GlobalRegistrator.register({ url: 'https://carpet.test/' })
  // React 19 refuses to run `act` without this and warns without the flag.
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  registered = true
}

export interface Rendered {
  container: HTMLElement
  /** Everything the tree renders, whitespace collapsed, for substring assertions. */
  text(): string
  /** Every element a keyboard can reach, in document order. */
  focusables(): HTMLElement[]
  find<T extends Element = HTMLElement>(selector: string): T
  all<T extends Element = HTMLElement>(selector: string): T[]
  /** The accessible name, as far as the four mechanisms this app actually uses. */
  name(element: Element): string
  press(element: Element, key: string): void
  click(element: Element): void
  unmount(): void
}

/** Render a tree, flush its effects, and hand back a few ways to look at it. */
export function render(element: ReactElement): Rendered {
  useDom()
  const container = document.createElement('div')
  document.body.append(container)

  let root: Root
  act(() => {
    root = createRoot(container)
    root.render(element)
  })

  const view: Rendered = {
    container,
    text: () => (container.textContent ?? '').replace(/\s+/g, ' ').trim(),
    focusables: () =>
      [
        ...container.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((node) => !node.hasAttribute('disabled')),
    find: <T extends Element = HTMLElement>(selector: string): T => {
      const found = container.querySelector<T>(selector)
      if (!found) throw new Error(`Nothing in the render matched "${selector}".`)
      return found
    },
    all: <T extends Element = HTMLElement>(selector: string): T[] => [...container.querySelectorAll<T>(selector)],
    name: (node) => accessibleName(node),
    press: (node, key) => {
      act(() => {
        node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      })
    },
    click: (node) => {
      act(() => {
        node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
      })
    },
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }

  return view
}

/**
 * The accessible name, computed only as far as this application goes.
 *
 * Not a general implementation of accname — those are long and this repository
 * uses exactly four mechanisms: `aria-label`, `aria-labelledby`, a wrapping or
 * `for`-associated `<label>`, and text content. Anything beyond that would be
 * scaffolding for a case that does not exist here, and the point of the helper
 * is that a test can say what a screen reader would announce.
 */
function accessibleName(node: Element): string {
  const label = node.getAttribute('aria-label')
  if (label) return collapse(label)

  const by = node.getAttribute('aria-labelledby')
  if (by) {
    const parts = by
      .split(/\s+/)
      .map((id) => node.ownerDocument.getElementById(id)?.textContent ?? '')
      .filter(Boolean)
    if (parts.length > 0) return collapse(parts.join(' '))
  }

  const id = node.getAttribute('id')
  if (id) {
    const associated = node.ownerDocument.querySelector(`label[for="${id}"]`)
    if (associated) return collapse(associated.textContent ?? '')
  }

  const wrapping = node.closest('label')
  if (wrapping) return collapse(wrapping.textContent ?? '')

  return collapse(node.textContent ?? '')
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

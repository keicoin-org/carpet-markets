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
 * text, dispatch a key, type into a field. Four functions. A library that wraps
 * them would be more dependency than assertion.
 *
 * Registered per-file rather than by a `bunfig.toml` preload, so the ledger
 * tests keep running in a plain Bun process with no globals they did not ask
 * for — a `document` in scope changes what `Kei.start()` believes it is running
 * inside, and `Kei.server()` is required to refuse a browser (SPEC §6.3).
 *
 * The registration below happens at module scope, above the `react-dom` import,
 * and the order is the whole of #23. `react-dom` decides at *evaluation* time
 * whether it is running in a browser (`canUseDOM`), and from that one boolean it
 * derives, among other things, `isInputEventSupported`. Evaluated with no
 * `window` in scope it concludes there is no `input` event, and its change
 * plugin falls back for the rest of the process to the IE9 path: it ignores
 * `input` and `change` on a text field entirely and watches `focusin`,
 * `keydown`, `keyup` and `selectionchange` instead — which is why a `keydown` on
 * a `<div>` arrived normally while nothing dispatched at an `<input>` ever
 * reached `onChange`, and why that path threw `null is not an object (evaluating
 * 'inst.tag')`: it asks for the fiber of an element it never saw focused.
 *
 * So happy-dom was never the problem and neither was React. A static
 * `import ... from 'react-dom/client'` is hoisted above every statement in this
 * file, `GlobalRegistrator.register()` included, and that is the bug. Nothing
 * here may import `react` or `react-dom` statically.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ReactElement } from 'react'
import type { Root } from 'react-dom/client'

let registered = false

/**
 * Every view still mounted, so that a leaked one can be found and closed.
 *
 * A count would do for the bookkeeping and would not do for the failure. A test
 * that throws before its `unmount()` leaves the `document` installed, and the
 * next file to call `Kei.server()` is refused for looking like a browser
 * (SPEC §6.3) — so one wrong assertion about a panel reappears three files later
 * as a chain that will not start, which is the least useful shape a failure can
 * take. `unmountAll()` in an `afterEach` closes the leak at the file that caused
 * it.
 */
const live = new Set<() => void>()

/** Install `window`, `document` and friends. Idempotent. */
export function useDom(): void {
  if (registered) return
  GlobalRegistrator.register({ url: 'https://carpet.test/' })
  // React 19 refuses to run `act` without this and warns without the flag.
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  registered = true
}

useDom()
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')

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
  /**
   * Type into a text field, one keystroke at a time, replacing what is there.
   *
   * A character at a time rather than one assignment, because the field this
   * exists for is an Amount and the states on the way to `2.5` include `2.` —
   * a string `parseCoins` calls malformed. A panel that renders the end of a
   * number but throws in the middle of one is broken for every person who types
   * a decimal, and a helper that sets the value once would never find out.
   */
  type(element: Element, text: string): void
  unmount(): void
}

/**
 * Put a value into an input the way a keystroke does, not the way code does.
 *
 * React installs its own `value` accessor on each controlled node and uses it
 * to remember what it last rendered; a write through that accessor updates the
 * memory as well, so React compares the new value against itself, sees no
 * change, and drops the event. Writing through the prototype's accessor sets
 * the field and leaves React's memory stale, which is exactly the state a real
 * keystroke leaves behind.
 */
function keystroke(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')
  if (!descriptor?.set) throw new Error('This element has no settable value; it is not a text field.')
  descriptor.set.call(input, value)
  input.dispatchEvent(new window.InputEvent('input', { bubbles: true, cancelable: false }))
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

  let mounted = true
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
    type: (node, text) => {
      const field = node as HTMLInputElement | HTMLTextAreaElement
      act(() => {
        field.focus()
        keystroke(field, '')
      })
      for (const character of text) {
        act(() => keystroke(field, field.value + character))
      }
    },
    unmount: () => {
      if (!mounted) return
      mounted = false
      act(() => root.unmount())
      container.remove()
      live.delete(view.unmount)
      if (live.size === 0) {
        registered = false
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
        // unregister() removes the globals before its first await; the remaining
        // promise only closes Happy DOM's window. Do not let one component test
        // make a later server test look like it is running in a browser.
        void GlobalRegistrator.unregister()
      }
    },
  }

  live.add(view.unmount)
  return view
}

/**
 * Close anything still mounted, whether or not its test got that far.
 *
 * For an `afterEach`, so that a failed assertion costs one failure rather than
 * every server test that runs after it.
 */
export function unmountAll(): void {
  for (const close of [...live]) close()
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

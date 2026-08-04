'use client'

/**
 * A tablist that behaves like one.
 *
 * There were two hand-rolled tab strips here — Buy/Sell on the trade panel and
 * Trades/Replies on the coin page — and they had the same four defects, which is
 * the usual argument for one implementation:
 *
 *   1. Every tab pointed `aria-controls` at an id derived from the *selected*
 *      tab, so the unselected tab's reference was always dangling. A broken
 *      IDREF defeats the "jump to the controlled panel" command that is the
 *      whole reason a screen-reader user is told a tablist is a tablist.
 *   2. Every tab was its own tab stop. The ARIA pattern makes a tablist one stop
 *      and moves between tabs with the arrow keys, which is what a person who
 *      has met a tablist before will try.
 *   3. The panel was not focusable, and the trade log inside it contains no
 *      focusable elements at all — so activating a tab and pressing Tab jumped
 *      clean past the content the tab had just revealed. There was no way to
 *      put focus in it.
 *   4. Selection was signalled by colour alone on one of the two strips.
 *
 * Selection follows focus, which is the right choice here because both panels
 * are already loaded — the pattern only recommends manual activation when
 * revealing a panel is expensive, and neither of these fetches anything.
 *
 * The strip is generic over its key type so a caller keeps its own union rather
 * than stringly-typing the state it already had.
 */

import { useId, useRef, type ReactNode } from 'react'

export interface Tab<K extends string> {
  key: K
  label: ReactNode
  /** Overrides the accessible name where the label is decorated with a count. */
  name?: string
  /** Selected-state classes. Colour alone is not enough; pass a border too. */
  selectedClassName?: string
}

export function Tabs<K extends string>({
  label,
  tabs,
  active,
  onPick,
  className = '',
  tabClassName = '',
  children,
  after,
}: {
  /** Names the group, e.g. "Buy or sell". Required — a tablist without one is a puzzle. */
  label: string
  tabs: readonly Tab<K>[]
  active: K
  onPick: (key: K) => void
  className?: string
  tabClassName?: string
  /** The selected panel's content. One panel, reused — see the `aria-controls` note. */
  children: ReactNode
  /** Rendered beside the strip, outside the tablist, where a non-tab child belongs. */
  after?: ReactNode
}) {
  const panelId = useId()
  const strip = useRef<HTMLDivElement>(null)

  /**
   * Left/Right wrap, Home/End jump.
   *
   * Focus is moved by finding the button in the DOM rather than by holding refs
   * per tab: the strip is small, the query is exact, and a ref array that has to
   * stay in step with a prop is a second thing to get wrong.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const at = tabs.findIndex((tab) => tab.key === active)
    if (at < 0) return

    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (at + 1) % tabs.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (at - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : -1

    if (next < 0) return
    event.preventDefault()
    const key = tabs[next]!.key
    onPick(key)
    strip.current?.querySelector<HTMLButtonElement>(`[data-tab="${key}"]`)?.focus()
  }

  return (
    <>
      <div className={`flex ${className}`}>
        <div ref={strip} role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex min-w-0 flex-1">
          {tabs.map((tab) => {
            const selected = tab.key === active
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                data-tab={tab.key}
                aria-selected={selected}
                aria-controls={panelId}
                {...(tab.name === undefined ? {} : { 'aria-label': tab.name })}
                // One tab stop for the strip. The arrow keys do the rest.
                tabIndex={selected ? 0 : -1}
                onClick={() => onPick(tab.key)}
                className={`focus-inset transition-colors ${tabClassName} ${
                  selected ? (tab.selectedClassName ?? '') : 'text-fainter hover:text-dim'
                }`}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
        {after}
      </div>

      {/* One panel, one id, and both tabs point at it. The panel is focusable so
          that Tab after activating a tab lands *in* what was revealed. */}
      <div role="tabpanel" id={panelId} tabIndex={0} aria-label={label}>
        {children}
      </div>
    </>
  )
}

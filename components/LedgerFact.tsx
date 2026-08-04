'use client'

/**
 * What the chain says about this coin, asked directly.
 *
 * SPEC §9.6 criterion 7 asks that the transfer-policy badge *link to the ledger
 * fact that backs it rather than restating it*. Restating it is what the page
 * did: the badge read `listing.transfer`, which is a field in the registry's own
 * JSON, described in the registry's own words, and a badge sourced from the
 * index it is meant to be evidence against is decoration.
 *
 * So this panel is the destination the badge points at, and everything in it
 * comes from `asset_info` on the node — the issuance block's own record, read by
 * this browser, past the registry entirely (`Trader.assetInfo`). The two sources
 * are then compared out loud. If they ever disagree, the panel says which one is
 * enforced by consensus and which one is a server's opinion, because that is the
 * single most useful thing a page like this can demonstrate: the badge is not
 * trustworthy because we wrote it carefully, it is trustworthy because you can
 * check it, and here is the check.
 *
 * The three states are all real and all rendered. A node that will not answer
 * gets a sentence rather than a blank, and the sentence does not pretend the
 * registry's copy is the fact.
 */

import { formatCoins } from '../shared/format'
import type { Listing, TransferPolicy } from '../shared/listing'
import { useAssetInfo } from '../lib/use-market'

/** What the node's flag actually permits, in the node's terms. */
const ENFORCED: Record<TransferPolicy, string> = {
  open: 'any account may move units to any other, so a peer-to-peer order book exists and cannot be switched off',
  'issuer-only': 'units move only to or from the issuing account, so an offer between two holders is an invalid block',
  none: 'units cannot move at all, so no offer for them is a valid block',
}

export function LedgerFact({ listing }: { listing: Listing }) {
  const { info, loading, problem } = useAssetInfo(listing.asset)

  return (
    <section id="ledger" className="panel scroll-mt-20 p-3" aria-labelledby="ledger-heading">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="ledger-heading" className="eyebrow">
          What the chain says
        </h2>
        <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-fainter">
          read from the node, not the registry
        </span>
      </div>

      {loading && (
        <p className="py-4 text-xs text-fainter" role="status">
          Asking the node for this asset’s record…
        </p>
      )}

      {problem && !loading && (
        <p className="mt-2 text-xs leading-relaxed text-[#ffd9d9]">
          The node would not answer for this asset: {problem} The badge above is the registry’s copy of the policy,
          which is what it always was — it is this panel that makes it checkable, and right now it cannot.
        </p>
      )}

      {info && (
        <>
          <dl className="mt-2 space-y-2.5">
            <Fact label="transfer" value={info.transfer} accent>
              {ENFORCED[info.transfer as TransferPolicy] ??
                'a policy this page does not have words for, which means the ledger has grown one since it was written'}
              . Chosen at issuance, validated by the node on every move, and immutable afterwards (SPEC §5.4).
            </Fact>

            <Fact label="asset id" value={info.id} mono>
              Derived as <code className="text-dim">H(issuer_pubkey ‖ symbol)</code> rather than assigned (SPEC §5.6.1),
              so the same issuer and symbol always compute this same id and there is no registry to race.
            </Fact>

            <Fact label="issuer" value={info.issuer} mono>
              The only account that could ever mint more of it. One per coin here, which is what makes the launch fee
              flat.
            </Fact>

            <Fact
              label="circulating"
              value={`${formatCoins(unitsOf(info.circulating, info.decimals))} of ${
                info.maxSupply === null ? 'an uncapped supply' : formatCoins(unitsOf(info.maxSupply, info.decimals))
              }`}
            >
              What exists right now. `maxSupply` caps what can exist at once rather than cumulative mints, so burning
              frees headroom (SPEC §5.6.6).
            </Fact>

            <Fact label="swap policy" value={info.swap}>
              Stored on-chain and never acted on by the node (SPEC §5.4). It describes whether the issuer runs its own
              buy/sell desk; this demo runs none, and nothing here reads it.
            </Fact>
          </dl>

          <Agreement chain={info.transfer as TransferPolicy} registry={listing.transfer} />
        </>
      )}
    </section>
  )
}

/**
 * Whether the index and the ledger are saying the same thing.
 *
 * Rendered in the agreeing case too, and that is the point. A check that only
 * appears when it fails is a check nobody has seen working, and the whole
 * argument of this demo is that a player can verify the badge rather than
 * believe it.
 */
function Agreement({ chain, registry }: { chain: TransferPolicy; registry: TransferPolicy }) {
  if (chain === registry) {
    return (
      <p className="mt-3 border-t border-line pt-2.5 text-[11px] leading-relaxed text-fainter">
        The badge on this page says <span className="text-dim">{registry}</span> and so does the node. They are two
        different sources and only one of them is enforced by consensus — this panel exists so you never have to take
        the other one’s word for it.
      </p>
    )
  }

  return (
    <p className="mt-3 border-t border-down/40 pt-2.5 text-[11px] leading-relaxed text-[#ffd9d9]" role="alert">
      The registry lists this coin as <span className="font-mono">{registry}</span> and the ledger says{' '}
      <span className="font-mono">{chain}</span>. Believe the ledger: the node validates every transfer against its own
      record and cannot be argued with by a server. The badge above is now wrong, and this is how you would know.
    </p>
  )
}

function Fact({
  label,
  value,
  children,
  mono = false,
  accent = false,
}: {
  label: string
  value: string
  children: React.ReactNode
  mono?: boolean
  accent?: boolean
}) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd
        className={`mt-0.5 font-mono text-xs ${mono ? 'break-all text-dim' : ''} ${accent ? 'text-gold' : 'text-ink'}`}
      >
        {value}
      </dd>
      <p className="mt-1 text-[11px] leading-relaxed text-fainter">{children}</p>
    </div>
  )
}

/**
 * Raw units as whole ones.
 *
 * `AssetInfo` reports supply raw, like every amount the node hands out, and the
 * coins here have no decimals — so this is division by one in practice and by
 * `10^decimals` in principle. Done with `BigInt` because raw does not fit a
 * double, and the one thing worse than no supply figure is a rounded one.
 */
function unitsOf(raw: string, decimals: number): number {
  try {
    return Number(BigInt(raw) / 10n ** BigInt(Math.max(0, decimals)))
  } catch {
    return 0
  }
}

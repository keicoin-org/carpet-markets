# Which chain is under this, and what was actually checked

This demo used to run on a mock chain because the public network was not ready to
carry a market. That was a claim, not a measurement, and a claim like that goes
stale silently — so it is now checked by a script anybody can run, and the answer
turned out to have changed.

**The public Kei testnet carries the whole market path.** Carpet Markets
therefore ships with two modes, one command to verify either, and a third mode
that is refused rather than unimplemented.

```sh
bun run probe:testnet                            # the public node
bun run scripts/testnet-probe.ts --node <url>    # any other one
bun run scripts/testnet-probe.ts --json out.json # machine-readable
```

## The modes

| `CARPET_NETWORK` | What it is | `/rpc` is | Survives a restart |
|---|---|---|---|
| unset, or `mock` | A `MockNode` in the same process as the registry | that node's own handler | no |
| `testnet` | The public Kei testnet at `https://testnet.keicoin.org/rpc` | a pass-through to it | yes |
| `mainnet` | **Refused, by name, before anything opens a socket** | — | — |

`CARPET_NODE` overrides the testnet URL. Anything else — including a typo like
`tesnet` — is refused rather than defaulted, because a misconfiguration that
quietly serves a mock is a misconfiguration nobody finds.

The client never guesses which of these is live: the mode travels with
`/market/facts` and the badge in the bar renders what the server said. A badge
compiled into the bundle would keep saying "mock" the first time somebody served
the same build against a real node, which is the single most damaging thing it
could get wrong.

## The readiness probe, and what it found

The probe walks the whole path a launch and a trade take, in order, writing real
blocks: faucet, `issue`, `mint`, `swap_offer`, reading the offer back off the
seller's own chain, `swap_accept`, `swap_cancel`, price history, and finally a
refusal it *expects* the ledger to make. Every step is recorded whether it passes
or fails, because "the swap RPC is served and the faucet is dry" needs a
different fix from "nothing is there".

Run against `https://testnet.keicoin.org/rpc`:

```
  ok    the node answers `version`
        Banano V25.1, network "dev", protocol 19
  ok    work tiers A, B and C are published (SPEC §5.6.4)
        A/B/C present, so this is a Kei node rather than a stock Banano one
  ok    `swap_info` is served — the §9.2 read path exists
        answers `offer: null` for an unknown hash rather than an unknown-action error
  ok    three wallets open against it
  ok    the faucet funds three cold addresses
        issuer 25 Kei, seller 25 Kei, buyer 25 Kei
  ok    `issue` writes an asset and burns Kei (SPEC §5.6.5)
        asset DC0E90F042C4…, issuer balance 25 → 24 Kei
  ok    `mint` credits a holder, arriving as a receivable (SPEC §5.6.3)
        1 receivable waiting before sync, 10,000 units held after it
  ok    `swap_offer` locks the seller’s own units (SPEC §9.2)
        offer 5703F526879A…, 1,000 units out of the spendable balance
  ok    the offer is readable off the seller’s own chain (SPEC §9.4)
        0.0005 Kei each, 0.5 Kei for the lot
  ok    `swap_accept` settles both legs in one block (SPEC §9.2)
        paid 0.5000 Kei for 1,000 units, block 407CC5AB7437…
  ok    `swap_cancel` returns the lock to the offerer
        9000 → 8500 while listed → 9000 after the cancel
  ok    price history reads off the settled blocks (SPEC §9.1)
        1 trade(s), last 0.0005 Kei per unit, volume 1000
  ok    a soulbound coin cannot be offered at all (SPEC §5.4)
        refused: The node rejected "process": The asset's transfer policy does not permit this move

  READY — this node carries the whole market path
  13/13 steps passed in 35371 ms
```

Two things in there are worth reading twice.

**The vendor string says Banano and the work tiers say Kei.** `version` reports
`Banano V25.1` because the node is a fork and has not been rebranded, so vendor
alone cannot tell you what you are talking to. `work_thresholds` answering with
tiers A, B and C — the split SPEC §5.6.4 introduces for `issue`/`mint` against
`send`/`transfer` against `receive`/`claim` — can only come from a node that
implements the asset primitive. That is the check that matters.

**The last line is a pass because it failed.** A soulbound coin's units cannot be
locked into a `swap_offer`, so the node rejected the block. If that step ever
*succeeds*, the badge on every coin card is marketing rather than a fact, and the
probe exits non-zero.

## End-to-end, through the app rather than a script

The probe writes its own blocks. The demo pointed at the same node was then run
whole:

```sh
CARPET_NETWORK=testnet bun run dev:api    # registry against the public node
bunx next dev                             # the client
bun run seed                              # six coins, launched and traded
```

```
  chain      Public testnet — https://testnet.keicoin.org/rpc
  registry   kei_3hkanzc4uq3cfms494eykx9x6z1nbpor3ekni39si38gafi6id4mycyaug6a

  KILIM     open         3 ask(s), 2 filled, 1 bid(s)
  UNDERLAY  open         1 ask(s), 1 filled, 2 bid(s)
  FRINGE    open         1 ask(s), 0 filled, 0 bid(s)
  WARP      open         1 ask(s), 1 filled, 0 bid(s)
  HEIRLOOM  none         0 ask(s), 0 filled, 0 bid(s)
  BAZAAR    issuer-only  0 ask(s), 0 filled, 0 bid(s)

  6 coins listed on testnet.
```

`/market/facts` then answered:

```json
{ "chain": { "mode": "testnet", "sdkNetwork": "testnet",
             "node": "https://testnet.keicoin.org/rpc", "ephemeral": false } }
```

and a headless browser completed a buy from the board — one click into the coin,
one on a row of the book — ending with `YOU HOLD 5,000`, the transaction tray at
`settling`, and the holder table listing the browser's own wallet beside the
creator's:

```json
{"holders":[
  {"address":"kei_3dgfqy…ze6yy","amount":995000,"creator":true},
  {"address":"kei_1mwkhe…nh6r","amount":5000,"creator":false}]}
```

Every one of those blocks was signed by a key in the browser and validated by a
node this repository does not run.

## The Cloudflare path, audited separately

The dev server and the Worker are two processes with different globals, so
"it works in `bun run dev`" says nothing about the deployed shape. `server/network.ts`
exists so both answer the question once, and all three modes were then run
through `wrangler dev --local`, which is the Durable Object for real:

| Mode | `GET /examples/carpet-markets/market/facts` |
|---|---|
| default | `{"chain":{"mode":"mock","node":null,"ephemeral":true}}`, then `bun run seed` listed six coins |
| `CARPET_NETWORK=testnet` | `{"chain":{"mode":"testnet","node":"https://testnet.keicoin.org/rpc","ephemeral":false}}`, `/rpc` proxied `version` to the real node, and `bun run seed` launched and traded six coins on it |
| `CARPET_NETWORK=mainnet` | HTTP 503 and the refusal, with all five gates named |

Two things the audit turned up that are worth writing down.

**The object is not always the chain.** On the mock it holds the whole ledger, so
an eviction resets the market — an empty board means the object restarted rather
than that nobody came. On the testnet it holds only the registry, and `/rpc` is a
deliberately dumb pass-through: it does not rewrite actions, cache them, or add a
header the node did not ask for, because anything it did to a block on the way
past would be a claim the chain had not made. All it adds is CORS.

**The deployed default stays `mock`, and that is an operational call rather than
a technical one.** It is one word in `wrangler.jsonc`. The public node is a
single best-effort box with no uptime promise (SPEC §15) and every open tab polls
it every two seconds, so pointing a public page at it belongs to whoever owns
that box.

## What none of that makes true

The coins are still worth nothing, and the point of measuring carefully is to be
able to say that precisely rather than defensively.

- **A testnet is a testnet.** The faucet hands out Kei to anybody who asks, so
  the supply is whatever people have asked for.
- **The node is one box, best-effort, with no uptime promise** (SPEC §15, public
  node policy). It is explicitly not infrastructure.
- **The registry's list of coins is still in memory.** On the mock, a restart
  loses the coins and the ledger together. On the testnet it loses only the
  *list*: the assets, the offers and the trades are still on the chain, and a
  reader with the account list gets the same answers without this server. That
  asymmetry is the honest shape of "no indexer" (SPEC §9.4) and not a bug to
  fix here.
- **The book is only as complete as that list.** An offer written by a wallet
  that never announced itself settles perfectly well and does not appear.

## Mainnet is not a setting

`CARPET_NETWORK=mainnet` exits before it opens a socket, and says why. Five
things gate it, and four of them are arguments rather than builds:

| SPEC | Gate |
|---|---|
| §15.2 | **Validator distribution.** ≥ 10 unaffiliated representative operators, no single operator above 33% of online weight, the project below 34%. Until then Kei is a testnet with real branding. |
| §15.1 | **Threshold modelling.** The 51% quorum and 66% approval on a reserve release were chosen before anybody modelled turnout, against a supply that is 72% project-held at launch. |
| §15.3 | **Stale proposals.** A never-quorate proposal stays votable indefinitely, and both levers that bound it are held by the party seeking the release. |
| §17 | **The legal conversation.** Anything cash-out shaped ships disabled until it has happened. |
| §9.6 | **A launchpad is the wrong first thing.** Even with every gate above cleared, this demo is a joke about losing money and needs the coins to be worthless to stay one. |

No amount of work in this repository moves any of them, and this document is not
a plan to. It exists so the demo's own boundary is checkable in one command
instead of taken on trust.

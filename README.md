# Carpet Markets

Durable mock operation and recovery are documented in
[`DURABLE_LOG.md`](./DURABLE_LOG.md). Read it before enabling log compaction: the
first deployment is intentionally compatibility-only.

A coin launchpad, in the pump.fun shape: anybody can launch a token in one click,
whoever launched it is holding all of it, and from there it is worth whatever the
next person will pay.

There is no bonding curve and no house. Every trade here is an offer one player
wrote and another accepted — `swap_offer` and `swap_accept`, settled in one block
by consensus (SPEC §9.2). This is what `@keicoin/market` is for, and this repo is
the example of it.

```sh
bun install
bun run dev          # client on :3000, chain and registry on :7788
bun run seed         # six coins and a market between them, so there is something to look at
```

The client is Next.js and ships as a **static export** — plain HTML, CSS and JS
with no Node server behind it. `next dev` proxies `/rpc` and `/market/*` to the
Bun process on :7788; the deployed copy has no proxy at all, because there a
Cloudflare Worker serves the exported files and answers those two paths out of a
Durable Object. That deployed object starts with the same deterministic six-coin
board and replays its storage-backed event log after eviction, so an accepted buy
is still there after a cold start.

Every coin the board calls buyable has a lot one faucet press covers. That is not
a coincidence in the seed data: the board is `shared/demo-board.ts`, the grant is
`shared/faucet.ts`, and `test/first-buy.test.ts` opens a fresh wallet against each
of those coins and settles its cheapest ask, so an edit that prices the small side
out of reach fails in `bun test` rather than in front of a visitor. It used to
leave KILIM's 66 Kei lot as the cheapest thing open against a 25 Kei grant, which
was [#18](https://github.com/keicoin-org/carpet-markets/issues/18).

> **This is a demo, and every coin on it is worthless by construction.** That is
> what makes it safe to show you how a market like this actually behaves.

## Which chain is under it

Two modes, and the badge in the bar always says which one is live — read off the
server rather than compiled into the page, so it cannot disagree with the thing
it describes.

```sh
bun run dev                              # local mock: resets when this process stops
CARPET_NETWORK=testnet bun run dev:api   # the public Kei testnet, over HTTP
CARPET_NETWORK=mainnet bun run dev:api   # refused, by name, before it opens a socket
```

The public testnet carries the whole market path — `issue`, `mint`,
`swap_offer`, `swap_accept`, `swap_cancel`, price history, and the policy
refusal — and that is checked rather than asserted:

```sh
bun run probe:testnet
```

[`NETWORK.md`](NETWORK.md) carries the last run of it with the node's own
answers, the end-to-end walk through the app, and the five things that gate
mainnet. Four of them are arguments rather than builds, and nothing in this
repository moves any of them.

## The point

There is no mechanic here called "rug". A creator is minted the whole supply at
launch and can sell it, in whatever size they choose, whenever they choose. That
is not an exploit and it is not a special power — it is selling, which is the
only thing anybody on this market can do.

What the chain decides is whether that market can exist at all. A coin's
`transfer` policy is chosen at issuance, enforced by consensus, and immutable
afterwards (SPEC §5.4):

| | `transfer` | What it means |
|---|---|---|
| **Open** | `'open'` | Anybody can send it to anybody, so there is a real order book — and the creator is holding a million of them. |
| **Issuer only** | `'issuer-only'` | Units move only to or from the issuing account. An offer between two holders is an invalid block, so no player-to-player market exists or can. |
| **Soulbound** | `'none'` | Nothing moves, ever. It cannot be sold, by anybody, including whoever made it. |

A database can hold the same flag. A developer can edit the row. That is the
whole difference: a player can read the badge, buy the open coin anyway, watch
the creator work through their position a thousand at a time, and check
afterwards that the chain said so the entire time.

The site never claims a coin is safe. It shows you what was issued.

## The loop

| | |
|---|---|
| **Launch** | Name a coin, pick who may move it, pay the fee. You are minted the whole supply. |
| **Sell** | Write an offer: how many, and what you want for them. The coins lock until it settles or you cancel. |
| **Buy** | Take somebody's offer, after the terms are restated. One block, both legs, or neither. |
| **Bid** | The mirror of selling: lock Kei, and take the coins from whoever fills it. The only way to be a buyer when nobody is selling. |
| **Cancel** | Take back your own unaccepted order, and whatever it locked. |

### Both sides, and no matching engine

A bid is a `swap_offer` with its legs the other way up — Kei locked, coins wanted
— so the book has two sides without a second primitive, and filling either side
is the same `swap_accept`.

The trap that comes with it, which cost an afternoon: **`Offer.price` is
`want.amount` per unit of `give`**, which is Kei-per-coin on an ask and
*coins-per-Kei* on a bid. Rendered raw, a bid of 0.0003 Kei each appears as
3,333.33 next to asks in the fourth decimal place, sorts the book upside down,
and puts a spike into a chart of fractions. `unitPrice()` in `shared/listing.ts`
is the one place that is undone, and `test/pricing.test.ts` is why it is allowed
to be the only one.

### A first buy is five steps, and they are a state machine

A stranger's first buy passes through five states, in order, and the order is
enforced in `lib/funnel.ts` rather than afforded by the layout:

| | |
|---|---|
| **nothing for sale** | No trades yet and no reserve. Somebody has to write an offer before there is anything to take, and the panel says so rather than greying out a price field. |
| **pick a quote** | The book. Every row is one account's offer at its own price, so picking one is choosing a counterparty. |
| **confirm the terms** | What the offer hands over, what it costs, per unit, and from whom — restated before anything is signed. |
| **settling** | The block is out and no read has seen it. Its own step, not a spinner inside a button. |
| **settled** | A read has seen it. The only step in which a buy is a fact. |

`chose` is the only way into the third and `confirmed` is the only way into the
fourth, so there is no path from a row straight to a signature: a panel that
dropped the confirmation could not sign either. The poll cannot rewind any of
them — an ask filled by somebody else while a confirmation is on screen leaves it
where it is. `test/funnel.test.ts` is every transition, including the ones that
must do nothing.

The confirmation costs one interaction, which puts the path from the board at
four — narrow to what is buyable, open a coin, take a row, confirm — against
SPEC §9.6 criterion 1's budget of five.

That is the click count, and it is not the same claim as a stranger getting
through. The money half of that is `test/first-buy.test.ts`, which presses the
faucet once and settles a real lot on every coin the board calls buyable, and the
shortfall the funnel reports on any other row now names the number of presses that
covers it. `bun run walk` counts the interactions in a real browser and is the
only thing that checks both halves at once.

### There is no curve, deliberately

An earlier version of this priced everything with a linear bonding curve: the
server minted on every buy, burned on every sell, and paid people out of a
reserve it held. That made the server the counterparty to every trade, which is
the payment infrastructure Kei exists to remove (SPEC §5.2) — and it meant the
"price" was a formula, not a price.

Now the price is the last thing two people agreed on, and `market.price()` reads
it off the settled `swap_accept` blocks. A coin nobody has traded has no price,
and the page says so instead of quoting one.

It also removed *graduation*, a threshold at which the curve closed and the coin
"left". It was borrowed from the thing this repo is making fun of and it made the
demo worse: it put a clock on the only decision that mattered.

### The launch fee is flat, and that is the fix

Issuing an asset burns Kei, and the nth asset an **account** issues burns n Kei
(SPEC §5.6.5). The rule is per account, and its purpose is that one account
cannot cheaply create a great many permanent asset records.

This repo used to issue every coin from the registry's own account, which turned
that per-account rule into a tax on arriving late: the fiftieth visitor paid for
the forty-nine launches before theirs, a newcomer's *first* coin was the most
expensive thing on the site, and the whole place stopped working somewhere around
the thousandth coin. The code called that the anti-spam mechanism. It was the
bug.

Every coin now gets its own issuing account, derived from the registry's seed by
index. A launch pays that account's first burn — **1 Kei, forever** — and never
anybody else's. The launcher is charged **1.1 Kei**: the 1 Kei burn, plus a 0.1 Kei
margin so the new issuing account can still sign after paying it. Spam is still
bounded, per launcher, exactly as the spec intended.

## Where things are

```
shared/format.ts        turning numbers into text. Used to be the bonding curve.
shared/listing.ts       the wire shape, a valid coin identity, and which way up a price is.
shared/network.ts       mock, testnet, and the refusal that is not a schedule.
shared/social.ts        replies, and the signature that makes one attributable.
server/registry.ts      issues coins, and remembers who to read. The whole backend.
server/network.ts       choosing the chain, once, for both deployments.
server/main.ts          /rpc and the registry at /market/*, for `bun run dev`.
worker/index.ts         the same two, on Cloudflare, in one Durable Object.
lib/market.ts           every line of Kei in the client.
lib/balance.ts          confirmed, incoming and in-flight money, kept apart.
lib/tx.ts               what became of a signature, and whether a retry is honest.
lib/funnel.ts           the five states a first buy passes through, in order.
lib/refusals.ts         every reason a trade will not go through, worked out first.
lib/board.ts            the board's sorts and filters, as arithmetic.
lib/use-market.tsx      the wallet, the poll, and where React finds out about them.
app/page.tsx            the board.
app/coin/page.tsx       one coin: chart, book, holders, trades, replies.
app/launch/page.tsx     the three-way choice the whole example is about.
app/network/page.tsx    what is under the page, at length.
components/             the board's parts, including the woven coin marks.
scripts/testnet-probe.ts  whether a given node can carry this market.
scripts/seed.ts         a board worth looking at, made out of ordinary blocks.
scripts/walk.ts         the three acceptance criteria that need a real browser.
spawn.ts                running a command on an OS that disagrees what one is.
```

`lib/market.ts` is the file to read if you are here to learn `@keicoin/market`.
`server/registry.ts` is the file to read if you are here to learn what a server
still has to do when it is not allowed to touch the money.

### A balance is three numbers, and only one of them can be spent

A block-lattice wallet has three, where a bank account has one, and the gaps
between them are exactly the moments somebody is watching the screen:

| | |
|---|---|
| **Confirmed** | Signed for, on this wallet's chain, spendable this instant. The ledger checks a spend against this and nothing else. |
| **Incoming** | Sent to this wallet and not yet received by it. Real, owed, and not spendable — a receivable becomes a balance when the holder's own key signs for it (SPEC §5.6.3), which is what `sync()` does. |
| **In flight** | Signed by this browser a moment ago and not yet visible in a balance read. Nothing disagrees with it; the two-second poll simply has not come back. |

Showing only the first makes the page look broken for two seconds after every
trade. Adding them together makes it offer money that cannot move, and the
ledger then refuses with "balance is 0", which reads like a bug in the market
rather than the market working. So they are carried separately all the way to
the screen: the bar shows what is spendable, and says what is settling beside
it rather than inside it.

The rule the whole of `lib/balance.ts` exists to hold is that only `spendable`
is ever allowed near a decision. A credit in flight moves the display and never
funds the next spend; a debit is counted the moment it is signed, so two clicks
in the same second cannot both be checked against the same coins.

### The coin art is derived, not uploaded

Launchpads in this shape get their density from an image per coin, which means an
upload, a pinning service, a bucket and a moderation problem. Here the asset id
seeds a small mirrored kilim, so the same coin draws the same rug everywhere and
nothing is stored anywhere. It is in `components/CoinArt.tsx` and it is about
sixty lines.

## What the server is, and is not

It is not a market. It never holds a coin, never quotes a price, and cannot move
anybody's balance. It does two things, and both are things a chain deliberately
does not do:

1. **It issues.** A coin needs an issuing account and issuance burns Kei.
2. **It is the list of who to read.** `market.offers()` requires a `from`,
   because an offer lives on its author's chain — "every offer on the network" is
   an indexer, and SPEC §9.4 says Kei does not ship one. Somebody has to remember
   which accounts have touched a coin.

Everything it reports is read back off the chain. A reader with the same list of
accounts gets the same answer without asking this server anything, which is the
property worth having and the reason it is an index rather than an oracle.

The client enforces that rather than assuming it. Every number in the book
reaches the screen through this server, and an index can attach the hash of one
offer to the price and quantity of another — by a bug, by a stale cache, or on
purpose. So a Buy carries the terms the row rendered into `market.accept`, the
SDK re-reads the offer from the chain and checks every field of both legs against
them, and a disagreement refuses before anything is signed. This server does not
need the key if it can choose which offer the key signs for; it cannot.

## No balance database

There is no `users` table, no `balances` table, no `holdings` table, and no save
file. Who holds which coin is a question the chain answers, and asking it is
`balanceOf`.

The local Bun mock is deliberately ephemeral: stop it and its chain, listings,
and threads are gone. The deployed Worker has a different lifecycle. Before it
accepts a mutating mock request, `Floor` appends the versioned JSON-safe input to
Durable Object storage; after eviction a fresh `Floor` replays those inputs into
new in-memory ledger, registry, and thread instances. Cryptographic objects and
the operator's `CARPET_SEED` are never serialized; the fixed no-value bootstrap
wallets are public code fixtures. Testnet is not replayed this way: `/rpc`
remains a pass-through and its remote chain is the authority.

The event log is append-only and intentionally small-demo infrastructure, not an
indexer or a production ledger. It grows with successful faucet, block, launch,
watch, and reply mutations. Resetting the public mock means deleting the named
`carpet-markets` Durable Object's storage; changing `CARPET_SEED` requires the
same reset. Eviction, a Worker restart, or a routine deploy does not reset it.

## Four things worth stealing

Written down because each one cost an afternoon.

- **`sell({ amount, price })` takes the total ask, not the price each.** The
  `Offer` that comes back reports `price` *per unit*, so the two differ by
  `amount`. Getting it backwards mislists by several orders of magnitude on a
  coin with a million units. `lib/market.ts` multiplies in one place for exactly
  this reason.
- **`market.price()` defaults to your own trades.** Pass `{ from }` or a wallet
  that has never traded summarises nothing and returns null, which reads like the
  coin has no history.
- **A payment event carries a JS number.** `PaymentEvent.amount` is a `double`,
  and a double cannot hold eighteen decimal places: a fee of exactly 1.1 Kei
  arrives as `1.0999999999999999`. An equality check against a quote therefore
  rejects real payments. Accept a documented dust tolerance and refund the change.
- **Minted coins are a receivable, not a balance.** They are owed until the
  recipient's wallet signs for them. Selling before `sync()` fails with
  "balance is 0", which is correct and reads like a bug in the market.
- **`Offer.mine` answers for whoever did the reading.** The SDK sets it to
  `from === client.address`, and the offers in `/market/book` were read by the
  registry's wallet — so it is `false` on every row in that book, including
  yours. A client filtering on it removes nothing and offers people their own
  coins back. Compare `offer.from` to the browser wallet's own address instead.

### Nothing refuses a trade after the fact

Every state that can stop an action is worked out before the click and named
beside it — `lib/refusals.ts`, asserted sentence by sentence in
`test/refusals.test.ts`. The three that matter are the three a block-lattice has
and a bank account does not, and they need three different sentences:

- Kei that **has arrived and is not signed for yet** is real, owed, and
  unspendable. Saying "not enough Kei" here is actively false; the page says what
  is settling and the button turns itself on.
- Coins **locked into your own open offer** left the spendable balance when the
  `swap_offer` block was written. The fix is a cancel, not a purchase, and only
  that case says so.
- A **transfer policy** makes the whole trade an invalid block. Nothing changes
  it, so nothing suggests anything might, and the panel is absent rather than
  disabled.

After the click, `lib/tx.ts` decides what a failure *was*. A ledger refusal is
not an outage — offering "try again" under `transfer: none` would teach people
that consensus is a glitch — and a lost accept/cancel race is somebody else
winning rather than a reason to try harder. A launch is never retryable at all,
whatever went wrong: its first half sends a fee, and the fee buys a burn.

## Honest about what this is not

- **Nothing here is worth anything**, on purpose. The mock ledger is rebuilt in
  memory from demo-only Durable Object events; on the public testnet the faucet gives Kei to anybody who asks and
  the node is one best-effort box (SPEC §15). Neither is a place to find out what
  losing money feels like with money in it, which is the whole reason this demo
  can exist at all.
- **Mainnet is refused rather than unimplemented.** Five gates, four of which are
  arguments rather than builds. They are in [`NETWORK.md`](NETWORK.md), on the
  `/network` page, and in `shared/network.ts` as `MAINNET_GATES`.
- **The book is only as complete as the account list.** The registry lists offers
  from accounts it has heard of. An offer written by a wallet that never
  announced itself is perfectly valid, settles perfectly well, and does not
  appear here — which is what SPEC §9.4 means when it says there is no indexer.
- **The registry has one open quote per address.** A Kei transfer carries no
  memo, so an arriving payment says only who sent it and how much. Two browser
  tabs racing is a thing you can do to yourself. The honest fix is a memo field
  in the wire format, not a cleverer guess on this side.
- **The registry keeps unmatched payments.** Send it Kei answering no quote and
  it stays there. Reflexively refunding whoever sends money would make it return
  its own working capital to the faucet on startup.
- **The replies are not on the chain**, and they are the only thing here that is
  not. The registry stores them and the registry can lose them; they go when the
  chain does. What they do carry is a signature from the same key that signs
  their author's blocks, so nobody can post as the creator — which is a strictly
  weaker claim than a block makes, and the panel says so rather than letting the
  word "signed" imply consensus. In a genre where *dev said he's not selling* is
  load-bearing, being able to prove only who said it is still worth having.
- **A creator selling their whole position is not an exploit.** It is the
  documented behaviour of `transfer: 'open'`. If you would like it to be
  impossible, that is the other radio button, and it is impossible at the ledger
  rather than here.

## Building on Windows

`bun run build` shells out to `next build`, and that spawn is the one thing here
that does not survive the platform. `Bun.spawn` does not go through a shell, so
a bare `bunx` is resolved by libuv's own PATH walk — which does not apply
`PATHEXT`, and therefore looks for a file called exactly `bunx`. An npm global
install puts one there: a POSIX shell script, sitting beside the `bunx.cmd` that
Windows can actually run. libuv finds the script, cannot start it, and the build
dies with `uv_spawn 'bunx' ENOENT` while `bunx next build` typed at the same
prompt works perfectly.

`spawn.ts` stops asking PATH about the one thing the process already holds a
path to. `process.execPath` is the Bun binary running the build and `bunx` is an
alias for `bun x`, so both become an absolute executable and an argument list
with no lookup at all. Anything else is searched across PATH the way the shell
would search it: `PATHEXT` order first so a real executable wins over an
extensionless script of the same name, and a `.cmd` or `.bat` handed to the
command interpreter, because `CreateProcess` refuses a script.

`build.ts` and `dev.ts` both go through it, and a command that genuinely is not
installed now fails saying which one, rather than as an errno from libuv.

## Checks

```sh
bun run check     # typecheck, worker typecheck, and the tests
bun run walk      # the three acceptance criteria that need a browser
```

`bun run walk` starts the chain, the registry and the client, seeds the board out
of ordinary blocks, and drives Chrome through the demo. It exists because three
of SPEC §9.6's nine criteria — a buy in five interactions, no horizontal scroll at
360 px, and the whole loop by keyboard — are claims about layout, focus and a
click count, and none of them survives being asserted in happy-dom: there is no
layout engine there, so `scrollWidth` is a fiction and a focus ring is a class
name nobody drew. It prints the click count, the measured widths and the focus
ring at every stop, and exits non-zero if any of the three does not hold.

It is not a CI job, because as of this commit it still exits non-zero. Run on this
branch against Chrome 141, one of the three holds and it is the one this change is
about:

```
PASS  criterion 1 — a first buy in 4 interactions, with every funnel step announced in order
      1. buyable now  2. opened KILIM  3. Buy 8,000 KILIM for 7.2 Kei  4. Confirm the buy
FAIL  criterion 5 — the network page's primary action is not found at 360 px
      no page scrolls horizontally; three of the four expose a primary action
FAIL  criterion 6 — "Your open orders" never appeared after a settled sell
1 of 3 checked criteria hold. Unmet: 5, 6.
```

Criterion 1 is what this branch bought: it stopped on the unaffordable lot before,
and the row it takes now is the 7.2 Kei clip added to the board. Criterion 6 stops
on #25, not on anything here — a seller whose order is not listed has no route to
the cancel that unlocks the units. Criterion 5 stops on the network page alone. A
red job nobody can fix teaches people to ignore the job, so this stays a command
until its criteria pass.

It installs no browser. `puppeteer-core` drives whichever Chrome is already on
the machine; set `CHROME_PATH` if it is somewhere unusual.

`test/registry.test.ts` is where the claim on the badge is either true or
marketing. It asserts at the ledger that a soulbound coin cannot be offered at
all, that an issuer-only coin cannot be traded between two holders, that an open
one settles peer-to-peer in whatever size the seller chose, that a bid is the
same block the other way up and a holder can fill it, and that the launch fee
does not move as coins pile up.

`test/refusals.test.ts` is criterion 2 of SPEC §9.6 as assertions: every state
that can refuse a trade gets its own sentence, and the one that would otherwise
be a lie — arrived-but-unsigned-for money reported as "not enough Kei" — is
tested apart from the one that is true.

`test/funnel.test.ts` is the first-buy path as a state machine, transition by
transition, including the ones that must do nothing: the book cannot sign, a
chosen quote cannot land without being confirmed, and a poll cannot rewind a
block in flight. `test/screen.test.tsx` then asserts the same five steps reach
the screen, in order, with `settling` provably on it before `settled`.

`test/tx.test.ts` is the state machine a signature moves through, and the two
rules in it that would cost somebody money: a policy refusal never offers a
retry, and a launch never offers one whatever went wrong.

`test/pricing.test.ts` pins which way up a price is, on both sides of the book.
`test/board.test.ts` pins every sort and filter to the field it claims to read.
`test/network.test.ts` pins the badge, the mainnet refusal, and the readiness
verdict — including that neither runnable mode is described as worth anything.

`test/social.test.ts` covers the other claim the UI makes — that the address on a
reply wrote it. Every test in it is a way of trying to post as somebody else:
forging the author, editing the body after signing, lifting a signed reply onto
another coin, and sending the same one twice.

`test/balance.test.ts` is the rule above in assertions: whatever is arriving or
halfway out, `spendable` never counts anything the chain has not confirmed.

`test/format.test.ts` holds down the price formatter, which was rendering every
price below a millionth in exponent notation — `6.00e-7` — which is the exact
output it exists to prevent, on exactly the range a new coin trades in.

`test/spawn.test.ts` is the Windows build blocker. It fakes a filesystem and a
PATH rather than reading the host's, because the bug appears on one platform and
CI runs on another, and the point is that the rule is checked from either.

MIT.

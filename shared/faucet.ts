/**
 * What the faucet hands out, in one place.
 *
 * This was written as a bare `25` in five files — the mock node's default, the
 * client's first-visit top-up, the bar's button and its tooltip, and two "you
 * are short" refusals — and the demo board's asks were written in a sixth by
 * somebody who did not read the other five. The cheapest lot left open on the
 * first coin the board called "buyable now" ended up costing 66 Kei, so the
 * page's leading affordance took a new visitor to a refusal (#18).
 *
 * A number that four subsystems have to agree on is not a literal. It is here so
 * that `test/first-buy.test.ts` can compare the grant against the board and fail
 * before a browser does.
 *
 * On the public testnet the node decides what a faucet call pays and this is
 * only what the client asks for. That is why the fix for #18 sizes a lot against
 * the grant rather than raising the grant: raising it is a knob that exists on
 * the mock and not on the chain the deployed demo talks to.
 */

import { KEI_RAW } from './format.js'

/** Kei per press of the faucet in the bar. */
export const FAUCET_KEI = 25

/** The same grant in raw Kei, for the optimistic balance the bar shows. */
export const FAUCET_GRANT_RAW = BigInt(FAUCET_KEI) * KEI_RAW

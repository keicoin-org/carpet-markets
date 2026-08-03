/**
 * Two builds out of one config.
 *
 * `next dev` runs an ordinary dev server and proxies the two backend paths to
 * `bun run server/main.ts` on :7788, so the client sees `/rpc` and `/market/*`
 * at its own origin and needs no idea that they are somewhere else.
 *
 * `bun run build:site` sets NEXT_EXPORT and gets a static export instead: plain
 * HTML, CSS and JS with no Node server behind it, which is what the Cloudflare
 * Worker serves out of its ASSETS binding. `output: 'export'` and `rewrites` are
 * mutually exclusive — an exported site has nothing running to proxy with — so
 * the two are switched between rather than declared together.
 *
 * The deployed copy lives under a path, not at a root, because keicoin.org owns
 * the domain and this is one demo on it. `basePath` is what makes every asset
 * URL agree with that, and NEXT_PUBLIC_BASE_PATH hands the same string to the
 * client so its fetches land on the right Worker.
 */

const exporting = process.env.NEXT_EXPORT === '1'
const basePath = exporting ? '/examples/carpet-markets' : ''

/** Where the dev client's `/rpc` and `/market/*` actually go. */
const api = process.env.CARPET_API ?? 'http://localhost:7788'

/** @type {import('next').NextConfig} */
export default {
  ...(exporting ? { output: 'export', basePath } : {}),

  // Pinned, because Turbopack otherwise walks up looking for a lockfile and can
  // land on one outside the project entirely.
  turbopack: { root: import.meta.dirname },

  // The Worker serves directories, so `/coin` has to be `coin/index.html`.
  trailingSlash: true,

  // No image optimiser exists in a static export, and the only images here are
  // drawn in the browser anyway.
  images: { unoptimized: true },

  env: { NEXT_PUBLIC_BASE_PATH: basePath },

  ...(exporting
    ? {}
    : {
        async rewrites() {
          return [
            { source: '/rpc', destination: `${api}/rpc` },
            { source: '/market/:path*', destination: `${api}/market/:path*` },
          ]
        },
      }),
}

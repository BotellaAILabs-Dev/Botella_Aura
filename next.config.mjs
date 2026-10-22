/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  experimental: {
    /**
     * instrumentation.ts: at server start, report which integrations are
     * configured (variable names only, never values).
     */
    instrumentationHook: true,
    /**
     * Client-side Router Cache lifetime.
     *
     * Every page under /dashboard is `force-dynamic`, and Next 14's default
     * stale time for a dynamic segment is 0 — so re-opening a page you looked
     * at ten seconds ago, or pressing Back, threw away the rendered tree and
     * paid for the session lookup, the company query and the page's own
     * queries all over again. That is the bulk of the "laggy" feel: not one
     * slow query, but the same queries repeated on every navigation.
     *
     * 30s matches the TanStack Query staleTime in app/providers.tsx, so server
     * and client data age out together. It is safe because every mutation in
     * the app calls `router.refresh()`, which clears this cache outright —
     * a navigation after a write always re-reads the database.
     */
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
    /**
     * Barrel-file imports (`import { X } from '@radix-ui/react-dialog'`) pull
     * the whole package's module graph into a route's compile unit. Rewriting
     * them to direct imports cuts dev-server compile time and bundle size.
     *
     * Next merges this with its own default list, which already covers
     * lucide-react — so only the Radix packages below actually change
     * anything. They are named explicitly rather than left to the default so
     * the optimisation does not silently disappear if that list changes.
     */
    /**
     * Marketing creatives (server/media/creative): resvg is a native module,
     * loaded by Node rather than bundled, and the bundled fonts are read from
     * disk at runtime — so they must ship with every function that renders.
     */
    serverComponentsExternalPackages: ['@resvg/resvg-js'],
    outputFileTracingIncludes: {
      '/api/**/*': ['./assets/fonts/**/*'],
      '/dashboard/**/*': ['./assets/fonts/**/*'],
    },
    optimizePackageImports: [
      '@radix-ui/react-avatar',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-label',
    ],
  },

  images: {
    /**
     * Optimised images are re-fetched and re-encoded once their cache entry
     * expires. The default TTL is 60 seconds, which for logos and avatars —
     * files that essentially never change — means paying the optimiser
     * repeatedly for the same bytes, and a visibly slow first paint each time.
     * 30 days is appropriate for this content; a changed logo gets a new URL.
     */
    minimumCacheTTL: 60 * 60 * 24 * 30,
    remotePatterns: [
      // Google account avatars (OAuth)
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
      /**
       * Company logos are user-supplied URLs pointing at arbitrary hosts, so
       * this stays open by necessity.
       *
       * Be aware of the tradeoff: it also makes /_next/image an open image
       * proxy — anyone who finds the deployment can optimise arbitrary remote
       * images through your Vercel account and bill the transformations to it.
       * The fix is to stop hotlinking: copy an uploaded logo into your own
       * blob storage at upload time and narrow this to that one hostname.
       */
      { protocol: 'https', hostname: '**' },
    ],
  },
  /**
   * Baseline security headers. Nothing embeds Aura in a frame, so framing is
   * refused outright — otherwise another site could overlay the Approve /
   * Publish buttons (clickjacking).
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

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
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [
      // Google account avatars (OAuth)
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
      // Company logos / user-provided images (loosen as needed per sprint)
      { protocol: 'https', hostname: '**' },
    ],
  },
};

export default nextConfig;

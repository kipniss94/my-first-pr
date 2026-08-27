import type { NextConfig } from 'next';

/**
 * The browser talks to `/api/v1/*` on its own origin and Next proxies that to
 * the API service. Same-origin keeps CORS out of the picture in development and
 * lets a single hostname serve the whole product in production.
 *
 * Set `NEXT_PUBLIC_API_BASE` to point the browser straight at the API instead
 * (the API's CORS_ORIGINS must then include the site origin).
 */
const apiTarget = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    if (process.env.NEXT_PUBLIC_API_BASE) return [];
    return [{ source: '/api/v1/:path*', destination: `${apiTarget}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ];
  },
};

export default nextConfig;

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
  // A second build can sit beside the one being served — a check run while
  // the viewer stays open — when this names another folder.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Uploads reach the API through the rewrite below, and Next cuts a
    // proxied body at 10 MB by default: a 15 MB presentation never arrived.
    // As large as the API takes, and a little over for the form's own bytes.
    middlewareClientMaxBodySize: `${Number(process.env.MAX_UPLOAD_MB ?? 250) + 16}mb` as `${number}mb`,
  },
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

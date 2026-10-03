import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const config: NextConfig = {
  transpilePackages: ['@hotella/ui'],
  poweredByHeader: false,
  // The browser reaches the API through this origin (`/hotella/*`, a runtime proxy route): same origin, no CORS.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Activation and QR tokens are in the URL: never leak them to other sites.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default createNextIntlPlugin('./src/i18n/request.ts')(config);

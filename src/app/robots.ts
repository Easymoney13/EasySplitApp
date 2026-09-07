import type { MetadataRoute } from 'next';

const publicOrigin = process.env.NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN || 'https://billspltapp.onrender.com';

export default function robots(): MetadataRoute.Robots {
  const origin = new URL('/', publicOrigin).origin;

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: '/api/',
    },
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}

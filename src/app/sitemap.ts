import type { MetadataRoute } from 'next';

const publicOrigin = process.env.NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN || 'https://billspltapp.onrender.com';

export default function sitemap(): MetadataRoute.Sitemap {
  return [{
    url: new URL('/', publicOrigin).toString(),
    changeFrequency: 'weekly',
    priority: 1,
  }];
}

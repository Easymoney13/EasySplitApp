const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relativePath => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

const notFoundSource = read('src/app/not-found.tsx');
const sitemapSource = read('src/app/sitemap.ts');
const robotsSource = read('src/app/robots.ts');
const sessionLayoutSource = read('src/app/session/[id]/layout.tsx');
const groupLayoutSource = read('src/app/group/[id]/layout.tsx');

test('the custom 404 is branded, bilingual, and provides a safe home route', () => {
  assert.match(notFoundSource, /Page not found/);
  assert.match(notFoundSource, /העמוד שחיפשת לא נמצא/);
  assert.match(notFoundSource, /<EasySplitMark/);
  assert.match(notFoundSource, /<EasySplitWordmark/);
  assert.match(notFoundSource, /href="\/"/);
});

test('the sitemap publishes only the public home page at the configured production origin', () => {
  assert.match(sitemapSource, /MetadataRoute\.Sitemap/);
  assert.match(sitemapSource, /NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN/);
  assert.match(sitemapSource, /url: new URL\('\/', publicOrigin\)\.toString\(\)/);
  assert.doesNotMatch(sitemapSource, /session|group|api/);
});

test('robots keeps server routes out of search without breaking room link previews', () => {
  assert.match(robotsSource, /MetadataRoute\.Robots/);
  assert.match(robotsSource, /allow: '\/'/);
  assert.match(robotsSource, /disallow: '\/api\/'/);
  assert.doesNotMatch(robotsSource, /disallow:[^\n]*(session|group)/);
  assert.match(robotsSource, /sitemap: `\$\{origin\}\/sitemap\.xml`/);
  assert.match(robotsSource, /host: origin/);
});

test('private room routes also emit explicit noindex metadata', () => {
  for (const source of [sessionLayoutSource, groupLayoutSource]) {
    assert.match(source, /robots:[\s\S]*?index: false[\s\S]*?follow: false/);
  }
});

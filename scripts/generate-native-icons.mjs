/**
 * Mechanical platform exports of the existing approved EasySplit logo.
 * Run: node scripts/generate-native-icons.mjs [--check]
 *
 * The source is currently 180x180; resizing does not recover master-art detail.
 * No AI generation, tracing, or changes to the receipt/checkmark are involved.
 * sharp is already installed by Next.js; no new dependency is required.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'public/images/easysplit-logo.webp');
const check = process.argv.includes('--check');
const purple = '#302fb9';
const metadata = await sharp(source).metadata();
if (metadata.width !== metadata.height) throw new Error('The approved logo must be square.');

const outputs = new Map();
// Apple applies its own corner mask. Store a full opaque RGB square.
outputs.set('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png',
  await sharp(source).flatten({ background: purple }).resize(1024, 1024).removeAlpha().png().toBuffer());

for (const [density, size, adaptiveSize] of [
  ['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432],
]) {
  const directory = `android/app/src/main/res/mipmap-${density}`;
  const square = await sharp(source).flatten({ background: purple }).resize(size, size).png().toBuffer();
  outputs.set(`${directory}/ic_launcher.png`, square);
  const roundMask = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`);
  outputs.set(`${directory}/ic_launcher_round.png`,
    await sharp(square).ensureAlpha().composite([{ input: roundMask, blend: 'dest-in' }]).png().toBuffer());

  // Android's canvas is 108dp, with an inner safe region. Scaling the complete
  // source to 81dp keeps its receipt/checkmark inside the central 66dp circle,
  // including the receipt's lower corners, for round and other OEM masks.
  // The foreground itself is square and opaque: only the launcher clips it.
  const logoSize = Math.round(adaptiveSize * 0.75);
  const inset = Math.floor((adaptiveSize - logoSize) / 2);
  const logo = await sharp(source).resize(logoSize, logoSize).png().toBuffer();
  outputs.set(`${directory}/ic_launcher_foreground.png`,
    await sharp({ create: { width: adaptiveSize, height: adaptiveSize, channels: 3, background: purple } })
      .composite([{ input: logo, left: inset, top: inset }]).removeAlpha().png().toBuffer());
}

outputs.set('android/app/src/main/res/values/ic_launcher_background.xml', Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${purple.toUpperCase()}</color>
</resources>
`));
// These legacy drawable names are retained, but no longer contain the Android
// Studio/Capacitor template artwork. The launcher uses the mipmap resources.
outputs.set('android/app/src/main/res/drawable/ic_launcher_background.xml', Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="@color/ic_launcher_background" />
</shape>
`));
outputs.set('android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml', Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<bitmap xmlns:android="http://schemas.android.com/apk/res/android"
    android:src="@mipmap/ic_launcher_foreground"
    android:gravity="fill" />
`));

const mismatches = [];
for (const [relative, contents] of outputs) {
  const destination = path.join(root, relative);
  if (check) {
    const actual = await fs.readFile(destination).catch(() => null);
    if (!actual?.equals(contents)) mismatches.push(relative);
  } else {
    await fs.writeFile(destination, contents);
  }
}
if (mismatches.length) {
  throw new Error(`Native icons differ from the approved source exports:\n${mismatches.join('\n')}`);
}
console.log(`${check ? 'Verified' : 'Exported'} ${outputs.size} native icon files from ${metadata.width}x${metadata.height} approved artwork.`);
if (metadata.width < 1024) {
  console.log('Source-resolution limit: the iOS 1024px export is upscaled, not a high-resolution master.');
}

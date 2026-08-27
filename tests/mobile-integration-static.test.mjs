import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = async (path) => readFile(new URL(path, root), 'utf8');

async function exists(path) {
  try {
    await access(new URL(path, root));
    return true;
  } catch {
    return false;
  }
}

test('mobile package scripts are pinned and guarded by Node 22 without changing web scripts', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.scripts.build, 'next build');
  assert.equal(pkg.scripts.start, 'NODE_ENV=production node server.js');
  assert.match(pkg.scripts['mobile:build'], /mobile:check-node/);
  assert.equal(pkg.devDependencies['@capacitor/cli'], '8.5.0');
  assert.equal(pkg.devDependencies.vite, '8.2.2');
});

test('mobile shell is included in Tailwind scanning and generated output stays untracked', async () => {
  const tailwind = await read('tailwind.config.js');
  const gitignore = await read('.gitignore');
  assert.match(tailwind, /\.\/mobile\/\*\*\/\*\.\{js,ts,jsx,tsx,mdx\}/);
  assert.match(gitignore, /\/mobile-dist\//);
  assert.match(gitignore, /!\.env\.mobile\.example/);
});

test('shared room pages keep mobile recovery and use the native camera bridge explicitly', async () => {
  const session = await read('src/app/session/[id]/page.tsx');
  const group = await read('src/app/group/[id]/page.tsx');
  for (const source of [session, group]) {
    assert.match(source, /MOBILE_RECOVERY_EVENT/);
    assert.match(source, /addEventListener\(MOBILE_RECOVERY_EVENT/);
    assert.match(source, /from ['"]@capacitor\/core['"]/);
    assert.match(source, /from ['"]@capacitor\/camera['"]/);
    assert.match(source, /Capacitor\.isNativePlatform\(\)/);
    assert.match(source, /CapCamera\.getPhoto/);
  }
  assert.doesNotMatch(group, /window\.location\.href\s*=\s*`\/session\//);
});

test('committed native projects wire Camera and Haptics on both iOS and Android', async () => {
  assert.equal(await exists('ios/App/CapApp-SPM/Package.swift'), true);
  assert.equal(await exists('android/capacitor.settings.gradle'), true);
  assert.equal(await exists('android/app/capacitor.build.gradle'), true);

  const pkg = JSON.parse(await read('package.json'));
  const iosPackage = await read('ios/App/CapApp-SPM/Package.swift');
  const androidSettings = await read('android/capacitor.settings.gradle');
  const androidBuild = await read('android/app/capacitor.build.gradle');

  assert.ok(pkg.dependencies['@capacitor/camera']);
  assert.ok(pkg.dependencies['@capacitor/haptics']);
  assert.match(iosPackage, /CapacitorCamera/);
  assert.match(iosPackage, /CapacitorHaptics/);
  assert.match(androidSettings, /include ':capacitor-camera'/);
  assert.match(androidSettings, /include ':capacitor-haptics'/);
  assert.match(androidBuild, /implementation project\(':capacitor-camera'\)/);
  assert.match(androidBuild, /implementation project\(':capacitor-haptics'\)/);
});

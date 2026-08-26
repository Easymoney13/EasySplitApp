import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = async (path) => readFile(new URL(path, root), 'utf8');

async function missing(path) {
  try {
    await access(new URL(path, root));
    return false;
  } catch {
    return true;
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

test('shared room pages consume mobile recovery without importing Capacitor', async () => {
  const session = await read('src/app/session/[id]/page.tsx');
  const group = await read('src/app/group/[id]/page.tsx');
  for (const source of [session, group]) {
    assert.match(source, /MOBILE_RECOVERY_EVENT/);
    assert.match(source, /addEventListener\(MOBILE_RECOVERY_EVENT/);
    assert.doesNotMatch(source, /from ['"]@capacitor\//);
  }
  assert.doesNotMatch(group, /window\.location\.href\s*=\s*`\/session\//);
});

test('Stage 1 native platform projects are committed and structurally present', async () => {
  assert.equal(await missing('ios/'), false);
  assert.equal(await missing('android/'), false);
  assert.equal(await missing('ios/App/App.xcodeproj/project.pbxproj'), false);
  assert.equal(await missing('android/app/build.gradle'), false);
});

test('Camera and Haptics are synchronized into both native projects', async () => {
  const packageSwift = await read('ios/App/CapApp-SPM/Package.swift');
  const androidSettings = await read('android/capacitor.settings.gradle');
  const androidBuild = await read('android/app/capacitor.build.gradle');

  for (const plugin of ['Camera', 'Haptics']) {
    assert.match(packageSwift, new RegExp(`Capacitor${plugin}`));
  }
  for (const plugin of ['camera', 'haptics']) {
    assert.match(androidSettings, new RegExp(`:capacitor-${plugin}`));
    assert.match(androidBuild, new RegExp(`project\\(':capacitor-${plugin}'\\)`));
  }
  assert.doesNotMatch(packageSwift, /path:\s*"[^"\n]*\\/);
});

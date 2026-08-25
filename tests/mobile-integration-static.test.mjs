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

test('Task 1 does not generate native platform projects', async () => {
  assert.equal(await missing('ios/'), true);
  assert.equal(await missing('android/'), true);
});

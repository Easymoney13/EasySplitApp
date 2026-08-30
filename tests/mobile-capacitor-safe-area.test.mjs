import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchCapacitorSystemBars } from '../scripts/patch-capacitor-system-bars.mjs';

const systemBarsFixture = `package com.getcapacitor.plugin;

class SystemBars {
  void injectSafeAreaCSS() {
    String script = String.format(
      Locale.US,
      """
                    try {
                      document.documentElement.style.setProperty("--safe-area-inset-top", "%dpx");
                      document.documentElement.style.setProperty("--safe-area-inset-right", "%dpx");
                      document.documentElement.style.setProperty("--safe-area-inset-bottom", "%dpx");
                      document.documentElement.style.setProperty("--safe-area-inset-left", "%dpx");
                    } catch(e) { console.error('Error injecting safe area CSS:', e); }
      """
    );
  }
}
`;

test('Capacitor SystemBars patch guards a missing document root and is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easysplit-system-bars-'));
  const filePath = join(directory, 'SystemBars.java');
  try {
    await writeFile(filePath, systemBarsFixture);

    assert.equal(patchCapacitorSystemBars(filePath), 'patched');
    const patched = await readFile(filePath, 'utf8');
    assert.match(patched, /if \(document\.documentElement\) \{/);
    assert.equal(
      (patched.match(/document\.documentElement\.style\.setProperty/g) || []).length,
      4,
    );
    assert.equal(patchCapacitorSystemBars(filePath), 'already-patched');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Capacitor SystemBars patch fails closed for an unexpected framework source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easysplit-system-bars-'));
  const filePath = join(directory, 'SystemBars.java');
  try {
    await writeFile(filePath, 'class SystemBars {}\n');
    assert.throws(
      () => patchCapacitorSystemBars(filePath),
      /Unsupported @capacitor\/android SystemBars source/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Capacitor SystemBars patch fails closed when patched and unpatched injections coexist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easysplit-system-bars-'));
  const filePath = join(directory, 'SystemBars.java');
  try {
    await writeFile(filePath, systemBarsFixture);
    patchCapacitorSystemBars(filePath);
    const patched = await readFile(filePath, 'utf8');
    await writeFile(filePath, `${patched}\n${systemBarsFixture}`);

    assert.throws(
      () => patchCapacitorSystemBars(filePath),
      /Unsupported @capacitor\/android SystemBars source/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('package install always applies the pinned Capacitor SystemBars patch', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.dependencies['@capacitor/android'], '8.5.0');
  assert.equal(packageJson.scripts.postinstall, 'node scripts/patch-capacitor-system-bars.mjs');
});

test('Capacitor retries safe-area injection after the document root exists', async () => {
  const systemBars = await readFile(new URL(
    '../node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/SystemBars.java',
    import.meta.url,
  ), 'utf8');
  const nativeBridge = await readFile(new URL(
    '../node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js',
    import.meta.url,
  ), 'utf8');

  assert.match(systemBars, /public void onDOMReady\(\)/);
  assert.match(systemBars, /onDOMReady[\s\S]*?requestApplyInsets\(\)/);
  assert.match(systemBars, /onPageCommitVisible[\s\S]*?requestApplyInsets\(\)/);
  assert.match(nativeBridge, /DOMContentLoaded[\s\S]*?CapacitorSystemBarsAndroidInterface\.onDOMReady\(\)/);
});

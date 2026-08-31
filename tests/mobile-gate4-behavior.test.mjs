import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { instrumentGate4AuthSource } from '../mobile/gate4/auth-instrumentation.mjs';
import { GATE4_CORE_MARKERS, runGate4Core } from '../mobile/gate4/core-flow.mjs';
import { GATE4_CORE_MARKERS as REPORT_MARKERS } from '../.github/validation/gate4-contract.mjs';
import { gate4FixtureScript } from '../mobile/gate4/fixture.mjs';
import { runGate4Once } from '../mobile/gate4/run-once.mjs';

const execFileAsync = promisify(execFile);

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

test('Gate 4 fixture behaviorally installs a complete guest profile before application code', () => {
  const storage = memoryStorage();
  vm.runInNewContext(gate4FixtureScript(), { localStorage: storage });
  assert.deepEqual(JSON.parse(storage.getItem('billsplit_local_profile')), {
    displayName: 'Gate Four Host',
    phoneNumber: '0501234567',
    avatarColor: '#4DE1A1',
  });
  assert.equal(storage.getItem('billsplit_phone'), '0501234567');
  assert.equal(storage.getItem('billsplit_account_scope'), 'guest');
  assert.equal(storage.getItem('billsplit_lang'), 'en');
});

test('test-only auth instrumentation observes the real sequence without changing product sources', async () => {
  const [firebaseSource, languageSource] = await Promise.all([
    readFile(new URL('../lib/firebase.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/LanguageContext.tsx', import.meta.url), 'utf8'),
  ]);
  const firebase = instrumentGate4AuthSource(firebaseSource, '/repo/lib/firebase.ts').code;
  const language = instrumentGate4AuthSource(languageSource, '/repo/src/components/LanguageContext.tsx').code;
  assert.match(firebase, /stage: 'AUTH_CREATED'/);
  assert.match(firebase, /stage: 'PERSISTENCE_STARTED'/);
  assert.match(firebase, /stage: 'PERSISTENCE_COMPLETED'/);
  assert.match(language, /stage: 'MODULE_IMPORTED'/);
  assert.match(language, /stage: 'LISTENER_REGISTERED'/);
  assert.match(language, /stage: 'CALLBACK_FIRED'/);
  assert.match(language, /history: \[\.\.\.\(previous\?\.history \|\| \[\]\), entry\]\.slice\(-20\)/);
  assert.doesNotMatch(firebaseSource, /__EASYSPLIT_GATE4_AUTH_DIAGNOSTICS__/);
  assert.doesNotMatch(languageSource, /__EASYSPLIT_GATE4_AUTH_DIAGNOSTICS__/);
  assert.throws(
    () => instrumentGate4AuthSource('const auth = missing();', '/repo/lib/firebase.ts'),
    /anchor is missing/,
  );
});

test('Gate 4 core earns markers in order only after each behavioral step', async () => {
  assert.deepEqual(GATE4_CORE_MARKERS, REPORT_MARKERS);
  const calls = [];
  const progress = [];
  const driver = Object.fromEntries([
    ['waitForApplication', {}],
    ['createSession', { sessionId: 'session-1' }],
    ['joinParticipant', { guestId: 'guest-1' }],
    ['allocateAndReconcile', { itemTotal: 150 }],
    ['completePayment', { finalStatus: 'settled' }],
  ].map(([method, result]) => [method, async (context) => {
    calls.push({ method, context: { ...context } });
    return result;
  }]));

  const result = await runGate4Core(driver, async (update) => progress.push(update));
  assert.deepEqual(calls.map(({ method }) => method), [
    'waitForApplication',
    'createSession',
    'joinParticipant',
    'allocateAndReconcile',
    'completePayment',
  ]);
  assert.deepEqual(result.markers, GATE4_CORE_MARKERS);
  assert.equal(result.context.sessionId, 'session-1');
  assert.equal(result.context.finalStatus, 'settled');
  assert.deepEqual(progress.at(-1), {
    stage: 'NATIVE_CORE_FLOW',
    status: 'PASS',
    markers: GATE4_CORE_MARKERS,
  });
});

test('a failed Gate 4 step stops later actions and cannot claim later markers', async () => {
  const calls = [];
  const progress = [];
  const driver = {
    async waitForApplication() { calls.push('ready'); },
    async createSession() { calls.push('create'); return { sessionId: 'session-1' }; },
    async joinParticipant() { calls.push('join'); return { guestId: 'guest-1' }; },
    async allocateAndReconcile() { calls.push('allocate'); throw new Error('UI did not update'); },
    async completePayment() { calls.push('payment'); },
  };
  await assert.rejects(
    runGate4Core(driver, async (update) => progress.push(update)),
    /UI did not update/,
  );
  assert.deepEqual(calls, ['ready', 'create', 'join', 'allocate']);
  assert.deepEqual(progress.at(-1), {
    stage: 'ALLOCATION_RECONCILIATION',
    status: 'FAIL',
    markers: GATE4_CORE_MARKERS.slice(0, 2),
    error: 'UI did not update',
  });
});

test('durable run guard permits one execution per runId across concurrent launches and reloads', async () => {
  const storage = memoryStorage();
  let executions = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const first = runGate4Once({
    storage,
    runId: 'run-1',
    platform: 'ios',
    execute: async () => { executions += 1; await pending; return 'done'; },
  });
  const concurrent = await runGate4Once({
    storage,
    runId: 'run-1',
    platform: 'ios',
    execute: async () => { executions += 1; },
  });
  assert.equal(concurrent.started, false);
  assert.equal(concurrent.state.status, 'running');
  release();
  assert.equal((await first).state.status, 'pass');
  assert.equal((await runGate4Once({
    storage,
    runId: 'run-1',
    platform: 'ios',
    execute: async () => { executions += 1; },
  })).started, false);
  assert.equal((await runGate4Once({
    storage,
    runId: 'run-2',
    platform: 'ios',
    execute: async () => { executions += 1; },
  })).started, true);
  assert.equal(executions, 2);
});

test('Android orchestration runs Gate 3 even when the Gate 4 child fails', async () => {
  const root = new URL('../', import.meta.url);
  const wrapper = new URL('.github/validation/run-native-android-validation.sh', root);
  const fixture = await mkdtemp(join(tmpdir(), 'easysplit-gate4-orchestration-'));
  const gate4 = join(fixture, 'gate4.sh');
  const gate3 = join(fixture, 'gate3.sh');
  const apk = join(fixture, 'app.apk');
  try {
    await writeFile(gate4, '#!/usr/bin/env bash\nmkdir -p "$1"\nprintf gate4 >"$1/called"\nexit 23\n');
    await writeFile(gate3, '#!/usr/bin/env bash\nmkdir -p "$1"\nprintf gate3 >"$1/called"\nexit 17\n');
    await writeFile(apk, 'fixture');
    await chmod(gate4, 0o755);
    await chmod(gate3, 0o755);
    await execFileAsync('bash', [wrapper.pathname, join(fixture, 'out'), apk, 'run-android'], {
      env: {
        ...process.env,
        EASYSPLIT_GATE4_WRAPPER: gate4,
        EASYSPLIT_GATE3_WRAPPER: gate3,
      },
    });
    assert.equal(await readFile(join(fixture, 'out/gate4/called'), 'utf8'), 'gate4');
    assert.equal(await readFile(join(fixture, 'out/gate3/called'), 'utf8'), 'gate3');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('Android Gate 4 wrapper preserves validator failure and runtime diagnostics', async () => {
  const root = new URL('../', import.meta.url);
  const wrapper = new URL('.github/validation/run-native-android-gate4.sh', root);
  const fixture = await mkdtemp(join(tmpdir(), 'easysplit-gate4-wrapper-'));
  const output = join(fixture, 'output');
  const apk = join(fixture, 'app.apk');
  const adb = join(fixture, 'adb');
  const node = join(fixture, 'node');
  const npm = join(fixture, 'npm');
  const curl = join(fixture, 'curl');
  try {
    await writeFile(apk, 'fixture');
    await writeFile(adb, `#!/usr/bin/env bash
if [[ "$1" == "exec-out" ]]; then printf 'png-bytes'; exit 0; fi
if [[ "$1" == "logcat" && "\${2:-}" != "-c" ]]; then printf 'logcat-line\\n'; exit 0; fi
exit 0
`);
    await writeFile(node, `#!/usr/bin/env bash
if [[ "\${2:-}" == "serve" ]]; then while true; do sleep 1; done; fi
printf 'validator failed after progress capture\\n'
exit 23
`);
    await writeFile(npm, '#!/usr/bin/env bash\nwhile true; do sleep 1; done\n');
    await writeFile(curl, '#!/usr/bin/env bash\nexit 0\n');
    await Promise.all([adb, node, npm, curl].map((path) => chmod(path, 0o755)));
    await execFileAsync('bash', [wrapper.pathname, output, apk, 'run-wrapper'], {
      cwd: root.pathname,
      env: {
        ...process.env,
        ADB: adb,
        EASYSPLIT_NODE_BIN: node,
        NPM: npm,
        CURL: curl,
      },
    });
    assert.equal((await readFile(join(output, 'gate4-exit-code.txt'), 'utf8')).trim(), '23');
    assert.match(await readFile(join(output, 'gate4-result.txt'), 'utf8'), /validator failed/);
    assert.equal(await readFile(join(output, 'gate4-final.png'), 'utf8'), 'png-bytes');
    assert.match(await readFile(join(output, 'gate4-logcat.txt'), 'utf8'), /logcat-line/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

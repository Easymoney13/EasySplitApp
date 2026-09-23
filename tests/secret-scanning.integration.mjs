import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Run with a real Gitleaks >= 8.28 binary. No provider request is made and all
// credential-shaped fixtures are generated locally and have never been issued.
const binary = process.env.GITLEAKS_BIN || 'gitleaks';
const config = fileURLToPath(new URL('../.gitleaks.toml', import.meta.url));
const publicFirebaseKey = Buffer.from(
  'QUl6YVN5QlFtZUpWOFRSNzdYR1JTeWJ3VEpYQTZIWlhoOERtR3g4', 'base64',
).toString('utf8');

async function scan(files, expectation) {
  const root = await mkdtemp(path.join(tmpdir(), 'easysplit-scanner-'));
  const source = path.join(root, 'source');
  const report = path.join(root, 'redacted.json');
  try {
    for (const [name, contents] of Object.entries(files)) {
      const file = path.join(source, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
    const result = spawnSync(binary, [
      'dir', '.', '--config', config, '--redact', '--no-banner',
      '--log-level', 'error', '--report-format', 'json', '--report-path', report,
    ], { cwd: source, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    assert.ok([0, 1].includes(result.status), 'Gitleaks must finish successfully, not skip or crash');
    const findings = JSON.parse(await readFile(report, 'utf8'));
    // Never print matched values, even when a regression fails.
    const locations = findings.map(({ File, RuleID, StartLine }) => ({ File, RuleID, StartLine }));
    assert.deepEqual(locations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      expectation.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    assert.equal(result.status, expectation.length ? 1 : 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('the exact public Firebase identifier is exempt only in its client config', async () => {
  await scan({
    'lib/firebase.ts': `const apiKey = '${publicFirebaseKey}';\n`,
    'lib/server.ts': `const apiKey = '${publicFirebaseKey}';\n`,
  }, [{ File: 'lib/server.ts', RuleID: 'gcp-api-key', StartLine: 1 }]);
});

test('a different Google credential in Firebase client config still fails scanning', async () => {
  const synthetic = ['AI', 'za', randomBytes(24).toString('base64url').slice(0, 32), 'Z9b'].join('');
  await scan({ 'lib/firebase.ts': `const apiKey = '${synthetic}';\n` },
    [{ File: 'lib/firebase.ts', RuleID: 'gcp-api-key', StartLine: 1 }]);
});

test('default credential rules cover source, tests, database and release verifier files', async () => {
  const synthetic = ['gh', 'p_', randomBytes(18).toString('hex')].join('');
  const paths = ['server.js', 'lib/firebase.ts', 'tests/fixture.js', 'db.json', 'scripts/verify-mobile-release.mjs'];
  await scan(Object.fromEntries(paths.map((file) => [file, `const token = '${synthetic}';\n`])),
    paths.map((File) => ({ File, RuleID: 'github-pat', StartLine: 1 })));
});

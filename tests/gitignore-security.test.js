const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function createIgnoreHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easysplit-gitignore-'));
  fs.copyFileSync(path.join(__dirname, '..', '.gitignore'), path.join(directory, '.gitignore'));
  execFileSync('git', ['init', '-q'], { cwd: directory });
  return directory;
}

function isIgnored(directory, candidate) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', candidate], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.ok(result.status === 0 || result.status === 1, `git check-ignore failed for ${candidate}: ${result.stderr}`);
  return result.status === 0;
}

test('security-sensitive local artifacts cannot be accidentally added', () => {
  const directory = createIgnoreHarness();
  try {
    const blocked = [
      '.env.staging', '.env.development.local', 'apps/web/.env.production',
      'config/firebase-adminsdk-project.json', 'secrets/service-account-prod.json',
      'secrets/service_account_prod.json', 'secrets/serviceAccountKey.json',
      'secrets/credential.json', 'secrets/credentials.json',
      'secrets/client_secret_web.json', 'keys/private-key.pem',
      'keys/signing.key', 'keys/id_ed25519', 'db.production.json',
      'db.json.bak', 'runtime.sqlite', 'data/runtime.sqlite.bak',
      'data/local.db-wal',
    ];
    for (const candidate of blocked) {
      assert.equal(isIgnored(directory, candidate), true, `${candidate} must be ignored`);
    }

    const allowed = [
      '.env.example', 'db.example.json', 'config/app.json',
      'docs/credentials.md', 'public/private-key-icon.svg',
      'tests/fixtures/sample.json',
    ];
    for (const candidate of allowed) {
      assert.equal(isIgnored(directory, candidate), false, `${candidate} must remain addable`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

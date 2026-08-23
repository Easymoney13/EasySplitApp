const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRoomMember } = require('../lib/roomAuth');

async function getAvailablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function waitForServer(child, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out.\n${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('BillSplit Unified Server ready')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before startup with code ${code}.\n${output}`));
    });
  });
}

test('legacy four-digit invite codes remain compatible and responses include security headers', { timeout: 60_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easysplit-invite-'));
  const dbPath = path.join(tempDir, 'db.json');
  const sessionHost = createRoomMember({ name: 'Session Host', isHost: true });
  const groupHost = createRoomMember({ name: 'Group Host', isHost: true });
  fs.writeFileSync(dbPath, JSON.stringify({
    users: {},
    history: [],
    sessions: {
      'sess_invite_test': {
        id: 'sess_invite_test',
        code: '4321',
        status: 'active',
        members: [sessionHost.member],
        items: [],
      },
    },
    groups: {
      'grp_invite_test': {
        id: 'grp_invite_test',
        code: '6789',
        status: 'active',
        currency: 'NIS',
        members: [groupHost.member],
        bills: [],
      },
    },
  }));

  const port = await getAvailablePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      NEXT_TELEMETRY_DISABLED: '1',
      BILLSPLIT_DB_PATH: dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(child);
  const baseUrl = `http://127.0.0.1:${port}`;

  const sessionDiscovery = await fetch(`${baseUrl}/api/session/4321`);
  assert.equal(sessionDiscovery.status, 200);
  assert.equal(sessionDiscovery.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(sessionDiscovery.headers.get('x-frame-options'), 'DENY');
  assert.equal(sessionDiscovery.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(sessionDiscovery.headers.get('permissions-policy') || '', /microphone=\(\)/);
  assert.match(sessionDiscovery.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.match(sessionDiscovery.headers.get('content-security-policy') || '', /https:\/\/fonts\.googleapis\.com/);
  assert.match(sessionDiscovery.headers.get('content-security-policy') || '', /https:\/\/fonts\.gstatic\.com/);
  assert.deepEqual(await sessionDiscovery.json(), {
    session: { id: 'sess_invite_test', code: '4321', status: 'active' },
  });

  const oversizedEarlyResponse = await fetch(`${baseUrl}/api/unknown`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'x'.repeat(769 * 1024),
  });
  assert.equal(oversizedEarlyResponse.status, 413);
  assert.equal(oversizedEarlyResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.match(oversizedEarlyResponse.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);

  const sessionJoin = await fetch(`${baseUrl}/api/session/4321/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Session Guest' }),
  });
  assert.equal(sessionJoin.status, 200);
  assert.equal((await sessionJoin.json()).session.members.length, 2);

  const groupDiscovery = await fetch(`${baseUrl}/api/groups/6789`);
  assert.equal(groupDiscovery.status, 200);
  assert.deepEqual(await groupDiscovery.json(), {
    group: { id: 'grp_invite_test', code: '6789', status: 'active' },
  });

  const groupJoin = await fetch(`${baseUrl}/api/groups/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groupId: '6789', name: 'Group Guest' }),
  });
  assert.equal(groupJoin.status, 200);
  assert.equal((await groupJoin.json()).group.members.length, 2);
});

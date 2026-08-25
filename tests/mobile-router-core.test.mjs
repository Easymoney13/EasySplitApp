import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backAction,
  buildShellSearch,
  currentDepth,
  initialHistoryPlan,
  paramsFromRoute,
  routeFromSearch,
} from '../mobile/router-core.mjs';

test('arbitrary session IDs remain client-routable without static path generation', () => {
  const search = buildShellSearch('/session/s_abc-123?groupId=g42');
  assert.equal(routeFromSearch(search), '/session/s_abc-123');
  assert.deepEqual(paramsFromRoute(routeFromSearch(search)), { id: 's_abc-123' });
  assert.equal(new URLSearchParams(search).get('groupId'), 'g42');
});

test('arbitrary group IDs remain client-routable', () => {
  const search = buildShellSearch('/group/98765432');
  assert.equal(routeFromSearch(search), '/group/98765432');
  assert.deepEqual(paramsFromRoute(routeFromSearch(search)), { id: '98765432' });
});

test('route transport never creates a local dynamic pathname', () => {
  const search = buildShellSearch('/session/live-room');
  assert.ok(search.startsWith('?'));
  assert.ok(!search.includes('https://localhost/session'));
});

test('navigation depth fails safe and rejects negative/fractional values', () => {
  assert.equal(currentDepth(undefined), 0);
  assert.equal(currentDepth({}), 0);
  assert.equal(currentDepth({ esDepth: 3 }), 3);
  assert.equal(currentDepth({ esDepth: -1 }), 0);
  assert.equal(currentDepth({ esDepth: 1.5 }), 0);
});

test('route parameter cannot override the reserved shell route key', () => {
  const search = buildShellSearch('/session/a?esRoute=/attacker&groupId=g');
  const params = new URLSearchParams(search);
  assert.equal(params.get('esRoute'), '/session/a');
  assert.equal(params.get('groupId'), 'g');
});

test('malformed encoded ids cannot crash the mobile router', () => {
  assert.doesNotThrow(() => paramsFromRoute('/session/%E0%A4%A'));
  assert.deepEqual(paramsFromRoute('/session/%E0%A4%A'), { id: '%E0%A4%A' });
});

test('a direct session/group launch seeds a real home history entry for Android back', () => {
  assert.deepEqual(initialHistoryPlan('?esRoute=%2Fsession%2Fabc', null), { seedHome: true, depth: 1 });
  assert.deepEqual(initialHistoryPlan('?esRoute=%2Fgroup%2Fg1', {}), { seedHome: true, depth: 1 });
  assert.deepEqual(initialHistoryPlan('?esRoute=%2F', null), { seedHome: false, depth: 0 });
  assert.deepEqual(initialHistoryPlan('?esRoute=%2Fsession%2Fabc', { esDepth: 2 }), { seedHome: false, depth: 2 });
});


test('Android back decision is deterministic at each navigation state', () => {
  assert.equal(backAction('?esRoute=%2Fsession%2Fa', { esDepth: 1 }), 'history-back');
  assert.equal(backAction('?esRoute=%2Fgroup%2Fg', { esDepth: 0 }), 'home');
  assert.equal(backAction('?esRoute=%2F', { esDepth: 0 }), 'exit');
});

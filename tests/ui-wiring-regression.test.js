const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
const homeSource = read('src/app/page.tsx');
const groupSource = read('src/app/group/[id]/page.tsx');
const sessionSource = read('src/app/session/[id]/page.tsx');
const rollingNumberSource = read('src/components/AnimatedRollingNumber.tsx');

test('the shared rolling-number component is wired into live session and group values', () => {
  assert.match(sessionSource, /import \{ AnimatedRollingNumber \}/);
  assert.doesNotMatch(sessionSource, /function AnimatedPriceCounter/);
  assert.equal((sessionSource.match(/<AnimatedRollingNumber/g) || []).length, 3);
  assert.match(groupSource, /import \{ AnimatedRollingNumber \}/);
  assert.ok((groupSource.match(/<AnimatedRollingNumber/g) || []).length >= 2);
  assert.match(rollingNumberSource, /cancelAnimationFrame/);
  assert.match(rollingNumberSource, /dir="ltr"/);
});

test('the active-group context modal consumes its prepared swipe state and handlers', () => {
  assert.match(homeSource, /transform: groupModalDragY > 0 \? `translateY\(\$\{groupModalDragY\}px\)`/);
  assert.ok((homeSource.match(/onTouchStart=\{handleGroupTouchStart\}/g) || []).length >= 2);
  assert.ok((homeSource.match(/onTouchMove=\{handleGroupTouchMove\}/g) || []).length >= 2);
  assert.ok((homeSource.match(/onTouchEnd=\{handleGroupTouchEnd\}/g) || []).length >= 2);
  assert.match(homeSource, /if \(groupModalDragY > 75\) \{\s+closeGroupModal\(\)/);
});

test('the group overview reserves enough height and keeps its content distributed inside the card', () => {
  assert.match(groupSource, /min-h-\[132px\][^"\n]*flex flex-col justify-between gap-3/);
  assert.match(groupSource, /pointer-events-none absolute -top-16/);
  assert.match(groupSource, /className="block text-3xl font-black text-white/);
});

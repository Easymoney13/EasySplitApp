const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
const homeSource = read('src/app/page.tsx');
const groupSource = read('src/app/group/[id]/page.tsx');
const sessionSource = read('src/app/session/[id]/page.tsx');
const rollingNumberSource = read('src/components/AnimatedRollingNumber.tsx');
const qrModalSource = read('src/components/QRCodeModal.tsx');
const swipeableSource = read('src/components/SwipeableCard.tsx');
const serverSource = read('server.js');

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

test('invite races, QR layering, and destructive swipes are guarded in the UI contract', () => {
  assert.match(sessionSource, /authLoading \|\| !displayName \|\| !isValidIsraeliPhone\(phoneNumber\)/);
  assert.match(sessionSource, /joinInFlightRef/);
  assert.match(sessionSource, /clientId: getOrCreateRoomClientId\(\)/);
  assert.match(serverSource, /actorPayload = \['TOGGLE_CLAIM', 'TOGGLE_SETTLED'\]\.includes\(action\)/);
  assert.match(qrModalSource, /z-\[90\]/);
  assert.match(qrModalSource, /max-h-\[calc\(100dvh-1\.5rem\)\]/);
  assert.match(swipeableSource, /createPortal/);
  assert.match(swipeableSource, /Are you sure\?/);
});

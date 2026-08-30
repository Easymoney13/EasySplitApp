const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
const homeSource = read('src/app/page.tsx');
const groupSource = read('src/app/group/[id]/page.tsx');
const sessionSource = read('src/app/session/[id]/page.tsx');
const rollingNumberSource = read('src/components/AnimatedRollingNumber.tsx');
const qrModalSource = read('src/components/QRCodeModal.tsx');
const swipeableSource = read('src/components/SwipeableCard.tsx');
const cameraSource = read('src/components/CameraViewfinder.tsx');
const ocrProgressSource = read('src/components/OCRProgressOverlay.tsx');
const serverSource = read('server.js');

test('every receipt scan keeps the original phone video and result-bound progress bar', () => {
  assert.match(homeSource, /<OCRProgressOverlay isVisible=\{isUploading\} \/>/);
  assert.match(groupSource, /<OCRProgressOverlay isVisible=\{isUploading\} \/>/);
  assert.match(cameraSource, /return <OCRProgressOverlay isVisible=\{true\} \/>/);
  assert.doesNotMatch(cameraSource, /EasySplitLoadingScreen/);
  assert.match(ocrProgressSource, /className="fixed inset-0[^"\n]*overflow-hidden/);
  assert.match(ocrProgressSource, /src="\/easysplit-loading\.mp4"/);
  assert.match(ocrProgressSource, /autoPlay\s+loop\s+muted\s+playsInline\s+preload="auto"/s);
  assert.match(ocrProgressSource, /Math\.min\(92,/);
  assert.match(ocrProgressSource, /if \(shouldRender\) \{\s+setProgress\(100\)/);
  assert.match(ocrProgressSource, /role="progressbar"/);

  const video = fs.readFileSync(path.join(__dirname, '..', 'public/easysplit-loading.mp4'));
  assert.equal(
    crypto.createHash('sha256').update(video).digest('hex'),
    '037c9b824bfab47ebc7ee865efd3b58e20383b60c923bc4db49b70656f219bff',
  );
});

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
  assert.match(swipeableSource, /resetDeleteUi/);
  assert.match(qrModalSource, /sessionInviteTarget = codeInvite \? sessionCode : sessionId/);
  assert.match(sessionSource, /purgeDeletedSessionFromStorage/);
  assert.match(groupSource, /purgeDeletedGroupFromStorage/);
  assert.match(homeSource, /api\/user\/groups\/\$\{groupId\}\/history/);
  assert.match(homeSource, /\.\.\.receiptConfirmationPayload\(receiptDraft\),\s+\.\.\.billData/);
  assert.match(groupSource, /finishedCount[^]*?of \$\{finishTargetCount\} finished/);
  assert.match(groupSource, /billsplit_closed_groups/);
  assert.match(homeSource, /successful account response is authoritative/);
  assert.match(homeSource, /api\/rooms\/status/);
  assert.match(homeSource, /window\.addEventListener\('online', applyGuestCacheConvergence\)/);
  assert.match(homeSource, /purgeDeletedSessionFromStorage\(localStorage, sessionId\)/);
  assert.match(homeSource, /purgeRoomCredentialsFromStorage\(localStorage, 'session', sessionId\)/);
  assert.doesNotMatch(homeSource, /handleOpenActiveSessionQr[^]*?finally\s*\{\s*setShowQrModal\(true\)/);
  assert.doesNotMatch(sessionSource, /openShareModal[^]*?finally\s*\{\s*setShowQrModal\(true\)/);
  assert.match(sessionSource, /if \(!session\?\.id \|\| session\.status === 'settled'\) return/);
  assert.ok((sessionSource.match(/!isSessionClosed && \(/g) || []).length >= 1);
  assert.match(sessionSource, /if \(session\?\.status === 'settled'\) \{\s+localStorage\.removeItem\('billsplit_active_session'\);\s+setShowQrModal\(false\)/);
  assert.match(homeSource, /code\.length === 5 \|\| code\.length === 4 \|\| code\.length === 8/);
  assert.match(sessionSource, /persistSessionHistoryLocally\(memberCalculations\.myShare\)/);
  assert.match(serverSource, /coarseShard/);
});

test('the session payment bar follows receipt items without an empty viewport-filling spacer', () => {
  assert.match(sessionSource, /session-scroll-area p-5 pb-4 space-y-6/);
  assert.doesNotMatch(sessionSource, /session-scroll-area flex-1 min-h-0 overflow-y-auto/);
  assert.doesNotMatch(sessionSource, /app-surface flex flex-1 min-h-0 w-full flex-col/);
});

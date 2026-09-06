# Audit verification: tasks 4 and 5

Base: `0efb7834646617864567dfbe9d459ed886136402` (merged PR #17).
Branch: `codex/audit-verification-coverage`.

## Why this change

The native workflow previously omitted standalone `server.js`, Firestore rules,
database configuration and most test changes from its path filters. Those changes
could therefore land without the existing regression checks running.

Both pull requests and pushes to main now include these paths. The existing
shared/Android/iOS jobs are preserved. A separate Firestore job exercises the
repository's actual security rules against a loopback-only demo emulator, using
the already installed Firebase client and Admin SDKs. No product dependency or
production rules change is required.

The earlier maintenance, restaurant-alias and room-read regressions already
assert the corrected behavior; they are retained. Two extra maintenance tests
cover concurrent payment state plus repeat-run idempotency, and an explicit
unmatched UID with a same-name account.

## Run the database gate

Use Node 22.12+ and Java 21. The CI Node version remains 22.23.2.

```bash
npm ci
npx --yes firebase-tools@15.29.0 emulators:exec \
  --config firebase.emulators.json --project demo-easysplit-audit --only firestore \
  "node --test tests/firestore-rules.integration.mjs"
```

The test refuses to initialize either SDK unless `FIRESTORE_EMULATOR_HOST` points
to `127.0.0.1` with a valid port. It always uses `demo-easysplit-audit`. It proves
an owner can read their profile, while other-user access, profile enumeration,
all client profile writes, nested history access, and direct access to private
collections are denied. The positive owner read and explicit permission-denied
assertions prevent an unavailable emulator from being mistaken for a PASS.

## Evidence obtained locally

- Node suite: 278 passed.
- Mobile/release static checks: 111 passed.
- Real Tesseract Hebrew fixture checks: 5 passed.
- HTTP/WebSocket strain test: 1 passed; 128 sockets admitted, 12 rejected, all
  unauthenticated sockets closed.
- Real Firestore rules checks: 15 passed.
- TypeScript, Next production build and mobile Vite build: passed.
- Production dependency audit: zero reported advisories (`npm audit --omit=dev`),
  which is not a claim that the application has no security vulnerabilities.
- Isolated image-to-API journey: Hebrew OCR, unauthenticated account mutation
  rejection, explicit cloud-OCR-unavailable response, required confirmation, receipt edit,
  invite/rejoin, actor-bound claims, tip, payment target, recovery read, per-member
  completion and final closure passed. Browser interaction and actual Bit/PayBox
  launch/return were not exercised by that script.

Local tests used Node 24.19.0; the exact main commit was independently checked in
CI on Node 22.23.2. The new workflow still needs its own CI run after an approved
push. Emulator tests ran with Java 21.0.12.1 and Firebase CLI 15.29.0.

The existing main run is
[34028079824](https://github.com/Easymoney13/EasySplitApp/actions/runs/34028079824).
All three decoded job logs were read. Both downloaded artifact SHA-256 digests
matched GitHub's metadata, and the current native evidence validator accepted
both artifact sets with their exact platform/run IDs. They are evidence for the
base commit, not for a future candidate push or production deployment.

## Open findings from task 5

1. **High: account-deletion lost updates.** The production branch of
   `deleteUserAccountData` scans room snapshots and later uses unconditional
   `batch.set`. A deterministic real-emulator interleaving reproduced loss of a
   concurrent join and claim, and a settled room/member reverting to unpaid.
   This is a separate path from the canonical-maintenance repair. The audit
   records the finding; this verification change does not modify account deletion.
   A dedicated repair must reread affected records transactionally, preserve
   unrelated updates, and cover retries/partial completion and observation writes.
2. **High-priority release-control verification gap:** main is marked unprotected,
   with no required status checks in the returned branch metadata. The connector
   did not allow the branch-rules endpoint, so organization/repository ruleset
   enforcement could not be independently established. Expanding workflow
   triggers alone does not enforce passing CI. Confirm effective protection and
   require the new database job alongside the existing release checks.
3. **Medium accessibility gap:** existing receipt-item rows in
   `ManualBillModal.tsx` are click-only divs with no keyboard handler/tab stop;
   the category select has no explicit accessible label. No full screen-reader
   or keyboard session was possible in the available browser.
4. **Medium measurement gap:** `joinRoom` sets `changed=true` for returning
   members, and the server emits `participant_joined` for that case. Guest
   analytics still lack a stable user hash. This requires metric semantics work,
   not changes to correct guest-room membership behavior.

Production deployment SHA, IAM, deployed rules, App Check enforcement, secret
configuration, backup schedule/retention and restore success remain unverified.
The available Render connection has no selected partner workspace. The browser
blocked localhost preview. Real provider sign-in, cloud OCR, camera permission
prompts, native payment-app round trip and physical-device RTL/accessibility
remain separate validation gaps. No production mutations were made.

This is a verification patch and an audit record, not unconditional release
approval. New findings should be resolved according to their evidence and scope.

# Pre-store audit repairs — 2026-09-08

Branch: `codex/prestore-audit-repairs`

Base: `b4ecacf657ead0c9b76e76c2217ee549a0e1b1a2` (`origin/main`, rechecked after implementation).

## Changes and behavior

| Confirmed issue | Repair | Regression evidence |
| --- | --- | --- |
| Receipt content sent to AI without explicit disclosure/permission | Versioned affirmative consent before image preparation/upload; server rejects missing/stale permission before provider/cache access; bilingual public `/privacy`, settings withdrawal and native route | `receipt-privacy-consent`, `privacy-public-route`, `prestore-api-integration` |
| Deletion overwrites concurrent shared changes; partial retries can diverge | Re-read and transform each live Firestore record transactionally; stable random job seed across retries; remove observation references before visits; atomically finalize matching job | `account-deletion-concurrency`, `account-deletion.firestore.integration` |
| Deleted unpaid participant blocks completion | Explicit host-only unconfirmed resolution; preserve unpaid debt and claimed items; freeze affected allocations; retain marker in shared history/linked bill; reopening resets confirmation markers | `deleted-member-resolution`, `prestore-api-integration`, `prestore-ui-repair` |
| OCR deadline ends at headers instead of complete body | Keep timeout and abort signal active through JSON consumption; close unread errors and quorum losers | `ocr-provider-lifecycle` uses real loopback HTTP streams |
| Profile synchronization overwrites group/history indices | Transactional profile patches; avatar synchronization writes only the avatar fields | `account-deletion-concurrency`, Firestore integration and API regression |
| Initial session GET/JOIN failure leaves indefinite skeleton | Bounded requests through response bodies, visible retry and automatic recovery; retain JOIN single-flight | `prestore-ui-repair` |
| Included VAT shown twice in confirmation | Reconcile current edited rows through shared receipt math | `prestore-ui-repair` |
| Native camera denial appears to do nothing | Localized permission recovery; intentional cancellation stays silent; consent decline opens clean manual entry; camera retake reattaches stream and late camera requests are stopped after unmount | `receipt-entry-handlers` |
| Native launcher assets still use templates | Export current EasySplit artwork to existing iOS/Android resource names; deterministic generation/check script | `node scripts/generate-native-icons.mjs --check` |

The Hebrew accuracy integration test now prepares the unchanged Hebrew/English language assets before timing fixture scans. This removes CDN setup time from the accuracy measurement; the 18-second scan budget, 96% acceptance target and exact dual-pass agreement assertion remain unchanged. Production local OCR parsing is unchanged.

## Validation and CI

The native workflow's existing Firestore emulator job also runs the new real account-deletion/profile concurrency regressions against the loopback-only `demo-easysplit-audit` project. No production credentials or data are used.

Final validation uses CI's Node **22.23.2**, with Java 21 for Firestore. The shared gate is `npm run verify`; native-shell checks and the existing HTTP/WebSocket strain suite run separately. New JavaScript regression files are automatically included by `npm test`.

| Final local gate | Result |
| --- | --- |
| `npm run verify` | 369/369 shared tests; 5/5 Hebrew OCR tests; TypeScript and production Next build passed |
| `npm run verify:mobile-shell` | 99/99 tests; final Vite mobile build passed |
| Firestore rules + account cleanup emulator | 17/17 passed, no skipped tests |
| `npm run test:strain` | Passed HTTP/WebSocket admission and load checks |
| `npm run test:release` | 25/25 passed (overlaps some shared/mobile checks) |
| Native icon regeneration check | 19/19 files match |
| Ordinary mobile bundle | No Gate 4 validation instrumentation |

All commands exited successfully. These are local gate results; no new remote CI run is claimed.

## Rollout and remaining release facts

- Deploy the consent UI and server contract together. Older cached/native clients that omit current permission receive HTTP 428 for cloud receipt processing; they need the updated client. Manual bill confirmation remains available without cloud permission.
- A resolved deleted participant remains `active:true`, `settled:false`; the new marker never marks money transferred. Linked bill `settledMemberIds` remains empty until the existing financial settlement flow handles it.
- No database migration or new production secret is required. `_account_deletions` is a temporary server-only retry job and is removed when cleanup completes. This repairs discovered-record overwrite/retry races; it does not introduce global admission fencing for entirely new records created during account deletion.
- The approved icon source is 180×180. The 1024×1024 opaque iOS export uses that exact artwork, upscaled; a higher-resolution original would improve sharpness.
- The policy describes implemented data processing and deletion limits. Operator/contact details, production Gemini service terms and store privacy declarations still require factual owner verification; no identities, retention promises or provider guarantees were invented.
- Local builds and behavioral tests do not establish signed-device, TestFlight or store-review approval. The configured iOS/Android CI builds and runtime evidence remain the next platform gate.
- Cloud Browser blocked this environment's local URL. No visual browser pass is claimed; actual React handlers/rendering, navigation events and local API routes were exercised by regression tests.

Changes are prepared locally for review and push. No remote push, merge, deployment or production data mutation is part of this repair task.

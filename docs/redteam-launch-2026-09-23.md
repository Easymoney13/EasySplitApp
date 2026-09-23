# Launch repair red-team review — 2026-09-23

Reviewed repair commit `1b32df4` against main `dc5d3c9bb795271927721364d5e1f54be3a0676b`. Three independent reviewers inspected deletion/concurrency, user flows/authentication, and native release/scanning/CI. Main was rechecked and had not moved. The user explicitly authorized push and merge after repairs and comprehensive verification.

## Reproduced findings and repairs

| Finding | Repair and evidence |
| --- | --- |
| Supported legacy `users/*/history` snapshots still exposed deleted identities when canonical history was absent | Scan the `history` collection group and anonymize current documents transactionally. Covers surviving and missing parent profiles, retains pointer-only records and concurrent financial changes. New local, conflict-retry and real Firestore regressions. |
| A stale `deleteHistory` profile snapshot could restore deleted identities and discard new bills | Read and transform the current profile in a transaction, writing only the filtered bills. Regression injects account deletion and a new bill between discovery and mutation. |
| A successful account DELETE with a lost response could not be retried after Firebase Auth removal | Only the deletion route accepts an idempotent completion response after `auth/user-not-found`, valid signed/unexpired identity proof, and a consistent read proving the fence exists while both job and profile are absent. It performs no further deletion/provider mutation. Invalid/expired/disabled/revoked/unfenced/incomplete cases and other API routes remain denied. Actual API and client-handler tests cover retry and local cleanup; a separate reviewer checked the exception. |
| New archive regression tests did not run in ordinary PR/main CI | Added `npm run test:release` to shared verification before native jobs. |
| Android polling regression depended on a 100ms wall-clock window and failed under concurrent CPU load | Use deterministic time and timer mocks in three polling tests. Actual validator polling, deadlines, classification and fail conditions are unchanged; the success test still requires four snapshots and three waits. |

## Final local verification

Node 22.23.2; Java 21 for the loopback-only Firestore emulator. No production data mutations or paid receipt requests.

| Gate | Result |
| --- | --- |
| `npm run verify` | Exit 0: 387 shared tests and 6 Hebrew OCR tests, TypeScript and production build |
| Firestore rules + deletion emulator | 26/26, no failures or skips |
| `npm run test:release` | 28/28 |
| Mobile tests | 99/99 |
| `npm run test:strain` | Passed HTTP/WebSocket admission and load checks |
| Production mobile bundle | Passed origin, identity and packaged-asset audit; no source maps or Gate 4 diagnostics |
| Actual Gitleaks integration tests | 3/3 |

Counts overlap; they are not a sum of unique checks. The initial Android wall-clock regression failed and was repaired before the final 99/99 run. One redirected emulator invocation exited without complete test output; it was not accepted as verification. The subsequent run emitted all 26 test results and a successful script exit.

## Confirmed boundaries

- After successful account deletion, an old room token cannot mutate or resubscribe, and an existing deleted-member socket receives no later room broadcasts. Remaining members can continue.
- Firebase bearer revocation and room capabilities are separate existing authorization mechanisms. Disabling/revoking a still-present Firebase account does not itself revoke its independently issued room capabilities. This behavior predates the repairs and remains unchanged; the new bearer check must not be described as globally revoking all application sessions.
- The existing iOS smoke script checks URL dispatch and screenshot creation, not the resulting route. A command double with identical screenshots demonstrated the missing assertion, not a real routing failure. Gate 4 validates core session UI via internal navigation, not incoming native links. No stronger device/deep-link evidence is claimed.
- Signed archive, real-device/TestFlight verification, factual operator/support information and provider/store configuration remain the separate App Store release gates recorded in `launch-readiness-2026-09-23.md`.

This document records local review evidence before push. The PR and exact-head CI results are the remote merge evidence; no remote result is inferred from local tests.

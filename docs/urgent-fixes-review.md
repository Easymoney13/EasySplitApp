# Urgent data and realtime fixes — 2026-09-05

Base: `4d6af8c3b2f44f55bd8ae886d49ace0162682c15`.
Branch: `codex/urgent-data-realtime-fixes`.

The original changes were uploaded as `a2dd952f63be4b0e90e3ec51d77e218c19da1739` in [PR #17](https://github.com/Easymoney13/EasySplitApp/pull/17), following user approval. The uploaded tree exactly matches locally tested commit `935ecae`. No merge, deployment or production data change has been performed.

## 1. Preserve live data during maintenance

The former scheduled canonicalizer could overwrite members and bills using stale collection snapshots. Startup and daily maintenance now default to disabled; the optional `EASYSPLIT_CANONICAL_AUDIT_ENABLED=true` job is read-only. The CLI defaults to preview and requires `--apply` for phone updates.

Application uses one Firestore transaction per affected room, rereads current members and explicit account UID records, and writes only phone-related changes. It preserves current membership, bill claims, receipt names, identifiers and identity evidence, and skips removed/deleting rooms. Matching usernames never supplies another account's phone number. The administrative customer directory also removes username-based phone inference.

## 2. Resolve OCR variants without merging different venues

`restaurantResolution.js` provides a shared alias resolver for the administrative audience query and customer directory. It keeps source restaurant IDs and printed receipt evidence intact while aggregating verified aliases under a deterministic canonical ID and display name.

Automatic matching requires resolved records, trust of at least 0.8, verified relevant fields, and:

- An exact normalized name and matching verified address; or
- A similar OCR name, matching verified address, and matching verified phone or valid business ID.

Conflicting verified business IDs, addresses, phones or numeric branch markers reject a match. Missing or explicitly untrusted fields do not count as proof. Connected alias candidates must also agree pairwise; ambiguous chains return `review_required` instead of silently joining different venues. Source IDs remain accepted as query inputs. Phone HMACs are deduplicated across aliases, with deletion tombstones and existing visit-quality exclusions preserved.

The audience response adds `restaurant.canonicalId`, `canonicalPrintedName`, `restaurantIds` and `resolution`; its original `printedName` remains the requested source record's name. Canonical display names are selected from observed names, not invented. Name-only evidence remains unresolved and requires additional evidence or human review; this is not a claim that every historical spelling error can be resolved automatically.

Limits: audience catalog reads stop at 10,001 records. Above 10,000 records alias inference is disabled for that query and marked `catalog_limit`. Components above 100 candidates require review. Visit reads retain a global 10,000-result limit and the existing `truncated` indicator. These conservative limits avoid inferring identity from a partial catalog; larger catalogs need an indexed alias directory. The administrative raw-phone directory remains a privileged, explicit CLI report, not a customer-facing endpoint.

## 3. Keep rooms usable on shared Wi-Fi

Verified members receive separate read budgets (600 per ten minutes); payment-target reads have an independent budget (60). Unknown credentials still pass through the existing discovery limiter before database access. A bounded, short-lived cache classifies rate budgets only: each response still reads the room and validates current membership. Joining seeds this classification. Rate responses include `Retry-After`, exposed through CORS for allowed native clients.

Session/group polling now avoids overlapping requests and hidden-page polling, uses a 30-second reconciliation interval after WebSocket subscription confirmation, falls back to the existing 3/4-second cadence when disconnected, and backs off on errors and HTTP 429. Periodic reconciliation remains necessary because broadcasts are process-local. Requests time out after 15 seconds; stale responses cannot update a different room or an unmounted instance.

WebSockets allow up to 128 connections per IP, retaining the global 500-connection cap, subscription deadline, heartbeat and message limits. A verified member can have at most three open sockets per room. The higher per-IP ceiling supports shared restaurant networks but increases the maximum unauthenticated connections one IP can temporarily occupy; the existing authentication deadline still bounds their lifetime.

## Verification

- Main Node test suite: **276 passed, 0 failed** with non-loopback network access blocked.
- Final changed restaurant/maintenance tests: **16 passed, 0 failed** after the final trust checks.
- Final server integration: **2 passed, 0 failed**, including ten real WebSocket clients on one IP, reconnect, 250 repeated authenticated HTTP reads, per-member socket cap and access revocation.
- Poll policy test covers ten members polling every three seconds over **20 virtual minutes**. The socket integration is a short real run, not a 20-minute wall-clock soak.
- TypeScript check: passed.
- Next production build: passed; BUILD_ID, route and prerender manifests generated.
- Real Tesseract OCR integration: **5 passed**, including four synthetic Hebrew receipt images. Language assets were downloaded for this test; no production receipts or OCR service credentials were used.
- Mobile static tests: **99 passed**. An existing stale assertion was aligned with main's `node server.js --production` command and verifies the server recognizes that flag.
- Mobile Vite build: passed using `https://build-check.example.invalid` as the API/web origin. This is a compilation check, not a distributable production bundle.

Initial checks exposed two setup issues: the network guard blocked Tesseract's public language-asset download, and the mobile build required explicit origins. Both checks subsequently passed with appropriate test setup. The mobile build retains its existing large-chunk/config-loader warnings.

Firestore concurrency regression tests use a deterministic transaction double to inject changes between initial collection reads and transaction reads. The real Firestore service/emulator and native iOS/Android devices were not exercised. Production data quality and deployment configuration still require verification in the authorized deployment environment.

## Review and rollout

CI run `34020377786` passed all 276 Node tests, all 5 OCR tests, TypeScript and the Next build, then failed the standalone strain test because it still asserted the retired eight-socket limit. Android/iOS jobs were skipped. The prepared follow-up updates that test to attempt 140 connections and require exactly 128 admissions, 12 HTTP 429 rejections, and closure of all 128 unauthenticated sockets. It preserves the remaining HTTP, join and mutation load assertions. This test passed locally after the update; the follow-up needs separate push approval before CI can verify it. Product code is unchanged by the follow-up.

1. Review and approve pushing this isolated branch; no main-branch push is needed.
2. Open a PR against main and run the repository CI gates.
3. Deploy through the existing authorized owner/workspace, then smoke-test a shared room and an admin alias query with approved test data.
4. Keep canonical maintenance disabled by default. Preview before any separately authorized production phone cleanup.

No migration is necessary for alias aggregation. Rolling back the code removes the new query/polling behavior without requiring reconstruction of rewritten receipt data, because this change performs no automatic restaurant-identity rewrites.

# EasySplit Mobile Migration — Stage 1 Handoff

Date: 2026-08-24

## Hard constraints

- The existing EasySplit web app must remain intact and must not be degraded or redesigned as part of the mobile migration.
- Existing product content, flows, OCR behavior, realtime behavior, groups, sessions, payments and history remain the product source of truth.
- Mobile work adapts the same product to iOS/Android; it does not replace the web app.

## Stage 1 status

Stage 1 (Platform Foundation) is complete and merged to `main`.

It introduces an isolated transport/security boundary so native builds can use a remote EasySplit backend while the current web deployment keeps the same same-origin behavior by default.

Implemented:

- API origin abstraction (`lib/platformTransport.js`)
- Realtime/WebSocket origin abstraction
- Public web/share origin abstraction
- Exact mobile-origin allowlist and API CORS boundary (`lib/platformSecurity.js`)
- Firebase auth-token routing for the configured EasySplit backend without leaking tokens to unrelated origins
- Capacitor-aware share/QR URL behavior
- Session/group API and realtime migration to the platform transport boundary
- Receipt OCR API migration to the platform transport boundary
- Environment-variable documentation in `.env.example`
- Regression tests for web parity, native routing, origin security and fail-closed configuration

## Verification

Verified on a full GitHub-hosted checkout before merge:

- `npm ci` — success
- `npm run test` — 134/134 passed
- `npm run test:ocr-hebrew` — 2/2 passed
- TypeScript typecheck — success
- `next build` production build — success
- `git diff --check` — success after newline normalization

The temporary Stage 1 verification workflow was removed from `main` after the verified merge.

## Mobile configuration prepared by Stage 1

Native builds can configure:

- `NEXT_PUBLIC_EASYSPLIT_API_ORIGIN`
- `NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN`
- `NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN`
- server-side `EASYSPLIT_ALLOWED_MOBILE_ORIGINS`

Current web deployments should leave the mobile overrides unset to preserve existing behavior.

## Stage 2 starting point

Start Stage 2 from current `main`.

First objective: establish the Capacitor application shell/build strategy around the existing Next.js + Express architecture without changing the live web experience.

Stage 2 should first resolve how mobile web assets are packaged/served while API and realtime continue to use the Stage 1 remote transport boundary. Then add iOS/Android projects and verify the unchanged EasySplit core flow inside the shell before native camera/haptics/share/payment refinements.

Suggested order:

1. Select and implement the Capacitor-compatible client build/shell strategy while keeping the current server/web build untouched.
2. Add Capacitor config and iOS/Android platform projects in an isolated mobile path/configuration.
3. Wire mobile environment origins to the existing EasySplit backend.
4. Smoke-test home → receipt → OCR → session → realtime split → settlement on iOS/Android shell.
5. Confirm the existing web regression suite remains green before moving to native feature adapters.

Do not push future mobile changes to `Easymoney13/EasySplitApp` without explicit user approval for that specific push.

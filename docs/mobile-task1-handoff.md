# EasySplit Mobile Build — Task 1 Handoff

## Scope boundary

This task creates the packaged mobile web build layer only. It does **not** generate `ios/` or `android/`, perform signing, register store apps, or replace any existing web route/content.

## Baseline

- Prepared and drift-audited against EasySplit `main` commit `707daf376dbd76a30e4146e926baa7342f5f631a`.
- Existing Groups Stage 3 reconnect/cleanup fixes are retained rather than reimplemented.

## Resulting architecture

- Existing web: unchanged `Next.js -> Express` build/deployment.
- Mobile: Vite bundles the same Home, Session and Group React components into `mobile-dist/`.
- `next/navigation` is replaced only inside the mobile build by a query-backed compatibility shim.
- API, public share URL and WebSocket endpoints continue through the Stage 1 transport boundary.
- Capacitor production config points to bundled `mobile-dist`; it has no production `server.url`.

## Toolchain

- Capacitor `8.5.0` family, pinned.
- Vite `8.2.2`, pinned.
- Mobile commands require Node 22.12.0+. A dedicated guard enforces this without changing the existing web runtime requirement.
- App ID `com.easysplit.app` is provisional until the founders confirm the final store identity before native platform generation.

## Required mobile environment

Copy `.env.mobile.example` to an untracked `.env.mobile` and supply:

- `NEXT_PUBLIC_EASYSPLIT_API_ORIGIN`
- `NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN`
- optionally `NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN`
- production Firebase public client values before release

The build fails closed when required origins are missing or malformed.

## Verification gates

Run with Node 22:

```bash
npm install --package-lock-only --ignore-scripts
npm ci
npm run verify
npm run verify:mobile-shell
npm run test:strain
```

Expected Task 1 output:

- `mobile-dist/index.html` and hashed bundled assets exist.
- `npm run verify` remains green for the web product.
- mobile preflight and Vite production build pass.
- no `ios/` or `android/` directory exists.

## Next owner action

Only after this handoff is green, the partner can continue from the same commit with:

```bash
npx cap add ios
npx cap add android
npx cap sync
```

Those commands are explicitly outside Task 1.

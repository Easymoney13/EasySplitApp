# Capacitor Stage 1 — Native Projects Handoff

## Measurable outcome

EasySplit now has generated Capacitor 8 native projects for both iOS and Android, sourced from the existing mobile-dist build path without replacing or changing the web deployment path.

## Verified baseline

- Base main: `18588e21757e9d36a112c5b1b423ad714a969f09`
- App ID: `com.easysplit.app`
- App name: `EasySplit`
- Capacitor: `8.5.0`
- iOS dependency manager: Swift Package Manager (Capacitor 8 default)
- Web verification: passed
- Hebrew OCR integration: passed
- Strain regression: passed
- Mobile shell tests and Vite production build: passed
- `npx cap sync`: passed for iOS and Android
- iOS simulator compilation without signing: passed
- Android debug compilation: passed

## Handoff commands

From a clean checkout with Node 22+:

```bash
npm ci
NEXT_PUBLIC_EASYSPLIT_API_ORIGIN=https://YOUR_BACKEND NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN=https://YOUR_PUBLIC_WEB npm run mobile:sync
npx cap open ios
npx cap open android
```

## Explicitly not included in Stage 1

- Apple or Google signing
- Store accounts or uploads
- Production mobile environment values
- Emulator/device core-flow testing
- Native Camera, Share, Haptics or Deep Links
- Product/UI changes

The web application remains the unchanged source of truth. Generated native build artifacts remain ignored; the maintainable iOS and Android projects are version-controlled.

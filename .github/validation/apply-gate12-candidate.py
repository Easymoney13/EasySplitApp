from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative_path: str, old: str, new: str) -> None:
    path = ROOT / relative_path
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{relative_path}: expected exactly one match, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def append_once(relative_path: str, marker: str, addition: str) -> None:
    path = ROOT / relative_path
    text = path.read_text(encoding="utf-8")
    if marker in text:
        raise SystemExit(f"{relative_path}: candidate marker already present")
    path.write_text(text.rstrip() + "\n\n" + addition.strip() + "\n", encoding="utf-8")


# Native CORS: add only EasySplit's exact Capacitor origins as safe defaults.
replace_once(
    "lib/platformSecurity.js",
    """function parseAllowedOrigins(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map(normalizeOrigin)
      .filter(Boolean),
  );
}
""",
    """function parseAllowedOrigins(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map(normalizeOrigin)
      .filter(Boolean),
  );
}

const DEFAULT_MOBILE_CLIENT_ORIGINS = Object.freeze([
  'capacitor://localhost',
  'https://localhost',
]);

function resolveAllowedMobileOrigins(value = '') {
  return parseAllowedOrigins([
    ...DEFAULT_MOBILE_CLIENT_ORIGINS,
    String(value || ''),
  ].join(','));
}
""",
)
replace_once(
    "lib/platformSecurity.js",
    "res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Room-Token');",
    "res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Room-Token, X-Firebase-AppCheck');",
)
replace_once(
    "lib/platformSecurity.js",
    """module.exports = {
  appendVaryHeader,
  createApiCorsMiddleware,
  isAllowedClientOrigin,
  isSameHostOrigin,
  normalizeOrigin,
  parseAllowedOrigins,
};
""",
    """module.exports = {
  DEFAULT_MOBILE_CLIENT_ORIGINS,
  appendVaryHeader,
  createApiCorsMiddleware,
  isAllowedClientOrigin,
  isSameHostOrigin,
  normalizeOrigin,
  parseAllowedOrigins,
  resolveAllowedMobileOrigins,
};
""",
)
replace_once(
    "server.js",
    "const { createApiCorsMiddleware, isAllowedClientOrigin, parseAllowedOrigins } = require('./lib/platformSecurity');",
    "const { createApiCorsMiddleware, isAllowedClientOrigin, resolveAllowedMobileOrigins } = require('./lib/platformSecurity');",
)
replace_once(
    "server.js",
    "const allowedMobileOrigins = parseAllowedOrigins(process.env.EASYSPLIT_ALLOWED_MOBILE_ORIGINS || '');",
    "const allowedMobileOrigins = resolveAllowedMobileOrigins(process.env.EASYSPLIT_ALLOWED_MOBILE_ORIGINS || '');",
)
replace_once(
    "tests/platform-security.test.js",
    """  normalizeOrigin,
  parseAllowedOrigins,
} = require('../lib/platformSecurity');
""",
    """  normalizeOrigin,
  parseAllowedOrigins,
  resolveAllowedMobileOrigins,
} = require('../lib/platformSecurity');
""",
)
replace_once(
    "tests/platform-security.test.js",
    """test('normalizes standard and Capacitor origins exactly', () => {
  assert.equal(normalizeOrigin('https://localhost/'), 'https://localhost');
  assert.equal(normalizeOrigin('capacitor://localhost/'), 'capacitor://localhost');
  assert.equal(normalizeOrigin('not a url'), '');
});
""",
    """test('normalizes standard and Capacitor origins exactly', () => {
  assert.equal(normalizeOrigin('https://localhost/'), 'https://localhost');
  assert.equal(normalizeOrigin('capacitor://localhost/'), 'capacitor://localhost');
  assert.equal(normalizeOrigin('not a url'), '');
});

test('native Capacitor origins are exact safe defaults and explicit values only extend them', () => {
  const defaults = resolveAllowedMobileOrigins();
  assert.deepEqual([...defaults].sort(), ['capacitor://localhost', 'https://localhost'].sort());
  assert.equal(defaults.has('https://localhost.attacker.example'), false);

  const extended = resolveAllowedMobileOrigins('https://native-preview.easysplit.example');
  assert.equal(extended.has('capacitor://localhost'), true);
  assert.equal(extended.has('https://localhost'), true);
  assert.equal(extended.has('https://native-preview.easysplit.example'), true);
});
""",
)
replace_once(
    "tests/platform-security.test.js",
    "assert.match(ios.headers.get('access-control-allow-headers'), /X-Room-Token/);",
    """assert.match(ios.headers.get('access-control-allow-headers'), /X-Room-Token/);
  assert.match(ios.headers.get('access-control-allow-headers'), /X-Firebase-AppCheck/);""",
)

# Android Back: preserve the existing global Capacitor router handler. An open
# Start Split sheet gets first refusal through one cancelable browser event.
replace_once(
    "lib/mobileEvents.ts",
    """/** Neutral browser event shared by the bundled mobile runtime and existing room pages. */
export const MOBILE_RECOVERY_EVENT = 'easysplit:runtime-recover' as const;
""",
    """/** Neutral browser events shared by the bundled mobile runtime and existing pages. */
export const MOBILE_RECOVERY_EVENT = 'easysplit:runtime-recover' as const;
export const MOBILE_BACK_REQUEST_EVENT = 'easysplit:native-back-request' as const;
""",
)
replace_once(
    "mobile/runtime/mobileRuntime.ts",
    "import { MOBILE_RECOVERY_EVENT } from '../../lib/mobileEvents';",
    "import { MOBILE_BACK_REQUEST_EVENT, MOBILE_RECOVERY_EVENT } from '../../lib/mobileEvents';",
)
replace_once(
    "mobile/runtime/mobileRuntime.ts",
    """  handles.push(await App.addListener('backButton', async () => {
    const action = backAction(window.location.search, window.history.state);
""",
    """  handles.push(await App.addListener('backButton', async () => {
    const backRequest = new Event(MOBILE_BACK_REQUEST_EVENT, { cancelable: true });
    window.dispatchEvent(backRequest);
    if (backRequest.defaultPrevented) return;

    const action = backAction(window.location.search, window.history.state);
""",
)
replace_once(
    "src/app/page.tsx",
    "import { triggerHaptic } from '../../lib/haptics';\n",
    """import { triggerHaptic } from '../../lib/haptics';
import { MOBILE_BACK_REQUEST_EVENT } from '../../lib/mobileEvents';
""",
)
replace_once(
    "src/app/page.tsx",
    """  const [showStartSplitModal, setShowStartSplitModal] = useState(false);
  const [showJoinSessionModal, setShowJoinSessionModal] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // Swipe-down to dismiss gestures for start split & group modals
""",
    """  const [showStartSplitModal, setShowStartSplitModal] = useState(false);
  const [showJoinSessionModal, setShowJoinSessionModal] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android' || !showStartSplitModal) return;

    const consumeNativeBack = (event: Event) => {
      event.preventDefault();
      setShowStartSplitModal(false);
    };
    window.addEventListener(MOBILE_BACK_REQUEST_EVENT, consumeNativeBack);
    return () => window.removeEventListener(MOBILE_BACK_REQUEST_EVENT, consumeNativeBack);
  }, [showStartSplitModal]);

  // Swipe-down to dismiss gestures for start split & group modals
""",
)
replace_once(
    "src/app/page.tsx",
    """              <button
                type="button"
                onClick={() => {
                  setShowStartSplitModal(true);
""",
    """              <button
                type="button"
                data-testid="start-split-button"
                onClick={() => {
                  setShowStartSplitModal(true);
""",
)
replace_once(
    "src/app/page.tsx",
    """      {showStartSplitModal && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-slate-950/60 backdrop-blur-xs animate-fadeIn" onClick={() => setShowStartSplitModal(false)}>
""",
    """      {showStartSplitModal && (
        <div
          data-testid="start-split-sheet"
          className="fixed inset-0 z-50 flex flex-col justify-end bg-slate-950/60 backdrop-blur-xs animate-fadeIn"
          onClick={() => setShowStartSplitModal(false)}
        >
""",
)
append_once(
    "tests/mobile-integration-static.test.mjs",
    "Android back gives an open Start Split sheet first refusal before shell navigation",
    """test('Android back gives an open Start Split sheet first refusal before shell navigation', async () => {
  const events = await read('lib/mobileEvents.ts');
  const runtime = await read('mobile/runtime/mobileRuntime.ts');
  const home = await read('src/app/page.tsx');
  const config = await read('capacitor.config.ts');

  assert.match(events, /MOBILE_BACK_REQUEST_EVENT/);
  assert.match(runtime, /new Event\(MOBILE_BACK_REQUEST_EVENT, \{ cancelable: true \}\)/);
  assert.match(runtime, /if \(backRequest\.defaultPrevented\) return/);
  assert.match(home, /window\.addEventListener\(MOBILE_BACK_REQUEST_EVENT/);
  assert.match(home, /event\.preventDefault\(\)/);
  assert.match(home, /setShowStartSplitModal\(false\)/);
  assert.match(home, /data-testid=\"start-split-button\"/);
  assert.match(home, /data-testid=\"start-split-sheet\"/);
  assert.doesNotMatch(config, /disableBackButtonHandler:\s*true/);
});""",
)

print("Gate 1+2 validation candidate applied successfully.")

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
  assert.deepEqual(
    [...defaults].sort(),
    ['capacitor://localhost', 'https://localhost'].sort(),
  );
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

replace_once(
    ".env.example",
    """# Exact Capacitor WebView origins permitted by the EasySplit server (comma-separated).
# Capacitor defaults are capacitor://localhost on iOS and https://localhost on Android.
# EASYSPLIT_ALLOWED_MOBILE_ORIGINS=capacitor://localhost,https://localhost
""",
    """# Additional exact native origins permitted by the EasySplit server (comma-separated).
# The standard Capacitor origins capacitor://localhost and https://localhost are built in.
# EASYSPLIT_ALLOWED_MOBILE_ORIGINS=https://native-preview.easysplit.example
""",
)

replace_once(
    "capacitor.config.ts",
    """  plugins: {
    // Do NOT set App.disableBackButtonHandler=true: our App.addListener('backButton')
    // relies on the native callback remaining enabled.
    Keyboard: {
""",
    """  plugins: {
    App: {
      // Android 16 predictive back stays system-owned until a page explicitly
      // enables Capacitor's callback for a visible native sheet.
      disableBackButtonHandler: true,
    },
    Keyboard: {
""",
)
replace_once(
    "android/variables.gradle",
    "androidxActivityVersion = '1.11.0'",
    "androidxActivityVersion = '1.12.4'",
)
replace_once(
    "src/app/page.tsx",
    "import { Camera as CapCamera, CameraResultType, CameraSource } from '@capacitor/camera';\n",
    """import { Camera as CapCamera, CameraResultType, CameraSource } from '@capacitor/camera';
import { App as CapacitorApp } from '@capacitor/app';
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

    let cancelled = false;
    let backListener: { remove: () => Promise<void> } | null = null;

    const enableSheetBack = async () => {
      try {
        const handle = await CapacitorApp.addListener('backButton', () => {
          setShowStartSplitModal(false);
        });
        if (cancelled) {
          await handle.remove();
          return;
        }
        backListener = handle;
        await CapacitorApp.toggleBackButtonHandler({ enabled: true });
      } catch (error) {
        console.warn('Native sheet back handling could not be enabled:', error);
      }
    };

    void enableSheetBack();
    return () => {
      cancelled = true;
      void CapacitorApp.toggleBackButtonHandler({ enabled: false }).catch(() => {});
      if (backListener) void backListener.remove();
    };
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
    "Android 16 back is system-owned except while the Start Split sheet is open",
    """test('Android 16 back is system-owned except while the Start Split sheet is open', async () => {
  const config = await read('capacitor.config.ts');
  const home = await read('src/app/page.tsx');
  const variables = await read('android/variables.gradle');
  const mainActivity = await read('android/app/src/main/java/com/easysplit/app/MainActivity.java');

  assert.match(config, /disableBackButtonHandler:\s*true/);
  assert.match(home, /App as CapacitorApp/);
  assert.match(home, /CapacitorApp\.addListener\(['\"]backButton['\"]/);
  assert.match(home, /toggleBackButtonHandler\(\{ enabled: true \}\)/);
  assert.match(home, /toggleBackButtonHandler\(\{ enabled: false \}\)/);
  assert.match(home, /data-testid=\"start-split-button\"/);
  assert.match(home, /data-testid=\"start-split-sheet\"/);
  assert.match(variables, /androidxActivityVersion = '1\.12\.4'/);
  assert.doesNotMatch(mainActivity, /OnBackInvokedDispatcher|onBackPressed\(/);
});""",
)

print("Gate 1+2 validation candidate applied successfully.")

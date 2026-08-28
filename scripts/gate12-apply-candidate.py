from pathlib import Path

root = Path(__file__).resolve().parents[1]


def replace_exact(relative_path: str, old: str, new: str) -> None:
    path = root / relative_path
    source = path.read_text(encoding="utf-8")
    count = source.count(old)
    if count != 1:
        raise SystemExit(
            f"{relative_path}: expected exactly one match, found {count}"
        )
    path.write_text(source.replace(old, new, 1), encoding="utf-8")


replace_exact(
    "server.js",
    "const allowedMobileOrigins = parseAllowedOrigins(process.env.EASYSPLIT_ALLOWED_MOBILE_ORIGINS || '');",
    "const allowedMobileOrigins = parseAllowedOrigins(\n"
    "  process.env.EASYSPLIT_ALLOWED_MOBILE_ORIGINS || 'capacitor://localhost,https://localhost',\n"
    ");",
)

replace_exact(
    "lib/platformSecurity.js",
    "      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Room-Token');",
    "      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Room-Token, X-Firebase-AppCheck');",
)

replace_exact(
    "tests/platform-security.test.js",
    "const assert = require('node:assert/strict');\n",
    "const assert = require('node:assert/strict');\n"
    "const fs = require('node:fs');\n"
    "const path = require('node:path');\n",
)

replace_exact(
    "tests/platform-security.test.js",
    "  assert.match(ios.headers.get('access-control-allow-headers'), /X-Room-Token/);",
    "  assert.match(ios.headers.get('access-control-allow-headers'), /X-Room-Token/);\n"
    "  assert.match(ios.headers.get('access-control-allow-headers'), /X-Firebase-AppCheck/);",
)

platform_test = root / "tests/platform-security.test.js"
platform_source = platform_test.read_text(encoding="utf-8")
marker = "server defaults to the exact Capacitor WebView origins"
if marker in platform_source:
    raise SystemExit("tests/platform-security.test.js: candidate test already present")
platform_source += r'''

test('server defaults to the exact Capacitor WebView origins', () => {
  const serverSource = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  assert.match(
    serverSource,
    /EASYSPLIT_ALLOWED_MOBILE_ORIGINS\s*\|\|\s*'capacitor:\/\/localhost,https:\/\/localhost'/,
  );
  assert.doesNotMatch(serverSource, /EASYSPLIT_ALLOWED_MOBILE_ORIGINS[^\n]*\|\|\s*['"]\*['"]/);
});
'''
platform_test.write_text(platform_source, encoding="utf-8")

replace_exact(
    "lib/mobileEvents.ts",
    "/** Neutral browser event shared by the bundled mobile runtime and existing room pages. */\n"
    "export const MOBILE_RECOVERY_EVENT = 'easysplit:runtime-recover' as const;\n",
    "/** Neutral browser events shared by the bundled mobile runtime and existing pages. */\n"
    "export const MOBILE_RECOVERY_EVENT = 'easysplit:runtime-recover' as const;\n"
    "export const MOBILE_NATIVE_BACK_EVENT = 'easysplit:native-back' as const;\n",
)

replace_exact(
    "mobile/runtime/mobileRuntime.ts",
    "import { MOBILE_RECOVERY_EVENT } from '../../lib/mobileEvents';",
    "import { MOBILE_NATIVE_BACK_EVENT, MOBILE_RECOVERY_EVENT } from '../../lib/mobileEvents';",
)

replace_exact(
    "mobile/runtime/mobileRuntime.ts",
    "  handles.push(await App.addListener('backButton', async () => {\n"
    "    const action = backAction(window.location.search, window.history.state);",
    "  handles.push(await App.addListener('backButton', async () => {\n"
    "    const interceptEvent = new Event(MOBILE_NATIVE_BACK_EVENT, { cancelable: true });\n"
    "    window.dispatchEvent(interceptEvent);\n"
    "    if (interceptEvent.defaultPrevented) return;\n\n"
    "    const action = backAction(window.location.search, window.history.state);",
)

replace_exact(
    "src/app/page.tsx",
    "import { triggerHaptic } from '../../lib/haptics';\n",
    "import { triggerHaptic } from '../../lib/haptics';\n"
    "import { MOBILE_NATIVE_BACK_EVENT } from '../../lib/mobileEvents';\n",
)

replace_exact(
    "src/app/page.tsx",
    "  const [showStartSplitModal, setShowStartSplitModal] = useState(false);\n"
    "  const [showJoinSessionModal, setShowJoinSessionModal] = useState(false);\n",
    "  const [showStartSplitModal, setShowStartSplitModal] = useState(false);\n"
    "  const [showJoinSessionModal, setShowJoinSessionModal] = useState(false);\n\n"
    "  useEffect(() => {\n"
    "    if (!showStartSplitModal || Capacitor.getPlatform() !== 'android') return;\n\n"
    "    const handleNativeBack = (event: Event) => {\n"
    "      event.preventDefault();\n"
    "      setShowStartSplitModal(false);\n"
    "    };\n"
    "    window.addEventListener(MOBILE_NATIVE_BACK_EVENT, handleNativeBack);\n"
    "    return () => {\n"
    "      window.removeEventListener(MOBILE_NATIVE_BACK_EVENT, handleNativeBack);\n"
    "    };\n"
    "  }, [showStartSplitModal]);\n",
)

replace_exact(
    "android/variables.gradle",
    "    androidxActivityVersion = '1.11.0'",
    "    androidxActivityVersion = '1.12.4'",
)

mobile_test = root / "tests/mobile-integration-static.test.mjs"
mobile_source = mobile_test.read_text(encoding="utf-8")
mobile_marker = "native Android back is consumed by an open Start Split sheet"
if mobile_marker in mobile_source:
    raise SystemExit("tests/mobile-integration-static.test.mjs: candidate test already present")
mobile_source += r'''

test('native Android back is consumed by an open Start Split sheet', async () => {
  const home = await read('src/app/page.tsx');
  const runtime = await read('mobile/runtime/mobileRuntime.ts');
  const events = await read('lib/mobileEvents.ts');
  const variables = await read('android/variables.gradle');

  assert.match(events, /easysplit:native-back/);
  assert.match(runtime, /new Event\(MOBILE_NATIVE_BACK_EVENT, \{ cancelable: true \}\)/);
  assert.match(runtime, /interceptEvent\.defaultPrevented/);
  assert.match(home, /Capacitor\.getPlatform\(\)\s*!==\s*['"]android['"]/);
  assert.match(home, /addEventListener\(MOBILE_NATIVE_BACK_EVENT/);
  assert.match(home, /event\.preventDefault\(\)/);
  assert.match(home, /setShowStartSplitModal\(false\)/);
  assert.doesNotMatch(home, /CapacitorApp\.addListener\(['"]backButton['"]/);
  assert.match(variables, /androidxActivityVersion = '1\.12\.4'/);
});
'''
mobile_test.write_text(mobile_source, encoding="utf-8")

print("Gate 1+2 candidate applied")

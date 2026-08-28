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
    "src/app/page.tsx",
    "import { Camera as CapCamera, CameraResultType, CameraSource } from '@capacitor/camera';\n",
    "import { Camera as CapCamera, CameraResultType, CameraSource } from '@capacitor/camera';\n"
    "import { App as CapacitorApp } from '@capacitor/app';\n",
)

replace_exact(
    "src/app/page.tsx",
    "  const [showStartSplitModal, setShowStartSplitModal] = useState(false);\n"
    "  const [showJoinSessionModal, setShowJoinSessionModal] = useState(false);\n",
    "  const [showStartSplitModal, setShowStartSplitModal] = useState(false);\n"
    "  const [showJoinSessionModal, setShowJoinSessionModal] = useState(false);\n\n"
    "  useEffect(() => {\n"
    "    if (!showStartSplitModal || Capacitor.getPlatform() !== 'android') return;\n\n"
    "    let cancelled = false;\n"
    "    let backHandle: { remove: () => Promise<void> } | null = null;\n"
    "    void CapacitorApp.addListener('backButton', () => {\n"
    "      setShowStartSplitModal(false);\n"
    "    }).then((handle) => {\n"
    "      if (cancelled) {\n"
    "        void handle.remove();\n"
    "        return;\n"
    "      }\n"
    "      backHandle = handle;\n"
    "    });\n\n"
    "    return () => {\n"
    "      cancelled = true;\n"
    "      if (backHandle) void backHandle.remove();\n"
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
mobile_marker = "native Android back dismisses the Start Split sheet"
if mobile_marker in mobile_source:
    raise SystemExit("tests/mobile-integration-static.test.mjs: candidate test already present")
mobile_source += r'''

test('native Android back dismisses the Start Split sheet', async () => {
  const home = await read('src/app/page.tsx');
  const variables = await read('android/variables.gradle');

  assert.match(home, /from ['"]@capacitor\/app['"]/);
  assert.match(home, /Capacitor\.getPlatform\(\)\s*!==\s*['"]android['"]/);
  assert.match(home, /CapacitorApp\.addListener\(['"]backButton['"]/);
  assert.match(home, /setShowStartSplitModal\(false\)/);
  assert.match(variables, /androidxActivityVersion = '1\.12\.4'/);
});
'''
mobile_test.write_text(mobile_source, encoding="utf-8")

print("Gate 1+2 candidate applied")

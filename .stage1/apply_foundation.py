#!/usr/bin/env python3
from __future__ import annotations
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()

if not (ROOT / 'package.json').exists() or not (ROOT / 'server.js').exists():
    raise SystemExit(f'Not an EasySplit checkout: {ROOT}')


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding='utf-8')


def write(rel: str, text: str) -> None:
    p = ROOT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding='utf-8')


def require_replace(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        if new in text:
            return text
        raise RuntimeError(f'Anchor not found for {label}')
    return text.replace(old, new)


def add_import(text: str, line: str, after: str) -> str:
    if line in text:
        return text
    if after not in text:
        raise RuntimeError(f'Import anchor missing: {after}')
    return text.replace(after, after + '\n' + line, 1)


def wrap_direct_api_fetches(text: str) -> tuple[str, int]:
    count = 0
    patterns = [
        re.compile(r"fetch\((?P<q>['\"])(?P<url>/api/[^'\"]*)(?P=q)"),
        re.compile(r"fetch\((?P<q>`)(?P<url>/api/[^`]*)(?P=q)"),
    ]
    for pattern in patterns:
        def repl(match: re.Match[str]) -> str:
            nonlocal count
            count += 1
            q = match.group('q')
            url = match.group('url')
            return f"fetch(apiUrl({q}{url}{q})"
        text = pattern.sub(repl, text)
    return text, count

for rel in [
    'lib/platformTransport.js',
    'lib/platformSecurity.js',
    'lib/authFetch.js',
    'tests/platform-transport.test.js',
    'tests/platform-security.test.js',
    'tests/auth-fetch.test.js',
]:
    src = HERE / rel
    if not src.exists():
        raise RuntimeError(f'Missing prepared foundation file: {src}')
    write(rel, src.read_text(encoding='utf-8'))

rel = 'lib/accountClient.ts'
s = read(rel)
if "import { apiUrl } from './platformTransport';" not in s:
    s = "import { apiUrl } from './platformTransport';\n\n" + s
s = require_replace(
    s,
    "const response = await fetch(`${endpoint}?${params.toString()}`);",
    "const response = await fetch(apiUrl(`${endpoint}?${params.toString()}`));",
    rel,
)
write(rel, s)

rel = 'lib/receiptScanClient.ts'
s = read(rel)
s = add_import(s, "import { apiUrl } from './platformTransport';", "import { scanBillImagesInBrowser } from './ocrScanner';")
s, count = wrap_direct_api_fetches(s)
if count < 1 and "apiUrl('/api/receipt/parse')" not in s:
    raise RuntimeError('Receipt API call was not migrated')
write(rel, s)

rel = 'src/components/LanguageContext.tsx'
s = read(rel)
s = require_replace(
    s,
    "import { isProtectedSameOriginApi } from '../../lib/authFetch';",
    "import { isProtectedApi } from '../../lib/authFetch';",
    rel + ' auth import',
)
s = add_import(s, "import { apiUrl, getApiOrigin } from '../../lib/platformTransport';", "import { cleanIsraeliPhone, isValidIsraeliPhone } from '../../lib/bitDeepLink';")
s = require_replace(
    s,
    "isProtectedSameOriginApi(input, window.location.origin)",
    "isProtectedApi(input, window.location.origin, getApiOrigin())",
    rel + ' auth check',
)
s, _ = wrap_direct_api_fetches(s)
write(rel, s)

rel = 'src/app/page.tsx'
s = read(rel)
s = add_import(s, "import { apiUrl, publicWebUrl } from '../../lib/platformTransport';", "import { fetchPaginatedAccountData } from '../../lib/accountClient';")
s, _ = wrap_direct_api_fetches(s)
s = s.replace("const groupUrl = `${window.location.origin}/group/${selectedGroupForModal.id}`;", "const groupUrl = publicWebUrl(`/group/${selectedGroupForModal.id}`);")
write(rel, s)

workspace_import_anchors = {
    'src/app/session/[id]/page.tsx': "import { fetchPaginatedAccountData } from '../../../../lib/accountClient';",
    'src/app/group/[id]/page.tsx': "import { clearRoomCredentials, getRoomMemberId, getRoomToken, roomHeaders, saveRoomCredentials } from '../../../../lib/roomTokens';",
}
for rel in ['src/app/session/[id]/page.tsx', 'src/app/group/[id]/page.tsx']:
    s = read(rel)
    s = add_import(
        s,
        "import { apiUrl, realtimeUrl } from '../../../../lib/platformTransport';",
        workspace_import_anchors[rel],
    )
    s, _ = wrap_direct_api_fetches(s)
    old = "const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';\n      const wsUrl = `${protocol}//${window.location.host}`;\n      const ws = new WebSocket(wsUrl);"
    new = "const ws = new WebSocket(realtimeUrl());"
    s = require_replace(s, old, new, rel + ' websocket')
    write(rel, s)

rel = 'src/components/QRCodeModal.tsx'
s = read(rel)
s = add_import(s, "import { hasConfiguredApiOrigin, publicWebUrl } from '../../lib/platformTransport';", "import QRCode from 'qrcode';")
s = require_replace(
    s,
    "const joinUrl = networkUrl || (typeof window !== 'undefined'\n    ? `${window.location.origin}${basePath}`\n    : basePath);",
    "const joinUrl = networkUrl || publicWebUrl(basePath);",
    rel + ' public URL',
)
s = require_replace(
    s,
    "const isLocalhost = typeof window !== 'undefined' && \n      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');",
    "const isLocalhost = !hasConfiguredApiOrigin() && typeof window !== 'undefined' &&\n      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');",
    rel + ' localhost guard',
)
write(rel, s)

rel = 'server.js'
s = read(rel)
s = add_import(
    s,
    "const { createApiCorsMiddleware, isAllowedClientOrigin, parseAllowedOrigins } = require('./lib/platformSecurity');",
    "const security = require('./lib/security');",
)
if "const allowedMobileOrigins = parseAllowedOrigins(process.env.EASYSPLIT_ALLOWED_MOBILE_ORIGINS || '');" not in s:
    anchor = "const PORT = process.env.PORT || 3000;"
    s = require_replace(
        s,
        anchor,
        anchor + "\nconst allowedMobileOrigins = parseAllowedOrigins(process.env.EASYSPLIT_ALLOWED_MOBILE_ORIGINS || '');",
        rel + ' allowed origins',
    )
if "server.use(createApiCorsMiddleware(allowedMobileOrigins));" not in s:
    anchor = "  const httpServer = http.createServer(server);"
    s = require_replace(
        s,
        anchor,
        "  server.use(createApiCorsMiddleware(allowedMobileOrigins));\n\n" + anchor,
        rel + ' CORS middleware',
    )
s = require_replace(
    s,
    "        if (new URL(origin).host !== host) return rejectUpgrade(socket, 403, 'Forbidden');",
    "        if (!isAllowedClientOrigin(origin, host, allowedMobileOrigins)) return rejectUpgrade(socket, 403, 'Forbidden');",
    rel + ' WS origin',
)
write(rel, s)

rel = '.env.example'
s = read(rel)
block = """

# Mobile Platform Foundation (set these for the native build, not the existing web deployment).
# Keep them unset on the current web deployment to preserve same-origin behavior.
# NEXT_PUBLIC_EASYSPLIT_API_ORIGIN=https://your-easysplit-backend.example
# NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN=https://your-public-easysplit-web.example
# NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN=wss://your-realtime-origin.example
# Exact Capacitor WebView origins permitted by the EasySplit server (comma-separated).
# Capacitor defaults are capacitor://localhost on iOS and https://localhost on Android.
# EASYSPLIT_ALLOWED_MOBILE_ORIGINS=capacitor://localhost,https://localhost
"""
if 'NEXT_PUBLIC_EASYSPLIT_API_ORIGIN' not in s:
    s = s.rstrip() + block + '\n'
write(rel, s)

print('Platform Foundation applied locally.')

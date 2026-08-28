const fs = require('fs');
const path = require('path');

// Automatically load .env and .env.local into process.env if present
function loadEnvFiles() {
  const candidates = [
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env'),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
            const idx = trimmed.indexOf('=');
            const key = trimmed.slice(0, idx).trim();
            const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
            if (key && process.env[key] === undefined) {
              process.env[key] = val;
            }
          }
        }
      } catch (_) {}
    }
  }
}
loadEnvFiles();

const express = require('express');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const next = require('next');

const dbModule = require('./lib/db');
const db = dbModule.db || dbModule.default || dbModule;

const geminiModule = require('./lib/gemini');
const parseReceiptImage = geminiModule.parseReceiptImage || geminiModule.default?.parseReceiptImage;
const parseReceiptTextWithGemini = geminiModule.parseReceiptTextWithGemini || geminiModule.default?.parseReceiptTextWithGemini;

const security = require('./lib/security');
const { createApiCorsMiddleware, isAllowedClientOrigin, parseAllowedOrigins } = require('./lib/platformSecurity');
const debtMinimizer = require('./lib/debtMinimizer');
const calculateDebtMinimization = debtMinimizer.calculateDebtMinimization;
const allocateCentsProportionally = debtMinimizer.allocateCentsProportionally;
const allocateTipAdjustedCents = debtMinimizer.allocateTipAdjustedCents;
const splitCents = debtMinimizer.splitCents;
const toCents = debtMinimizer.toCents;
const { createEntityId, hashAccessToken } = require('./lib/ids');
const { ValidationError, validateItems, validateReceiptBody, validateUserSyncBody } = require('./lib/validation');
const { processSessionAction } = require('./lib/sessionActions');
const {
  createRoomMember,
  findRoomMember,
  deduplicateRoomMembers,
  getRequestRoomToken,
  joinRoom,
  syncRoomMember,
  publicRoom,
} = require('./lib/roomAuth');
const { broadcastToRoom, subscribeClient } = require('./lib/realtimeRooms');
const { reconcileReceipt, getReceiptPayableTotal, isTotalOrTaxLine } = require('./lib/receiptMath');
const { assessReceipt } = require('./lib/receiptAssessment');
const { assessOcrReadability, hasRequiredHebrewVerification, normalizeOcrName } = require('./lib/ocrQuality');
const {
  normalizeScanId,
  normalizeRecoveryToken,
  createStableScanEntityId,
  createAsyncGate,
  createExpiringPromiseCache,
} = require('./lib/ocrControl');
const { processGroupBillAction } = require('./lib/groupActions');
const {
  GROUP_STATUS,
  BILL_STATUS,
  getGroupStatus,
  getBillStatus,
  assertGroupActive,
  normalizeGroupPayerId,
  isValidPayerId,
  assertGroupSettlementPaymentPhase,
  assertSessionSettlementNotDeferredToGroup,
  summarizeGroup,
  groupMatchesScope,
} = require('./lib/groupLifecycle');
const { trackAnalyticsEvent } = require('./lib/analytics');

const admin = require('firebase-admin');

if (!process.env.GEMINI_API_KEY) {
  console.warn('⚠️ GEMINI_API_KEY is not configured. Server-side receipt OCR will reject image scans instead of returning unverified text.');
}

// Initialize Firebase Admin SDK
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'firebase-service-account.json';
const fullServiceAccountPath = path.resolve(process.cwd(), serviceAccountPath);

if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID || 'easysplit-24576',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      })
    });
    console.log('✅ Firebase Admin SDK initialized successfully with Environment Variables.');
  } catch (err) {
    console.error('❌ Failed to initialize Firebase Admin with Environment Variables:', err.message);
  }
} else if (fs.existsSync(fullServiceAccountPath)) {
  try {
    const serviceAccount = require(fullServiceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin SDK initialized successfully with Service Account Key.');
  } catch (err) {
    console.error('❌ Failed to initialize Firebase Admin with service account key:', err.message);
  }
} else {
  try {
    admin.initializeApp({
      projectId: 'easysplit-24576'
    });
    console.warn(`⚠️ Firebase Admin initialized with PROJECT_ID only. Verification will fail unless credentials are provided via environment variables or JSON file at: ${fullServiceAccountPath}`);
  } catch (err) {
    console.error('❌ Failed to initialize Firebase Admin fallback:', err.message);
  }
}

// Local data migration is an explicit administrative operation. Never upload a
// repository-adjacent database merely because a Firestore project is empty.
if (process.env.MIGRATE_LOCAL_DB_TO_FIRESTORE === 'true' && typeof db.migrateLocalDbToFirestore === 'function') {
  throw new Error('MIGRATE_LOCAL_DB_TO_FIRESTORE is no longer supported at server startup. Run the verified standalone cutover script instead.');
}

// Middleware to verify Firebase ID token in Authorization header
async function authenticateUser(req, res, nextMiddleware) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return nextMiddleware();
  }

  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    nextMiddleware();
  } catch (err) {
    console.warn('⚠️ Invalid or expired Firebase ID token:', err.message);
    req.user = null;
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
}

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();
const PORT = process.env.PORT || 3000;
const allowedMobileOrigins = parseAllowedOrigins(process.env.EASYSPLIT_ALLOWED_MOBILE_ORIGINS || '');

function getLocalNetworkIp() {
  try {
    const interfaces = require('os').networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      for (const iface of entries || []) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
  } catch (err) {
    console.warn('Local network address is unavailable; using localhost.');
  }
  return 'localhost';
}

app.prepare().then(() => {
  const server = express();
  const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
  if (Number.isInteger(trustedProxyHops) && trustedProxyHops > 0) server.set('trust proxy', trustedProxyHops);

  // Install the browser security boundary before admission controls and body
  // parsing so early 4xx/5xx responses receive the same protections.
  server.use((req, res, nextMiddleware) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    const scriptSources = ["'self'", "'unsafe-inline'", "https://apis.google.com", "https://*.firebaseapp.com", "https://*.googleapis.com"];
    if (process.env.NODE_ENV !== 'production') scriptSources.push("'unsafe-eval'");
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      `script-src ${scriptSources.join(' ')}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https://*.googleusercontent.com https://lh3.googleusercontent.com https://*.google.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' ws: wss: https://*.googleapis.com https://*.firebaseio.com https://*.firebaseapp.com https://accounts.google.com https://*.google.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://apis.google.com",
      "frame-src https://accounts.google.com https://*.firebaseapp.com https://*.google.com https://*.firebase.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '));
    nextMiddleware();
  });

  server.use(createApiCorsMiddleware(allowedMobileOrigins));

  const httpServer = http.createServer(server);
  const wss = new WebSocket.Server({ noServer: true, maxPayload: 10_000 });
  const wsConnectionsByIp = new Map();
  const maxWebSockets = 500;
  const maxWebSocketsPerIp = 8;
  const wsSubscriptionTimeoutMs = Math.max(500, Math.min(30_000, Number(process.env.WS_SUBSCRIPTION_TIMEOUT_MS) || 10_000));

  function rejectUpgrade(socket, statusCode, statusText) {
    if (!socket.destroyed) {
      socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    }
  }

  function websocketClientIp(request) {
    if (trustedProxyHops > 0) {
      const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').map((part) => part.trim()).filter(Boolean);
      if (forwarded.length) return forwarded[Math.max(0, forwarded.length - trustedProxyHops)] || forwarded[0];
    }
    return request.socket.remoteAddress || 'unknown';
  }

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname !== '/') return rejectUpgrade(socket, 404, 'Not Found');
    const origin = String(request.headers.origin || '');
    const host = String(request.headers.host || '');
    if (origin) {
      try {
        if (!isAllowedClientOrigin(origin, host, allowedMobileOrigins)) return rejectUpgrade(socket, 403, 'Forbidden');
      } catch (_) {
        return rejectUpgrade(socket, 403, 'Forbidden');
      }
    }
    const clientIp = websocketClientIp(request);
    if (wss.clients.size >= maxWebSockets || (wsConnectionsByIp.get(clientIp) || 0) >= maxWebSocketsPerIp) {
      return rejectUpgrade(socket, 429, 'Too Many Requests');
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.clientIp = clientIp;
      wsConnectionsByIp.set(clientIp, (wsConnectionsByIp.get(clientIp) || 0) + 1);
      wss.emit('connection', ws, request);
    });
  });

  let activeReceiptRequests = 0;
  const activeReceiptRequestsByIp = new Map();
  let activeMutationRequests = 0;
  const activeMutationRequestsByIp = new Map();
  server.use((req, res, nextMiddleware) => {
    const isApiRequest = req.path.startsWith('/api/');
    const isApiMutation = req.path.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const isReceiptRequest = req.method === 'POST' && req.path.startsWith('/api/receipt/');
    const contentLength = Number(req.headers['content-length'] || 0);
    if (!isApiRequest) return nextMiddleware();
    if (!isApiMutation) {
      if (contentLength > 0) return res.status(413).json({ error: 'Request bodies are not accepted on this endpoint' });
      return nextMiddleware();
    }
    if (isReceiptRequest) return nextMiddleware();
    if (contentLength > 768 * 1024) return res.status(413).json({ error: 'API request is too large' });
    const mutationIp = req.ip || req.socket.remoteAddress || 'unknown';
    const activeForIp = activeMutationRequestsByIp.get(mutationIp) || 0;
    if (activeForIp >= 8 || activeMutationRequests >= 48) {
      return res.status(429).json({ error: 'Too many active updates. Please retry shortly.' });
    }
    activeMutationRequests += 1;
    activeMutationRequestsByIp.set(mutationIp, activeForIp + 1);
    let released = false;
    const timeout = setTimeout(() => {
      if (!req.complete && !res.headersSent) {
        res.status(408).json({ error: 'Request body timed out.' });
        req.destroy();
      }
    }, 10_000);
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      activeMutationRequests = Math.max(0, activeMutationRequests - 1);
      const remaining = Math.max(0, (activeMutationRequestsByIp.get(mutationIp) || 1) - 1);
      if (remaining) activeMutationRequestsByIp.set(mutationIp, remaining);
      else activeMutationRequestsByIp.delete(mutationIp);
    };
    req.once('end', () => clearTimeout(timeout));
    res.once('finish', release);
    res.once('close', release);
    return nextMiddleware();
  });

  server.use((req, res, nextMiddleware) => {
    const isReceiptRequest = req.method === 'POST' && req.path.startsWith('/api/receipt/');
    if (!isReceiptRequest) return nextMiddleware();
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > 12 * 1024 * 1024) return res.status(413).json({ error: 'Receipt request is too large' });
    const admissionIp = req.ip || req.socket.remoteAddress || 'unknown';
    const activeForIp = activeReceiptRequestsByIp.get(admissionIp) || 0;
    if (activeForIp >= 3) return res.status(429).json({ error: 'Too many receipt requests from this connection.' });
    if (activeReceiptRequests >= 8) return res.status(503).json({ error: 'Receipt scanning is busy. Please try again shortly.' });
    activeReceiptRequests += 1;
    activeReceiptRequestsByIp.set(admissionIp, activeForIp + 1);
    let released = false;
    const bodyTimeoutMs = contentLength > 0
      ? Math.min(55_000, Math.max(10_000, Math.ceil(contentLength / (200 * 1024)) * 1_000))
      : 10_000;
    const bodyTimeout = setTimeout(() => {
      if (req.complete || res.headersSent) return;
      res.status(408).json({ error: 'Receipt upload timed out.' });
      req.destroy();
    }, bodyTimeoutMs);
    req.once('end', () => clearTimeout(bodyTimeout));
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(bodyTimeout);
      activeReceiptRequests = Math.max(0, activeReceiptRequests - 1);
      const remainingForIp = Math.max(0, (activeReceiptRequestsByIp.get(admissionIp) || 1) - 1);
      if (remainingForIp === 0) activeReceiptRequestsByIp.delete(admissionIp);
      else activeReceiptRequestsByIp.set(admissionIp, remainingForIp);
    };
    res.once('finish', release);
    res.once('close', release);
    return nextMiddleware();
  });

  const receiptJsonParser = express.json({ limit: '12mb' });
  const standardApiJsonParser = express.json({ limit: '768kb' });
  server.use((req, res, nextMiddleware) => {
    if (!req.path.startsWith('/api/')) return nextMiddleware();
    const parser = req.method === 'POST' && req.path.startsWith('/api/receipt/')
      ? receiptJsonParser
      : standardApiJsonParser;
    return parser(req, res, nextMiddleware);
  });
  server.use((error, req, res, nextMiddleware) => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
    return nextMiddleware(error);
  });

  const ocrGate = createAsyncGate({ maxConcurrent: 3, maxQueue: 8, waitTimeoutMs: 1_000 });
  const ocrResultCache = createExpiringPromiseCache({ ttlMs: 5 * 60_000, maxEntries: 200 });
  const accountReadGate = createAsyncGate({ maxConcurrent: 2, maxQueue: 4, waitTimeoutMs: 750 });

  // 🛡️ Pass-through API Middleware
  server.use('/api/', (req, res, nextMiddleware) => {
    nextMiddleware();
  });

  function memberHasSubscriptionHash(member, tokenHash) {
    if (!member || !tokenHash) return false;
    return [member.accessTokenHash, ...(Array.isArray(member.accessTokenHashes) ? member.accessTokenHashes : [])]
      .filter(Boolean)
      .includes(tokenHash);
  }

  function sendToRoom(type, id, payload, room) {
    broadcastToRoom(wss.clients, type, id, payload, WebSocket.OPEN, (client, key) => {
      const authorization = client.roomAuthorizations instanceof Map
        ? client.roomAuthorizations.get(key)
        : null;
      const member = room?.members?.find((candidate) => candidate.id === authorization?.memberId && candidate.active !== false);
      return memberHasSubscriptionHash(member, authorization?.tokenHash);
    });
  }

  function groupDebtView(group) {
    const status = getGroupStatus(group);
    const settlement = group?.settlement;
    if (
      status !== GROUP_STATUS.ACTIVE
      && settlement
      && Array.isArray(settlement.balances)
      && Array.isArray(settlement.transfers)
    ) {
      return {
        balances: settlement.balances,
        transactions: settlement.transfers.filter((transfer) => transfer?.paid !== true),
        unassignedAmount: 0,
        isBalanced: true,
      };
    }
    return calculateDebtMinimization(group);
  }

  function publicGroupWithDebt(group) {
    const cleanGroup = deduplicateRoomMembers(group);
    const status = getGroupStatus(cleanGroup);
    const debtData = groupDebtView(cleanGroup);
    return publicRoom({
      ...cleanGroup,
      status,
      summary: summarizeGroup(cleanGroup),
      balances: debtData.balances,
      minimizedTransactions: debtData.transactions,
      unassignedAmount: debtData.unassignedAmount || 0,
      isBalanced: debtData.isBalanced !== false,
    });
  }

  function authorizedRoomMember(req, room) {
    return findRoomMember(room, {
      uid: req.user?.uid,
      accessToken: getRequestRoomToken(req),
    });
  }

  function roomDiscovery(room) {
    return {
      id: room.id,
      code: room.code,
      status: Array.isArray(room?.bills)
        ? getGroupStatus(room)
        : room.status,
    };
  }

  function publicUserProfile(user) {
    return {
      id: user.id,
      username: user.username || 'User',
      phone: user.phone || '',
      avatarColor: user.avatarColor || '#7C3AED',
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      settings: {
        language: user.settings?.language || 'en',
        currency: user.settings?.currency || 'NIS',
        theme: user.settings?.theme || 'light',
        ocrEngine: user.settings?.ocrEngine || 'tesseract',
      },
    };
  }

  function sendRouteError(res, err, fallbackMessage) {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    if (status >= 500) console.error(fallbackMessage, err);
    return res.status(status).json({
      error: typeof err?.publicMessage === 'string'
        ? err.publicMessage
        : (status >= 500 ? fallbackMessage : err.message),
      ...(typeof err?.errorCode === 'string' ? { errorCode: err.errorCode } : {}),
    });
  }

  function createSessionHistoryRecord(session, groupName = '') {
    const publicSession = publicRoom(session);
    const subtotal = getReceiptPayableTotal(session);
    const totalAmount = Math.round(subtotal * (1 + Number(session.tipPercentage || 0) / 100) * 100) / 100;
    const memberIds = [...new Set((session.members || []).map((member) => (
      member?.userId
      || member?.uid
      || (member?.id && !String(member.id).startsWith('member_') ? member.id : '')
    )).filter(Boolean))];
    return {
      id: session.id,
      storeName: session.storeName || 'Bill Session',
      date: session.date || new Date().toISOString().split('T')[0],
      currency: session.currency || 'NIS',
      totalAmount,
      payableSubtotal: subtotal,
      membersCount: session.members?.length || 1,
      members: publicSession.members || [],
      memberIds,
      items: publicSession.items || [],
      tipPercentage: session.tipPercentage || 0,
      settledAt: session.settledAt || Date.now(),
      createdAt: session.createdAt || Date.now(),
      ...(session.groupId ? { groupId: session.groupId } : {}),
      ...(session.groupId && groupName ? { groupName } : {}),
      ...(session.payerId ? { payerId: session.payerId } : {}),
    };
  }

  function encodeHistoryCursor(source, offset, emitted) {
    return Buffer.from(JSON.stringify({ v: 1, source, offset, emitted }), 'utf8').toString('base64url');
  }

  function decodeHistoryCursor(rawCursor) {
    if (!rawCursor) return { source: 'canonical', offset: 0, emitted: 0 };
    try {
      const parsed = JSON.parse(Buffer.from(String(rawCursor), 'base64url').toString('utf8'));
      if (parsed?.v !== 1 || !['canonical', 'legacy'].includes(parsed.source)) return null;
      const offset = Number(parsed.offset);
      const emitted = Number(parsed.emitted);
      if (!Number.isInteger(offset) || offset < 0 || offset > 200) return null;
      if (!Number.isInteger(emitted) || emitted < 0 || emitted > 200) return null;
      return { source: parsed.source, offset, emitted };
    } catch (_) {
      return null;
    }
  }

  function amountWithTip(baseAmount, tipPercentage) {
    const baseCents = toCents(baseAmount);
    return Math.round(baseCents * (1 + Math.max(0, Number(tipPercentage) || 0) / 100)) / 100;
  }

  function groupBillContentDigest(bill) {
    const items = (Array.isArray(bill?.items) ? bill.items : []).map((item) => ({
      name: String(item?.name || ''),
      price: Number(item?.price || 0),
      quantity: Number(item?.quantity || 1),
      unitPrice: Number(item?.unitPrice || 0),
      lineTotal: Number(item?.lineTotal ?? item?.price ?? 0),
      claimedBy: [...new Set(Array.isArray(item?.claimedBy) ? item.claimedBy.map(String) : [])].sort(),
    }));
    return crypto.createHash('sha256').update(JSON.stringify({
      title: String(bill?.title || bill?.storeName || ''),
      date: String(bill?.date || ''),
      currency: String(bill?.currency || ''),
      payerId: String(bill?.payerId || ''),
      tipPercentage: Math.max(0, Number(bill?.tipPercentage) || 0),
      receiptTotal: optionalReceiptAmount(bill?.receiptTotal),
      subtotal: optionalReceiptAmount(bill?.subtotal),
      tax: optionalReceiptAmount(bill?.tax),
      service: optionalReceiptAmount(bill?.service),
      discount: optionalReceiptAmount(bill?.discount),
      items,
    })).digest('hex');
  }

  global.broadcastSessionState = async function (sessionId) {
    try {
      const session = await db.getSession(sessionId);
      if (!session) return;
      sendToRoom('session', session.id, {
        type: 'SESSION_UPDATE',
        session: publicRoom(session),
      }, session);
    } catch (error) {
      console.warn('Session broadcast refresh failed:', error?.message || error);
    }
  };

  global.broadcastGroupState = async function (groupId) {
    try {
      const group = await db.getGroup(groupId);
      if (!group) return;
      sendToRoom('group', group.id, {
        type: 'GROUP_UPDATE',
        group: publicGroupWithDebt(group),
      }, group);
    } catch (error) {
      console.warn('Group broadcast refresh failed:', error?.message || error);
    }
  };

  const avatarColors = ['#A3E635', '#38BDF8', '#F472B6', '#A78BFA', '#FBBF24', '#34D399'];
  function getRandomAvatarColor() {
    return avatarColors[Math.floor(Math.random() * avatarColors.length)];
  }

  const ocrRateBuckets = new Map();
  const sessionCreateRateBuckets = new Map();
  const roomLookupRateBuckets = new Map();
  const roomJoinRateBuckets = new Map();
  const mutationRateBuckets = new Map();
  const accountReadRateBuckets = new Map();
  function pruneRateBuckets(buckets, now) {
    for (const [bucketKey, value] of buckets) {
      if (now - value.startedAt > 10 * 60 * 1000) buckets.delete(bucketKey);
    }
    while (buckets.size > 2_000) buckets.delete(buckets.keys().next().value);
  }

  function sessionCreateRateLimit(req, res, nextMiddleware) {
    const now = Date.now();
    const key = req.user?.uid
      ? `user:${req.user.uid}`
      : `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const existing = sessionCreateRateBuckets.get(key);
    const bucket = !existing || now - existing.startedAt > 10 * 60 * 1000
      ? { startedAt: now, count: 0 }
      : existing;
    bucket.count += 1;
    sessionCreateRateBuckets.set(key, bucket);
    if (sessionCreateRateBuckets.size > 1_000) pruneRateBuckets(sessionCreateRateBuckets, now);
    if (bucket.count > 30) {
      return res.status(429).json({ error: 'Too many new bills. Please wait a few minutes and try again.' });
    }
    return nextMiddleware();
  }

  const ocrUserRateLimiter = security.createUserRateLimiter({
    shortWindowMs: 10 * 60 * 1000,
    shortMax: 5,
    dailyWindowMs: 24 * 60 * 60 * 1000,
    dailyMax: 25,
    shortMessage: 'Too many receipt scans in a short period. Please wait a few minutes before trying again.',
    dailyMessage: 'Daily receipt scan limit reached (25 scans per day). Please try again tomorrow.',
    requireAuth: process.env.NODE_ENV === 'production' || process.env.REQUIRE_OCR_AUTH === 'true',
    unauthMessage: 'Please sign in with Google or Email to scan receipts with AI.',
  });

  function ocrRateLimit(req, res, nextMiddleware) {
    return ocrUserRateLimiter.middleware(req, res, nextMiddleware);
  }

  // Firebase App Check middleware (validates genuine app traffic)
  async function appCheckProtection(req, res, nextMiddleware) {
    const appCheckToken = req.header('X-Firebase-AppCheck');
    if (process.env.ENFORCE_APP_CHECK === 'true') {
      if (!appCheckToken) {
        return res.status(401).json({ error: 'App Check token is required', errorCode: 'APP_CHECK_REQUIRED' });
      }
      try {
        const appCheckClaims = await admin.appCheck().verifyToken(appCheckToken);
        req.appCheck = appCheckClaims;
        return nextMiddleware();
      } catch (err) {
        return res.status(401).json({ error: 'Unauthorized: Invalid App Check token', errorCode: 'APP_CHECK_INVALID' });
      }
    }
    if (appCheckToken) {
      try {
        const appCheckClaims = await admin.appCheck().verifyToken(appCheckToken);
        req.appCheck = appCheckClaims;
      } catch (_) {}
    }
    return nextMiddleware();
  }

  function roomWindowRateLimit(buckets, limit, message) {
    return (req, res, nextMiddleware) => {
      const now = Date.now();
      const key = req.user?.uid
        ? `user:${req.user.uid}`
        : `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
      const previous = buckets.get(key);
      const bucket = !previous || now - previous.startedAt > 10 * 60_000
        ? { startedAt: now, count: 0 }
        : previous;
      bucket.count += 1;
      buckets.set(key, bucket);
      if (buckets.size > 1_000) pruneRateBuckets(buckets, now);
      if (bucket.count > limit) return res.status(429).json({ error: message });
      return nextMiddleware();
    };
  }

  // New invites use eight digits; retain tighter limits for code discovery and
  // legacy four-digit rooms until those records expire.
  const roomLookupRateLimit = roomWindowRateLimit(roomLookupRateBuckets, 60, 'Too many room lookups. Please wait and try again.');
  const roomJoinRateLimit = roomWindowRateLimit(roomJoinRateBuckets, 30, 'Too many room join attempts. Please wait and try again.');
  const mutationRateLimit = roomWindowRateLimit(mutationRateBuckets, 240, 'Too many room updates. Please wait and try again.');
  const accountReadRateLimit = roomWindowRateLimit(accountReadRateBuckets, 240, 'Too many account reads. Please wait and try again.');
  async function accountReadAdmission(req, res, nextMiddleware) {
    try {
      const releaseGate = await accountReadGate.acquire();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseGate();
      };
      res.once('finish', release);
      res.once('close', release);
      return nextMiddleware();
    } catch (_) {
      return res.status(503).json({ error: 'Account data is busy. Please retry shortly.' });
    }
  }

  function receiptInputDigest(body) {
    const hash = crypto.createHash('sha256');
    const imageParts = Array.isArray(body?.imageBase64Parts)
      ? body.imageBase64Parts
      : (typeof body?.imageBase64 === 'string' ? [body.imageBase64] : []);
    if (imageParts.length) {
      imageParts.forEach((part) => hash.update(String(part)));
      hash.update(String(body?.mimeType || ''));
    } else if (typeof body?.rawText === 'string') {
      hash.update(body.rawText);
    } else if (typeof body?.parsedBill?.inputDigest === 'string') {
      return security.sanitizeString(body.parsedBill.inputDigest, 64);
    } else {
      return '';
    }
    return hash.digest('hex');
  }

  async function parseReceiptRequest(req) {
    const {
      imageBase64,
      imageBase64Parts,
      mimeType,
      parsedBill: clientParsed,
      customGeminiKey,
      rawText,
      confirmedByUser,
      imageQuality,
      scanId,
    } = validateReceiptBody(req.body);

    let parsedReceipt = null;
    if (rawText) {
      if (!customGeminiKey && !process.env.GEMINI_API_KEY) {
        const error = new Error('Gemini OCR is not configured');
        error.name = 'OcrProviderUnavailableError';
        error.statusCode = 503;
        error.errorCode = 'OCR_PROVIDER_UNAVAILABLE';
        error.publicMessage = 'Receipt scanning is temporarily unavailable. Please try again or enter the bill manually.';
        throw error;
      }
      parsedReceipt = await parseReceiptTextWithGemini(rawText, customGeminiKey);
    } else if (imageBase64Parts.length || imageBase64) {
      if (!customGeminiKey && !process.env.GEMINI_API_KEY) {
        const error = new Error('Gemini OCR is not configured');
        error.name = 'OcrProviderUnavailableError';
        error.statusCode = 503;
        error.errorCode = 'OCR_PROVIDER_UNAVAILABLE';
        error.publicMessage = 'Receipt scanning is temporarily unavailable. Please try again or enter the bill manually.';
        throw error;
      }
      parsedReceipt = await parseReceiptImage(
        imageBase64Parts.length ? imageBase64Parts : imageBase64,
        mimeType,
        customGeminiKey,
      );
    }

    if ((!parsedReceipt?.items?.length) && clientParsed?.items?.length) parsedReceipt = clientParsed;
    if (!parsedReceipt?.items?.length) return null;
    const effectiveImageQuality = sanitizeImageQuality(imageQuality);
    const normalizedAmounts = {
      receiptTotal: optionalReceiptAmount(parsedReceipt.receiptTotal ?? parsedReceipt.total),
      subtotal: optionalReceiptAmount(parsedReceipt.subtotal),
      tax: optionalReceiptAmount(parsedReceipt.tax),
      service: optionalReceiptAmount(parsedReceipt.service),
      discount: optionalReceiptAmount(Math.abs(Number(parsedReceipt.discount))),
    };
    const providerInput = Boolean(rawText || imageBase64Parts.length || imageBase64);
    const normalizedScanId = normalizeScanId(scanId);
    const ocrEvidence = sanitizeOcrEvidence(parsedReceipt.ocr)
      || (providerInput ? { source: getOcrSource(req.body), modelName: '', modelAttempts: 0, verificationStatus: '' } : null);
    const hasReceiptEvidence = Boolean(
      providerInput
      || normalizedScanId
      || ocrEvidence
    );

    const filteredItems = (parsedReceipt.items || []).map((item) => ({
      ...item,
      name: normalizeOcrName(item?.name || item?.description || ''),
    })).filter((item) => {
      const name = item.name;
      return name && !isTotalOrTaxLine(name);
    });
    if (!filteredItems.length) return null;

    if (hasReceiptEvidence) {
      const readability = assessOcrReadability(
        { ...parsedReceipt, items: filteredItems },
        { expectedLanguage: parsedReceipt?.ocr?.documentLanguage || parsedReceipt?.documentLanguage },
      );
      if (!readability.readable) return null;
      if (!hasRequiredHebrewVerification({
        ...parsedReceipt,
        documentLanguage: readability.language,
        ocr: ocrEvidence,
        items: filteredItems,
      })) return null;
      if (ocrEvidence) {
        ocrEvidence.readabilityScore = readability.score;
        ocrEvidence.documentLanguage = readability.language;
        ocrEvidence.hebrewCharacterRatio = readability.hebrewCharacterRatio;
      }
    }

    const items = validateItems(filteredItems).map((item) => ({
      ...item,
      id: createEntityId('item'),
      claimedBy: [],
    }));
    const receipt = {
      storeName: security.sanitizeString(parsedReceipt.storeName || 'Scanned Receipt', 80),
      date: security.sanitizeString(parsedReceipt.date || new Date().toISOString().split('T')[0], 20),
      currency: security.sanitizeString(parsedReceipt.currency || 'NIS', 5).toUpperCase(),
      ...normalizedAmounts,
      ocr: ocrEvidence,
      imageQuality: effectiveImageQuality,
      scanId: normalizedScanId,
      inputDigest: receiptInputDigest(req.body),
      items,
    };
    receipt.reconciliation = hasReceiptEvidence ? reconcileReceipt(receipt) : null;
    receipt.assessment = hasReceiptEvidence
      ? assessReceipt(receipt, {
          source: receipt.ocr?.source || 'receipt-evidence',
          imageQuality: effectiveImageQuality,
          confirmedByUser,
        })
      : null;
    if (hasReceiptEvidence && confirmedByUser) receipt.confirmedByUserAt = Date.now();
    return receipt;
  }

  function getOcrSource(body) {
    if (body?.imageBase64 || (Array.isArray(body?.imageBase64Parts) && body.imageBase64Parts.length)) return 'server-image';
    if (body?.rawText) return 'client-raw-text';
    if (body?.parsedBill) return 'client-parsed';
    return 'unknown';
  }

  function optionalReceiptAmount(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 50_000) return null;
    return Math.round((number + Number.EPSILON) * 100) / 100;
  }

  function sanitizeOcrEvidence(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return {
      source: security.sanitizeString(value.source || '', 30),
      modelName: security.sanitizeString(value.modelName || '', 50),
      verificationModelName: security.sanitizeString(value.verificationModelName || '', 50),
      tiebreakerModelName: security.sanitizeString(value.tiebreakerModelName || '', 50),
      modelAttempts: Math.max(0, Math.min(10, Number(value.modelAttempts) || 0)),
      successfulModelReads: Math.max(0, Math.min(10, Number(value.successfulModelReads) || 0)),
      providerDurationMs: Math.max(0, Math.min(60_000, Number(value.providerDurationMs) || 0)),
      verificationStatus: security.sanitizeString(value.verificationStatus || '', 50),
      resolvedItemPrices: Math.max(0, Math.min(250, Number(value.resolvedItemPrices) || 0)),
      unresolvedItemPrices: Math.max(0, Math.min(250, Number(value.unresolvedItemPrices) || 0)),
      consensusChangedValues: Math.max(0, Math.min(260, Number(value.consensusChangedValues) || 0)),
      documentLanguage: security.sanitizeString(value.documentLanguage || '', 12),
      readabilityScore: Math.max(0, Math.min(1, Number(value.readabilityScore) || 0)),
      hebrewCharacterRatio: Math.max(0, Math.min(1, Number(value.hebrewCharacterRatio) || 0)),
      confidence: Math.max(0, Math.min(100, Number(value.confidence) || 0)),
      nameVerificationStatus: security.sanitizeString(value.nameVerificationStatus || '', 40),
    };
  }

  function sanitizeImageQuality(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return {
      width: Math.max(0, Math.min(20_000, Number(value.width) || 0)),
      height: Math.max(0, Math.min(20_000, Number(value.height) || 0)),
      meanBrightness: Math.max(0, Math.min(255, Number(value.meanBrightness) || 0)),
      edgeScore: Math.max(0, Math.min(255, Number(value.edgeScore) || 0)),
      warnings: Array.isArray(value.warnings)
        ? value.warnings.filter((item) => typeof item === 'string').slice(0, 10).map((item) => security.sanitizeString(item, 40))
        : [],
    };
  }

  // REST API Routes

  // Parse a receipt and create a private real-time session.
  server.post('/api/receipt/parse', authenticateUser, appCheckProtection, ocrRateLimit, async (req, res) => {
    const startedAt = Date.now();
    const ocrSource = getOcrSource(req.body);
    void trackAnalyticsEvent('ocr_scan_started', {
      userId: req.user?.uid,
      metadata: { route: '/api/receipt/parse', ocrSource },
    });
    try {
      const scanId = normalizeScanId(req.body?.scanId);
      const ownerKey = req.user?.uid || req.ip || req.socket.remoteAddress || 'guest';
      const cacheKey = scanId ? `parse:${ownerKey}:${scanId}:${receiptInputDigest(req.body)}` : '';
      const receipt = await ocrResultCache.run(cacheKey, async () => {
        const release = await ocrGate.acquire();
        try {
          return await parseReceiptRequest(req);
        } finally {
          release();
        }
      });
      if (!receipt) {
        void trackAnalyticsEvent('ocr_scan_failed', {
          userId: req.user?.uid,
          metadata: {
            route: '/api/receipt/parse', ocrSource, outcome: 'not-readable',
            durationMs: Date.now() - startedAt, httpStatus: 400,
          },
        });
        return res.status(400).json({
          success: false,
          isNotBill: true,
          error: 'No readable receipt items and prices were detected.',
        });
      }
      void trackAnalyticsEvent('ocr_scan_succeeded', {
        userId: req.user?.uid,
        metadata: {
          route: '/api/receipt/parse', ocrSource, durationMs: Date.now() - startedAt,
          itemCount: receipt.items.length,
          reconciliationStatus: receipt.reconciliation?.status || 'unknown',
        },
      });
      return res.json({ success: true, receipt });
    } catch (err) {
      void trackAnalyticsEvent('ocr_scan_failed', {
        userId: req.user?.uid,
        metadata: {
          route: '/api/receipt/parse', ocrSource, outcome: 'error',
          durationMs: Date.now() - startedAt, httpStatus: err?.statusCode || 500,
          errorCode: err?.name || 'parse_error',
        },
      });
      return sendRouteError(res, err, 'Failed to parse receipt');
    }
  });

  server.post('/api/receipt/scan', authenticateUser, appCheckProtection, sessionCreateRateLimit, ocrRateLimit, async (req, res) => {
    const startedAt = Date.now();
    const ocrSource = getOcrSource(req.body);
    void trackAnalyticsEvent('ocr_scan_started', {
      userId: req.user?.uid,
      metadata: { route: '/api/receipt/scan', ocrSource },
    });
    try {
      const providerBackedInput = Boolean(
        req.body?.imageBase64
        || (Array.isArray(req.body?.imageBase64Parts) && req.body.imageBase64Parts.length)
        || req.body?.rawText
      );
      const requestScanId = normalizeScanId(req.body?.scanId);
      const requestOwnerKey = req.user?.uid || req.ip || req.socket.remoteAddress || 'guest';
      const parsedReceipt = providerBackedInput
        ? await ocrResultCache.run(requestScanId ? `scan:${requestOwnerKey}:${requestScanId}:${receiptInputDigest(req.body)}` : '', async () => {
            const release = await ocrGate.acquire();
            try {
              return await parseReceiptRequest(req);
            } finally {
              release();
            }
          })
        : await parseReceiptRequest(req);
      if (!parsedReceipt) {
        void trackAnalyticsEvent('ocr_scan_failed', {
          userId: req.user?.uid,
          metadata: {
            route: '/api/receipt/scan', ocrSource, outcome: 'not-readable',
            durationMs: Date.now() - startedAt, httpStatus: 400,
          },
        });
        return res.status(400).json({
          success: false,
          isNotBill: true,
          error: "No receipt items or prices were detected in this image. Please upload or take a clear photo of a physical bill or receipt."
        });
      }

      const inputWasOcr = Boolean(parsedReceipt.reconciliation || parsedReceipt.ocr || parsedReceipt.scanId);
      if (inputWasOcr && req.body?.confirmedByUser !== true) {
        return res.status(409).json({
          success: false,
          confirmationRequired: true,
          receipt: parsedReceipt,
          error: 'Please review and confirm the scanned receipt before starting the split.',
        });
      }
      if (inputWasOcr) {
        parsedReceipt.assessment = assessReceipt(parsedReceipt, {
          source: parsedReceipt.ocr?.source || 'receipt-evidence',
          imageQuality: parsedReceipt.imageQuality,
          confirmedByUser: true,
        });
        parsedReceipt.confirmedByUserAt = Date.now();
      }
      const confirmedContentDigest = groupBillContentDigest(parsedReceipt);

      const rawHostName = req.body?.hostName || (req.user ? req.user.name : 'Host');
      const scanId = normalizeScanId(req.body?.scanId);
      const recoveryToken = scanId ? normalizeRecoveryToken(req.body?.recoveryToken) : '';
      if (scanId && !recoveryToken) {
        return res.status(400).json({ error: 'A valid receipt recovery token is required.' });
      }
      const ownerKey = recoveryToken
        ? `recovery:${crypto.createHash('sha256').update(recoveryToken).digest('hex')}`
        : (req.user?.uid || req.ip || req.socket.remoteAddress || 'guest');
      const stableSessionId = scanId ? createStableScanEntityId('sess_scan', ownerKey, scanId) : '';
      const sessionResponse = await (async () => {
          const existingSession = stableSessionId ? await db.getSession(stableSessionId) : null;
          if (existingSession) {
            if (parsedReceipt.inputDigest && existingSession.inputDigest && parsedReceipt.inputDigest !== existingSession.inputDigest) {
              const error = new Error('This scan identifier belongs to a different receipt.');
              error.statusCode = 409;
              throw error;
            }
            if (existingSession.contentDigest && existingSession.contentDigest !== confirmedContentDigest) {
              const error = new Error('This receipt draft changed after it was confirmed. Reopen the existing split or use a new scan.');
              error.statusCode = 409;
              throw error;
            }
            const existingHost = Array.isArray(existingSession.members)
              ? existingSession.members.find((member) => member.isHost)
              : null;
            if (!existingHost) {
              const error = new Error('Existing scan session is invalid');
              error.statusCode = 409;
              throw error;
            }
            const existingToken = getRequestRoomToken(req) || recoveryToken;
            const authenticatedExistingHost = findRoomMember(existingSession, {
              uid: req.user?.uid,
              accessToken: existingToken,
            });
            if (!authenticatedExistingHost?.isHost) {
              const error = new Error('This receipt was already confirmed. Open the existing split instead of creating it again.');
              error.statusCode = 409;
              throw error;
            }
            return {
              success: true,
              idempotentReplay: true,
              sessionId: existingSession.id,
              code: existingSession.code,
              hostId: existingHost.id,
              memberId: existingHost.id,
              accessToken: existingToken,
              session: publicRoom(existingSession),
            };
          }

          const host = createRoomMember({
            uid: req.user?.uid,
            name: rawHostName,
            phone: req.body?.hostPhone,
            isHost: true,
            avatarColor: '#A3E635',
          });
          if (recoveryToken) {
            host.member.accessTokenHash = hashAccessToken(recoveryToken);
            host.accessToken = recoveryToken;
          }
          const newSessionId = stableSessionId || createEntityId('sess');
          const newSession = {
            id: newSessionId,
            code: await db.generateUniqueRoomCode('session', newSessionId),
            storeName: security.sanitizeString(parsedReceipt.storeName || 'Scanned Receipt', 40),
            date: parsedReceipt.date || new Date().toISOString().split('T')[0],
            currency: security.sanitizeString(parsedReceipt.currency || 'NIS', 5),
            receiptTotal: parsedReceipt.receiptTotal,
            subtotal: parsedReceipt.subtotal,
            tax: parsedReceipt.tax,
            service: parsedReceipt.service,
            discount: parsedReceipt.discount,
            reconciliation: parsedReceipt.reconciliation,
            assessment: parsedReceipt.assessment,
            ocr: parsedReceipt.ocr,
            imageQuality: parsedReceipt.imageQuality,
            scanId: scanId || undefined,
            inputDigest: parsedReceipt.inputDigest || undefined,
            contentDigest: confirmedContentDigest,
            confirmedByUserAt: parsedReceipt.confirmedByUserAt || undefined,
            hostPhone: host.member.phone || '',
            status: 'active',
            createdAt: Date.now(),
            members: [host.member],
            items: parsedReceipt.items,
          };
          if (stableSessionId && typeof db.createSessionIfAbsent === 'function') {
            const creation = await db.createSessionIfAbsent(newSession);
            if (!creation.created) {
              const persistedHost = findRoomMember(creation.session, {
                uid: req.user?.uid,
                accessToken: recoveryToken,
              });
              if (persistedHost?.isHost && (
                !parsedReceipt.inputDigest
                || !creation.session.inputDigest
                || parsedReceipt.inputDigest === creation.session.inputDigest
              ) && (
                !creation.session.contentDigest
                || creation.session.contentDigest === confirmedContentDigest
              )) {
                return {
                  success: true,
                  idempotentReplay: true,
                  sessionId: creation.session.id,
                  code: creation.session.code,
                  hostId: persistedHost.id,
                  memberId: persistedHost.id,
                  accessToken: recoveryToken,
                  session: publicRoom(creation.session),
                };
              }
              const error = new Error('This receipt was already confirmed by another request.');
              error.statusCode = 409;
              throw error;
            }
          } else {
            await db.saveSession(newSession);
          }

          const commonAnalyticsContext = {
            userId: req.user?.uid,
            sessionId: newSession.id,
            metadata: {
              route: '/api/receipt/scan', ocrSource, durationMs: Date.now() - startedAt,
              itemCount: newSession.items.length,
              memberCount: newSession.members.length,
              currency: newSession.currency,
              reconciliationStatus: newSession.reconciliation?.status || 'unknown',
            },
          };
          void trackAnalyticsEvent('ocr_scan_succeeded', commonAnalyticsContext);
          void trackAnalyticsEvent('session_created', commonAnalyticsContext);

          return {
            success: true,
            sessionId: newSession.id,
            code: newSession.code,
            hostId: host.member.id,
            memberId: host.member.id,
            accessToken: host.accessToken,
            session: publicRoom(newSession),
          };
      })();
      return res.json(sessionResponse);
    } catch (err) {
      void trackAnalyticsEvent('ocr_scan_failed', {
        userId: req.user?.uid,
        metadata: {
          route: '/api/receipt/scan', ocrSource, outcome: 'error',
          durationMs: Date.now() - startedAt, httpStatus: err?.statusCode || 500,
          errorCode: err?.name || 'scan_error',
        },
      });
      return sendRouteError(res, err, 'Failed to parse receipt');
    }
  });

  server.get('/api/session/:idOrCode', authenticateUser, roomLookupRateLimit, async (req, res) => {
    const sanitizedId = security.sanitizeString(req.params.idOrCode, 100);
    const session = await db.getSession(sanitizedId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const actor = authorizedRoomMember(req, session);
    return res.json({ session: actor ? publicRoom(session) : roomDiscovery(session) });
  });

  server.get('/api/session/:sessionId/payment-target/:memberId', authenticateUser, roomLookupRateLimit, async (req, res) => {
    const sessionId = security.sanitizeString(req.params.sessionId, 100);
    const memberId = security.sanitizeString(req.params.memberId, 100);
    const session = await db.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const actor = authorizedRoomMember(req, session);
    if (!actor) return res.status(401).json({ error: 'A valid room membership is required' });
    try {
      assertSessionSettlementNotDeferredToGroup(session);
    } catch (error) {
      return res.status(error.statusCode || 409).json({ error: error.message });
    }
    if (session.status === 'settled') return res.status(409).json({ error: 'This session is already closed' });
    if (actor.settled === true || !session.payerId || session.payerId === 'each' || session.payerId !== memberId || actor.id === memberId) {
      return res.status(403).json({ error: 'No payment is due from this member to that recipient' });
    }

    const recipient = session.members.find((member) => member.id === memberId && member.active !== false);
    const amount = calculateUserShareForSession(
      session.items,
      session.members,
      actor.id,
      actor.name,
      actor.phone,
      Number(session.tipPercentage || 0),
      getReceiptPayableTotal(session),
    );
    if (!recipient || amount <= 0) {
      return res.status(403).json({ error: 'No payment is due from this member to that recipient' });
    }

    const paymentAmount = req.query?.round === 'true' ? Math.round(amount) : amount;
    if (paymentAmount <= 0) {
      return res.status(403).json({ error: 'No payment is due from this member to that recipient' });
    }

    return res.json({
      memberId,
      phone: recipient.phone || (recipient.isHost ? session.hostPhone || '' : ''),
      amount: paymentAmount,
    });
  });

  server.post('/api/session/:idOrCode/join', authenticateUser, roomJoinRateLimit, async (req, res) => {
    try {
      const session = await db.getSession(security.sanitizeString(req.params.idOrCode, 100));
      if (!session) return res.status(404).json({ error: 'Session not found' });
      let joined = null;
      const mutation = await db.transactSessionAndLinkedGroup(session.id, (currentSession, currentGroup) => {
        if (currentSession.status === 'settled') {
          const error = new Error('This session is already closed');
          error.statusCode = 409;
          throw error;
        }
        const joinInput = {
          uid: req.user?.uid,
          accessToken: getRequestRoomToken(req),
          name: req.body?.name || req.user?.name || 'Guest',
          phone: req.body?.phone,
          avatarColor: getRandomAvatarColor(),
        };
        if (currentGroup) {
          const existingGroupMember = findRoomMember(currentGroup, joinInput);
          if (!existingGroupMember) {
            const error = new Error('Join the linked group before opening this bill session');
            error.statusCode = 403;
            throw error;
          }
          const groupJoin = joinRoom(currentGroup, joinInput);
          if (!Array.isArray(currentSession.members)) currentSession.members = [];
          let sessionMember = currentSession.members?.find((member) => member.id === groupJoin.member.id);
          if (!sessionMember) {
            sessionMember = { ...groupJoin.member, settled: false };
            currentSession.members.push(sessionMember);
          } else {
            syncRoomMember(sessionMember, groupJoin.member);
          }
          joined = { member: sessionMember, accessToken: groupJoin.accessToken, changed: true };
          return { session: currentSession, group: currentGroup };
        }
        joined = joinRoom(currentSession, joinInput);
        return { session: currentSession, group: null };
      });
      if (!mutation || !joined) return res.status(404).json({ error: 'Session not found' });
      if (joined.changed) {
        void trackAnalyticsEvent('participant_joined', {
          userId: req.user?.uid,
          sessionId: mutation.session.id,
          metadata: { memberCount: mutation.session.members.length },
        });
      }
      global.broadcastSessionState(mutation.session.id);
      return res.json({
        success: true,
        memberId: joined.member.id,
        accessToken: joined.accessToken,
        session: publicRoom(mutation.session),
      });
    } catch (err) {
      return sendRouteError(res, err, 'Failed to join session');
    }
  });

  server.post('/api/session/action', authenticateUser, mutationRateLimit, async (req, res) => {
    try {
      const { sessionId, action, payload } = req.body || {};
      const cleanSessionId = security.sanitizeString(sessionId, 100);
      const mutation = await db.transactSessionAndLinkedGroup(cleanSessionId, (session, linkedGroup) => {
        const actor = authorizedRoomMember(req, session);
        if (!actor) {
          const error = new Error('A valid room membership is required');
          error.statusCode = 401;
          throw error;
        }
        if (linkedGroup) {
          const groupActor = authorizedRoomMember(req, linkedGroup);
          if (!groupActor || groupActor.id !== actor.id) {
            const error = new Error('A valid linked-group membership is required');
            error.statusCode = 403;
            throw error;
          }
          if (action === 'SETTLE_ALL' || (action === 'TOGGLE_SETTLED' && payload?.settled !== false)) {
            assertSessionSettlementNotDeferredToGroup(session);
          }
        }
        const actionId = security.sanitizeString(req.body?.actionId || '', 100);
        if (actionId && Array.isArray(session.processedActionIds) && session.processedActionIds.includes(actionId)) {
          return { session, group: linkedGroup, history: null, idempotentReplay: true };
        }
        const updatedSession = processSessionAction(session, action, payload, {
          uid: req.user?.uid,
          memberId: actor.id,
        });
        if (actionId) {
          updatedSession.processedActionIds = [...new Set([...(updatedSession.processedActionIds || []), actionId])].slice(-50);
        }
        if (['ADD_ITEM', 'EDIT_ITEM', 'DELETE_ITEM'].includes(action) && updatedSession.reconciliation) {
          updatedSession.reconciliation = reconcileReceipt(updatedSession);
          updatedSession.assessment = assessReceipt(updatedSession, {
            source: updatedSession.ocr?.source || 'confirmed-scan',
            imageQuality: updatedSession.imageQuality,
            confirmedByUser: Boolean(updatedSession.confirmedByUserAt),
          });
        }
        const linkedBill = linkedGroup?.bills?.find((bill) => bill.id === updatedSession.billId || bill.sessionId === updatedSession.id);
        if (linkedBill) {
          linkedBill.items = updatedSession.items;
          linkedBill.settledMemberIds = (updatedSession.members || [])
            .filter((member) => member.active !== false && member.settled === true)
            .map((member) => member.id);
          linkedBill.tipPercentage = Math.max(0, Number(updatedSession.tipPercentage) || 0);
          linkedBill.amount = amountWithTip(getReceiptPayableTotal(updatedSession), linkedBill.tipPercentage);
          linkedBill.revision = Number(linkedBill.revision || 0) + 1;
          if (updatedSession.reconciliation) {
            linkedBill.reconciliation = updatedSession.reconciliation;
            linkedBill.assessment = updatedSession.assessment;
          }
          if (action === 'SET_PAYER' || updatedSession.payerId) linkedBill.payerId = updatedSession.payerId;
          if (action === 'SETTLE_ALL') {
            linkedBill.status = 'settled';
            linkedBill.settledAt = updatedSession.settledAt;
          }
        }
        const shouldPersistHistory = action === 'SETTLE_ALL';
        return {
          session: updatedSession,
          group: linkedGroup,
          history: shouldPersistHistory ? createSessionHistoryRecord(updatedSession, linkedGroup?.name || '') : null,
        };
      });
      if (!mutation) return res.status(404).json({ error: 'Session not found' });
      const updated = mutation.session;
      const linkedGroup = mutation.group;
      const linkedBill = linkedGroup?.bills?.find((bill) => bill.id === updated.billId || bill.sessionId === updated.id);

      const subtotal = getReceiptPayableTotal(updated);
      if (linkedGroup && linkedBill) global.broadcastGroupState(linkedGroup.id);

      global.broadcastSessionState(updated.id);

      const actionEventMap = {
        TOGGLE_CLAIM: 'item_claim_toggled',
        SPLIT_EVERYONE: 'items_split_everyone',
        ADD_ITEM: 'receipt_corrected',
        EDIT_ITEM: 'receipt_corrected',
        DELETE_ITEM: 'receipt_corrected',
        SET_TIP: 'tip_selected',
        SET_PAYER: 'payer_selected',
        TOGGLE_SETTLED: 'member_settled_toggled',
        SETTLE_ALL: 'session_completed',
      };
      const eventType = actionEventMap[action];
      if (eventType) {
        const actionItem = payload?.itemId ? updated.items.find((item) => item.id === payload.itemId) : null;
        void trackAnalyticsEvent(eventType, {
          userId: req.user?.uid,
          sessionId: updated.id,
          metadata: {
            action,
            amount: Math.round(subtotal * (1 + Number(updated.tipPercentage || 0) / 100) * 100) / 100,
            category: actionItem?.category,
            correctionKind: ['ADD_ITEM', 'EDIT_ITEM', 'DELETE_ITEM'].includes(action) ? action.toLowerCase() : undefined,
            currency: updated.currency,
            durationMs: action === 'SETTLE_ALL' ? Math.max(0, Number(updated.settledAt || Date.now()) - Number(updated.createdAt || Date.now())) : undefined,
            itemCount: updated.items.length,
            memberCount: updated.members.length,
            tipPercentage: updated.tipPercentage || 0,
          },
        });
      }
      return res.json({ success: true, session: publicRoom(updated) });
    } catch (err) {
      void trackAnalyticsEvent('product_error', {
        userId: req.user?.uid,
        sessionId: req.body?.sessionId,
        metadata: {
          route: '/api/session/action', action: req.body?.action,
          httpStatus: err?.statusCode || 500, errorCode: err?.name || 'session_action_error',
        },
      });
      return sendRouteError(res, err, 'Failed to update session');
    }
  });



  // GROUPS API ENDPOINTS

  // 1. Create Group
  server.post('/api/groups', authenticateUser, sessionCreateRateLimit, async (req, res) => {
    try {
      const { name, currency, hostName, hostPhone } = req.body;
      const cleanName = security.sanitizeString(name || 'Trip Group', 40);
      const rawHostName = hostName || (req.user ? req.user.name : 'Host');
      const host = createRoomMember({
        uid: req.user?.uid,
        name: rawHostName,
        phone: hostPhone,
        isHost: true,
        avatarColor: '#A3E635',
      });

      const newGroupId = createEntityId('grp');
      const createdAt = Date.now();
      const newGroup = {
        id: newGroupId,
        code: await db.generateUniqueRoomCode('group', newGroupId),
        name: cleanName,
        currency: security.sanitizeString(currency || 'NIS', 5),
        status: GROUP_STATUS.ACTIVE,
        createdAt,
        updatedAt: createdAt,
        members: [host.member],
        bills: []
      };

      await db.saveGroup(newGroup);

      if (req.user?.uid && typeof db.addGroupToUser === 'function') {
        await db.addGroupToUser(req.user.uid, newGroup.id);
      }

      return res.json({
        success: true,
        groupId: newGroup.id,
        code: newGroup.code,
        hostId: host.member.id,
        memberId: host.member.id,
        accessToken: host.accessToken,
        group: publicGroupWithDebt(newGroup),
      });
    } catch (err) {
      return sendRouteError(res, err, 'Failed to create group');
    }
  });

  // 2. Fetch Group by durable ID or human invite code
  server.get('/api/groups/:idOrCode', authenticateUser, roomLookupRateLimit, async (req, res) => {
    const sanitizedId = security.sanitizeString(req.params.idOrCode, 50);
    const group = await db.getGroup(sanitizedId);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const actor = authorizedRoomMember(req, group);
    return res.json({ group: actor ? publicGroupWithDebt(group) : roomDiscovery(group) });
  });

  server.get('/api/groups/:groupId/payment-target/:memberId', authenticateUser, roomLookupRateLimit, async (req, res) => {
    const groupId = security.sanitizeString(req.params.groupId, 100);
    const memberId = security.sanitizeString(req.params.memberId, 100);
    const group = await db.getGroup(groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const actor = authorizedRoomMember(req, group);
    if (!actor) return res.status(401).json({ error: 'A valid room membership is required' });

    try {
      assertGroupSettlementPaymentPhase(group);
    } catch (error) {
      return res.status(error.statusCode || 409).json({ error: error.message });
    }
    const authorizedTransfer = group.settlement?.transfers?.find((transaction) => (
      transaction.fromId === actor.id
      && transaction.toId === memberId
      && transaction.paid !== true
      && Number(transaction.amount) > 0
    ));
    if (!authorizedTransfer) {
      return res.status(403).json({ error: 'No payment is due from this member to that recipient' });
    }

    const recipient = group.members.find((member) => member.id === memberId && member.active !== false);
    return res.json({
      memberId,
      phone: recipient?.phone || '',
      amount: authorizedTransfer.amount,
    });
  });

  // 3. Join Group by Code
  server.post('/api/groups/join', authenticateUser, roomJoinRateLimit, async (req, res) => {
    try {
      const { groupId, name, phone } = req.body;
      const group = await db.getGroup(groupId);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }

      let joined = null;
      const mutation = await db.transactGroupMembership(group.id, (currentGroup) => {
        const joinInput = {
          uid: req.user?.uid,
          accessToken: getRequestRoomToken(req),
          name: name || req.user?.name || 'Member',
          phone,
          avatarColor: getRandomAvatarColor(),
        };
        const existingMember = findRoomMember(currentGroup, joinInput);
        if (!existingMember) assertGroupActive(currentGroup);
        joined = joinRoom(currentGroup, joinInput);
        return currentGroup;
      });
      if (!mutation || !joined) return res.status(404).json({ error: 'Group not found' });
      if (req.user?.uid && typeof db.addGroupToUser === 'function') {
        await db.addGroupToUser(req.user.uid, mutation.group.id);
      }
      global.broadcastGroupState(mutation.group.id);

      return res.json({
        success: true,
        memberId: joined.member.id,
        accessToken: joined.accessToken,
        group: publicGroupWithDebt(mutation.group),
      });
    } catch (err) {
      return sendRouteError(res, err, 'Failed to join group');
    }
  });

  server.post('/api/groups/:groupId/leave', authenticateUser, async (req, res) => {
    try {
      const group = await db.getGroup(security.sanitizeString(req.params.groupId, 100));
      if (!group) return res.status(404).json({ error: 'Group not found' });
      const actor = authorizedRoomMember(req, group);
      const targetMemberId = actor?.id;
      if (!targetMemberId) return res.status(401).json({ error: 'A valid group membership is required' });
      assertGroupActive(group);
      
      const updated = await db.leaveGroup(group.id, targetMemberId);
      if (updated) {
        global.broadcastGroupState(group.id);
      }

      return res.json({ success: true, group: updated ? publicGroupWithDebt(updated) : null });
    } catch (err) {
      return sendRouteError(res, err, 'Failed to leave group');
    }
  });

  server.delete('/api/groups/:groupId', authenticateUser, async (req, res) => {
    try {
      const group = await db.getGroup(security.sanitizeString(req.params.groupId, 100));
      if (!group) return res.status(404).json({ error: 'Group not found' });
      const actor = authorizedRoomMember(req, group);
      if (!actor) return res.status(401).json({ error: 'A valid group membership is required' });
      if (!actor.isHost) return res.status(403).json({ error: 'Only the group host can delete this group' });
      if (getGroupStatus(group) === GROUP_STATUS.SETTLING) {
        return res.status(409).json({ error: 'Finish or reopen the group settlement before deleting this group' });
      }
      await db.deleteGroup(group.id, actor.id);
      sendToRoom('group', group.id, { type: 'GROUP_DELETED', groupId: group.id }, group);
      return res.json({ success: true });
    } catch (err) {
      return sendRouteError(res, err, 'Failed to delete group');
    }
  });

  // 4. Add or Edit Bill in Group
  server.post('/api/groups/bill', authenticateUser, mutationRateLimit, async (req, res) => {
    try {
      const { groupId, bill } = req.body;
      const group = await db.getGroup(security.sanitizeString(groupId, 100));
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
      const actor = authorizedRoomMember(req, group);
      if (!actor) return res.status(401).json({ error: 'A valid group membership is required' });
      assertGroupActive(group);
      if (!bill || typeof bill !== 'object' || Array.isArray(bill)) {
        throw new ValidationError('A bill is required');
      }
      const billCurrency = security.sanitizeString(bill.currency || group.currency || 'NIS', 5).toUpperCase();
      const groupCurrency = security.sanitizeString(group.currency || 'NIS', 5).toUpperCase();
      if (billCurrency !== groupCurrency) {
        throw new ValidationError(`This group uses ${groupCurrency}. Convert the bill before adding a ${billCurrency} expense.`);
      }

      if (!Array.isArray(group.bills)) group.bills = [];

      const cleanTitle = security.sanitizeString(bill.title || 'Group Expense', 50);
      const groupHost = group.members.find((member) => member.isHost && member.active !== false)
        || group.members.find((member) => member.active !== false);
      const cleanPayerId = normalizeGroupPayerId(bill.payerId || groupHost?.id);
      if (!isValidPayerId(group, cleanPayerId)) {
        throw new ValidationError('The selected payer is not an active group member');
      }
      const billDate = security.sanitizeString(bill.date || new Date().toISOString().split('T')[0], 20);

      const memberIds = new Set(
        group.members.filter((member) => member.active !== false).map((member) => member.id)
      );
      const cleanItems = validateItems(Array.isArray(bill.items) ? bill.items : [], { allowEmpty: true })
        .map((item) => ({
          ...item,
          id: item.id || createEntityId('item'),
          claimedBy: item.claimedBy.filter((memberId) => memberIds.has(memberId)),
        }));

      const receiptEvidence = bill.receipt && typeof bill.receipt === 'object' && !Array.isArray(bill.receipt)
        ? bill.receipt
        : {};
      const requestedScanId = normalizeScanId(receiptEvidence.scanId || bill.scanId);
      const sourceSessionId = security.sanitizeString(bill.sourceSessionId || '', 100);
      const stableBillId = requestedScanId
        ? createStableScanEntityId('bill_scan', group.id, requestedScanId)
        : (sourceSessionId ? createStableScanEntityId('bill_session', group.id, sourceSessionId) : '');
      const billId = stableBillId || bill.id || createEntityId('bill');
      const existingIdx = group.bills.findIndex((candidate) => candidate.id === billId);
      const existingBill = existingIdx > -1 ? group.bills[existingIdx] : null;
      const expectedRevision = existingBill && bill.expectedRevision !== undefined && bill.expectedRevision !== null
        ? Math.max(0, Math.round(Number(bill.expectedRevision) || 0))
        : null;
      const existingBillStatus = existingBill ? getBillStatus(existingBill) : BILL_STATUS.ACTIVE;
      if (existingBill && existingBillStatus !== BILL_STATUS.ACTIVE) {
        return res.status(409).json({
          error: existingBillStatus === BILL_STATUS.FINALIZED
            ? 'A finalized bill cannot be edited until it is reopened'
            : 'A settled bill cannot be edited'
        });
      }
      if (existingBill && !actor.isHost && existingBill.createdByMemberId !== actor.id) {
        return res.status(403).json({ error: 'Only the bill creator or group host can edit this bill' });
      }
      let scanId = requestedScanId || normalizeScanId(existingBill?.scanId);
      let confirmedByUser = receiptEvidence.confirmedByUser === true
        || bill.confirmedByUser === true
        || Boolean(existingBill?.confirmedByUserAt);
      let receiptFields = {
        receiptTotal: optionalReceiptAmount(receiptEvidence.receiptTotal) ?? optionalReceiptAmount(existingBill?.receiptTotal),
        subtotal: optionalReceiptAmount(receiptEvidence.subtotal) ?? optionalReceiptAmount(existingBill?.subtotal),
        tax: optionalReceiptAmount(receiptEvidence.tax) ?? optionalReceiptAmount(existingBill?.tax),
        service: optionalReceiptAmount(receiptEvidence.service) ?? optionalReceiptAmount(existingBill?.service),
        discount: optionalReceiptAmount(Math.abs(Number(receiptEvidence.discount))) ?? optionalReceiptAmount(existingBill?.discount),
      };
      let ocrEvidence = sanitizeOcrEvidence(receiptEvidence.ocr) || sanitizeOcrEvidence(existingBill?.ocr);
      let receiptImageQuality = sanitizeImageQuality(receiptEvidence.imageQuality)
        || sanitizeImageQuality(existingBill?.imageQuality);
      let hasReceiptEvidence = Boolean(scanId || ocrEvidence || Object.values(receiptFields).some((value) => value !== null));
      if (hasReceiptEvidence && !confirmedByUser) {
        return res.status(409).json({ error: 'Please review and confirm the scanned receipt before adding it to the group.' });
      }
      let receiptReconciliation = hasReceiptEvidence
        ? reconcileReceipt({ ...receiptFields, items: cleanItems })
        : null;
      let receiptAssessment = hasReceiptEvidence
        ? assessReceipt({
            ...receiptFields,
            items: cleanItems,
            reconciliation: receiptReconciliation,
            ocr: ocrEvidence,
          }, {
            source: ocrEvidence?.source || 'confirmed-scan',
            imageQuality: receiptImageQuality,
            confirmedByUser,
          })
        : null;
      const sourceSession = sourceSessionId ? await db.getSession(sourceSessionId) : null;
      if (sourceSessionId) {
        const sourceMember = sourceSession ? findRoomMember(sourceSession, {
          uid: req.user?.uid,
          accessToken: typeof bill.sourceSessionToken === 'string' ? bill.sourceSessionToken : '',
        }) : null;
        if (!sourceSession || !sourceMember?.isHost) {
          return res.status(403).json({ error: 'Only the source session host can attach this bill' });
        }
        if (sourceSession.status === 'settled') {
          return res.status(409).json({ error: 'A settled session cannot be attached or edited' });
        }
        if (sourceSession.groupId && (
          sourceSession.groupId !== group.id
          || (sourceSession.billId && sourceSession.billId !== billId)
        )) {
          return res.status(409).json({ error: 'This session is already attached to another group bill' });
        }
      }
      if (sourceSession && !hasReceiptEvidence) {
        scanId = scanId || normalizeScanId(sourceSession.scanId);
        confirmedByUser = confirmedByUser || Boolean(sourceSession.confirmedByUserAt);
        receiptFields = {
          receiptTotal: optionalReceiptAmount(sourceSession.receiptTotal),
          subtotal: optionalReceiptAmount(sourceSession.subtotal),
          tax: optionalReceiptAmount(sourceSession.tax),
          service: optionalReceiptAmount(sourceSession.service),
          discount: optionalReceiptAmount(sourceSession.discount),
        };
        ocrEvidence = sanitizeOcrEvidence(sourceSession.ocr);
        receiptImageQuality = sanitizeImageQuality(sourceSession.imageQuality);
        hasReceiptEvidence = Boolean(ocrEvidence || receiptFields.receiptTotal !== null);
        receiptReconciliation = hasReceiptEvidence
          ? reconcileReceipt({ ...receiptFields, items: cleanItems })
          : null;
        receiptAssessment = hasReceiptEvidence
          ? assessReceipt({ ...receiptFields, items: cleanItems, reconciliation: receiptReconciliation, ocr: ocrEvidence }, {
              source: ocrEvidence?.source || 'confirmed-scan',
              imageQuality: receiptImageQuality,
              confirmedByUser: Boolean(sourceSession.confirmedByUserAt),
            })
          : null;
      }
      if (hasReceiptEvidence && !confirmedByUser) {
        return res.status(409).json({ error: 'Please review and confirm the scanned receipt before adding it to the group.' });
      }
      const sessionId = sourceSession?.id || existingBill?.sessionId || ('sess_g_' + billId);
      const itemsTotal = cleanItems.reduce((sum, item) => sum + item.price, 0);
      const requestedAmount = security.sanitizePrice(bill.amount);
      const cleanAmount = hasReceiptEvidence
        ? getReceiptPayableTotal({ ...receiptFields, items: cleanItems, reconciliation: receiptReconciliation })
        : (itemsTotal > 0 ? itemsTotal : requestedAmount);
      if (cleanAmount <= 0) throw new ValidationError('Bill amount must be greater than zero');
      const billTipPercentage = Math.max(0, Number(existingBill?.tipPercentage || sourceSession?.tipPercentage) || 0);
      const proposedBillForDigest = {
        title: cleanTitle,
        date: billDate,
        currency: groupCurrency,
        payerId: cleanPayerId,
        tipPercentage: billTipPercentage,
        items: cleanItems,
        ...receiptFields,
      };
      const contentDigest = groupBillContentDigest(proposedBillForDigest);
      if (existingBill && expectedRevision === null) {
        const matchesOriginalRequest = existingBill.contentDigest
          ? existingBill.contentDigest === contentDigest
          : groupBillContentDigest(existingBill) === contentDigest;
        if (requestedScanId && matchesOriginalRequest) {
          return res.json({
            success: true,
            idempotentReplay: true,
            sessionId: existingBill.sessionId,
            billId: existingBill.id,
            group: publicGroupWithDebt(group),
          });
        }
        return res.status(409).json({ error: 'This bill changed while it was being edited. Reopen it and apply your changes again.' });
      }
      const newBillRecord = {
        id: billId,
        sessionId,
        title: cleanTitle,
        date: billDate,
        amount: amountWithTip(cleanAmount, billTipPercentage),
        tipPercentage: billTipPercentage,
        revision: Number(existingBill?.revision || 0) + 1,
        contentDigest,
        payerId: cleanPayerId,
        items: cleanItems,
        currency: groupCurrency,
        ...receiptFields,
        reconciliation: receiptReconciliation,
        assessment: receiptAssessment,
        ocr: ocrEvidence,
        imageQuality: receiptImageQuality,
        scanId: scanId || undefined,
        confirmedByUserAt: confirmedByUser ? (existingBill?.confirmedByUserAt || Date.now()) : undefined,
        createdByMemberId: existingBill?.createdByMemberId || actor.id,
        createdAt: existingBill?.createdAt || Date.now(),
        status: existingBill?.status || 'active',
      };

      if (existingIdx > -1) {
        group.bills[existingIdx] = newBillRecord;
      } else {
        group.bills.unshift(newBillRecord);
      }

      const existingSession = await db.getSession(sessionId);
      const liveSession = {
        id: sessionId,
        groupId: group.id,
        billId,
        payerId: cleanPayerId,
        code: existingSession?.code || await db.generateUniqueRoomCode('session', sessionId),
        storeName: cleanTitle,
        date: billDate,
        currency: group.currency || 'NIS',
        hostPhone: groupHost?.phone || '',
        status: existingSession?.status || 'active',
        tipPercentage: billTipPercentage,
        members: group.members.map(m => ({
          id: m.id,
          name: m.name,
          phone: m.phone || '',
          isHost: m.isHost || false,
          settled: Boolean(existingSession?.members?.find((member) => member.id === m.id)?.settled),
          avatarColor: m.avatarColor || '#A3E635',
          accessTokenHash: m.accessTokenHash,
          active: m.active !== false,
        })),
        items: cleanItems,
        ...receiptFields,
        reconciliation: receiptReconciliation,
        assessment: receiptAssessment,
        ocr: ocrEvidence,
        imageQuality: receiptImageQuality,
        scanId: scanId || undefined,
        confirmedByUserAt: confirmedByUser ? (existingSession?.confirmedByUserAt || Date.now()) : undefined,
        createdAt: existingSession?.createdAt || Date.now(),
      };
      const persisted = typeof db.saveGroupBillAndSession === 'function'
        ? await db.saveGroupBillAndSession(group.id, newBillRecord, liveSession, actor.id, expectedRevision)
        : await db.saveGroupAndSession(group, liveSession);
      if (!persisted) return res.status(404).json({ error: 'Group not found' });
      const persistedGroup = persisted.group || group;

      if (global.broadcastGroupState) {
        global.broadcastGroupState(group.id);
      }

      return res.json({
        success: true,
        sessionId,
        billId,
        group: publicGroupWithDebt(persistedGroup),
        idempotentReplay: Boolean(persisted.idempotentReplay),
      });
    } catch (err) {
      return sendRouteError(res, err, 'Failed to save group bill');
    }
  });

  server.post('/api/groups/bill/action', authenticateUser, mutationRateLimit, async (req, res) => {
    try {
      const groupId = security.sanitizeString(req.body?.groupId, 100);
      const requestedAction = security.sanitizeString(req.body?.action || req.body?.type || '', 50);
      const billId = security.sanitizeString(req.body?.payload?.billId, 100);
      const mutation = await db.transactGroupAndLinkedSession(
        groupId,
        (group) => group.bills?.find((candidate) => candidate.id === billId)?.sessionId || '',
        (group, liveSession) => {
          const actor = authorizedRoomMember(req, group);
          if (!actor) {
            const error = new Error('A valid group membership is required');
            error.statusCode = 401;
            throw error;
          }
          const actionId = security.sanitizeString(req.body?.actionId || '', 100);
          if (actionId && Array.isArray(group.processedActionIds) && group.processedActionIds.includes(actionId)) {
            return { group, session: liveSession, idempotentReplay: true };
          }
          if (liveSession?.members?.some((member) => member.active !== false && member.settled === true)) {
            const error = new Error('Payment allocations are locked while a member is marked paid');
            error.statusCode = 409;
            throw error;
          }
          const previousBill = group.bills?.find((candidate) => candidate.id === billId);
          if (requestedAction === 'FINALIZE_BILL' && Array.isArray(previousBill?.settledMemberIds) && previousBill.settledMemberIds.length > 0) {
            const error = new Error('Reopen legacy paid shares before finishing this split');
            error.statusCode = 409;
            throw error;
          }
          const previousRevision = Number(previousBill?.revision || 0);
          const previousStatus = previousBill ? getBillStatus(previousBill) : null;
          const updatedGroup = processGroupBillAction(group, requestedAction, req.body?.payload, actor);
          if (actionId) {
            updatedGroup.processedActionIds = [...new Set([...(updatedGroup.processedActionIds || []), actionId])].slice(-50);
          }
          const bill = updatedGroup.bills.find((candidate) => candidate.id === billId);
          const isIdempotentFinalize = requestedAction === 'FINALIZE_BILL'
            && previousStatus === BILL_STATUS.FINALIZED;
          const isIdempotentReopen = requestedAction === 'REOPEN_BILL'
            && previousStatus === BILL_STATUS.ACTIVE;
          if (bill && !isIdempotentFinalize && !isIdempotentReopen) bill.revision = previousRevision + 1;
          if (bill?.reconciliation) {
            bill.reconciliation = reconcileReceipt(bill);
            bill.assessment = assessReceipt(bill, {
              source: bill.ocr?.source || 'confirmed-scan',
              imageQuality: bill.imageQuality,
              confirmedByUser: Boolean(bill.confirmedByUserAt),
            });
          }
          if (liveSession && bill) {
            liveSession.items = bill.items;
            liveSession.payerId = bill.payerId;
            if (bill.reconciliation) {
              liveSession.reconciliation = bill.reconciliation;
              liveSession.assessment = bill.assessment;
            }
            if (requestedAction === 'FINALIZE_BILL' && getBillStatus(bill) === BILL_STATUS.FINALIZED) {
              liveSession.status = 'settled';
              liveSession.settledAt = bill.finalizedAt || Date.now();
              liveSession.groupSettlementDeferred = true;
              (liveSession.members || []).forEach((member) => { member.settled = false; });
            }
            if (requestedAction === 'REOPEN_BILL' && getBillStatus(bill) === BILL_STATUS.ACTIVE) {
              liveSession.status = 'active';
              delete liveSession.settledAt;
              delete liveSession.groupSettlementDeferred;
              (liveSession.members || []).forEach((member) => { member.settled = false; });
            }
          }
          return { group: updatedGroup, session: liveSession };
        },
      );
      if (!mutation) return res.status(404).json({ error: 'Group not found' });
      const updated = mutation.group;
      const liveSession = mutation.session;
      if (liveSession) global.broadcastSessionState(liveSession.id);
      global.broadcastGroupState(updated.id);
      return res.json({ success: true, group: publicGroupWithDebt(updated) });
    } catch (err) {
      return sendRouteError(res, err, 'Failed to update group bill');
    }
  });

  // Real-Time Currency Exchange Rates API
  let cachedRates = null;
  let lastRatesFetchTime = 0;
  let activeRatesFetch = null;

  async function fetchLiveExchangeRates() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const apiRes = await fetch('https://open.er-api.com/v6/latest/USD', { signal: controller.signal });
      if (!apiRes.ok) return null;
      const data = await apiRes.json();
      if (!data || !data.rates) return null;
      const usdToNis = data.rates.ILS || 3.65;
      return {
        ...data.rates,
        USD: 1.0,
        NIS: usdToNis,
        ILS: usdToNis,
        EUR: data.rates.EUR || 0.92,
        GBP: data.rates.GBP || 0.78,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  server.get('/api/exchange-rates', async (req, res) => {
    try {
      const now = Date.now();
      if (cachedRates && now - lastRatesFetchTime < 30 * 60 * 1000) {
        return res.json({ success: true, rates: cachedRates, source: 'cached' });
      }

      if (!activeRatesFetch) {
        activeRatesFetch = fetchLiveExchangeRates().finally(() => {
          activeRatesFetch = null;
        });
      }
      const liveRates = await activeRatesFetch;
      if (liveRates) {
        cachedRates = liveRates;
        lastRatesFetchTime = Date.now();
        console.log(`⚡ Live currency exchange rates updated: 1 USD = ${cachedRates.NIS.toFixed(2)} NIS, 1 GBP = ${(cachedRates.NIS / cachedRates.GBP).toFixed(2)} NIS, 1 EUR = ${(cachedRates.NIS / cachedRates.EUR).toFixed(2)} NIS`);
        return res.json({ success: true, rates: cachedRates, source: 'live' });
      }
    } catch (err) {
      console.error('Error fetching real-time exchange rates, using fallback:', err.message);
    }

    const fallbackRates = {
      USD: 1.0,
      NIS: 3.65,
      ILS: 3.65,
      EUR: 0.92,
      GBP: 0.78
    };
    return res.json({ success: true, rates: cachedRates || fallbackRates, source: 'fallback' });
  });

  function isUserMember(memberList, userName, phone, userId) {
    if (!Array.isArray(memberList) || memberList.length === 0) return false;
    const cleanName = (userName || '').trim().toLowerCase();
    const cleanPhone = (phone || '').replace(/\D/g, '');
    if (userId) {
      const match = memberList.some((member) => (member.id === userId || member.userId === userId || member.uid === userId) && member.active !== false);
      return match;
    }
    return memberList.some((member) => {
      if (member.active === false) return false;
      if (cleanName && (member.name || '').trim().toLowerCase() === cleanName) return true;
      if (cleanPhone && (member.phone || '').replace(/\D/g, '') === cleanPhone) return true;
      return false;
    });
  }

  function getUserMember(memberList, userName, phone, userId) {
    if (!Array.isArray(memberList) || memberList.length === 0) return null;
    const cleanName = (userName || '').trim().toLowerCase();
    const cleanPhone = (phone || '').replace(/\D/g, '');
    if (userId) {
      const match = memberList.find((member) => (member.id === userId || member.userId === userId || member.uid === userId) && member.active !== false);
      return match || null;
    }
    return memberList.find((member) => {
      if (member.active === false) return false;
      if (cleanName && (member.name || '').trim().toLowerCase() === cleanName) return true;
      if (cleanPhone && (member.phone || '').replace(/\D/g, '') === cleanPhone) return true;
      return false;
    }) || null;
  }

  function calculateUserShareForSession(itemsList, memberList, userId, userName, phone, tipPercentage = 0, payableTotal = null) {
    const items = Array.isArray(itemsList) ? itemsList : [];
    const members = Array.isArray(memberList) ? memberList : [];
    if (items.length === 0 || members.length === 0) return 0;

    const memberIds = members.filter((member) => member?.id && member.active !== false).map((member) => member.id);
    const targetMember = userId ? members.find((member) => member.id === userId && member.active !== false) : null;
    if (!targetMember) return 0;
    const validMemberIds = new Set(memberIds);
    const itemWeights = items.map((item) => toCents(item.price));
    const itemTotalCents = itemWeights.reduce((sum, cents) => sum + cents, 0);
    const payableCents = toCents(payableTotal) || itemTotalCents;
    const allocatedItemCents = allocateCentsProportionally(payableCents, itemWeights);
    const sharesByMember = new Map(memberIds.map((memberId) => [memberId, 0]));
    items.forEach((item, index) => {
      const claimantIds = [...new Set(
        (Array.isArray(item.claimedBy) ? item.claimedBy : []).filter((id) => validMemberIds.has(id))
      )];
      splitCents(allocatedItemCents[index], claimantIds).forEach(({ memberId, cents }) => {
        sharesByMember.set(memberId, (sharesByMember.get(memberId) || 0) + cents);
      });
    });
    const tippedShares = allocateTipAdjustedCents(
      memberIds.map((memberId) => sharesByMember.get(memberId) || 0),
      tipPercentage,
    );
    const targetIndex = memberIds.indexOf(targetMember.id);
    return targetIndex >= 0 ? tippedShares[targetIndex] / 100 : 0;
  }

  // POST /api/user/sync - Synchronize/register user account & settings
  server.post('/api/user/sync', authenticateUser, async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized: Authentication required' });
      }

      const { uid, name, picture } = req.user;
      const { username, phone, settings } = validateUserSyncBody(req.body || {});
      const finalName = security.sanitizeName(username || name || 'User', 'User');

      const user = await db.findOrCreateUser(uid, finalName, phone, settings || {});

      // Sync avatar URL from Google if available
      if (picture && user.avatarUrl !== picture) {
        user.avatarUrl = picture;
        await db.saveUser(user, uid);
      }

      void trackAnalyticsEvent('user_synced', {
        userId: uid,
        metadata: { route: '/api/user/sync' },
      });

      return res.json({ success: true, user: publicUserProfile(user) });
    } catch (err) {
      return sendRouteError(res, err, 'Failed to sync user');
    }
  });

  // GET /api/user/groups - Get active groups for a specific user
  server.get('/api/user/groups', authenticateUser, accountReadRateLimit, accountReadAdmission, async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      const uid = req.user.uid;
      const user = await db.getUserByUid(uid);
      const userName = user ? user.username : '';
      const phone = user ? user.phone : '';
      const requestedScope = security.sanitizeString(String(req.query?.scope || 'active'), 10).toLowerCase();
      const scope = ['active', 'closed', 'all'].includes(requestedScope) ? requestedScope : 'active';

      const cursor = Math.max(0, Math.min(200, Math.round(Number(req.query?.cursor) || 0)));
      const orderedGroupIds = [...(Array.isArray(user?.groups) ? user.groups : [])].reverse().slice(0, 200);
      const groupIds = orderedGroupIds.slice(cursor, cursor + 20);
      const userGroups = (await Promise.all(groupIds.map((groupId) => db.getGroup(groupId))))
        .filter((group) => (
          group
          && isUserMember(group.members, userName, phone, uid)
          && groupMatchesScope(group, scope)
        ));
      const nextCursor = cursor + groupIds.length < orderedGroupIds.length
        ? cursor + groupIds.length
        : null;

      return res.json({
        success: true,
        groups: userGroups.map(summarizeGroup),
        scope,
        nextCursor,
      });
    } catch (err) {
      console.error('Error fetching user groups:', err);
      return res.status(500).json({ error: 'Failed to fetch user groups' });
    }
  });

  // GET /api/history - Get user payments (strictly isolated by user identity)
  server.get('/api/history', authenticateUser, accountReadRateLimit, accountReadAdmission, async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      const uid = req.user.uid;
      const user = await db.getUserByUid(uid);
      const userName = user ? user.username : '';
      const phone = user ? user.phone : '';
      const hiddenHistoryIds = new Set(Array.isArray(user?.hiddenHistoryIds) ? user.hiddenHistoryIds : []);
      const cursorState = decodeHistoryCursor(req.query?.cursor);
      if (!cursorState) return res.status(400).json({ error: 'Invalid history cursor' });
      if (cursorState.emitted >= 200) return res.json({ success: true, history: [], nextCursor: null });

      const summarizeHistory = (histItem) => {
        if (!histItem?.id || hiddenHistoryIds.has(histItem.id)) return null;
        const effectiveMembers = Array.isArray(histItem.members) ? histItem.members : [];
        const effectiveItems = Array.isArray(histItem.items) ? histItem.items : [];
        if (!isUserMember(effectiveMembers, userName, phone, uid)) return null;

        let userShare = typeof histItem.totalAmount === 'number'
          ? histItem.totalAmount
          : parseFloat(histItem.totalAmount) || 0;
        const userMember = getUserMember(effectiveMembers, userName, phone, uid);
        if (effectiveItems.length > 0 && userMember) {
          userShare = calculateUserShareForSession(
            effectiveItems,
            effectiveMembers,
            userMember.id,
            userName,
            phone,
            histItem.tipPercentage || 0,
            optionalReceiptAmount(histItem.payableSubtotal),
          );
        } else if (effectiveMembers.length > 0) {
          userShare /= effectiveMembers.length;
        }

        return {
          id: histItem.id,
          storeName: histItem.storeName || 'Bill Session',
          date: histItem.date || new Date().toISOString().split('T')[0],
          currency: histItem.currency || 'NIS',
          totalAmount: typeof histItem.totalAmount === 'number'
            ? histItem.totalAmount
            : parseFloat(histItem.totalAmount) || 0,
          userShare: Math.round(userShare * 100) / 100,
          membersCount: effectiveMembers.length || histItem.membersCount || 1,
          createdAt: histItem.createdAt || 0,
          settledAt: histItem.settledAt || histItem.createdAt || 0,
          status: 'settled',
          ...(histItem.groupId ? {
            isGroupBill: true,
            groupId: histItem.groupId,
            ...(histItem.groupName ? { groupName: histItem.groupName } : {}),
          } : {}),
        };
      };

      const pageLimit = Math.min(20, 200 - cursorState.emitted);
      const page = [];
      let source = cursorState.source;
      let offset = cursorState.offset;
      let hasMore = true;

      while (page.length < pageLimit && hasMore) {
        const remaining = pageLimit - page.length;
        if (source === 'canonical') {
          const canonicalRemaining = Math.max(0, 200 - offset);
          if (canonicalRemaining === 0) {
            source = 'legacy';
            offset = 0;
            continue;
          }
          const probeLimit = Math.min(remaining + 1, canonicalRemaining);
          let canonicalPage;
          if (typeof db.getHistoryPageForUser === 'function') {
            canonicalPage = await db.getHistoryPageForUser(uid, probeLimit, offset);
          } else {
            const slots = await db.getHistoryForUser(uid, probeLimit, offset);
            canonicalPage = { slots, rawCount: slots.length };
          }
          const slots = Array.isArray(canonicalPage?.slots) ? canonicalPage.slots : [];
          const rawCount = Number.isInteger(canonicalPage?.rawCount) ? canonicalPage.rawCount : slots.length;
          const consumed = Math.min(remaining, rawCount);
          for (const entry of slots.slice(0, consumed)) {
            const summary = summarizeHistory(entry);
            if (summary) page.push(summary);
          }
          offset += consumed;
          if (rawCount > consumed) break;
          source = 'legacy';
          offset = 0;
          continue;
        }

        const legacyHistory = [...(Array.isArray(user?.bills) ? user.bills : [])]
          .filter((entry, index, entries) => entry?.id && entries.findIndex((candidate) => candidate?.id === entry.id) === index)
          .sort((first, second) => Number(second.settledAt || second.createdAt || 0) - Number(first.settledAt || first.createdAt || 0));
        const legacyLimit = Math.min(200, legacyHistory.length);
        while (page.length < pageLimit && offset < legacyLimit) {
          const batchSize = Math.min(Math.max((pageLimit - page.length) * 2, 20), legacyLimit - offset);
          const candidates = legacyHistory.slice(offset, offset + batchSize);
          const indexedIds = typeof db.getResolvableHistoryPointerIds === 'function'
            ? await db.getResolvableHistoryPointerIds(uid, candidates.map((entry) => entry.id))
            : [];
          const indexedIdSet = new Set(indexedIds);
          for (const entry of candidates) {
            offset += 1;
            if (indexedIdSet.has(entry.id)) continue;
            const summary = summarizeHistory(entry);
            if (summary) page.push(summary);
            if (page.length >= pageLimit) break;
          }
        }
        hasMore = offset < legacyLimit;
      }

      const emitted = cursorState.emitted + page.length;
      const nextCursor = hasMore && emitted < 200
        ? encodeHistoryCursor(source, offset, emitted)
        : null;
      return res.json({ success: true, history: page, nextCursor });
    } catch (err) {
      console.error('Error fetching history:', err);
      return res.status(500).json({ error: 'Failed to fetch history' });
    }
  });

  server.delete('/api/history/:id', authenticateUser, async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      const id = security.sanitizeString(req.params.id, 100);
      const user = await db.hideHistoryForUser(req.user.uid, id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to delete history' });
    }
  });

  // 5. Delete Bill from Group
  server.delete('/api/groups/bill/:groupId/:billId', authenticateUser, async (req, res) => {
    try {
      const groupId = security.sanitizeString(req.params.groupId, 50);
      const billId = security.sanitizeString(req.params.billId, 50);
      const existingGroup = await db.getGroup(groupId);
      if (!existingGroup) return res.status(404).json({ error: 'Group not found' });
      const actor = authorizedRoomMember(req, existingGroup);
      if (!actor) return res.status(401).json({ error: 'A valid group membership is required' });
      assertGroupActive(existingGroup);
      const bill = existingGroup.bills?.find((candidate) => candidate.id === billId);
      if (!bill) return res.status(404).json({ error: 'Bill not found' });
      const billStatus = getBillStatus(bill);
      if (billStatus !== BILL_STATUS.ACTIVE) {
        return res.status(409).json({
          error: billStatus === BILL_STATUS.FINALIZED
            ? 'A finalized bill cannot be deleted until it is reopened'
            : 'A settled bill cannot be deleted'
        });
      }
      if (!actor.isHost && bill.createdByMemberId !== actor.id) {
        return res.status(403).json({ error: 'Only the bill creator or group host can delete this bill' });
      }

      const group = await db.deleteGroupBill(groupId, billId, actor.id);
      if (!group) {
        return res.status(404).json({ error: 'Group or bill not found' });
      }
      if (global.broadcastGroupState) {
        global.broadcastGroupState(group.id);
      }

      return res.json({
        success: true,
        group: publicGroupWithDebt(group),
      });
    } catch (err) {
      return sendRouteError(res, err, 'Failed to delete group bill');
    }
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws) => {
    ws.subscriptions = new Set();
    ws.roomAuthorizations = new Map();
    ws.isAlive = true;
    ws.messageWindowStartedAt = Date.now();
    ws.messageCount = 0;
    ws.messageInFlight = false;
    ws.subscriptionDeadline = setTimeout(() => {
      if (ws.subscriptions.size === 0) {
        ws.close(1008, 'Subscription required');
        const forcedClose = setTimeout(() => {
          if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
        }, 250);
        forcedClose.unref?.();
      }
    }, wsSubscriptionTimeoutMs);
    ws.subscriptionDeadline.unref?.();
    ws.on('pong', () => { ws.isAlive = true; });
    ws.once('close', () => {
      clearTimeout(ws.subscriptionDeadline);
      const clientIp = ws.clientIp || 'unknown';
      const remaining = Math.max(0, (wsConnectionsByIp.get(clientIp) || 1) - 1);
      if (remaining) wsConnectionsByIp.set(clientIp, remaining);
      else wsConnectionsByIp.delete(clientIp);
    });
    ws.on('error', (err) => {
      console.warn('⚠️ WebSocket client connection error:', err.message);
    });

    ws.on('message', async (message) => {
      const now = Date.now();
      if (now - ws.messageWindowStartedAt >= 60_000) {
        ws.messageWindowStartedAt = now;
        ws.messageCount = 0;
      }
      ws.messageCount += 1;
      if (ws.messageCount > 20) {
        ws.close(1008, 'Message rate exceeded');
        return;
      }
      if (ws.messageInFlight) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Wait for the previous subscription request' }));
        return;
      }
      ws.messageInFlight = true;
      try {
        if (message.length > 10_000) {
          ws.close(1009, 'Message too large');
          return;
        }
        const data = JSON.parse(message.toString());
        const { type, sessionId, groupId, accessToken } = data;
        if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 200 || !/^[a-z0-9_\-]+$/i.test(accessToken)) {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid subscription credentials' }));
          return;
        }
        if (ws.subscriptions.size >= 4) {
          ws.close(1008, 'Subscription limit exceeded');
          return;
        }

        if (type === 'SUBSCRIBE_GROUP' && groupId) {
          const sanitizedId = security.sanitizeString(groupId, 100);
          if (!security.isValidGroupId(sanitizedId)) {
            ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid group subscription' }));
            return;
          }
          const group = await db.getGroup(sanitizedId);
          const member = group ? findRoomMember(group, { accessToken }) : null;
          if (!group || !member) {
            ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid group subscription' }));
            return;
          }
          const authorization = { memberId: member.id, tokenHash: hashAccessToken(accessToken) };
          subscribeClient(ws, 'group', group.id, authorization);
          if (group.code) subscribeClient(ws, 'group', group.code, authorization);
          clearTimeout(ws.subscriptionDeadline);
          ws.send(JSON.stringify({ type: 'GROUP_UPDATE', group: publicGroupWithDebt(group) }));
          return;
        }

        if (type === 'SUBSCRIBE' && sessionId) {
          const sanitizedId = security.sanitizeString(sessionId, 100);
          if (!security.isValidSessionId(sanitizedId)) {
            ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid session subscription' }));
            return;
          }
          const session = await db.getSession(sanitizedId);
          const member = session ? findRoomMember(session, { accessToken }) : null;
          if (!session || !member) {
            ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid session subscription' }));
            return;
          }
          const authorization = { memberId: member.id, tokenHash: hashAccessToken(accessToken) };
          subscribeClient(ws, 'session', session.id, authorization);
          if (session.code) subscribeClient(ws, 'session', session.code, authorization);
          clearTimeout(ws.subscriptionDeadline);
          ws.send(JSON.stringify({ type: 'SESSION_UPDATE', session: publicRoom(session) }));
          return;
        }

        if (type === 'ACTION') {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'Actions must use the authenticated API' }));
        }

      } catch (err) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid WebSocket message' }));
      } finally {
        ws.messageInFlight = false;
      }
    });
  });

  server.get('/api/network-ip', (req, res) => {
    if (process.env.NODE_ENV === 'production' && process.env.ENABLE_NETWORK_IP_ENDPOINT !== 'true') {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ ip: getLocalNetworkIp(), port: PORT });
  });

  server.use(express.static(path.join(__dirname, 'public')));

  server.all('*', (req, res) => {
    const parsedUrl = require('url').parse(req.url, true);
    return handle(req, res, parsedUrl);
  });

  httpServer.listen(PORT, '0.0.0.0', (err) => {
    if (err) throw err;
    const localIp = getLocalNetworkIp();
    console.log(`> 🚀 BillSplit Unified Server ready:`);
    console.log(`  - Local PC: http://localhost:${PORT}`);
    console.log(`  - Phone/Wi-Fi: http://${localIp}:${PORT}`);
    console.log(`> ⚡ WebSockets running on ws://${localIp}:${PORT}`);
  });
}).catch((err) => {
  console.error('❌ Failed to prepare Next.js app:', err);
  process.exit(1);
});

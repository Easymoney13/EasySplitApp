const { createAccessToken, createEntityId, hashAccessToken, tokenMatches } = require('./ids');
const security = require('./security');
const { normalizeIsraeliPhone } = require('./validation');

function cleanRoomPhone(phone) {
  return normalizeIsraeliPhone(security.sanitizeString(phone || '', 30));
}

function createRoomMember({ uid, name, phone = '', isHost = false, avatarColor = '#A3E635' }) {
  const accessToken = createAccessToken();
  const member = {
    id: uid || createEntityId('member'),
    name: security.sanitizeName(name, isHost ? 'Host' : 'Member'),
    phone: cleanRoomPhone(phone),
    isHost: Boolean(isHost),
    settled: false,
    avatarColor,
    accessTokenHash: hashAccessToken(accessToken),
  };
  return { member, accessToken };
}

function findRoomMember(room, { uid, accessToken, email } = {}) {
  const members = Array.isArray(room?.members) ? room.members.filter((member) => member.active !== false) : [];
  if (uid) {
    const member = members.find((candidate) => candidate.id === uid || candidate.userId === uid || candidate.uid === uid);
    if (member) return member;
  }
  if (accessToken) {
    const member = members.find((candidate) => (
      tokenMatches(accessToken, candidate.accessTokenHash)
      || (Array.isArray(candidate.accessTokenHashes)
        && candidate.accessTokenHashes.some((hash) => tokenMatches(accessToken, hash)))
    ));
    if (member) return member;
  }
  if (email) {
    const cleanEmail = email.toString().toLowerCase().trim();
    const member = members.find((candidate) => candidate.email && candidate.email.toLowerCase().trim() === cleanEmail);
    if (member) return member;
  }
  return null;
}

function deduplicateRoomMembers(room) {
  if (!room || !Array.isArray(room.members)) return room;
  const seen = new Map();
  const deduped = [];
  const idRemap = new Map();

  for (const m of room.members) {
    if (!m || m.active === false) continue;
    // Deduplicate when members share the same Google UID / userId
    const key = (m.userId || m.uid || (m.id && !m.id.startsWith('member_') ? m.id : ''));
    if (key && seen.has(key)) {
      const primary = seen.get(key);
      idRemap.set(m.id, primary.id);
      if (!primary.phone && m.phone) primary.phone = m.phone;
      if (!primary.avatarColor && m.avatarColor) primary.avatarColor = m.avatarColor;
      if (m.isHost) primary.isHost = true;
    } else {
      if (key) seen.set(key, m);
      deduped.push(m);
    }
  }

  if (idRemap.size > 0 && Array.isArray(room.bills)) {
    room.bills.forEach((bill) => {
      if (bill.payerId && idRemap.has(bill.payerId)) {
        bill.payerId = idRemap.get(bill.payerId);
      }
      if (Array.isArray(bill.items)) {
        bill.items.forEach((item) => {
          if (Array.isArray(item.claimedBy)) {
            item.claimedBy = [...new Set(item.claimedBy.map((c) => idRemap.get(c) || c))];
          }
        });
      }
    });
  }

  if (idRemap.size > 0 && Array.isArray(room.items)) {
    room.items.forEach((item) => {
      if (Array.isArray(item.claimedBy)) {
        item.claimedBy = [...new Set(item.claimedBy.map((c) => idRemap.get(c) || c))];
      }
    });
  }

  room.members = deduped;
  return room;
}

function joinRoom(room, { uid, accessToken, name, phone, avatarColor, email }) {
  if (!room || !Array.isArray(room.members)) throw new Error('Room is invalid');

  deduplicateRoomMembers(room);

  const existing = findRoomMember(room, { uid, accessToken, email });
  if (existing) {
    const cleanName = name ? security.sanitizeName(name, existing.name || 'Member') : existing.name;
    const cleanPhone = cleanRoomPhone(phone);
    const changed = Boolean(
      (cleanName && cleanName !== existing.name)
      || (cleanPhone && cleanPhone !== existing.phone)
    );
    if (cleanName && cleanName !== existing.name) existing.name = cleanName;
    if (cleanPhone) existing.phone = cleanPhone;
    if (uid && !existing.userId) existing.userId = uid;
    const tokenIsCurrent = accessToken && (
      tokenMatches(accessToken, existing.accessTokenHash)
      || (Array.isArray(existing.accessTokenHashes)
        && existing.accessTokenHashes.some((hash) => tokenMatches(accessToken, hash)))
    );
    const nextToken = tokenIsCurrent ? accessToken : createAccessToken();
    const priorHashes = [
      ...(Array.isArray(existing.accessTokenHashes) ? existing.accessTokenHashes : []),
      existing.accessTokenHash,
    ].filter(Boolean);
    existing.accessTokenHash = hashAccessToken(nextToken);
    existing.accessTokenHashes = [...new Set([...priorHashes, existing.accessTokenHash])].slice(-5);
    return { member: existing, accessToken: nextToken, changed: true };
  }

  if (room.members.filter((member) => member?.active !== false).length >= 100) {
    const error = new Error('This room has reached its participant limit');
    error.statusCode = 409;
    throw error;
  }

  const created = createRoomMember({
    uid,
    name,
    phone,
    isHost: false,
    avatarColor,
  });
  room.members.push(created.member);
  return { ...created, changed: true };
}

function syncRoomMember(target, source) {
  if (!target || !source) return target;
  target.name = source.name;
  target.phone = cleanRoomPhone(source.phone);
  target.isHost = Boolean(source.isHost);
  target.active = source.active !== false;
  target.accessTokenHash = source.accessTokenHash;
  target.accessTokenHashes = source.accessTokenHashes;
  return target;
}

function stripPrivateFields(value) {
  if (Array.isArray(value)) return value.map(stripPrivateFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => ![
        'accessTokenHash',
        'accessTokenHashes',
        'hostTokenHash',
        'scanId',
        'inputDigest',
        'contentDigest',
        'processedActionIds',
        'phone',
        'hostPhone',
        'toPhone',
        'email',
      ].includes(key))
      .map(([key, child]) => [key, stripPrivateFields(child)])
  );
}

function publicRoom(room) {
  return stripPrivateFields(deduplicateRoomMembers(room));
}

function getRequestRoomToken(req) {
  const value = req?.headers?.['x-room-token'];
  return Array.isArray(value) ? value[0] : (typeof value === 'string' ? value : '');
}

module.exports = {
  createRoomMember,
  findRoomMember,
  deduplicateRoomMembers,
  joinRoom,
  syncRoomMember,
  publicRoom,
  getRequestRoomToken,
};

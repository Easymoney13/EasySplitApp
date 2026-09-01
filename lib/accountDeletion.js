const crypto = require('crypto');

const PRIVATE_MEMBER_FIELDS = new Set([
  'userId', 'uid', 'phone', 'email', 'accessTokenHash', 'accessTokenHashes',
  'clientIdentityHash', 'clientTokenSalt', 'avatarUrl',
]);

function memberAccountId(member) {
  if (!member || typeof member !== 'object') return '';
  return member.userId
    || member.uid
    || (member.id && !String(member.id).startsWith('member_') ? member.id : '');
}

function remapStrings(value, replacements) {
  if (typeof value === 'string') return replacements.get(value) || value;
  if (Array.isArray(value)) return value.map((child) => remapStrings(child, replacements));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, remapStrings(child, replacements)]),
  );
}

function deletedMemberId() {
  return `member_deleted_${crypto.randomBytes(10).toString('hex')}`;
}

function anonymizeAccountInRecord(record, uid, sharedReplacements = new Map()) {
  if (!record || typeof record !== 'object' || !uid) return { changed: false, record };
  const members = Array.isArray(record.members) ? record.members : [];
  const targets = members.filter((member) => memberAccountId(member) === uid);
  if (targets.length === 0) {
    const hasAccountIndex = Array.isArray(record.memberIds) && record.memberIds.includes(uid);
    if (!hasAccountIndex && record.submittedByUserId !== uid && record.userId !== uid) {
      return { changed: false, record };
    }
  }

  const replacements = sharedReplacements;
  for (const member of targets) {
    if (member?.id && !replacements.has(String(member.id))) {
      replacements.set(String(member.id), deletedMemberId());
    }
  }

  let next = remapStrings(record, replacements);
  const targetOriginalIds = new Set(targets.map((member) => String(member.id || '')).filter(Boolean));
  next.members = (Array.isArray(next.members) ? next.members : []).map((member, index) => {
    const original = members[index];
    if (!original || memberAccountId(original) !== uid) return member;
    const clean = {};
    for (const [key, value] of Object.entries(member || {})) {
      if (!PRIVATE_MEMBER_FIELDS.has(key)) clean[key] = value;
    }
    clean.id = replacements.get(String(original.id || '')) || deletedMemberId();
    clean.name = 'Deleted user';
    clean.avatarColor = '#CBD5E1';
    clean.deletedAccount = true;
    clean.isHost = Boolean(original.isHost);
    return clean;
  });

  if (Array.isArray(record.memberIds)) next.memberIds = record.memberIds.filter((id) => id !== uid);
  if (next.userId === uid) delete next.userId;
  if (next.submittedByUserId === uid) delete next.submittedByUserId;
  if (next.hostPhone && targets.some((member) => member.isHost)) next.hostPhone = '';
  if (next.hostName && targets.some((member) => member.isHost)) next.hostName = 'Deleted user';

  const deletedHosts = targets.filter((member) => member.isHost);
  if (deletedHosts.length > 0 && next.members.length > deletedHosts.length) {
    for (const member of next.members) {
      if (member.deletedAccount) member.isHost = false;
    }
    const successor = next.members.find((member) => !member.deletedAccount && member.active !== false)
      || next.members.find((member) => !member.deletedAccount);
    if (successor) successor.isHost = true;
  }

  // Avoid keeping the Firebase UID in arbitrary top-level/account index fields.
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === 'string' && value === uid && !targetOriginalIds.has(value)) delete next[key];
  }

  return { changed: true, record: next, replacedMemberIds: [...replacements.values()] };
}

module.exports = {
  anonymizeAccountInRecord,
  memberAccountId,
};

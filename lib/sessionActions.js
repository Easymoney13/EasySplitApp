const { createEntityId } = require('./ids');
const { validateSessionAction } = require('./validation');

const HOST_ACTIONS = new Set([
  'SPLIT_EVERYONE', 'ADD_ITEM', 'EDIT_ITEM', 'DELETE_ITEM',
  'SET_TIP', 'SET_PAYER', 'SETTLE_ALL', 'RESOLVE_DELETED_MEMBER',
]);
const SETTLEMENT_LOCKED_ACTIONS = new Set([
  'SPLIT_EVERYONE', 'ADD_ITEM', 'EDIT_ITEM', 'DELETE_ITEM',
  'SET_TIP', 'SET_PAYER',
]);

function hasUnconfirmedDeletedShare(member) {
  return member?.deletedAccount === true && member?.settled !== true
    && member?.deletionResolution?.status === 'unconfirmed';
}

function hasFinishedShare(member) {
  return member?.settled === true || hasUnconfirmedDeletedShare(member);
}

function closeCompletedSession(session, now) {
  const activeMembers = (session.members || []).filter((member) => member.active !== false);
  if (activeMembers.length > 0 && activeMembers.every(hasFinishedShare)) {
    session.status = 'settled';
    session.settledAt = now();
    const unconfirmedMemberIds = activeMembers.filter(hasUnconfirmedDeletedShare).map((member) => member.id);
    if (unconfirmedMemberIds.length) session.unconfirmedMemberIds = unconfirmedMemberIds;
  }
}

function resolveActor(session, actor = {}, payload = {}) {
  const members = Array.isArray(session?.members) ? session.members : [];
  const byUid = actor.uid ? members.find((member) => member.id === actor.uid || member.userId === actor.uid || member.uid === actor.uid) : null;
  const byMemberId = actor.memberId ? members.find((member) => member.id === actor.memberId) : null;
  const singleMemberFallback = members.length === 1 ? members[0] : null;
  return byUid || byMemberId || singleMemberFallback || null;
}

function canPerformSessionAction(session, action, actor = {}, payload = {}) {
  const members = Array.isArray(session?.members) ? session.members : [];
  const member = resolveActor(session, actor, payload);
  if (!member || member.deletedAccount === true || member.active === false) return { allowed: false, reason: 'You are not a member of this session' };
  if (session.status === 'settled') return { allowed: false, reason: 'This session is already closed' };
  const hasSettledMember = members.some((candidate) => candidate.active !== false && hasFinishedShare(candidate));
  if (hasSettledMember && SETTLEMENT_LOCKED_ACTIONS.has(action)) {
    return { allowed: false, reason: 'Payment allocations are locked while a participant share is finished' };
  }
  if (HOST_ACTIONS.has(action) && !member.isHost && (Array.isArray(session?.members) && session.members.length > 1)) {
    return { allowed: false, reason: 'Only the host can perform this action' };
  }
  if (action === 'TOGGLE_CLAIM' && payload.memberId && payload.memberId !== member.id && !member.isHost) {
    return { allowed: false, reason: 'You can only claim items for yourself' };
  }
  if (action === 'TOGGLE_CLAIM' && hasSettledMember) {
    if (hasFinishedShare(member)) {
      return { allowed: false, reason: 'Reopen your payment before changing claimed items' };
    }
    const item = (session.items || []).find((candidate) => candidate.id === payload.itemId);
    const settledIds = new Set(members
      .filter((candidate) => candidate.active !== false && hasFinishedShare(candidate))
      .map((candidate) => candidate.id));
    if ((item?.claimedBy || []).some((memberId) => settledIds.has(memberId))) {
      return { allowed: false, reason: 'This item is locked because it affects a finished share' };
    }
  }
  if (action === 'TOGGLE_SETTLED' && payload.memberId && payload.memberId !== member.id && !member.isHost) {
    return { allowed: false, reason: 'You can only update your own payment status' };
  }
  return { allowed: true, member };
}

function processSessionAction(session, action, rawPayload, actor, now = Date.now) {
  if (!session || typeof session !== 'object') throw new Error('Session is required');
  const payload = validateSessionAction(action, rawPayload);
  const authorization = canPerformSessionAction(session, action, actor, payload);
  if (!authorization.allowed) {
    const error = new Error(authorization.reason);
    error.statusCode = authorization.reason.includes('closed') ? 409 : 403;
    throw error;
  }

  const updated = structuredClone(session);
  const items = Array.isArray(updated.items) ? updated.items : [];
  const members = Array.isArray(updated.members) ? updated.members : [];

  switch (action) {
    case 'TOGGLE_CLAIM': {
      const item = items.find((candidate) => candidate.id === payload.itemId);
      if (!item) throw Object.assign(new Error('Item not found'), { statusCode: 404 });
      const claimants = Array.isArray(item.claimedBy) ? item.claimedBy : [];
      const shouldClaim = payload.claimed !== undefined
        ? payload.claimed
        : !claimants.includes(authorization.member.id);
      item.claimedBy = shouldClaim
        ? [...new Set([...claimants, authorization.member.id])]
        : claimants.filter((id) => id !== authorization.member.id);
      break;
    }
    case 'SPLIT_EVERYONE': {
      const ids = members.map((member) => member.id);
      items.forEach((item) => { item.claimedBy = [...ids]; });
      break;
    }
    case 'ADD_ITEM':
      if (payload.itemId && items.some((item) => item.id === payload.itemId)) break;
      items.push({
        id: payload.itemId || createEntityId('item'),
        name: payload.name,
        price: payload.price,
        category: payload.category,
        claimedBy: [],
      });
      break;
    case 'EDIT_ITEM': {
      const item = items.find((candidate) => candidate.id === payload.itemId);
      if (!item) throw Object.assign(new Error('Item not found'), { statusCode: 404 });
      item.name = payload.name;
      item.price = payload.price;
      item.category = payload.category;
      break;
    }
    case 'DELETE_ITEM': {
      const before = items.length;
      updated.items = items.filter((item) => item.id !== payload.itemId);
      if (updated.items.length === before) throw Object.assign(new Error('Item not found'), { statusCode: 404 });
      break;
    }
    case 'TOGGLE_SETTLED': {
      const member = members.find((candidate) => candidate.id === authorization.member.id);
      if (!member) throw Object.assign(new Error('Member not found'), { statusCode: 404 });
      const nextSettled = payload.settled !== undefined ? payload.settled : !member.settled;
      if (nextSettled) {
        const activeMemberIds = new Set(members.filter((candidate) => candidate.active !== false).map((candidate) => candidate.id));
        const hasUnassignedItem = items.some((item) => !Array.isArray(item.claimedBy)
          || !item.claimedBy.some((memberId) => activeMemberIds.has(memberId)));
        if (hasUnassignedItem) {
          throw Object.assign(new Error('Every item must be assigned before a payment can be finished'), { statusCode: 409 });
        }
      }
      member.settled = nextSettled;
      if (member.settled) member.settledAt = now();
      else delete member.settledAt;
      closeCompletedSession(updated, now);
      break;
    }
    case 'RESOLVE_DELETED_MEMBER': {
      const target = members.find((member) => member.id === payload.memberId);
      if (!target || target.deletedAccount !== true || target.active === false || target.settled === true) {
        throw Object.assign(new Error('Only an unpaid deleted participant can be resolved as unconfirmed'), { statusCode: 409 });
      }
      const activeMemberIds = new Set(members.filter((member) => member.active !== false).map((member) => member.id));
      if (items.some((item) => !Array.isArray(item.claimedBy) || !item.claimedBy.some((id) => activeMemberIds.has(id)))) {
        throw Object.assign(new Error('Every item must be assigned before a share can be resolved'), { statusCode: 409 });
      }
      if (!hasUnconfirmedDeletedShare(target)) {
        target.deletionResolution = {
          status: 'unconfirmed',
          resolvedByMemberId: authorization.member.id,
          resolvedAt: now(),
        };
      }
      target.settled = false;
      closeCompletedSession(updated, now);
      break;
    }
    case 'SET_TIP':
      updated.tipPercentage = payload.tipPercentage;
      break;
    case 'SET_PAYER': {
      const targetPayerId = payload.payerId;
      if (!targetPayerId || targetPayerId === 'each' || targetPayerId === 'split' || targetPayerId === 'everyone') {
        updated.payerId = 'each';
      } else {
        const validPayer = members.find((m) => m.id === targetPayerId);
        updated.payerId = validPayer ? validPayer.id : 'each';
      }
      break;
    }
    case 'SETTLE_ALL':
      if (!members.filter((member) => member.active !== false).every(hasFinishedShare)) {
        throw Object.assign(new Error('Every participant must finish and pay before the session can close'), { statusCode: 409 });
      }
      closeCompletedSession(updated, now);
      break;
    default:
      throw new Error('Unsupported action');
  }

  updated.updatedAt = now();
  return updated;
}

module.exports = {
  hasUnconfirmedDeletedShare,
  hasFinishedShare,
  HOST_ACTIONS,
  SETTLEMENT_LOCKED_ACTIONS,
  resolveActor,
  canPerformSessionAction,
  processSessionAction,
};

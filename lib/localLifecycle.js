function readArray(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

function addDeletedId(storage, key, id) {
  const ids = readArray(storage, key).filter((value) => typeof value === 'string');
  if (!ids.includes(id)) storage.setItem(key, JSON.stringify([...ids, id]));
}

function purgeRoomCredentialsFromStorage(storage, kind, roomId) {
  if (!roomId || !['session', 'group'].includes(kind)) return;
  const tokenPrefix = kind === 'session' ? 'billsplit_session_token_' : 'billsplit_group_token_';
  const memberPrefix = kind === 'session' ? 'billsplit_member_' : 'billsplit_group_member_';
  const exactToken = storage.getItem(`${tokenPrefix}${roomId}`);
  const aliases = new Set([roomId]);
  if (exactToken) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(tokenPrefix) && storage.getItem(key) === exactToken) {
        aliases.add(key.slice(tokenPrefix.length));
      }
    }
  }
  for (const alias of aliases) {
    storage.removeItem(`${tokenPrefix}${alias}`);
    storage.removeItem(`${memberPrefix}${alias}`);
    if (kind === 'session') storage.removeItem(`billsplit_session_invite_${alias}`);
  }
}

function removeSessionHistoryFromStorage(storage, sessionId) {
  if (!sessionId) return;
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key || (key !== 'billsplit_history' && !key.startsWith('billsplit_history_'))) continue;
    const filtered = readArray(storage, key).filter((entry) => entry?.id !== sessionId);
    storage.setItem(key, JSON.stringify(filtered));
  }
}

function removeActiveSessionFromStorage(storage, sessionId) {
  if (!sessionId) return;
  try {
    const active = JSON.parse(storage.getItem('billsplit_active_session') || 'null');
    if (active?.id === sessionId) storage.removeItem('billsplit_active_session');
  } catch (_) {
    storage.removeItem('billsplit_active_session');
  }
}

function purgeDeletedSessionFromStorage(storage, sessionId) {
  if (!sessionId) return;
  addDeletedId(storage, 'billsplit_deleted_history_ids', sessionId);
  removeSessionHistoryFromStorage(storage, sessionId);
  removeActiveSessionFromStorage(storage, sessionId);
  purgeRoomCredentialsFromStorage(storage, 'session', sessionId);
}

function purgeDeletedGroupFromStorage(storage, groupId) {
  if (!groupId) return;
  addDeletedId(storage, 'billsplit_deleted_group_ids', groupId);
  const linkedSessionIds = new Set();
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key) continue;
    const isGroupList = key === 'billsplit_user_groups'
      || key.startsWith('billsplit_user_groups_')
      || key === 'billsplit_closed_groups'
      || key.startsWith('billsplit_closed_groups_');
    const isHistoryList = key === 'billsplit_history' || key.startsWith('billsplit_history_');
    if (!isGroupList && !isHistoryList) continue;
    const entries = readArray(storage, key);
    entries.forEach((entry) => {
      if (isHistoryList && entry?.groupId === groupId && entry?.id) linkedSessionIds.add(entry.id);
      if (isGroupList && entry?.id === groupId) {
        (entry.bills || []).forEach((bill) => {
          if (bill?.sessionId) linkedSessionIds.add(bill.sessionId);
        });
      }
    });
    const filtered = entries.filter((entry) => (
      isHistoryList ? entry?.groupId !== groupId : entry?.id !== groupId
    ));
    storage.setItem(key, JSON.stringify(filtered));
  }
  purgeRoomCredentialsFromStorage(storage, 'group', groupId);
  linkedSessionIds.forEach((sessionId) => purgeRoomCredentialsFromStorage(storage, 'session', sessionId));
}

function moveClosedGroupToHistory(storage, groupId, serverSummary = {}) {
  if (!groupId) return null;
  let closedSummary = { id: groupId, status: 'closed', ...serverSummary };
  const targetClosedKeys = new Set(['billsplit_closed_groups']);
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key || (key !== 'billsplit_user_groups' && !key.startsWith('billsplit_user_groups_'))) continue;
    const groups = readArray(storage, key);
    const existing = groups.find((entry) => entry?.id === groupId);
    if (existing) closedSummary = { ...existing, ...closedSummary, id: groupId, status: 'closed' };
    storage.setItem(key, JSON.stringify(groups.filter((entry) => entry?.id !== groupId)));
    targetClosedKeys.add(key === 'billsplit_user_groups'
      ? 'billsplit_closed_groups'
      : key.replace('billsplit_user_groups_', 'billsplit_closed_groups_'));
  }
  for (const key of targetClosedKeys) {
    const existing = readArray(storage, key);
    storage.setItem(key, JSON.stringify([
      closedSummary,
      ...existing.filter((entry) => entry?.id !== groupId),
    ]));
  }
  return closedSummary;
}

function collectCachedRoomIds(storage) {
  const sessionIds = new Set();
  const groupIds = new Set();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) continue;
    const isHistory = key === 'billsplit_history' || key.startsWith('billsplit_history_');
    const isGroupCache = key === 'billsplit_user_groups'
      || key.startsWith('billsplit_user_groups_')
      || key === 'billsplit_closed_groups'
      || key.startsWith('billsplit_closed_groups_');
    if (!isHistory && !isGroupCache) continue;
    for (const entry of readArray(storage, key)) {
      if (isHistory && /^sess[_-][a-z0-9_-]{4,95}$/i.test(String(entry?.id || ''))) sessionIds.add(entry.id);
      if (isHistory && /^grp[_-][a-z0-9_-]{4,95}$/i.test(String(entry?.groupId || ''))) groupIds.add(entry.groupId);
      if (isGroupCache && /^grp[_-][a-z0-9_-]{4,95}$/i.test(String(entry?.id || ''))) groupIds.add(entry.id);
    }
  }
  try {
    const activeSession = JSON.parse(storage.getItem('billsplit_active_session') || 'null');
    if (/^sess[_-][a-z0-9_-]{4,95}$/i.test(String(activeSession?.id || ''))) sessionIds.add(activeSession.id);
  } catch (_) {}
  return { sessionIds: [...sessionIds], groupIds: [...groupIds] };
}

function purgeDeletedRoomsFromStatus(storage, status = {}) {
  const deletedSessions = Object.entries(status.sessions || {})
    .filter(([, value]) => value === 'deleted')
    .map(([id]) => id);
  const deletedGroups = Object.entries(status.groups || {})
    .filter(([, value]) => value === 'deleted')
    .map(([id]) => id);
  const closedGroups = Object.entries(status.groups || {})
    .filter(([, value]) => value === 'closed')
    .map(([id]) => moveClosedGroupToHistory(storage, id, status.groupSummaries?.[id] || {}))
    .filter(Boolean);
  const settledSessions = Object.entries(status.sessions || {})
    .filter(([, value]) => value === 'settled')
    .map(([id]) => id);
  const reopenedSessions = Object.entries(status.sessions || {})
    .filter(([id, value]) => value === 'active' && status.sessionHistoryStates?.[id] === 'absent')
    .map(([id]) => id);
  deletedSessions.forEach((id) => purgeDeletedSessionFromStorage(storage, id));
  deletedGroups.forEach((id) => purgeDeletedGroupFromStorage(storage, id));
  settledSessions.forEach((id) => removeActiveSessionFromStorage(storage, id));
  reopenedSessions.forEach((id) => removeSessionHistoryFromStorage(storage, id));
  return { deletedSessions, deletedGroups, closedGroups, settledSessions, reopenedSessions };
}

module.exports = {
  collectCachedRoomIds,
  moveClosedGroupToHistory,
  purgeDeletedGroupFromStorage,
  purgeDeletedRoomsFromStatus,
  purgeDeletedSessionFromStorage,
  purgeRoomCredentialsFromStorage,
  removeActiveSessionFromStorage,
  removeSessionHistoryFromStorage,
};

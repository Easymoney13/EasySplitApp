export type RoomKind = 'session' | 'group';

const ROOM_CLIENT_ID_KEY = 'billsplit_room_client_id';

function tokenKey(kind: RoomKind, roomId: string) {
  return `billsplit_${kind}_token_${roomId}`;
}

function memberKey(kind: RoomKind, roomId: string) {
  return kind === 'session'
    ? `billsplit_member_${roomId}`
    : `billsplit_group_member_${roomId}`;
}

function inviteKey(roomId: string) {
  return `billsplit_session_invite_${roomId}`;
}

export function getRoomToken(kind: RoomKind, roomId: string) {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(tokenKey(kind, roomId)) || '';
}

export function getRoomMemberId(kind: RoomKind, roomId: string) {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(memberKey(kind, roomId)) || '';
}

export function saveRoomCredentials(kind: RoomKind, roomId: string, memberId: string, accessToken: string) {
  if (typeof window === 'undefined') return;
  if (memberId) localStorage.setItem(memberKey(kind, roomId), memberId);
  if (accessToken) localStorage.setItem(tokenKey(kind, roomId), accessToken);
}

export function getSessionInviteToken(roomId: string) {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(inviteKey(roomId)) || '';
}

export function saveSessionInviteToken(roomId: string, inviteToken: string) {
  if (typeof window === 'undefined' || !roomId || !inviteToken) return;
  localStorage.setItem(inviteKey(roomId), inviteToken);
}

export function clearSessionInviteToken(roomId: string) {
  if (typeof window === 'undefined' || !roomId) return;
  localStorage.removeItem(inviteKey(roomId));
}

export function getOrCreateRoomClientId() {
  if (typeof window === 'undefined') return '';
  const existing = localStorage.getItem(ROOM_CLIENT_ID_KEY);
  if (existing) return existing;
  const generated = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `client_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
  localStorage.setItem(ROOM_CLIENT_ID_KEY, generated);
  return generated;
}

export function clearRoomCredentials(kind: RoomKind, roomId: string) {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(memberKey(kind, roomId));
  localStorage.removeItem(tokenKey(kind, roomId));
  if (kind === 'session') localStorage.removeItem(inviteKey(roomId));
}

export function roomHeaders(kind: RoomKind, roomId: string, includeJson = true): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeJson) headers['Content-Type'] = 'application/json';
  const clientId = getOrCreateRoomClientId();
  if (clientId) headers['X-EasySplit-Client-Id'] = clientId;
  const accessToken = getRoomToken(kind, roomId);
  if (accessToken) headers['X-Room-Token'] = accessToken;
  return headers;
}

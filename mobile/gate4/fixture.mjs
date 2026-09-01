export const GATE4_GUEST_PROFILE = Object.freeze({
  displayName: 'Gate Four Host',
  phoneNumber: '0501234567',
  avatarColor: '#4DE1A1',
});

export function gate4FixtureScript() {
  const profile = JSON.stringify(GATE4_GUEST_PROFILE);
  return `(() => {
    const profile = ${profile};
    localStorage.setItem('billsplit_local_profile', JSON.stringify(profile));
    localStorage.setItem('billsplit_phone', profile.phoneNumber);
    localStorage.setItem('billsplit_account_scope', 'guest');
    localStorage.setItem('billsplit_lang', 'en');
  })();`;
}

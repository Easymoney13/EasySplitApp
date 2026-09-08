// Capacitor's iOS and legacy Android camera reject with these message forms.
// Check permission failures before cancellation so a denied request is visible.
function nativeCameraErrorMessage(error, language = 'en') {
  const message = typeof error === 'string' ? error : String(error?.message || '');
  const code = typeof error?.code === 'string' ? error.code : '';
  const description = `${code} ${message}`;
  const he = language === 'he';
  if (/denied|restricted|permission|not.?authori[sz]ed/i.test(description)) {
    return he
      ? 'אין גישה למצלמה. אפשר לאפשר גישה בהגדרות המכשיר ← EasySplit ← הרשאות מצלמה, או לבחור תמונה מהגלריה או להזין את החשבון ידנית.'
      : 'Camera access is disabled. Enable camera access in your device Settings → EasySplit, or choose a photo from your gallery or enter the bill manually.';
  }
  if (/cancel(?:led|ed)?/i.test(description)) return null;
  return he
    ? 'לא הצלחנו לפתוח את המצלמה. נסו שוב, בחרו תמונה מהגלריה או הזינו את החשבון ידנית.'
    : 'Could not open the camera. Try again, choose a photo from your gallery, or enter the bill manually.';
}

module.exports = { nativeCameraErrorMessage };

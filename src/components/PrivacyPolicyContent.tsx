import React from 'react';

const content = {
  en: [
    ['Information you provide', 'EasySplit processes the name and phone number you enter, your account identifier and sign-in provider information, preferences, groups, bill history, receipt items and amounts, item selections, and settlement status. These support joining a bill, calculating shares, and returning to your groups. Your phone number can be made available to other participants when they select you as a payment recipient.'],
    ['Receipt photos and AI processing', 'If you allow cloud scanning, the receipt photo and its visible contents are sent through the EasySplit server to Google Gemini AI to extract restaurant details, dates, items, and prices. This may include personal or payment information printed on the receipt. Crop out unrelated information before scanning. You can enter items manually instead, without uploading a photo. Google processes submitted content under its Gemini API terms. We do not promise that an uploaded receipt is never retained or used by Google.'],
    ['Storage and service providers', 'Google Firebase provides account authentication and stores application records in Firestore. The EasySplit server handles requests and receipt processing. The app also keeps preferences, sign-in state, room access information, cached history, and your cloud-scanning choice on this device. Google or Apple receives sign-in information when you choose its sign-in option.'],
    ['Shared bills and payment apps', 'People who join your session or group can see shared bill details, participants, item selections, shares, and settlement status. Sending an invitation gives another person a way to join that room. When you open an external payment app, that provider handles the transfer under its own terms. EasySplit records settlement choices; opening a payment app does not verify that money was transferred.'],
    ['Restaurant information', 'Receipts and participation create restaurant and visit records, including restaurant identity, items, dates, bill identifiers, account references, and a protected identifier derived from a phone number when configured. These support restaurant matching, data quality, and internal counts of distinct visitors. The internal audience preview returns aggregate counts rather than raw phone numbers. Cloud-scanning permission is not permission to send marketing messages.'],
    ['Product analytics', 'When analytics delivery is configured, the server sends usage and error events to the EasySplit analytics service to assess reliability and product use. Events can include timestamps, hashed account and session identifiers, durations, item counts, amounts, and outcomes. This event format does not include receipt photos or raw phone numbers.'],
    ['Retention and account deletion', 'Profile and bill records remain available for the account and shared history; they do not have a general automatic expiry in the app. You can request account deletion in Settings. Account deletion removes your profile and linked visit records and replaces your identity in shared bills with a deleted-participant entry so the other participants retain their bill history. It does not automatically remove previously delivered analytics events or content already processed by external providers. Shared amounts and restaurant observations may remain without your account reference.'],
    ['Your choices', 'You can update your profile in Settings, delete your account there, change camera permissions in device settings, and withdraw cloud-scanning permission below. Withdrawing stops future photo uploads until you agree again; it cannot recall a photo already sent. The permission is saved on this browser or app installation and cleared when you change or sign out of an account. A changed disclosure requires a new choice.'],
  ],
  he: [
    ['המידע שאתם מוסרים', 'EasySplit מעבדת את השם ומספר הטלפון שהזנתם, מזהה החשבון ומידע מספק ההתחברות, העדפות, קבוצות, היסטוריית חשבונות, פריטים וסכומים בקבלה, בחירת פריטים ומצב סילוק החוב. המידע משמש להצטרפות לחשבון, לחישוב חלקו של כל משתתף ולחזרה לקבוצות שלכם. מספר הטלפון שלכם יכול להימסר למשתתף אחר כאשר הוא בוחר בכם כנמען לתשלום.'],
    ['תמונות קבלה ועיבוד בבינה מלאכותית', 'אם תאשרו סריקה בענן, תמונת הקבלה והתוכן הנראה בה יישלחו דרך שרת EasySplit לבינה המלאכותית Google Gemini, כדי לקרוא פרטי מסעדה, תאריך, פריטים ומחירים. התמונה עשויה לכלול מידע אישי או פרטי תשלום המודפסים בקבלה. חיתכו מידע שאינו נחוץ לפני הסריקה. אפשר להזין פריטים ידנית בלי להעלות תמונה. Google מעבדת את התוכן לפי תנאי Gemini API. איננו מבטיחים שתמונה שהועלתה לעולם לא תישמר או תשמש את Google.'],
    ['אחסון וספקי שירות', 'Google Firebase מספקת אימות חשבונות ואחסון רשומות האפליקציה ב־Firestore. שרת EasySplit מטפל בבקשות ובעיבוד קבלות. האפליקציה שומרת במכשיר גם העדפות, מצב התחברות, פרטי גישה לסשנים, עותק של היסטוריה ואת בחירתכם לגבי סריקה בענן. Google או Apple מקבלות מידע לצורך התחברות כאשר תבחרו בהתחברות באמצעותן.'],
    ['חשבונות משותפים ואפליקציות תשלום', 'מי שמצטרף לסשן או לקבוצה שלכם יכול לראות את פרטי החשבון המשותף, המשתתפים, בחירת הפריטים, החלקים ומצב סילוק החוב. שליחת הזמנה מאפשרת לאדם אחר להצטרף. בפתיחת אפליקציית תשלום חיצונית, ספק התשלום מטפל בהעברה לפי תנאיו. EasySplit מתעדת סימון של סילוק חוב; פתיחת אפליקציית תשלום אינה אימות שהכסף הועבר.'],
    ['מידע על מסעדות', 'קבלות והשתתפות בחשבונות יוצרות רשומות מסעדה וביקור, ובהן זהות המסעדה, פריטים, תאריכים, מזהי חשבונות, קישור לחשבון משתמש ומזהה מוגן הנגזר ממספר הטלפון כאשר האפשרות מוגדרת. המידע משמש להתאמת מסעדות, לבקרת איכות הנתונים ולספירה פנימית של מבקרים שונים. תצוגת הקהל הפנימית מחזירה ספירות מצטברות ולא מספרי טלפון גולמיים. הסכמה לסריקה בענן אינה הסכמה לשליחת הודעות שיווקיות.'],
    ['מדידת שימוש', 'כאשר משלוח נתוני מדידה מוגדר, השרת שולח אירועי שימוש ושגיאות לשירות המדידה של EasySplit לצורך בחינת אמינות ושימוש במוצר. אירועים יכולים לכלול זמנים, מזהי חשבון וסשן שעברו גיבוב, משכי פעולה, מספרי פריטים, סכומים ותוצאות. פורמט האירועים אינו כולל תמונות קבלה או מספרי טלפון גולמיים.'],
    ['שמירת מידע ומחיקת חשבון', 'רשומות פרופיל וחשבונות נשמרות לשימוש בחשבון ובהיסטוריה המשותפת; אין להן באפליקציה תאריך תפוגה אוטומטי כללי. ניתן לבקש מחיקת חשבון בהגדרות. המחיקה מסירה את הפרופיל ואת רשומות הביקור המקושרות ומחליפה את זהותכם בחשבונות משותפים ברשומת משתתף שנמחק, כדי לשמר את היסטוריית החשבון של יתר המשתתפים. היא אינה מסירה אוטומטית אירועי מדידה שכבר נשלחו או תוכן שכבר עובד אצל ספקים חיצוניים. סכומים משותפים ותצפיות על מסעדות יכולים להישאר ללא קישור לחשבונכם.'],
    ['הבחירות שלכם', 'אפשר לעדכן פרופיל ולמחוק חשבון בהגדרות, לשנות הרשאות מצלמה בהגדרות המכשיר ולבטל את ההסכמה לסריקה בענן כאן למטה. הביטול מונע העלאות תמונה עתידיות עד להסכמה נוספת; הוא אינו מחזיר תמונה שכבר נשלחה. הבחירה נשמרת בדפדפן או בהתקנת האפליקציה הזו ונמחקת בעת החלפת חשבון או התנתקות. שינוי בהסבר מחייב בחירה מחדש.'],
  ],
};

export function PrivacyPolicyContent({ language = 'en' }: { language?: string }) {
  const hebrew = language === 'he';
  return (
    <div className="space-y-5 text-sm leading-6 text-slate-600 dark:text-slate-300" dir={hebrew ? 'rtl' : 'ltr'} lang={hebrew ? 'he' : 'en'}>
      <p className="text-xs text-slate-500">{hebrew ? 'עודכן: 8 בספטמבר 2026' : 'Updated: September 8, 2026'}</p>
      {content[hebrew ? 'he' : 'en'].map(([title, body]) => (
        <section key={title}>
          <h2 className="mb-1 font-bold text-brand-950 dark:text-white">{title}</h2>
          <p>{body}</p>
        </section>
      ))}
      <p>
        <a className="underline underline-offset-4" href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noopener noreferrer">
          {hebrew ? 'תנאי Gemini API של Google' : 'Google Gemini API terms'}
        </a>
        {' · '}
        <a className="underline underline-offset-4" href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">
          {hebrew ? 'מדיניות הפרטיות של Google' : 'Google Privacy Policy'}
        </a>
      </p>
    </div>
  );
}

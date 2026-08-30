export const translations: Record<string, Record<string, string>> = {
  en: {
    appName: "BillSplit",
    tagline: "Split bills instantly in real-time with friends",
    welcomeBack: "Welcome back",
    helloUser: "Hello {name}",
    splitBillSubtitle: "Split your bill with EasySplit",
    startSplitCard: "Split a bill",
    letTryItNow: "Scan or upload a receipt",
    joinSessionViaCode: "Join by code",
    joinSessionSubtitle: "join friends session",
    createAGroupCard: "Create a group",
    createGroupSubtitle: "start a group with friends",
    seeAll: "See All",
    yourActiveGroupsHeader: "Your active groups",
    noActiveGroupsYet: "No active groups yet",
    createOrJoinGroupPrompt: "Create a group when the same people will split more than one bill",
    
    // Tabs
    tabSessions: "Sessions",
    tabHistory: "History",
    tabSettings: "Settings",
    
    // Sessions Home
    activeSplitTitle: "Active Split",
    reenterActiveSession: "Re-Enter Active Session",
    removeBtn: "Remove",
    realTimeOcrBadge: "Real-Time OCR Split",
    startNewSplit: "Start a New Split",
    startSplitSub: "Scan receipt with camera or upload a photo from your gallery to split costs instantly.",
    uploadPhoto: "Upload Photo",
    parsing: "Parsing OCR...",
    scanCamera: "Scan Camera",
    manualBtn: "Manual",
    joinViaCode: "Join via Room Code",
    enterCodePlaceholder: "Enter room code",
    joinSessionBtn: "Join Session",
    startSplitBtn: "Start Split",
    joinSessionBtnAction: "Join Session",
    sessionIdLabel: "Session ID",
    codeLabel: "Group Code",

    // Start Split Options
    startSplitTitle: "Start a New Split",
    startSplitSubtitle: "Choose how you want to load the bill",
    scanCameraOption: "Scan Receipt Camera",
    scanCameraDesc: "Snap a photo of the bill instantly",
    uploadPhotoOption: "Upload Image from Gallery",
    uploadPhotoDesc: "Select a receipt screenshot or photo",
    manualSplitOption: "Create Bill Manually",
    manualSplitDesc: "Type in the items and prices yourself",

    // Create Group Modal
    createGroupTitle: "Create Group",
    createGroupSub: "Keep multiple splits with the same people in one place",
    groupNameLabel: "Group Name",
    groupNamePlaceholder: "e.g. Eilat Weekend",
    creatingGroup: "Creating Group...",
    processingBill: "Creating Bill...",

    // Groups Section
    yourActiveGroups: "Your Active Groups ({n})",
    groupsTitle: "Groups",
    groupFallbackLabel: "Group",
    createGroupBtn: "Create Group",
    groupsSub: "Use a group when the same people will split more than one bill.",
    noGroupsYetHint: "💡 Create a group above to start a shared expense tracker with friends!",
    joinGroupBtn: "Join Group",
    enterGroupCodePlaceholder: "Enter 8-digit group code",
    tripExpenseTracker: "Group Expense Tracker",
    addBillsToGroup: "Add Bills to {groupName}",
    groupHeroSub: "Upload scans or manual bills anytime. Balances update & minimize automatically!",
    debtMinimizationTitle: "Debt Minimization Settlement",
    minimizedPaymentsCount: "{n} MINIMIZED PAYMENT(S)",
    memberNetBalances: "MEMBER NET BALANCES",
    allExpensesSettled: "All group expenses are settled! No debts owed. 🎉",
    groupPastBills: "Group Past Bills ({n})",
    tapPastBillNotice: "Tap past bill to claim items",
    noBillsYetGroup: "No bills added to this group yet. Use the buttons above to scan or create a bill!",
    paidByLabel: "Paid by {name}",
    liveSessionBtn: "Live Session",
    splitAllEqually: "Split All Equally",
    tapMemberChipNotice: "Tap member chip on an item to claim item share:",
    attachBillTitle: "Attach Bill to Group",
    attachBillSub: "Add this bill to a trip or roommate group",
    selectGroupLabel: "Select Your Group",
    enterGroupCodeLabel: "Enter 8-Digit Group Code",
    attachBtn: "Attach Bill 🔗",

    // History Tab
    pastHistoryTitle: "Past Splits History",
    totalExpenses: "Total expenses",
    recentBills: "Recent bills",
    recentBillsTitle: "Recent bills",
    splitsCount: "Splits {count}",
    noHistoryYet: "No settled splits yet. Completed splits will appear here.",
    noBillHistoryFound: "No bill history found.",
    deleteBtn: "Delete",
    storeLabel: "Store",
    dateLabel: "Date",
    totalLabel: "Total",
    membersCountLabel: "{n} members",

    // Settings Tab
    settingsTitle: "Account Settings",
    personalInfoSection: "Personal info",
    editPersonalInfo: "Personal info",
    editLabel: "Edit",
    displayNameLabel: "Display Name",
    phoneNumberLabel: "Phone Number",
    phoneInputPlaceholder: "050-1234567",
    phoneLabel: "Phone Number (for Bit/Paybox transfers)",
    phoneHint: "Required to receive payments from group members",
    preferencesSection: "Preferences",
    preferredCurrencyLabel: "Preferred Currency",
    languageSectionLabel: "Language / שפה",
    themeModeLabel: "App Theme Mode",
    lightModeBtn: "Light",
    darkModeBtn: "Dark Mode",
    hebrewLangBtn: "עברית (Hebrew)",
    englishLangBtn: "English",
    saveSettingsBtn: "Save Settings",
    settingsSavedMsg: "Settings Saved!",
    signOutBtn: "Sign Out",
    signInWithGoogle: "Sign in with Google",
    signedInAsGoogle: "Signed in as {email}",
    googleAccountConnected: "Google Account Connected",
    switchGoogleAccount: "Switch Account",
    connectGoogleAccount: "Connect Google Account",
    connectGoogleDesc: "Sign in with Google to sync your groups, splits, and history across all your devices.",
    phoneFormatHint: "Enter a valid 10-digit mobile number starting with 05",
    profilePhotoLabel: "Profile Picture",
    changePhotoBtn: "Change Profile Photo",
    removePhotoBtn: "Remove Photo",
    nameInputPlaceholder: "e.g. Naor",

    // Workspace & Session Screen
    roomMembersTitle: "Room Members",
    inviteBtn: "Invite",
    receiptItemsTitle: "Receipt Items",
    tapItemToClaim: "Tap item to claim & split cost",
    splitAllBtn: "Split All",
    availableLabel: "Available",
    claimedByLabel: "Claimed by {name}",
    splitBetweenLabel: "Split between {count}",
    yourShareLabel: "Your Share",
    settleAndPayBtn: "Settle & Pay",
    finishAndPayBtn: "Finish and Pay",
    youSuffix: "(You)",
    hostBadge: "HOST",

    // Modals
    welcomeTitle: "Welcome to BillSplit",
    enterNameSub: "Enter your display name to join the room:",
    namePlaceholder: "e.g. Sarah",
    joinRoomBtn: "Join Room",
    
    hostPhoneTitle: "Host Phone Number",
    hostPhoneSub: "Enter phone number for instant Bit/Paybox transfers:",
    savePhoneBtn: "Save Phone Number",

    addCustomItemTitle: "Add Custom Item",
    itemNameLabel: "Item Name",
    priceLabel: "Price",
    categoryLabel: "Category",
    cancelBtn: "Cancel",
    addItemBtn: "Add Item",

    // Settle Modal
    finalSettlementTitle: "Final Settlement",
    selectTipLabel: "Select Tip Percentage",
    itemsSubtotalLabel: "Items Subtotal",
    tipAmountLabel: "Tip ({pct}%)",
    yourTotalDueLabel: "Your Total Due",
    payHostTitle: "Pay Room Host ({hostName})",
    payWithBitBtn: "Pay with Bit 📲",
    payWithPayboxBtn: "Pay with Paybox 📦",
    markAsSettledBtn: "Mark as Settled ✨",
    settledBadge: "Settled ✓",
    archiveSessionBtn: "Close & Archive Session to History",
    settleAndCloseSessionBtn: "Settle Payment & Close Session",
    paymentMethodsTitle: "Choose payment method",
    selectPayerForPaymentNote: "Select a participant who paid to enable Bit and Paybox.",
    payerDoesNotPaySelfNote: "You are marked as the payer; the other participants can pay you.",
    finishContinueBtn: "Finish / Continue",
    finishingLabel: "Finished!",

    // QR Code Modal
    scanToJoinTitle: "Scan to Join Room",
    shareRoomTitle: "Invite Friends to Room",
    tabQrCode: "QR Code",
    tabShareLink: "Share Link",
    tabAddFriend: "Add Friend",
    scanCameraWifiHint: "Scan with phone camera to join instantly",
    directRoomUrl: "Direct Room URL",
    shareBtn: "Share",
    friendsDisplayName: "Friend's Display Name",
    friendAddedToRoom: "Friend added to room! ✓",
    addFriendToRoomBtn: "Add Friend to Room",
    generatingQr: "Generating QR code...",
    copiedMsg: "Copied!",
    closeBtn: "Close",
    friendsScanSub: "Friends scan with their camera to join",
    fourDigitSessionCodeLabel: "8-Digit Session Code",
    copyLinkBtn: "Copy Link",
    copiedLinkMsg: "Copied Link!",
    shareLinkBtn: "Share Link",

    // Scanner & Manual Entry
    receiptScannerTitle: "Camera Receipt OCR",
    presetPrompt: "Position bill within frame & tap shutter to scan",
    createBillManually: "Create Bill Manually",
    manualEntryTitle: "Create Custom Split Bill",
    manualEntrySub: "Enter bill title, choose currency, and add items manually.",
    billTitleLabel: "Bill / Venue Title",
    billTitlePlaceholder: "e.g. Sushi Dinner with Friends",
    quickPresetsLabel: "Quick Preset Items",
    createAndStartSessionBtn: "Create & Launch Session ✨",
    editItemTitle: "Edit Receipt Item",
    updateItemBtn: "Update Item",
    deleteItemBtn: "Delete Item",
    customGeminiKeyLabel: "Personal Gemini API Key (Optional)",
    customGeminiKeyHint: "Use your own free Gemini API key to avoid rate limits.",
    ocrEngineLabel: "Default OCR Engine",
    engineTesseract: "⚡ Free Client-Side OCR (Unlimited, 0$)",
    engineGemini: "✨ Gemini AI Vision (Custom API Key)",

    // Categories & Financial Summary
    personalFinancialSummary: "Personal Financial Summary",
    liveBreakdown: "Live Breakdown",
    catDining: "Dining & Drinks",
    catGroceries: "Groceries",
    catTravel: "Travel & Stay",
    catEntertainment: "Entertainment",
    catGeneral: "General & Other",
    catOther: "Other",
    catFood: "Food & Dining",
    catDrinks: "Drinks & Bar",
    catTransport: "Transport",
    catShopping: "Shopping",
    catBeverages: "Beverages",
    catDessert: "Dessert",
    catService: "Service",
    splitsWord: "splits",
    activeGroupsCountLabel: "{n} Active Groups",
    splitsCountLabel: "{n} Splits",
    totalSpentLabel: "Total Spent",
    billAttachedToGroup: "Bill Attached to Group",
    linkedBadge: "LINKED ✓",
    eachLabel: "each",
    deleteGroupItem: "Delete Group",
    shareGroupItem: "Share Group",
    seeGroupDetails: "See Group Details",
    backToOptions: "Back to Options",
    whoPaidUpfront: "Who to transfer to?",
    whoPaidLabel: "Who to transfer to?",
    whoPaidShort: "Transfer to?",
    eachPaidShareOption: "Each paid their share",
    eachPaidShare: "Each paid their own share",
    eachPaidShareSub: "Each pays their own share directly",
    eachPaidShareModalNote: "Everyone pays the vendor directly. Mark your share once paid.",
    youArePayerNote: "You paid upfront! Other room members will settle their shares with you.",
    settleWithPayerNote: "Please send your share to {name}.",
    payerPhoneNotSetNote: "{name} has not added a payment phone number yet.",
    confirmLeaveGroup: "Are you sure you want to leave this group?",
    leaveGroup: "Leave Group",
    leaveGroupItem: "Leave Group",
    leaveGroupSuccess: "You have left the group.",
    groupOptionsTitle: "Group Options",
    ocrScanningTitle: "Scanning receipt",
    ocrStage1: "Preparing receipt...",
    ocrStage2: "Reading items and prices...",
    ocrStage3: "Checking receipt totals...",
    ocrPoweredBy: "Powered by Real-Time Browser & AI OCR",
    receiptReviewTitle: "Compare every row with the receipt before confirming",
    receiptItemsShown: "Items shown: {amount}",
    receiptPrintedTotal: "Printed total: {amount}",
    receiptPrintedUnverified: "Printed total was not verified",
    receiptReviewFlags: "Review flags: {flags}",
    receiptAdjustedPolicy: "Printed tax, service, or discount is spread proportionally across claimed items. Edit item prices to net amounts if the adjustment belongs to specific rows.",
    receiptSourceAlt: "Receipt source {index}",
    confirmReceiptContinue: "Confirm receipt & continue",
    receiptEditedMismatchWarning: "Your edits no longer match the printed total. Review the changed rows, then click confirm once more to acknowledge the mismatch.",
    receiptEditedMismatchConfirm: "The edited rows still do not match the printed total. Click confirm again only if the receipt image supports these values.",
    reviewEditedReceiptBtn: "Review changed total",
    paymentAllocationLocked: "Items, payer and tip are locked while a member is marked paid. That member can reopen their share before further edits.",
    reopenMyShareBtn: "Reopen My Share",
    receiptNeedsReviewMissingTotal: "The printed receipt total could not be verified. Review the scanned items before splitting.",
    receiptNeedsReviewMismatch: "The scanned items total {itemsTotal}, while the receipt shows {receiptTotal}. Edit any OCR mistakes before splitting.",
    receiptAdjustmentLabel: "Receipt tax / service / discount",
    secureGroupInviteText: "Join our bill splitting room with this secure link.",
    secureGroupQrAlt: "QR code for secure group invite",
    recognizedItemsTitle: "Recognized Items",
    subtotalLabel: "Subtotal",
    totalBillLabel: "Total Bill",
    billNickNameLabel: "Bill's Name",
    continueBtn: "Continue",
    categoryFood: "Food & Dining 🍕",
    categoryCoffee: "Coffee & Drinks ☕",
    categoryGroceries: "Groceries 🛒",
    categoryTravel: "Travel & Trips ✈️",
    categoryOther: "General / Other 🏷️",

    // Alerts & Messages
    codeNotFound: "Room code not found. Please check the code.",
    couldNotParse: "Could not parse receipt image. Please take a clear, well-lit photo or enter items manually.",
    errorUploading: "Error uploading receipt image."
  },

  he: {
    appName: "BillSplit",
    tagline: "חלוקת חשבונות מהירה בזמן אמת עם חברים",
    welcomeBack: "ברוך שובך",
    helloUser: "שלום {name}",
    splitBillSubtitle: "חלקו את החשבון בקלות עם EasySplit",
    startSplitCard: "פיצול חשבון",
    letTryItNow: "סרקו או העלו קבלה",
    joinSessionViaCode: "הצטרפות לפי קוד",
    joinSessionSubtitle: "הצטרפו לחשבון חברים",
    createAGroupCard: "יצירת קבוצה",
    createGroupSubtitle: "פתחו קבוצה עם חברים",
    seeAll: "הצג הכל",
    yourActiveGroupsHeader: "הקבוצות הפעילות שלך",
    noActiveGroupsYet: "אין קבוצות פעילות עדיין",
    createOrJoinGroupPrompt: "צרו קבוצה כשאותה חבורה עומדת לבצע כמה חלוקות",
    
    // Tabs
    tabSessions: "חדרים",
    tabHistory: "היסטוריה",
    tabSettings: "הגדרות",
    
    // Sessions Home
    activeSplitTitle: "חלוקה פעילה",
    reenterActiveSession: "חזור לחדר הפעיל",
    removeBtn: "הסר",
    realTimeOcrBadge: "סריקת קבלה בזמן אמת",
    startNewSplit: "התחל חלוקה חדשה",
    startSplitSub: "סרקו קבלה במצלמה או העלו תמונה מהגלריה לפענוח פריטים מיידי.",
    uploadPhoto: "העלאת תמונה",
    parsing: "מפענח OCR...",
    scanCamera: "סריקה במצלמה",
    manualBtn: "ידני",
    joinViaCode: "הצטרפות באמצעות קוד חדר",
    enterCodePlaceholder: "הזן קוד חדר",
    joinSessionBtn: "הצטרף לחדר",
    startSplitBtn: "התחל חלוקה",
    joinSessionBtnAction: "הצטרף לחדר",
    sessionIdLabel: "מזהה חדר",
    codeLabel: "קוד קבוצה",

    // Start Split Options
    startSplitTitle: "התחל חלוקה חדשה",
    startSplitSubtitle: "בחר כיצד ברצונך להעלות את החשבונית",
    scanCameraOption: "סריקת קבלה במצלמה",
    scanCameraDesc: "צלמו תמונה של הקבלה באופן מיידי",
    uploadPhotoOption: "העלאת תמונה מהגלריה",
    uploadPhotoDesc: "בחרו צילום מסך או תמונה של קבלה",
    manualSplitOption: "יצירת חשבונית ידנית",
    manualSplitDesc: "הקלידו את הפריטים והמחירים בעצמכם",

    // Create Group Modal
    createGroupTitle: "צור קבוצה",
    createGroupSub: "רכזו כמה חלוקות עם אותה חבורה במקום אחד",
    groupNameLabel: "שם הקבוצה",
    groupNamePlaceholder: "למשל: סופ״ש באילת",
    creatingGroup: "יוצר קבוצה...",
    processingBill: "יוצר חשבון...",

    // Groups Section
    yourActiveGroups: "הקבוצות הפעילות שלך ({n})",
    groupsTitle: "קבוצות",
    groupFallbackLabel: "קבוצה",
    createGroupBtn: "צור קבוצה",
    groupsSub: "השתמשו בקבוצה כשאותה חבורה עומדת לבצע יותר מחלוקה אחת.",
    noGroupsYetHint: "💡 צרו קבוצה למעלה כדי להתחיל מעקב הוצאות משותף עם חברים!",
    joinGroupBtn: "הצטרף לקבוצה",
    enterGroupCodePlaceholder: "הזן קוד קבוצה בן 8 ספרות",
    tripExpenseTracker: "מעקב הוצאות קבוצתי",
    addBillsToGroup: "הוספת חשבונות ל{groupName}",
    groupHeroSub: "סרקו קבלות או הזינו חשבונות. היתרות מתעדכנות ומצטמצמות אוטומטית!",
    debtMinimizationTitle: "סיכום וצמצום חובות",
    minimizedPaymentsCount: "{n} תשלומים מצומצמים",
    memberNetBalances: "יתרות נטו של החברים",
    allExpensesSettled: "כל ההוצאות הקבוצתיות סודרו! אין חובות. 🎉",
    groupPastBills: "חשבונות עבר בקבוצה ({n})",
    tapPastBillNotice: "לחץ על חשבון עבר כדי לבחור פריטים",
    noBillsYetGroup: "עדיין לא נוספו חשבונות לקבוצה זו. השתמשו בכפתורים למעלה כדי לסרוק או ליצור חשבון!",
    paidByLabel: "שולם ע״י {name}",
    liveSessionBtn: "חדר פעיל",
    splitAllEqually: "חלוקה שווה לכולם",
    tapMemberChipNotice: "לחץ על שם חבר כדי לבחור את חלקו בפריט:",
    attachBillTitle: "שייך חשבון לקבוצה",
    attachBillSub: "הוסף חשבון זה לקבוצת טיול או שותפים",
    selectGroupLabel: "בחר את הקבוצה שלך",
    enterGroupCodeLabel: "הזן קוד קבוצה בן 8 ספרות",
    attachBtn: "שייך חשבון 🔗",

    // History Tab
    pastHistoryTitle: "היסטוריית חלוקות",
    totalExpenses: "סה״כ הוצאות",
    recentBills: "חשבונות אחרונים",
    recentBillsTitle: "חשבונות אחרונים",
    splitsCount: "חלוקות {count}",
    noHistoryYet: "אין עדיין חלוקות ששולמו. חלוקות שהסתיימו יופיעו כאן.",
    noBillHistoryFound: "לא נמצאו חשבונות בהיסטוריה.",
    deleteBtn: "מחק",
    storeLabel: "בית עסק",
    dateLabel: "תאריך",
    totalLabel: "סה״כ",
    membersCountLabel: "{n} משתתפים",

    // Settings Tab
    settingsTitle: "הגדרות חשבון",
    personalInfoSection: "פרטים אישיים",
    editPersonalInfo: "פרטים אישיים",
    editLabel: "עריכה",
    displayNameLabel: "שם לתצוגה",
    phoneNumberLabel: "מספר טלפון",
    phoneInputPlaceholder: "050-1234567",
    phoneLabel: "מספר טלפון (להעברות ביט/פייבוקס)",
    phoneHint: "נדרש לקבלת תשלומים מחברי הקבוצה",
    preferencesSection: "העדפות",
    preferredCurrencyLabel: "מטבע מועדף",
    languageSectionLabel: "שפה",
    themeModeLabel: "מצב תצוגה",
    lightModeBtn: "מצב יום",
    darkModeBtn: "מצב לילה",
    hebrewLangBtn: "עברית (Hebrew)",
    englishLangBtn: "English",
    saveSettingsBtn: "שמור הגדרות",
    settingsSavedMsg: "ההגדרות נשמרו!",
    signOutBtn: "התנתק",
    signInWithGoogle: "התחבר עם Google",
    signedInAsGoogle: "מחובר כ-{email}",
    googleAccountConnected: "חשבון Google מחובר",
    switchGoogleAccount: "החלף חשבון",
    connectGoogleAccount: "חיבור חשבון Google",
    connectGoogleDesc: "התחברו עם Google כדי לסנכרן את הקבוצות, החלוקות וההיסטוריה בכל המכשירים שלכם.",
    phoneFormatHint: "הזינו מספר נייד תקין בן 10 ספרות המתחיל ב-05",
    profilePhotoLabel: "תמונת פרופיל",
    changePhotoBtn: "שינוי תמונה",
    removePhotoBtn: "הסרת תמונה",
    nameInputPlaceholder: "למשל: נאור",

    // Workspace & Session Screen
    roomMembersTitle: "משתתפי החדר",
    inviteBtn: "הזמן",
    receiptItemsTitle: "פריטי החשבונית",
    tapItemToClaim: "לחצו על פריט כדי לבחור ולפצל",
    splitAllBtn: "פצל לכולם",
    availableLabel: "זמין",
    claimedByLabel: "נבחר על ידי {name}",
    splitBetweenLabel: "מתחלק בין {count}",
    yourShareLabel: "החלק שלך",
    settleAndPayBtn: "סיכום ותשלום",
    finishAndPayBtn: "סיום ותשלום",
    youSuffix: "(אתה)",
    hostBadge: "מארח",

    // Modals
    welcomeTitle: "ברוכים הבאים ל-BillSplit",
    enterNameSub: "הזינו שם תצוגה להצטרפות לחדר:",
    namePlaceholder: "למשל: שרה",
    joinRoomBtn: "הצטרף לחדר",
    
    hostPhoneTitle: "מספר טלפון של המארח",
    hostPhoneSub: "הזינו מספר טלפון להעברות בביט/פייבוקס:",
    savePhoneBtn: "שמור מספר טלפון",

    addCustomItemTitle: "הוספת פריט ידנית",
    itemNameLabel: "שם הפריט",
    priceLabel: "מחיר",
    categoryLabel: "קטגוריה",
    cancelBtn: "ביטול",
    addItemBtn: "הוסף פריט",

    // Settle Modal
    finalSettlementTitle: "סיכום חשבון ותשלום",
    selectTipLabel: "בחר אחוז טיפ",
    itemsSubtotalLabel: "סכום ביניים לפריטים",
    tipAmountLabel: "טיפ ({pct}%)",
    yourTotalDueLabel: "הסכום לתשלום שלך",
    payHostTitle: "שלם למארח החדר ({hostName})",
    payWithBitBtn: "שלם ב-Bit 📲",
    payWithPayboxBtn: "שלם ב-Paybox 📦",
    markAsSettledBtn: "סמן כשולם ✨",
    settledBadge: "שולם ✓",
    archiveSessionBtn: "סגור והעבר להיסטוריה",
    settleAndCloseSessionBtn: "סיכום תשלום וסגירת חדר",
    paymentMethodsTitle: "בחירת אמצעי תשלום",
    selectPayerForPaymentNote: "יש לבחור מי מהמשתתפים שילם כדי להפעיל Bit ו-Paybox.",
    payerDoesNotPaySelfNote: "סומנת כמי ששילם; שאר המשתתפים יכולים להעביר אליך.",
    finishContinueBtn: "סיום / המשך",
    finishingLabel: "החשבון נסגר!",

    // QR Code Modal
    scanToJoinTitle: "סרקו להצטרפות לחדר",
    shareRoomTitle: "הזמנת חברים לחדר",
    tabQrCode: "קוד QR",
    tabShareLink: "שיתוף קישור",
    tabAddFriend: "הוספת חבר",
    scanCameraWifiHint: "סרקו באמצעות מצלמת הטלפון להצטרפות מיידית",
    directRoomUrl: "קישור ישיר לחדר",
    shareBtn: "שיתוף",
    friendsDisplayName: "שם החבר לתצוגה",
    friendAddedToRoom: "החבר נוסף לחדר בהצלחה! ✓",
    addFriendToRoomBtn: "הוסף חבר לחדר",
    generatingQr: "מייצר קוד QR...",
    copiedMsg: "הועתק!",
    closeBtn: "סגור",
    friendsScanSub: "חברים סורקים במצלמה להצטרפות מיידית",
    fourDigitSessionCodeLabel: "קוד חדר בן 8 ספרות",
    copyLinkBtn: "העתק קישור",
    copiedLinkMsg: "הקישור הועתק!",
    shareLinkBtn: "שתף קישור",

    // Scanner & Manual Entry
    receiptScannerTitle: "סורק קבלות במצלמה",
    presetPrompt: "כוון את הקבלה למסגרת ולחץ על הלחצן לסריקה",
    createBillManually: "יצירת חשבונית ידנית",
    manualEntryTitle: "צור חלוקת חשבון ידנית",
    manualEntrySub: "הזינו שם מקום, בחרו מטבע והוסיפו פריטים ידנית.",
    billTitleLabel: "שם המקום / החשבון",
    billTitlePlaceholder: "למשל: סושי עם חברים",
    quickPresetsLabel: "פריטים מהירים",
    createAndStartSessionBtn: "צור ופתח חדר ✨",
    editItemTitle: "עריכת פריט בחשבונית",
    updateItemBtn: "עדכן פריט",
    deleteItemBtn: "מחק פריט",
    customGeminiKeyLabel: "מפתח Gemini API אישי (אופציונלי)",
    customGeminiKeyHint: "השתמשו במפתח Gemini בחינם שלכם כדי להימנע ממגבלות שימוש.",
    ocrEngineLabel: "מנוע פענוח OCR",
    engineTesseract: "⚡ OCR מקומי בחינם (ללא הגבלה, 0$)",
    engineGemini: "✨ Gemini AI Vision (מפתח אישי)",

    // Categories & Financial Summary
    personalFinancialSummary: "סיכום פיננסי אישי",
    liveBreakdown: "פירוט הוצאות",
    catDining: "מסעדות ושתייה",
    catGroceries: "קניות בסופר",
    catTravel: "נסיעות ולינה",
    catEntertainment: "בילויים ופנאי",
    catGeneral: "כללי ואחר",
    catOther: "אחר",
    catFood: "אוכל ומסעדות",
    catDrinks: "שתייה וברים",
    catTransport: "תחבורה",
    catShopping: "קניות וביגוד",
    catBeverages: "שתייה",
    catDessert: "קינוחים",
    catService: "שירות",
    splitsWord: "חלוקות",
    activeGroupsCountLabel: "{n} קבוצות פעילות",
    splitsCountLabel: "{n} חלוקות",
    totalSpentLabel: "סה״כ הוצאות",
    billAttachedToGroup: "חשבון משויך לקבוצה",
    linkedBadge: "מקושר ✓",
    eachLabel: "לכל אחד",
    deleteGroupItem: "מחק קבוצה",
    shareGroupItem: "שתף קבוצה",
    seeGroupDetails: "צפה בפרטי קבוצה",
    backToOptions: "חזור לאפשרויות",
    whoPaidUpfront: "אל מי להעביר?",
    whoPaidLabel: "אל מי להעביר?",
    whoPaidShort: "אל מי להעביר?",
    eachPaidShareOption: "כל אחד שילם את חלקו",
    eachPaidShare: "כל אחד שילם את חלקו",
    eachPaidShareSub: "כל אחד משלם את חלקו ישירות",
    eachPaidShareModalNote: "כל אחד משלם ישירות למקום. סמנו את החלק שלכם לאחר התשלום.",
    youArePayerNote: "אתה רשום כמשלם! שאר המשתתפים יעבירו אליך את החלק שלהם.",
    settleWithPayerNote: "נא להעביר את החלק שלך ל-{name}.",
    payerPhoneNotSetNote: "{name} טרם הגדיר/ה מספר טלפון לתשלום.",
    singlePayerSub: "{name} שילם מראש",
    confirmLeaveGroup: "האם אתה בטוח שברצונך לעזוב את הקבוצה?",
    leaveGroup: "עזוב קבוצה",
    leaveGroupItem: "עזוב קבוצה",
    leaveGroupSuccess: "עזבת את הקבוצה בהצלחה.",
    groupOptionsTitle: "אפשרויות קבוצה",
    ocrScanningTitle: "סורק חשבונית",
    ocrStage1: "מכין ומנתח את החשבונית...",
    ocrStage2: "קורא שורות פריטים ומחירים...",
    ocrStage3: "מאמת ומחשב סיכומי חשבון...",
    ocrPoweredBy: "מופעל באמצעות בינה מלאכותית ו-OCR בזמן אמת",
    receiptReviewTitle: "יש להשוות כל שורה לקבלה לפני האישור",
    receiptItemsShown: "סכום הפריטים: {amount}",
    receiptPrintedTotal: "הסכום המודפס: {amount}",
    receiptPrintedUnverified: "הסכום המודפס לא אומת",
    receiptReviewFlags: "סימונים לבדיקה: {flags}",
    receiptAdjustedPolicy: "מס, דמי שירות או הנחה מודפסים מחולקים באופן יחסי בין הפריטים שסומנו. אם ההתאמה שייכת לפריטים מסוימים, יש לערוך את מחיריהם לסכום נטו.",
    receiptSourceAlt: "צילום קבלה {index}",
    confirmReceiptContinue: "אישור הקבלה והמשך",
    receiptEditedMismatchWarning: "השינויים כבר אינם תואמים לסכום המודפס. יש לבדוק את השורות ששונו ואז ללחוץ שוב כדי לאשר את הפער.",
    receiptEditedMismatchConfirm: "השורות הערוכות עדיין אינן תואמות לסכום המודפס. יש לאשר שוב רק אם צילום הקבלה תומך בערכים האלה.",
    reviewEditedReceiptBtn: "בדיקת הסכום ששונה",
    paymentAllocationLocked: "הפריטים, המשלם והטיפ נעולים כל עוד חבר מסומן כשולם. אותו חבר יכול לפתוח מחדש את החלק שלו לפני עריכות נוספות.",
    reopenMyShareBtn: "פתיחת החלק שלי מחדש",
    receiptNeedsReviewMissingTotal: "לא ניתן היה לאמת את הסכום הכולל המודפס. יש לבדוק את הפריטים שנסרקו לפני החלוקה.",
    receiptNeedsReviewMismatch: "סכום הפריטים שנסרקו הוא {itemsTotal}, בעוד שבקבלה מופיע {receiptTotal}. יש לתקן שגיאות OCR לפני החלוקה.",
    receiptAdjustmentLabel: "מס, שירות או הנחה מהקבלה",
    secureGroupInviteText: "הצטרפו לחדר חלוקת החשבון באמצעות הקישור המאובטח הזה.",
    secureGroupQrAlt: "קוד QR להזמנה מאובטחת לקבוצה",
    recognizedItemsTitle: "פריטי החשבונית",
    subtotalLabel: "סכום ביניים",
    totalBillLabel: "סה״כ לתשלום",
    billNickNameLabel: "שם החשבון",
    continueBtn: "המשך",
    categoryFood: "אוכל ומסעדות 🍕",
    categoryCoffee: "קפה ומשקאות ☕",
    categoryGroceries: "סופר וקניות 🛒",
    categoryTravel: "טיולים וחופשות ✈️",
    categoryOther: "כללי / אחר 🏷️",

    // Alerts & Messages
    codeNotFound: "קוד החדר לא נמצא. אנא בדוק את הקוד.",
    couldNotParse: "לא ניתן לפענח את הקבלה. אנא צלם תמונה ברורה או הזן פריטים ידנית.",
    errorUploading: "שגיאה בהעלאת תמונת הקבלה."
  }
};

export const CURRENCY_SYMBOLS: Record<string, string> = {
  NIS: "₪",
  ILS: "₪",
  USD: "$",
  EUR: "€",
  GBP: "£"
};

// Base mapping: Number of units of currency per 1 USD
export const LIVE_RATES_FROM_USD: Record<string, number> = {
  USD: 1.0,
  NIS: 3.65,
  ILS: 3.65,
  EUR: 0.92,
  GBP: 0.78
};

export function updateLiveExchangeRates(newRates: Record<string, number>) {
  if (newRates && typeof newRates === 'object') {
    Object.keys(newRates).forEach((k) => {
      const val = newRates[k];
      if (typeof val === 'number' && val > 0) {
        LIVE_RATES_FROM_USD[k.toUpperCase()] = val;
      }
    });
  }
}

export function normalizeCurrencyCode(curr: string): string {
  if (!curr) return 'NIS';
  const c = String(curr).trim().toUpperCase();
  if (c.includes('$') || c.includes('USD') || c.includes('DOLLAR')) return 'USD';
  if (c.includes('₪') || c.includes('NIS') || c.includes('ILS') || c.includes('SHEKEL')) return 'NIS';
  if (c.includes('€') || c.includes('EUR') || c.includes('EURO')) return 'EUR';
  if (c.includes('£') || c.includes('GBP') || c.includes('POUND')) return 'GBP';
  return 'NIS';
}

export function formatCurrency(amount: number, currency: string = "NIS"): string {
  const code = normalizeCurrencyCode(currency);
  const num = typeof amount === "number" ? amount : parseFloat(amount as any) || 0;
  const roundedNum = Math.round((num + Number.EPSILON) * 100) / 100;
  const formattedStr = roundedNum.toFixed(2);
  const symbol = CURRENCY_SYMBOLS[code] || (code === 'NIS' ? '₪' : '$');
  
  if (code === "NIS" || code === "ILS") {
    return `₪${formattedStr}`;
  }
  if (code === "USD") {
    return `$${formattedStr}`;
  }
  if (code === "EUR") {
    return `€${formattedStr}`;
  }
  if (code === "GBP") {
    return `£${formattedStr}`;
  }
  return `${symbol}${formattedStr}`;
}

export function convertCurrency(amount: number, fromCurrency: string, toCurrency: string): number {
  const from = normalizeCurrencyCode(fromCurrency);
  const to = normalizeCurrencyCode(toCurrency);
  const num = typeof amount === "number" ? amount : parseFloat(amount as any) || 0;

  if (from === to || isNaN(num)) {
    return Math.round((num + Number.EPSILON) * 100) / 100;
  }

  const defaultRates: Record<string, number> = {
    USD: 1.0,
    NIS: 3.65,
    ILS: 3.65,
    EUR: 0.92,
    GBP: 0.78
  };

  const fromRateInUSD = (typeof LIVE_RATES_FROM_USD[from] === 'number' && LIVE_RATES_FROM_USD[from] > 0)
    ? LIVE_RATES_FROM_USD[from]
    : (defaultRates[from] || 1.0);

  const toRateInUSD = (typeof LIVE_RATES_FROM_USD[to] === 'number' && LIVE_RATES_FROM_USD[to] > 0)
    ? LIVE_RATES_FROM_USD[to]
    : (defaultRates[to] || 1.0);

  // Calculate: (amount / fromRateInUSD) * toRateInUSD
  const amountInUSD = num / fromRateInUSD;
  const converted = amountInUSD * toRateInUSD;

  return Math.round((converted + Number.EPSILON) * 100) / 100;
}

export function formatDualPrice(
  amount: number,
  billCurrency: string = 'NIS',
  userCurrency: string = 'NIS'
): { primary: string; secondary?: string } {
  try {
    const rawVal = typeof amount === 'number' ? amount : parseFloat(amount as any) || 0;
    const val = Math.round((rawVal + Number.EPSILON) * 100) / 100;
    const bCurr = normalizeCurrencyCode(billCurrency);
    const uCurr = normalizeCurrencyCode(userCurrency);

    const primary = formatCurrency(val, bCurr);
    if (!uCurr || bCurr === uCurr) {
      return { primary };
    }
    const converted = convertCurrency(val, bCurr, uCurr);
    const secondary = formatCurrency(converted, uCurr);
    return { primary, secondary };
  } catch (err) {
    const rawVal = typeof amount === 'number' ? amount : parseFloat(amount as any) || 0;
    return { primary: `₪${rawVal.toFixed(2)}` };
  }
}

export default translations;

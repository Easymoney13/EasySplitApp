from pathlib import Path

path = Path('src/app/group/[id]/page.tsx')
text = path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    text = text.replace(old, new, 1)


replace_once(
    '          <h1 className="font-extrabold text-base text-slate-900 dark:text-white tracking-tight truncate">{group.name}</h1>',
    """          <h1
            className="font-black text-[17px] text-slate-900 dark:text-white tracking-normal leading-none truncate"
            style={{ fontFamily: 'var(--font-heebo)' }}
          >
            {group.name}
          </h1>""",
    'group title typography',
)

replace_once(
    '      <div className="relative overflow-hidden rounded-[24px] p-5 bg-gradient-to-br from-brand-500 via-brand-700 to-brand-950 text-white border border-brand-700 shadow-brand space-y-4">',
    '      <div className="relative overflow-hidden rounded-[24px] p-5 bg-gradient-to-br from-brand-500 via-brand-700 to-brand-950 text-white border border-brand-700 shadow-md space-y-3">',
    'active group card shell',
)
replace_once(
    '        <div className="brand-peach-glow absolute -top-16 -right-10 h-52 w-52 rounded-full opacity-70" aria-hidden="true" />',
    '        <div className="brand-peach-glow absolute -top-16 -right-10 h-52 w-52 rounded-full opacity-35" aria-hidden="true" />',
    'active group flair',
)
replace_once(
    "            <h2 className=\"text-2xl font-black text-white tracking-tight leading-tight mt-1\">{formatCurrency(totalGroupSpent, group.currency || 'NIS')}</h2>",
    "            <h2 className=\"text-3xl font-black text-white tracking-tight leading-tight mt-1\">{formatCurrency(totalGroupSpent, group.currency || 'NIS')}</h2>",
    'active group amount size',
)

replace_once(
    """        {isGroupActive && (
          <button
            type="button"
            onClick={() => {
              setShowStartSplitModal(true);
              triggerHaptic('medium');
            }}
            className="relative z-10 w-full py-3.5 px-6 rounded-full bg-white hover:bg-slate-100 text-slate-950 font-black text-xs shadow-md active:scale-[0.98] transition-all flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4 text-brand-600" />
            <span>{isRtl ? 'חלוקה חדשה' : 'New Split'}</span>
          </button>
        )}

""",
    '',
    'legacy in-card new split button',
)

replace_once(
    """      </div>

      {/* Splits — the group is an overview; item claiming stays in the live Split screen. */}""",
    """      </div>

      {isGroupActive && (
        <button
          type="button"
          onClick={() => {
            setShowStartSplitModal(true);
            triggerHaptic('medium');
          }}
          className="home-start-card brand-tap w-full py-4 px-6 rounded-[18px] text-white font-black text-sm shadow-md active:scale-[0.98] transition-all flex items-center justify-center gap-2.5"
        >
          <Camera className="w-5 h-5" />
          <span>{isRtl ? 'סריקת קבלה' : 'Scan receipt'}</span>
        </button>
      )}

      {/* Splits — the group is an overview; item claiming stays in the live Split screen. */}""",
    'primary scan receipt CTA placement',
)

replace_once(
    """        {validBills.length === 0 ? (
          <div className="rounded-[24px] p-6 bg-white dark:bg-brand-950 border border-slate-200/80 dark:border-slate-800 text-center space-y-2 shadow-xs">
            <FileText className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600" />
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {isRtl ? 'עוד אין חלוקות בקבוצה. התחילו מהכפתור למעלה.' : 'No splits yet. Start the first one from the button above.'}
            </p>
          </div>
        ) : (""",
    """        {validBills.length === 0 ? (
          <div className="rounded-[24px] p-6 bg-white dark:bg-brand-950 border border-slate-200/80 dark:border-slate-800 text-center space-y-3 shadow-xs">
            <div className="w-12 h-12 mx-auto rounded-2xl bg-brand-50 dark:bg-brand-900/70 border border-brand-100 dark:border-brand-800 flex items-center justify-center">
              <FileText className="w-6 h-6 text-brand-400 dark:text-brand-300" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-black text-slate-900 dark:text-white">
                {isRtl ? 'עוד אין חלוקות' : 'No splits yet'}
              </p>
              <p className="text-[11px] font-medium leading-relaxed text-slate-500 dark:text-slate-400 max-w-xs mx-auto">
                {isRtl ? 'סרקו את הקבלה הראשונה כדי לחלץ את הפריטים וליצור חלוקה.' : 'Scan your first receipt to extract the items and create a split.'}
              </p>
            </div>
            {isGroupActive && (
              <button
                type="button"
                onClick={() => {
                  setShowStartSplitModal(true);
                  triggerHaptic('light');
                }}
                className="mx-auto py-2.5 px-4 rounded-xl border border-brand-200 dark:border-brand-700 text-brand-700 dark:text-brand-200 bg-brand-50/60 dark:bg-brand-900/40 font-extrabold text-[11px] flex items-center justify-center gap-2 active:scale-[0.98]"
              >
                <Camera className="w-4 h-4" />
                <span>{isRtl ? 'סריקת קבלה ראשונה' : 'Scan first receipt'}</span>
              </button>
            )}
          </div>
        ) : (""",
    'empty state receipt CTA',
)

path.write_text(text)

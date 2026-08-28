// ---------- Translation dictionary ----------
// Every user-facing string in the app lives here, keyed the same in both languages.
export const translations = {
  ar: {
    // Brand
    appTitle: "استوديو الدوبلاج",
    appTagline: "قسّم، سجّل، صدّر — بترتيب اللقطات",

    // Upload stage
    videoFileLabel: "ملف الفيديو",
    videoFileHint: "MP4, MOV, WEBM",
    videoFileUploaded: "تم الرفع — اضغط للتغيير",
    srtFileLabel: "ملف الترجمة",
    srtFileHint: ".srt فقط",
    srtFileUploaded: "تم التحليل — اضغط للتغيير",
    srtLineCount: (n) => `${n} سطر ترجمة`,
    detectedCharacters: (n, names) => `✓ لقيت ${n} شخصية بالأسماء تلقائياً (${names})`,
    noDetectedCharacters: "ما لقيت أسماء شخصيات بالملف — بتقدر تعيّنها يدوياً بالخطوة الجاية",
    nextCharactersBtn: "التالي: الشخصيات",

    // Characters stage
    charactersTitle: "الشخصيات",
    charactersSub: "ضيف الشخصيات وعيّن كل سطر حوار",
    assignedProgress: (done, total) => `${done} / ${total} معيّنة`,
    newCharacterPlaceholder: "اسم شخصية جديدة...",
    addBtn: "+ إضافة",
    noCharacters: "ما ضفت شخصيات بعد",
    unassignedOption: "— بدون —",
    backBtn: "رجوع",
    startRecordingBtn: "ابدأ التسجيل",

    // Studio stage — sidebar
    charactersSidebarTitle: "الشخصيات",
    allFilter: "الكل",
    overallProgressLabel: "الإنجاز الكلي",
    downloadRecordingsBtn: "تنزيل التسجيلات",
    finalScreenBtn: "الشاشة النهائية",

    // Studio stage — main panel
    prevBtn: "◀ السابق",
    nextBtn: "التالي ▶",
    onAirLabel: "ON AIR — جاري التسجيل",
    originalAudioLegend: "صوت الفيديو الأصلي",
    yourVoiceLegend: "صوتك الآن",
    recordBtn: "سجّل هذا المقطع",
    stopRecordingBtn: "إيقاف التسجيل",
    autoSyncBtn: "مزامنة تلقائية",
    cleanupBtn: "تنظيف الصوت",
    cleanCompareTitle: "مقارنة: الأصلي مقابل المنظّف",
    beforeLabel: "قبل",
    afterLabel: "بعد",
    useCleanedBtn: "استخدم النسخة المنظّفة",
    discardBtn: "تجاهل",
    micErrorGeneric: "ما قدرت أوصل للمايك. تأكد من صلاحيات المتصفح.",
    autoSyncError: "ما قدرت أسوي مزامنة تلقائية لهذا المقطع.",
    cleanupError: "ما قدرت أنظّف الصوت لهذا المقطع.",
    reviewPlaybackError: "ما قدر المتصفح يشغل المعاينة. جرب تضغط تشغيل مرة ثانية.",
    recordedProgress: (done, total, character) =>
      `${done} / ${total} مسجّلة${character ? ` — ${character}` : ""}`,

    // Review stage
    finalScreenTitle: "الشاشة النهائية",
    finalScreenSub: "معاينة الفيديو مع كل الأصوات المسجّلة بمواضعها",
    backToRecordingBtn: "رجوع للتسجيل",
    playFullVideoHint: "تشغيل كامل الفيديو مع الدوبلاج",
    timelineTitle: "المسار الزمني",
    notRecordedYet: "لم تُسجّل بعد",
    missingLabel: "ناقصة",
    exportTitle: "تصدير الفيديو النهائي",
    exportHint: "يدمج كل الأصوات المسجّلة مع الفيديو الأصلي بملف واحد جاهز.",
    exportBtn: "تصدير الفيديو النهائي (MP4)",
    reExportBtn: "إعادة تصدير الفيديو (تغيّرت التسجيلات)",
    loadingFFmpeg: "تحميل أدوات المعالجة...",
    mergingAudio: "دمج الأصوات...",
    muxingProgress: (pct) => `دمج الصوت مع الفيديو... ${pct}%`,
    exportError: "صار خطأ أثناء التصدير. جرب مرة ثانية أو تأكد إن كل الأسطر مسجّلة.",
    videoReady: "الفيديو جاهز",
    downloadFinalVideoBtn: "تنزيل الفيديو النهائي",
    downloadRecordingsIndividualBtn: "تنزيل التسجيلات منفردة (اختياري)",

    // Top bar controls
    themeToggleToDark: "الوضع الداكن",
    themeToggleToLight: "الوضع الفاتح",
    langToggle: "English",
  },

  en: {
    // Brand
    appTitle: "Dubbing Studio",
    appTagline: "Split, record, export — in shot order",

    // Upload stage
    videoFileLabel: "Video file",
    videoFileHint: "MP4, MOV, WEBM",
    videoFileUploaded: "Uploaded — click to change",
    srtFileLabel: "Subtitle file",
    srtFileHint: ".srt only",
    srtFileUploaded: "Parsed — click to change",
    srtLineCount: (n) => `${n} subtitle lines`,
    detectedCharacters: (n, names) => `✓ Found ${n} named characters automatically (${names})`,
    noDetectedCharacters: "No character names found in the file — you can assign them manually in the next step",
    nextCharactersBtn: "Next: Characters",

    // Characters stage
    charactersTitle: "Characters",
    charactersSub: "Add characters and assign each line of dialogue",
    assignedProgress: (done, total) => `${done} / ${total} assigned`,
    newCharacterPlaceholder: "New character name...",
    addBtn: "+ Add",
    noCharacters: "No characters added yet",
    unassignedOption: "— None —",
    backBtn: "Back",
    startRecordingBtn: "Start recording",

    // Studio stage — sidebar
    charactersSidebarTitle: "Characters",
    allFilter: "All",
    overallProgressLabel: "Overall progress",
    downloadRecordingsBtn: "Download recordings",
    finalScreenBtn: "Final screen",

    // Studio stage — main panel
    prevBtn: "◀ Prev",
    nextBtn: "Next ▶",
    onAirLabel: "ON AIR — Recording",
    originalAudioLegend: "Original video audio",
    yourVoiceLegend: "Your voice now",
    recordBtn: "Record this line",
    stopRecordingBtn: "Stop recording",
    autoSyncBtn: "Auto-sync",
    cleanupBtn: "Clean up audio",
    cleanCompareTitle: "Compare: original vs. cleaned",
    beforeLabel: "Before",
    afterLabel: "After",
    useCleanedBtn: "Use cleaned version",
    discardBtn: "Discard",
    micErrorGeneric: "Couldn't access the mic. Check your browser permissions.",
    autoSyncError: "Couldn't auto-sync this line.",
    cleanupError: "Couldn't clean up this line's audio.",
    reviewPlaybackError: "The browser couldn't play the preview. Try pressing play again.",
    recordedProgress: (done, total, character) =>
      `${done} / ${total} recorded${character ? ` — ${character}` : ""}`,

    // Review stage
    finalScreenTitle: "Final screen",
    finalScreenSub: "Preview the video with every recording in place",
    backToRecordingBtn: "Back to recording",
    playFullVideoHint: "Play the full video with the dub",
    timelineTitle: "Timeline",
    notRecordedYet: "Not recorded yet",
    missingLabel: "Missing",
    exportTitle: "Export final video",
    exportHint: "Merges every recording with the original video into one file.",
    exportBtn: "Export final video (MP4)",
    reExportBtn: "Re-export video (recordings changed)",
    loadingFFmpeg: "Loading processing tools...",
    mergingAudio: "Merging audio...",
    muxingProgress: (pct) => `Merging audio with video... ${pct}%`,
    exportError: "Something went wrong during export. Try again, or check that every line is recorded.",
    videoReady: "Video ready",
    downloadFinalVideoBtn: "Download final video",
    downloadRecordingsIndividualBtn: "Download recordings individually (optional)",

    // Top bar controls
    themeToggleToDark: "Dark mode",
    themeToggleToLight: "Light mode",
    langToggle: "العربية",
  },
};

export function useTranslation(lang) {
  const dict = translations[lang] || translations.ar;
  return (key, ...args) => {
    const entry = dict[key];
    if (typeof entry === "function") return entry(...args);
    return entry ?? key;
  };
}

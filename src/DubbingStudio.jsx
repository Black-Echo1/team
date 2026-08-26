import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Upload, Play, Pause, Mic, Square, Check, Trash2, Download, Users, Film, ChevronRight, RotateCcw, X, FileText, Loader2, Smartphone } from "lucide-react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

// ---------- Merge all recordings into a single audio track (Web Audio API) ----------
async function mergeRecordingsToWav(srtLines, recordings, totalDuration) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  const sampleRate = ctx.sampleRate;
  const outLength = Math.ceil(totalDuration * sampleRate);
  const outBuffer = ctx.createBuffer(2, outLength, sampleRate);

  const indices = Object.keys(recordings).map(Number);
  for (const idx of indices) {
    const rec = recordings[idx];
    const line = srtLines[idx];
    if (!rec || !line) continue;
    const arrayBuffer = await rec.blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    const startSample = Math.floor(line.start * sampleRate);

    for (let ch = 0; ch < 2; ch++) {
      const outData = outBuffer.getChannelData(ch);
      const inData = decoded.getChannelData(Math.min(ch, decoded.numberOfChannels - 1));
      for (let i = 0; i < inData.length; i++) {
        const outIdx = startSample + i;
        if (outIdx >= 0 && outIdx < outData.length) {
          outData[outIdx] += inData[i]; // mix (in case of overlap)
        }
      }
    }
  }

  // Encode outBuffer as WAV
  return audioBufferToWavBlob(outBuffer);
}

function audioBufferToWavBlob(buffer) {
  const numCh = buffer.numberOfChannels;
  const length = buffer.length * numCh * 2 + 44;
  const arrBuf = new ArrayBuffer(length);
  const view = new DataView(arrBuf);
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + buffer.length * numCh * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, buffer.length * numCh * 2, true);

  let offset = 44;
  const channels = [];
  for (let ch = 0; ch < numCh; ch++) channels.push(buffer.getChannelData(ch));
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      let sample = Math.max(-1, Math.min(1, channels[ch][i]));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }
  return new Blob([arrBuf], { type: "audio/wav" });
}

// ---------- SRT parsing ----------
function parseSRT(text) {
  const blocks = text.replace(/\r/g, "").trim().split(/\n\n+/);
  const lines = [];
  for (const block of blocks) {
    const rows = block.split("\n").filter(Boolean);
    if (rows.length < 2) continue;
    const timeRow = rows.find(r => r.includes("-->"));
    if (!timeRow) continue;
    const [startStr, endStr] = timeRow.split("-->").map(s => s.trim());
    const start = srtTimeToSeconds(startStr);
    const end = srtTimeToSeconds(endStr);
    const textRows = rows.slice(rows.indexOf(timeRow) + 1);
    let raw = textRows.join(" ").trim();

    // Try to detect speaker patterns: "(Name) dialogue" or "Name: dialogue"
    let speaker = null;
    let dialogue = raw;
    const parenMatch = raw.match(/^[（(]([^）)]{1,20})[）)]\s*(.+)$/);
    const colonMatch = raw.match(/^([\u0600-\u06FFA-Za-z0-9_ .'-]{1,20})[:：]\s*(.+)$/);
    if (parenMatch) {
      speaker = parenMatch[1].trim();
      dialogue = parenMatch[2].trim();
    } else if (colonMatch) {
      speaker = colonMatch[1].trim();
      dialogue = colonMatch[2].trim();
    }
    lines.push({ start, end, raw, speaker, dialogue });
  }
  return lines;
}

function srtTimeToSeconds(t) {
  const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  const [, h, mi, s, ms] = m;
  return (+h) * 3600 + (+mi) * 60 + (+s) + (+ms) / 1000;
}

function formatTime(s) {
  if (!isFinite(s)) return "00:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

const PALETTE = ["#E8A33D", "#5B8A9A", "#B5563C", "#7A8C5C", "#8A6BA8", "#4A7A6E", "#C97A56", "#5C6E9C"];

function InstallBadge({ onClick, visible }) {
  if (!visible) return null;
  return (
    <button style={S.installBadge} onClick={onClick} aria-label="تحميل التطبيق">
      <Smartphone size={20} strokeWidth={2} />
      <span style={S.installBadgeLabel}>تحميل التطبيق</span>
    </button>
  );
}

export default function DubbingStudio() {
  const [stage, setStage] = useState("upload"); // upload -> characters -> studio
  const [videoURL, setVideoURL] = useState(null);
  const [videoFile, setVideoFile] = useState(null);
  const [srtLines, setSrtLines] = useState([]);
  const [characters, setCharacters] = useState([]); // {name, color}
  const [lineAssignments, setLineAssignments] = useState({}); // index -> character name
  const [activeCharacter, setActiveCharacter] = useState(null); // null = all
  const [currentIdx, setCurrentIdx] = useState(0);
  const [recordings, setRecordings] = useState({}); // index -> {blob, url, duration}
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [micError, setMicError] = useState(null);
  const [newCharName, setNewCharName] = useState("");
  const [assignMode, setAssignMode] = useState(false);

  const videoRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const fileInputRef = useRef(null);
  const srtInputRef = useRef(null);
  const streamRef = useRef(null);

  // ---------- PWA install badge ----------
  const [installPromptEvent, setInstallPromptEvent] = useState(null);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    setIsStandalone(standalone);

    const onBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setInstallPromptEvent(e);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  const isIOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent);

  const handleInstallClick = async () => {
    if (installPromptEvent) {
      installPromptEvent.prompt();
      await installPromptEvent.userChoice;
      setInstallPromptEvent(null);
    } else if (isIOS) {
      alert("للتثبيت على آيفون: اضغط زر المشاركة 🔗 بالأسفل ثم اختر \"إضافة إلى الشاشة الرئيسية\".");
    } else {
      alert("افتح قائمة المتصفح ⋮ ثم اختر \"إضافة إلى الشاشة الرئيسية\" أو \"تثبيت التطبيق\".");
    }
  };

  const handleVideoUpload = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setVideoFile(f);
    setVideoURL(URL.createObjectURL(f));
  };

  const handleSrtUpload = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = parseSRT(String(ev.target.result));
      setSrtLines(parsed);

      // Auto-detect characters from "Name:" patterns
      const foundNames = [...new Set(parsed.filter(l => l.speaker).map(l => l.speaker))];
      if (foundNames.length > 0) {
        const chars = foundNames.map((name, i) => ({ name, color: PALETTE[i % PALETTE.length] }));
        setCharacters(chars);
        const assignments = {};
        parsed.forEach((l, i) => { if (l.speaker) assignments[i] = l.speaker; });
        setLineAssignments(assignments);
      }
    };
    reader.readAsText(f, "UTF-8");
  };

  const canProceedToCharacters = videoURL && srtLines.length > 0;

  const addCharacter = () => {
    const name = newCharName.trim();
    if (!name || characters.some(c => c.name === name)) return;
    setCharacters([...characters, { name, color: PALETTE[characters.length % PALETTE.length] }]);
    setNewCharName("");
  };

  const removeCharacter = (name) => {
    setCharacters(characters.filter(c => c.name !== name));
    const next = { ...lineAssignments };
    Object.keys(next).forEach(k => { if (next[k] === name) delete next[k]; });
    setLineAssignments(next);
  };

  const assignLine = (idx, name) => {
    setLineAssignments(prev => ({ ...prev, [idx]: name }));
  };

  const unassignedCount = srtLines.length - Object.keys(lineAssignments).length;

  // ---------- Studio stage ----------
  const filteredIndices = useMemo(() => {
    return srtLines
      .map((l, i) => i)
      .filter(i => !activeCharacter || lineAssignments[i] === activeCharacter);
  }, [srtLines, lineAssignments, activeCharacter]);

  const currentLine = srtLines[currentIdx];
  const currentCharName = currentIdx != null ? lineAssignments[currentIdx] : null;
  const currentChar = characters.find(c => c.name === currentCharName);

  useEffect(() => {
    if (filteredIndices.length > 0 && !filteredIndices.includes(currentIdx)) {
      setCurrentIdx(filteredIndices[0]);
    }
  }, [activeCharacter]); // eslint-disable-line

  const seekToLine = useCallback((idx) => {
    const line = srtLines[idx];
    if (!line || !videoRef.current) return;
    videoRef.current.currentTime = line.start;
    setCurrentIdx(idx);
  }, [srtLines]);

  const playCurrentClip = () => {
    const line = srtLines[currentIdx];
    if (!line || !videoRef.current) return;
    videoRef.current.currentTime = line.start;
    videoRef.current.play();
    setIsPlaying(true);
    const onTime = () => {
      if (videoRef.current.currentTime >= line.end) {
        videoRef.current.pause();
        setIsPlaying(false);
        videoRef.current.removeEventListener("timeupdate", onTime);
      }
    };
    videoRef.current.addEventListener("timeupdate", onTime);
  };

  const pauseClip = () => {
    videoRef.current?.pause();
    setIsPlaying(false);
  };

  const startRecording = async () => {
    setMicError(null);
    const targetIdx = currentIdx; // freeze which line we're recording, in case state shifts mid-flow
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => chunksRef.current.push(e.data);
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        setRecordings(prev => {
          const old = prev[targetIdx];
          if (old?.url) URL.revokeObjectURL(old.url); // free the previous take so it can't linger/confuse playback
          return {
            ...prev,
            [targetIdx]: { blob, url, duration: srtLines[targetIdx].end - srtLines[targetIdx].start }
          };
        });
        stream.getTracks().forEach(t => t.stop());
      };
      mr.start();
      setIsRecording(true);

      // Play the video clip while recording, for reference.
      // Recording stops automatically the instant the clip ends (or is paused).
      const line = srtLines[targetIdx];
      videoRef.current.currentTime = line.start;
      videoRef.current.muted = true;
      videoRef.current.play();

      const stopBoth = () => {
        videoRef.current.removeEventListener("timeupdate", onTime);
        videoRef.current.removeEventListener("pause", stopBoth);
        videoRef.current.muted = false;
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
        setIsRecording(false);
      };
      const onTime = () => {
        if (videoRef.current.currentTime >= line.end) {
          videoRef.current.pause(); // triggers stopBoth via the 'pause' listener
        }
      };
      videoRef.current.addEventListener("timeupdate", onTime);
      videoRef.current.addEventListener("pause", stopBoth);
    } catch (err) {
      setMicError("ما قدرت أوصل للمايك. تأكد من صلاحيات المتصفح.");
    }
  };

  const stopRecording = () => {
    // Pausing the video triggers the 'pause' listener set up in startRecording,
    // which stops the MediaRecorder and cleans up in one place.
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
    } else {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
    }
  };

  const goNext = () => {
    const pos = filteredIndices.indexOf(currentIdx);
    if (pos >= 0 && pos < filteredIndices.length - 1) {
      seekToLine(filteredIndices[pos + 1]);
    }
  };

  const goPrev = () => {
    const pos = filteredIndices.indexOf(currentIdx);
    if (pos > 0) {
      seekToLine(filteredIndices[pos - 1]);
    }
  };

  const deleteRecording = (idx) => {
    setRecordings(prev => {
      const next = { ...prev };
      delete next[idx];
      return next;
    });
  };

  const recordedCount = Object.keys(recordings).length;
  const totalForFilter = filteredIndices.length;
  const recordedForFilter = filteredIndices.filter(i => recordings[i]).length;

  const downloadAll = () => {
    // Build a manifest + trigger download of each recording
    filteredIndices.forEach((idx) => {
      const rec = recordings[idx];
      if (!rec) return;
      const a = document.createElement("a");
      a.href = rec.url;
      const charLabel = (lineAssignments[idx] || "unknown").replace(/\s+/g, "_");
      a.download = `${String(idx + 1).padStart(3, "0")}_${charLabel}_${formatTime(srtLines[idx].start).replace(":", "-")}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  };

  // ---------- Review stage: play the full video with recordings substituted ----------
  const [reviewPlaying, setReviewPlaying] = useState(false);
  const reviewVideoRef = useRef(null);
  const reviewAudioRef = useRef(null);
  const activeReviewIdxRef = useRef(null);

  const playFullReview = () => {
    if (!reviewVideoRef.current) return;
    reviewVideoRef.current.currentTime = 0;
    reviewVideoRef.current.muted = true; // original character dialogue stays out; video has none anyway
    const p = reviewVideoRef.current.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => {
        console.error("Review playback failed:", err);
        setMicError("ما قدر المتصفح يشغل المعاينة. جرب تضغط تشغيل مرة ثانية.");
      });
    }
    setReviewPlaying(true);
    activeReviewIdxRef.current = null;
  };

  useEffect(() => {
    if (stage !== "review") return;
    const v = reviewVideoRef.current;
    if (!v) return;
    const onTime = () => {
      const t = v.currentTime;
      const idx = srtLines.findIndex(l => t >= l.start && t < l.end);
      if (idx !== activeReviewIdxRef.current) {
        activeReviewIdxRef.current = idx;
        const audioEl = reviewAudioRef.current;
        if (idx >= 0 && recordings[idx] && audioEl) {
          audioEl.src = recordings[idx].url;
          audioEl.currentTime = 0;
          audioEl.play().catch(() => {});
        } else if (audioEl) {
          audioEl.pause();
        }
      }
    };
    const onEnd = () => activeReviewIdxRef.current = null;
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnd);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("ended", onEnd);
    };
  }, [stage, srtLines, recordings]);

  const videoDuration = srtLines.length ? Math.max(...srtLines.map(l => l.end)) : 1;

  // ---------- Export: merge audio, then mux with video via ffmpeg.wasm ----------
  const ffmpegRef = useRef(null);
  const [exportState, setExportState] = useState("idle"); // idle | loading-ffmpeg | merging-audio | muxing | done | error
  const [exportProgress, setExportProgress] = useState(0);
  const [exportURL, setExportURL] = useState(null);
  const [exportError, setExportError] = useState(null);
  const [exportedSnapshot, setExportedSnapshot] = useState(null); // fingerprint of recordings at last successful export

  // Fingerprint the current recordings so we can tell if anything changed since the last export.
  const recordingsFingerprint = useMemo(() => {
    return Object.keys(recordings)
      .sort((a, b) => Number(a) - Number(b))
      .map(idx => `${idx}:${recordings[idx].blob.size}`)
      .join("|");
  }, [recordings]);

  const isExportStale = exportState === "done" && exportedSnapshot !== null && exportedSnapshot !== recordingsFingerprint;

  // If recordings change after a completed export, drop the stale result so the button re-appears.
  useEffect(() => {
    if (exportState === "done" && exportedSnapshot !== null && exportedSnapshot !== recordingsFingerprint) {
      if (exportURL) URL.revokeObjectURL(exportURL);
      setExportURL(null);
      setExportState("idle");
      setExportedSnapshot(null);
    }
  }, [recordingsFingerprint]); // eslint-disable-line

  const getFFmpeg = async () => {
    if (ffmpegRef.current) return ffmpegRef.current;
    const ffmpeg = new FFmpeg();
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
    ffmpeg.on("progress", ({ progress }) => {
      setExportProgress(Math.min(99, Math.round(progress * 100)));
    });
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    });
    ffmpegRef.current = ffmpeg;
    return ffmpeg;
  };

  const exportFinalVideo = async () => {
    setExportError(null);
    setExportURL(null);
    setExportState("loading-ffmpeg");
    setExportProgress(0);
    try {
      const ffmpeg = await getFFmpeg();

      setExportState("merging-audio");
      const wavBlob = await mergeRecordingsToWav(srtLines, recordings, videoDuration + 1);

      setExportState("muxing");
      setExportProgress(0);
      await ffmpeg.writeFile("input.mp4", await fetchFile(videoFile));
      await ffmpeg.writeFile("dub.wav", await fetchFile(wavBlob));

      // Strategy: keep the original video stream fully copied (fast, no re-encode of
      // the whole file). To make sure a dub line that runs slightly long never gets
      // cut off, we generate a tiny separate 1s clip from the video's last frame
      // (only THIS small clip gets encoded), then concat it onto the original video
      // via the concat demuxer with -c copy. Re-encoding only happens on ~1s of
      // footage instead of the entire video, so export stays fast even for long files.
      // If the fast path fails (e.g. source codec/params aren't concat-compatible),
      // we fall back to the slower but always-safe full re-encode with tpad.
      let usedFastPath = true;
      try {
        // 1) Grab the very last frame of the original video as a still image.
        await ffmpeg.exec([
          "-sseof", "-1",
          "-i", "input.mp4",
          "-frames:v", "1",
          "-q:v", "2",
          "lastframe.jpg",
        ]);

        // 2) Turn that still into a 1s video clip matching the original's params,
        //    so the concat below can be done with a plain stream copy.
        await ffmpeg.exec([
          "-loop", "1",
          "-i", "lastframe.jpg",
          "-t", "1",
          "-r", "30",
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-pix_fmt", "yuv420p",
          "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
          "pad.mp4",
        ]);

        // 3) Concat original + 1s padding clip with -c copy (no re-encode of original).
        await ffmpeg.writeFile(
          "concat_list.txt",
          new TextEncoder().encode("file 'input.mp4'\nfile 'pad.mp4'\n")
        );
        await ffmpeg.exec([
          "-f", "concat",
          "-safe", "0",
          "-i", "concat_list.txt",
          "-c", "copy",
          "padded.mp4",
        ]);

        // 4) Mux the padded video (stream copy, no re-encode) with the new dub audio.
        await ffmpeg.exec([
          "-i", "padded.mp4",
          "-i", "dub.wav",
          "-map", "0:v:0",
          "-map", "1:a:0",
          "-c:v", "copy",
          "-c:a", "aac",
          "-shortest",
          "output.mp4",
        ]);
      } catch (fastPathErr) {
        console.warn("Fast copy-based export failed, falling back to re-encode:", fastPathErr);
        usedFastPath = false;
        // Safe fallback: re-encode the whole video, padding 1s of cloned last frame
        // via the tpad filter, so a long dub line never gets cut off.
        await ffmpeg.exec([
          "-i", "input.mp4",
          "-i", "dub.wav",
          "-filter_complex", "[0:v]tpad=stop_mode=clone:stop_duration=1[v]",
          "-map", "[v]",
          "-map", "1:a:0",
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-c:a", "aac",
          "output.mp4",
        ]);
      }
      void usedFastPath; // reserved for future diagnostics/telemetry if needed

      const data = await ffmpeg.readFile("output.mp4");
      const blob = new Blob([data.buffer], { type: "video/mp4" });
      setExportURL(URL.createObjectURL(blob));
      setExportState("done");
      setExportProgress(100);
      setExportedSnapshot(recordingsFingerprint);
    } catch (err) {
      console.error(err);
      setExportError("صار خطأ أثناء التصدير. جرب مرة ثانية أو تأكد إن كل الأسطر مسجّلة.");
      setExportState("error");
    }
  };

  // ---------- RENDER: Upload stage ----------
  if (stage === "upload") {
    return (
      <div style={S.page}>
        <InstallBadge onClick={handleInstallClick} visible={!isStandalone} />
        <div style={S.uploadWrap}>
          <div style={S.brandRow}>
            <div style={S.logoMark}>ص</div>
            <div>
              <div style={S.brandTitle}>استوديو الدوبلاج</div>
              <div style={S.brandSub}>قسّم، سجّل، صدّر — بترتيب اللقطات</div>
            </div>
          </div>

          <div style={S.uploadGrid}>
            <label style={{ ...S.dropZone, ...(videoFile ? S.dropZoneFilled : {}) }}>
              <input ref={fileInputRef} type="file" accept="video/*" onChange={handleVideoUpload} style={{ display: "none" }} />
              <Film size={28} strokeWidth={1.5} color={videoFile ? "#E8A33D" : "#8A8378"} />
              <div style={S.dropTitle}>{videoFile ? videoFile.name : "ملف الفيديو"}</div>
              <div style={S.dropHint}>{videoFile ? "تم الرفع — اضغط للتغيير" : "MP4, MOV, WEBM"}</div>
            </label>

            <label style={{ ...S.dropZone, ...(srtLines.length ? S.dropZoneFilled : {}) }}>
              <input ref={srtInputRef} type="file" accept=".srt" onChange={handleSrtUpload} style={{ display: "none" }} />
              <FileText size={28} strokeWidth={1.5} color={srtLines.length ? "#E8A33D" : "#8A8378"} />
              <div style={S.dropTitle}>{srtLines.length ? `${srtLines.length} سطر ترجمة` : "ملف الترجمة"}</div>
              <div style={S.dropHint}>{srtLines.length ? "تم التحليل — اضغط للتغيير" : ".srt فقط"}</div>
            </label>
          </div>

          {srtLines.length > 0 && (
            <div style={S.detectNote}>
              {characters.length > 0
                ? `✓ لقيت ${characters.length} شخصية بالأسماء تلقائياً (${characters.map(c => c.name).join("، ")})`
                : "ما لقيت أسماء شخصيات بالملف — بتقدر تعيّنها يدوياً بالخطوة الجاية"}
            </div>
          )}

          <button
            style={{ ...S.primaryBtn, opacity: canProceedToCharacters ? 1 : 0.4, pointerEvents: canProceedToCharacters ? "auto" : "none" }}
            onClick={() => setStage("characters")}
          >
            التالي: الشخصيات
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
    );
  }

  // ---------- RENDER: Character setup stage ----------
  if (stage === "characters") {
    return (
      <div style={S.page}>
        <InstallBadge onClick={handleInstallClick} visible={!isStandalone} />
        <div style={S.charWrap}>
          <div style={S.stageHeader}>
            <div>
              <div style={S.stageTitle}>الشخصيات</div>
              <div style={S.stageSub}>ضيف الشخصيات وعيّن كل سطر حوار</div>
            </div>
            <div style={S.progressPill}>
              {Object.keys(lineAssignments).length} / {srtLines.length} معيّنة
            </div>
          </div>

          <div style={S.charAddRow}>
            <input
              style={S.charInput}
              placeholder="اسم شخصية جديدة..."
              value={newCharName}
              onChange={(e) => setNewCharName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCharacter()}
            />
            <button style={S.addBtn} onClick={addCharacter}>+ إضافة</button>
          </div>

          <div style={S.charChips}>
            {characters.map(c => (
              <div key={c.name} style={{ ...S.charChip, borderColor: c.color }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: c.color }} />
                {c.name}
                <span style={S.chipCount}>
                  {Object.values(lineAssignments).filter(v => v === c.name).length}
                </span>
                <X size={13} style={{ cursor: "pointer", opacity: 0.5 }} onClick={() => removeCharacter(c.name)} />
              </div>
            ))}
            {characters.length === 0 && <div style={S.emptyHint}>ما ضفت شخصيات بعد</div>}
          </div>

          <div style={S.linesList}>
            {srtLines.map((line, i) => {
              const assigned = lineAssignments[i];
              const char = characters.find(c => c.name === assigned);
              return (
                <div key={i} style={S.lineRow}>
                  <div style={S.lineTime}>{formatTime(line.start)}</div>
                  <div style={S.lineText}>{line.dialogue}</div>
                  <div style={S.lineAssign}>
                    <select
                      style={{ ...S.select, borderColor: char?.color || "#3A362E" }}
                      value={assigned || ""}
                      onChange={(e) => assignLine(i, e.target.value)}
                    >
                      <option value="">— بدون —</option>
                      {characters.map(c => (
                        <option key={c.name} value={c.name}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={S.footerRow}>
            <button style={S.ghostBtn} onClick={() => setStage("upload")}>رجوع</button>
            <button
              style={{ ...S.primaryBtn, opacity: characters.length ? 1 : 0.4, pointerEvents: characters.length ? "auto" : "none" }}
              onClick={() => { setStage("studio"); setActiveCharacter(characters[0]?.name || null); setCurrentIdx(0); }}
            >
              ابدأ التسجيل
              <Mic size={17} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- RENDER: Studio stage ----------
  if (stage === "studio") {
  return (
    <div style={S.page}>
      <InstallBadge onClick={handleInstallClick} visible={!isStandalone} />
      <div style={S.studioWrap} className="studio-wrap">
        {/* Sidebar: character filter */}
        <div style={S.sidebar} className="studio-sidebar">
          <div style={S.sidebarTitle}><Users size={15} /> الشخصيات</div>
          <button
            style={{ ...S.filterBtn, ...(activeCharacter === null ? S.filterBtnActive : {}) }}
            onClick={() => setActiveCharacter(null)}
          >
            الكل
            <span style={S.filterCount}>{srtLines.length}</span>
          </button>
          {characters.map(c => {
            const count = srtLines.filter((_, i) => lineAssignments[i] === c.name).length;
            const done = srtLines.filter((_, i) => lineAssignments[i] === c.name && recordings[i]).length;
            return (
              <button
                key={c.name}
                style={{
                  ...S.filterBtn,
                  ...(activeCharacter === c.name ? S.filterBtnActive : {}),
                  borderInlineStart: `3px solid ${c.color}`
                }}
                onClick={() => setActiveCharacter(c.name)}
              >
                {c.name}
                <span style={S.filterCount}>{done}/{count}</span>
              </button>
            );
          })}

          <div style={S.sidebarDivider} />
          <div style={S.overallProgress}>
            <div style={S.overallLabel}>الإنجاز الكلي</div>
            <div style={S.progressTrack}>
              <div style={{ ...S.progressFill, width: `${(recordedCount / srtLines.length) * 100}%` }} />
            </div>
            <div style={S.overallNum}>{recordedCount} / {srtLines.length}</div>
          </div>
          <button style={S.downloadBtn} onClick={downloadAll} disabled={recordedForFilter === 0}>
            <Download size={15} /> تنزيل التسجيلات
          </button>
          <button
            style={{ ...S.downloadBtn, background: "#E8A33D", color: "#1C1A16" }}
            onClick={() => setStage("review")}
            disabled={recordedCount === 0}
          >
            <Film size={15} /> الشاشة النهائية
          </button>
        </div>

        {/* Main studio */}
        <div style={S.mainPanel} className="studio-main">
          <video
            ref={videoRef}
            src={videoURL}
            style={S.videoEl}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
          />

          {currentLine && (
            <div style={S.subtitleCard}>
              {currentChar && (
                <div style={{ ...S.subtitleChar, color: currentChar.color }}>{currentChar.name}</div>
              )}
              <div style={S.subtitleText}>{currentLine.dialogue}</div>
              <div style={S.subtitleTime}>{formatTime(currentLine.start)} → {formatTime(currentLine.end)}</div>
            </div>
          )}

          <div style={S.transportRow}>
            <button style={S.transportBtn} onClick={goPrev} disabled={filteredIndices.indexOf(currentIdx) <= 0}>◀ السابق</button>
            <button style={S.playBtn} onClick={isPlaying ? pauseClip : playCurrentClip}>
              {isPlaying ? <Pause size={20} /> : <Play size={20} />}
            </button>
            <button style={S.transportBtn} onClick={goNext} disabled={filteredIndices.indexOf(currentIdx) >= filteredIndices.length - 1}>التالي ▶</button>
          </div>

          <div style={S.recordZone}>
            {micError && <div style={S.errorMsg}>{micError}</div>}
            {!isRecording ? (
              <button style={S.recordBtn} onClick={startRecording}>
                <Mic size={18} /> سجّل هذا المقطع
              </button>
            ) : (
              <button style={S.stopBtn} onClick={stopRecording}>
                <Square size={16} fill="white" /> إيقاف التسجيل
              </button>
            )}

            {recordings[currentIdx] && (
              <div style={S.recordedRow}>
                <Check size={15} color="#7A8C5C" />
                <audio key={recordings[currentIdx].url} controls src={recordings[currentIdx].url} style={S.audioPlayer} />
                <Trash2 size={15} style={{ cursor: "pointer", opacity: 0.6 }} onClick={() => deleteRecording(currentIdx)} />
              </div>
            )}
          </div>

          <div style={S.miniProgress}>{recordedForFilter} / {totalForFilter} مسجّلة {activeCharacter ? `— ${activeCharacter}` : ""}</div>
        </div>
      </div>
    </div>
  );
  }

  // ---------- RENDER: Review / Timeline stage ----------
  if (stage === "review") {
    return (
      <div style={S.page}>
        <InstallBadge onClick={handleInstallClick} visible={!isStandalone} />
        <div style={S.reviewWrap}>
          <div style={S.stageHeader}>
            <div>
              <div style={S.stageTitle}>الشاشة النهائية</div>
              <div style={S.stageSub}>معاينة الفيديو مع كل الأصوات المسجّلة بمواضعها</div>
            </div>
            <button style={S.ghostBtn} onClick={() => setStage("studio")}>رجوع للتسجيل</button>
          </div>

          <video
            ref={reviewVideoRef}
            src={videoURL}
            style={S.videoEl}
            onPlay={() => setReviewPlaying(true)}
            onPause={() => setReviewPlaying(false)}
            onEnded={() => setReviewPlaying(false)}
          />
          <audio ref={reviewAudioRef} style={{ display: "none" }} />

          <div style={S.transportRow}>
            <button style={S.playBtn} onClick={reviewPlaying ? () => reviewVideoRef.current?.pause() : playFullReview}>
              {reviewPlaying ? <Pause size={20} /> : <Play size={20} />}
            </button>
            <div style={{ fontSize: 13, color: "#8A8378" }}>تشغيل كامل الفيديو مع الدوبلاج</div>
          </div>

          {/* Timeline */}
          <div style={S.timelineWrap}>
            <div style={S.timelineTitle}>المسار الزمني</div>
            <div style={S.timelineTrack}>
              {srtLines.map((line, i) => {
                const char = characters.find(c => c.name === lineAssignments[i]);
                const left = (line.start / videoDuration) * 100;
                const width = Math.max(((line.end - line.start) / videoDuration) * 100, 0.6);
                const has = !!recordings[i];
                return (
                  <div
                    key={i}
                    title={`${char?.name || "—"}: ${line.dialogue}`}
                    onClick={() => { seekToLine(i); setStage("studio"); }}
                    style={{
                      ...S.timelineBlock,
                      left: `${left}%`,
                      width: `${width}%`,
                      background: has ? (char?.color || "#7A8C5C") : "transparent",
                      border: has ? "none" : `1.5px dashed ${char?.color || "#6E685D"}`,
                    }}
                  />
                );
              })}
            </div>
            <div style={S.timelineLegend}>
              {characters.map(c => (
                <div key={c.name} style={S.legendItem}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: c.color }} />
                  {c.name}
                </div>
              ))}
              <div style={S.legendItem}>
                <span style={{ width: 9, height: 9, borderRadius: 3, border: "1.5px dashed #6E685D" }} />
                لم تُسجّل بعد
              </div>
            </div>
          </div>

          {/* Line-by-line list */}
          <div style={S.linesList}>
            {srtLines.map((line, i) => {
              const char = characters.find(c => c.name === lineAssignments[i]);
              const rec = recordings[i];
              return (
                <div key={i} style={S.lineRow}>
                  <div style={{ ...S.lineTime, width: 60 }}>{formatTime(line.start)}</div>
                  {char && <span style={{ width: 8, height: 8, borderRadius: 99, background: char.color, flexShrink: 0 }} />}
                  <div style={S.lineText}>{line.dialogue}</div>
                  {rec
                    ? <Check size={15} color="#7A8C5C" style={{ flexShrink: 0 }} />
                    : <span style={{ fontSize: 11, color: "#B5563C", flexShrink: 0 }}>ناقصة</span>}
                </div>
              );
            })}
          </div>

          <div style={S.exportBox}>
            <div style={S.exportTitle}>تصدير الفيديو النهائي</div>
            <div style={S.exportHint}>يدمج كل الأصوات المسجّلة مع الفيديو الأصلي بملف واحد جاهز.</div>

            {exportState === "idle" && (
              <button style={S.exportBtn} onClick={exportFinalVideo}>
                <Film size={16} /> {exportedSnapshot ? "إعادة تصدير الفيديو (تغيّرت التسجيلات)" : "تصدير الفيديو النهائي (MP4)"}
              </button>
            )}

            {(exportState === "loading-ffmpeg" || exportState === "merging-audio" || exportState === "muxing") && (
              <div style={S.exportProgressWrap}>
                <div style={S.exportStatusRow}>
                  <Loader2 size={15} className="spin" style={{ animation: "spin 1s linear infinite" }} />
                  <span>
                    {exportState === "loading-ffmpeg" && "تحميل أدوات المعالجة..."}
                    {exportState === "merging-audio" && "دمج الأصوات..."}
                    {exportState === "muxing" && `دمج الصوت مع الفيديو... ${exportProgress}%`}
                  </span>
                </div>
                <div style={S.progressTrack}>
                  <div style={{ ...S.progressFill, width: exportState === "muxing" ? `${exportProgress}%` : "15%" }} />
                </div>
              </div>
            )}

            {exportState === "error" && (
              <div style={S.errorMsg}>{exportError}</div>
            )}

            {exportState === "done" && exportURL && (
              <div style={S.exportDoneRow}>
                <Check size={16} color="#7A8C5C" />
                <span>الفيديو جاهز</span>
                <a href={exportURL} download="dubbed_final.mp4" style={S.exportDownloadLink}>
                  <Download size={14} /> تنزيل الفيديو النهائي
                </a>
              </div>
            )}
          </div>

          <button style={S.downloadBtn} onClick={downloadAll}>
            <Download size={15} /> تنزيل التسجيلات منفردة (اختياري)
          </button>
        </div>
      </div>
    );
  }
}

// ---------- Design tokens ----------
const S = {
  installBadge: {
    position: "fixed",
    bottom: 18,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 50,
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "#E8A33D",
    color: "#1C1A16",
    border: "none",
    borderRadius: 999,
    padding: "10px 18px",
    fontFamily: "'Tajawal', 'Segoe UI', sans-serif",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    boxShadow: "0 6px 18px rgba(232, 163, 61, 0.35)",
  },
  installBadgeLabel: { whiteSpace: "nowrap" },
  page: {
    minHeight: "100vh",
    background: "#1C1A16",
    color: "#EDE7DA",
    fontFamily: "'Tajawal', 'Segoe UI', sans-serif",
    direction: "rtl",
    display: "flex",
    justifyContent: "center",
    padding: "24px 16px 96px",
    boxSizing: "border-box",
  },
  uploadWrap: { width: "100%", maxWidth: 560 },
  brandRow: { display: "flex", alignItems: "center", gap: 14, marginBottom: 32 },
  logoMark: {
    width: 44, height: 44, borderRadius: 12, background: "linear-gradient(135deg, #E8A33D, #B5563C)",
    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 700, color: "#1C1A16",
  },
  brandTitle: { fontSize: 20, fontWeight: 700, letterSpacing: 0.2 },
  brandSub: { fontSize: 13, color: "#8A8378", marginTop: 2 },
  uploadGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 },
  dropZone: {
    border: "1.5px dashed #3A362E", borderRadius: 14, padding: "28px 16px", cursor: "pointer",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center",
    transition: "all 0.15s", background: "#211F1A",
  },
  dropZoneFilled: { borderColor: "#E8A33D", borderStyle: "solid", background: "#252118" },
  dropTitle: { fontSize: 14, fontWeight: 600, color: "#EDE7DA" },
  dropHint: { fontSize: 12, color: "#6E685D" },
  detectNote: {
    fontSize: 13, color: "#B5A98C", background: "#211F1A", border: "1px solid #3A362E",
    borderRadius: 10, padding: "10px 14px", marginBottom: 20, lineHeight: 1.6,
  },
  primaryBtn: {
    width: "100%", background: "#E8A33D", color: "#1C1A16", border: "none", borderRadius: 12,
    padding: "14px 20px", fontSize: 15, fontWeight: 700, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
  },
  ghostBtn: {
    background: "transparent", color: "#B5A98C", border: "1px solid #3A362E", borderRadius: 12,
    padding: "12px 20px", fontSize: 14, fontWeight: 600, cursor: "pointer",
  },

  charWrap: { width: "100%", maxWidth: 720 },
  stageHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 },
  stageTitle: { fontSize: 20, fontWeight: 700 },
  stageSub: { fontSize: 13, color: "#8A8378", marginTop: 3 },
  progressPill: { fontSize: 12, background: "#252118", border: "1px solid #3A362E", borderRadius: 99, padding: "6px 12px", color: "#B5A98C" },
  charAddRow: { display: "flex", gap: 8, marginBottom: 14 },
  charInput: {
    flex: 1, background: "#211F1A", border: "1px solid #3A362E", borderRadius: 10, padding: "10px 14px",
    color: "#EDE7DA", fontSize: 14, outline: "none",
  },
  addBtn: { background: "#3A362E", color: "#EDE7DA", border: "none", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  charChips: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 },
  charChip: {
    display: "flex", alignItems: "center", gap: 7, border: "1px solid", borderRadius: 99,
    padding: "6px 12px", fontSize: 13, background: "#211F1A",
  },
  chipCount: { fontSize: 11, color: "#8A8378" },
  emptyHint: { fontSize: 13, color: "#6E685D", fontStyle: "italic" },
  linesList: { maxHeight: 380, overflowY: "auto", border: "1px solid #3A362E", borderRadius: 12, marginBottom: 20 },
  lineRow: {
    display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid #2A271F",
  },
  lineTime: { fontSize: 11, color: "#6E685D", width: 44, flexShrink: 0, fontVariantNumeric: "tabular-nums" },
  lineText: { flex: 1, fontSize: 13, color: "#D8D1C2", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  lineAssign: { flexShrink: 0 },
  select: {
    background: "#211F1A", border: "1.5px solid", borderRadius: 8, padding: "5px 8px",
    color: "#EDE7DA", fontSize: 12, outline: "none",
  },
  footerRow: { display: "flex", gap: 10, justifyContent: "space-between" },

  studioWrap: { width: "100%", maxWidth: 900, display: "flex", gap: 16 },

  reviewWrap: { width: "100%", maxWidth: 760, display: "flex", flexDirection: "column", gap: 16 },
  timelineWrap: { background: "#211F1A", border: "1px solid #3A362E", borderRadius: 12, padding: 16 },
  timelineTitle: { fontSize: 12, color: "#8A8378", fontWeight: 600, marginBottom: 10 },
  timelineTrack: {
    position: "relative", height: 34, background: "#181613", borderRadius: 8, overflow: "hidden",
  },
  timelineBlock: {
    position: "absolute", top: 3, bottom: 3, borderRadius: 4, cursor: "pointer",
    minWidth: 3,
  },
  timelineLegend: { display: "flex", flexWrap: "wrap", gap: 14, marginTop: 12 },
  legendItem: { display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#B5A98C" },

  exportBox: { background: "#211F1A", border: "1px solid #3A362E", borderRadius: 12, padding: 16 },
  exportTitle: { fontSize: 14, fontWeight: 700, marginBottom: 4 },
  exportHint: { fontSize: 12, color: "#8A8378", marginBottom: 12 },
  exportBtn: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%",
    background: "#E8A33D", color: "#1C1A16", border: "none", borderRadius: 10, padding: "12px",
    fontSize: 14, fontWeight: 700, cursor: "pointer",
  },
  exportProgressWrap: { display: "flex", flexDirection: "column", gap: 8 },
  exportStatusRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#D8D1C2" },
  exportDoneRow: { display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#D8D1C2" },
  exportDownloadLink: {
    display: "flex", alignItems: "center", gap: 6, background: "#3A362E", color: "#EDE7DA",
    borderRadius: 8, padding: "7px 12px", fontSize: 12.5, textDecoration: "none", marginInlineStart: "auto",
  },
  sidebar: {
    width: 220, flexShrink: 0, background: "#211F1A", border: "1px solid #3A362E", borderRadius: 14,
    padding: 14, display: "flex", flexDirection: "column", gap: 6, height: "fit-content",
  },
  sidebarTitle: { fontSize: 12, color: "#8A8378", display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontWeight: 600 },
  filterBtn: {
    display: "flex", justifyContent: "space-between", alignItems: "center", background: "transparent",
    border: "none", borderRadius: 8, padding: "9px 10px", color: "#B5A98C", fontSize: 13, cursor: "pointer",
    textAlign: "right", width: "100%",
  },
  filterBtnActive: { background: "#2A271F", color: "#EDE7DA", fontWeight: 700 },
  filterCount: { fontSize: 11, color: "#6E685D" },
  sidebarDivider: { height: 1, background: "#3A362E", margin: "8px 0" },
  overallProgress: { padding: "4px 10px 10px" },
  overallLabel: { fontSize: 11, color: "#8A8378", marginBottom: 6 },
  progressTrack: { height: 5, background: "#2A271F", borderRadius: 99, overflow: "hidden" },
  progressFill: { height: "100%", background: "#7A8C5C", borderRadius: 99, transition: "width 0.3s" },
  overallNum: { fontSize: 11, color: "#6E685D", marginTop: 5 },
  downloadBtn: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 7, background: "#2A271F",
    border: "1px solid #3A362E", borderRadius: 10, padding: "10px", color: "#EDE7DA", fontSize: 12.5,
    fontWeight: 600, cursor: "pointer", marginTop: 4,
  },

  mainPanel: { flex: 1, display: "flex", flexDirection: "column", gap: 14 },
  videoEl: { width: "100%", borderRadius: 14, background: "#000", maxHeight: 380, objectFit: "contain" },
  subtitleCard: {
    background: "#211F1A", border: "1px solid #3A362E", borderRadius: 12, padding: "14px 18px",
  },
  subtitleChar: { fontSize: 12, fontWeight: 700, marginBottom: 4 },
  subtitleText: { fontSize: 16, lineHeight: 1.6, color: "#EDE7DA" },
  subtitleTime: { fontSize: 11, color: "#6E685D", marginTop: 6, fontVariantNumeric: "tabular-nums" },
  transportRow: { display: "flex", alignItems: "center", justifyContent: "center", gap: 14 },
  transportBtn: {
    background: "transparent", border: "1px solid #3A362E", borderRadius: 10, padding: "9px 16px",
    color: "#B5A98C", fontSize: 13, cursor: "pointer",
  },
  playBtn: {
    width: 46, height: 46, borderRadius: 99, background: "#E8A33D", color: "#1C1A16", border: "none",
    display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
  },
  recordZone: { display: "flex", flexDirection: "column", alignItems: "center", gap: 10 },
  recordBtn: {
    display: "flex", alignItems: "center", gap: 8, background: "#B5563C", color: "white", border: "none",
    borderRadius: 12, padding: "13px 26px", fontSize: 14.5, fontWeight: 700, cursor: "pointer",
  },
  stopBtn: {
    display: "flex", alignItems: "center", gap: 8, background: "#7A3226", color: "white", border: "none",
    borderRadius: 12, padding: "13px 26px", fontSize: 14.5, fontWeight: 700, cursor: "pointer",
    animation: "pulse 1.5s infinite",
  },
  errorMsg: { fontSize: 12, color: "#D97757" },
  recordedRow: { display: "flex", alignItems: "center", gap: 10, background: "#211F1A", borderRadius: 10, padding: "8px 12px" },
  audioPlayer: { height: 32, maxWidth: 220 },
  miniProgress: { textAlign: "center", fontSize: 12, color: "#6E685D" },
};

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Upload, Play, Pause, Mic, Square, Check, Trash2, Download, Users, Film, ChevronRight, RotateCcw, X, FileText, Loader2 } from "lucide-react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

// ---------- Silence detection + trimming (basic auto-sync, no AI) ----------
async function decodeBlobToAudioBuffer(blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  const arrayBuffer = await blob.arrayBuffer();
  const decoded = await ctx.decodeAudioData(arrayBuffer);
  ctx.close();
  return decoded;
}

// Finds the sample range that contains audio above a noise-floor threshold,
// trimming leading/trailing silence so the recording lines up with its target duration.
function findTrimRange(buffer, thresholdRatio = 0.02) {
  const data = buffer.getChannelData(0);
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i]);
    if (v > max) max = v;
  }
  const threshold = Math.max(max * thresholdRatio, 0.005);

  let start = 0;
  while (start < data.length && Math.abs(data[start]) < threshold) start++;
  let end = data.length - 1;
  while (end > start && Math.abs(data[end]) < threshold) end--;

  // small padding so we don't clip the start/end of speech
  const pad = Math.floor(buffer.sampleRate * 0.05);
  start = Math.max(0, start - pad);
  end = Math.min(data.length - 1, end + pad);
  return { start, end };
}

function sliceAudioBuffer(buffer, startSample, endSample) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  const length = Math.max(1, endSample - startSample);
  const out = ctx.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch).subarray(startSample, endSample);
    out.getChannelData(ch).set(src);
  }
  ctx.close();
  return out;
}

// Auto-sync a single recording: trims silence, then if it's still longer than the
// target duration, applies a light speed adjustment (never more than ~15%) so it
// fits without noticeable pitch distortion. Returns a new Blob + whether it was stretched.
async function autoSyncRecording(blob, targetDuration) {
  const decoded = await decodeBlobToAudioBuffer(blob);
  const { start, end } = findTrimRange(decoded);
  let trimmed = sliceAudioBuffer(decoded, start, end);

  const trimmedDuration = trimmed.length / trimmed.sampleRate;
  let stretched = false;
  let rate = 1;
  if (trimmedDuration > targetDuration && targetDuration > 0) {
    rate = trimmedDuration / targetDuration;
    if (rate > 1.15) rate = 1.15; // cap stretch so voice doesn't distort badly
    stretched = rate > 1.02;
  }

  if (stretched) {
    // Simple resample-based time-stretch (changes pitch slightly, but capped small).
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const newLength = Math.floor(trimmed.length / rate);
    const offlineCtx = new OfflineAudioContext(trimmed.numberOfChannels, newLength, trimmed.sampleRate);
    const src = offlineCtx.createBufferSource();
    src.buffer = trimmed;
    src.playbackRate.value = rate;
    src.connect(offlineCtx.destination);
    src.start();
    trimmed = await offlineCtx.startRendering();
    ctx.close();
  }

  return { blob: audioBufferToWavBlob(trimmed), stretched, originalDuration: trimmedDuration };
}

// ---------- Spectral noise reduction: learns a noise profile from the recording's
// quietest moments, then subtracts that frequency profile from the whole signal.
// This targets steady hums (fan, electrical buzz, room hiss) much better than a
// simple amplitude gate, while staying dependency-free (own small FFT below).
// ---------------------------------------------------------------------------

// Minimal in-place radix-2 FFT (iterative, Cooley-Tukey). `re`/`im` are Float32Arrays
// of length = power of two. Set `inverse` true for the inverse transform.
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 1 : -1) * 2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe; curIm = nextIm;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

// Denoises a single channel using frame-by-frame spectral subtraction with 50% overlap-add.
function denoiseChannel(data, sampleRate) {
  const FRAME = 2048; // power of two
  const HOP = FRAME / 2;
  const window = hannWindow(FRAME);
  const out = new Float32Array(data.length);
  const frameCount = Math.max(1, Math.floor((data.length - FRAME) / HOP) + 1);

  // --- Step 1: build a noise magnitude profile from the quietest ~15% of frames ---
  // (steady background noise is present everywhere; the quietest frames are mostly
  // just that noise, with little or no voice on top — a standard, simple estimate.)
  const frameEnergies = [];
  const magnitudes = [];
  for (let f = 0; f < frameCount; f++) {
    const start = f * HOP;
    const re = new Float32Array(FRAME);
    const im = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) re[i] = (data[start + i] || 0) * window[i];
    fft(re, im, false);
    const mag = new Float32Array(FRAME / 2);
    let energy = 0;
    for (let i = 0; i < FRAME / 2; i++) {
      mag[i] = Math.hypot(re[i], im[i]);
      energy += mag[i];
    }
    magnitudes.push(mag);
    frameEnergies.push(energy);
  }

  const sortedIdx = frameEnergies.map((e, i) => i).sort((a, b) => frameEnergies[a] - frameEnergies[b]);
  const noiseFrameCount = Math.max(1, Math.floor(frameCount * 0.15));
  const noiseProfile = new Float32Array(FRAME / 2);
  for (let k = 0; k < noiseFrameCount; k++) {
    const mag = magnitudes[sortedIdx[k]];
    for (let i = 0; i < FRAME / 2; i++) noiseProfile[i] += mag[i] / noiseFrameCount;
  }

  // --- Step 2: subtract the noise profile from every frame's spectrum, then rebuild via overlap-add ---
  // Two changes vs. a naive spectral-subtraction pass, both aimed at "musical noise"
  // (the crackling/warbling artifact this kind of filter is notorious for):
  //   1. Gentler, floor-protected subtraction per frequency bin (no over-aggressive OVER_SUBTRACT).
  //   2. Smoothing the gain envelope across consecutive frames per bin, so the amount
  //      of reduction doesn't jump abruptly frame-to-frame — abrupt per-frame changes
  //      are exactly what produces the crackling/warble.
  const OVER_SUBTRACT = 1.0; // subtract the noise profile at unity, not amplified
  const FLOOR = 0.25; // keep a larger residual than before — much safer against artifacts
  const SMOOTHING = 0.6; // 0 = no smoothing, closer to 1 = heavier smoothing across frames
  const prevGain = new Float32Array(FRAME / 2).fill(1);

  for (let f = 0; f < frameCount; f++) {
    const start = f * HOP;
    const re = new Float32Array(FRAME);
    const im = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) re[i] = (data[start + i] || 0) * window[i];
    fft(re, im, false);

    for (let i = 0; i < FRAME / 2; i++) {
      const mag = Math.hypot(re[i], im[i]);
      const phase = Math.atan2(im[i], re[i]);

      // Desired gain for this bin this frame (0..1), then smoothed against the
      // previous frame's gain for this same bin to avoid frame-to-frame jumps.
      const targetMag = Math.max(mag - noiseProfile[i] * OVER_SUBTRACT, mag * FLOOR);
      const targetGain = mag > 1e-8 ? targetMag / mag : 1;
      const gain = SMOOTHING * prevGain[i] + (1 - SMOOTHING) * targetGain;
      prevGain[i] = gain;

      const newMag = mag * gain;
      re[i] = newMag * Math.cos(phase);
      im[i] = newMag * Math.sin(phase);
      // mirror for the negative-frequency half (real signal symmetry)
      const mi = FRAME - i;
      if (mi < FRAME && mi !== i) {
        re[mi] = newMag * Math.cos(-phase);
        im[mi] = newMag * Math.sin(-phase);
      }
    }

    fft(re, im, true);
    for (let i = 0; i < FRAME; i++) {
      const s = start + i;
      if (s < out.length) out[s] += re[i] * window[i];
    }
  }

  // Overlap-add with a Hann window at 50% hop sums to a constant ~1.5 gain; correct for it.
  const compensation = 1 / 1.5;
  for (let i = 0; i < out.length; i++) out[i] *= compensation;
  return out;
}

async function cleanupRecording(blob) {
  const decoded = await decodeBlobToAudioBuffer(blob);
  const numCh = decoded.numberOfChannels;

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  const out = ctx.createBuffer(numCh, decoded.length, decoded.sampleRate);

  for (let ch = 0; ch < numCh; ch++) {
    const inData = decoded.getChannelData(ch);
    const denoised = denoiseChannel(inData, decoded.sampleRate);

    // Normalize to a safe peak after denoising.
    let peak = 0;
    for (let i = 0; i < denoised.length; i++) {
      const v = Math.abs(denoised[i]);
      if (v > peak) peak = v;
    }
    const gain = peak > 0 ? Math.min(0.95 / peak, 4) : 1;

    const outData = out.getChannelData(ch);
    for (let i = 0; i < denoised.length; i++) {
      outData[i] = Math.max(-1, Math.min(1, denoised[i] * gain));
    }
  }
  ctx.close();
  return audioBufferToWavBlob(out);
}

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

// ---------- Waveform peak decoding helper (unused by the live canvas below, kept for potential reuse) ----------
async function decodeToPeaks(blob, bucketCount) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const arrayBuffer = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    const data = decoded.getChannelData(0);
    const bucketSize = Math.max(1, Math.floor(data.length / bucketCount));
    const peaks = [];
    for (let i = 0; i < bucketCount; i++) {
      let max = 0;
      const start = i * bucketSize;
      const end = Math.min(start + bucketSize, data.length);
      for (let j = start; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      peaks.push(max);
    }
    ctx.close();
    return peaks;
  } catch {
    return null;
  }
}

// Extracts peaks for a specific [startTime, endTime) range of an already-decoded
// AudioBuffer — used to build the red reference track for just the current line,
// without re-decoding the whole video's audio on every line change.
function peaksFromBufferRange(audioBuffer, startTime, endTime, bucketCount) {
  if (!audioBuffer) return null;
  const data = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  const startSample = Math.max(0, Math.floor(startTime * sr));
  const endSample = Math.min(data.length, Math.ceil(endTime * sr));
  const rangeLen = Math.max(1, endSample - startSample);
  const bucketSize = Math.max(1, Math.floor(rangeLen / bucketCount));
  const peaks = [];
  for (let i = 0; i < bucketCount; i++) {
    let max = 0;
    const s = startSample + i * bucketSize;
    const e = Math.min(startSample + rangeLen, s + bucketSize);
    for (let j = s; j < e; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  return peaks;
}

// ---------- Theme toggle: sun/moon icon button, fixed top-start on every screen ----------
function ThemeToggle({ theme, onToggle, S }) {
  return (
    <button
      onClick={onToggle}
      aria-label={theme === "dark" ? "التبديل للوضع الفاتح" : "التبديل للوضع الداكن"}
      title={theme === "dark" ? "الوضع الفاتح" : "الوضع الداكن"}
      style={S.themeToggleBtn}
    >
      {theme === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="3.5" fill="currentColor" />
          <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <line x1="8" y1="0.5" x2="8" y2="2.2" />
            <line x1="8" y1="13.8" x2="8" y2="15.5" />
            <line x1="0.5" y1="8" x2="2.2" y2="8" />
            <line x1="13.8" y1="8" x2="15.5" y2="8" />
            <line x1="2.6" y1="2.6" x2="3.8" y2="3.8" />
            <line x1="12.2" y1="12.2" x2="13.4" y2="13.4" />
            <line x1="2.6" y1="13.4" x2="3.8" y2="12.2" />
            <line x1="12.2" y1="3.8" x2="13.4" y2="2.6" />
          </g>
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d="M13.5 9.5A6 6 0 0 1 6.5 2.5 6 6 0 1 0 13.5 9.5Z"
            fill="currentColor"
          />
        </svg>
      )}
    </button>
  );
}

// ---------- Waveform: static (purple, from an audio buffer) + live (blue, from mic while recording) ----------
// ---------- Dubbing timeline: two aligned tracks (red = original video audio, blue = your take) ----------
// The red track is a real waveform decoded once from the video's own audio for the
// current line's time range, and stays visible as a fixed reference — it never
// disappears while recording. The blue track fills in live while recording, and then
// stays as the recorded take's waveform afterward. A playhead shows current position
// within the line's duration.
function DubbingTimeline({
  isRecording,
  liveAnalyser,
  originalPeaks,     // Float32Array-like peaks for the red track (line-scoped), or null
  recordedPeaks,      // peaks for the blue track once a take exists, or null
  playheadRatio,       // 0..1 position within the line, or null to hide
  height = 46,
  C,
}) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const liveBucketsRef = useRef([]);

  const BUCKETS = 160;

  useEffect(() => {
    if (isRecording) liveBucketsRef.current = [];
  }, [isRecording]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);

    const trackH = (h - 6) / 2; // two stacked tracks with a small gap
    const redMid = trackH / 2;
    const blueMid = trackH + 6 + trackH / 2;
    const barW = w / BUCKETS;

    // --- Red track: fixed reference waveform of the original video's audio for this line ---
    ctx2d.fillStyle = C.onAir;
    if (originalPeaks && originalPeaks.length > 0) {
      for (let i = 0; i < BUCKETS; i++) {
        const p = originalPeaks[Math.min(originalPeaks.length - 1, Math.floor((i / BUCKETS) * originalPeaks.length))];
        const barH = Math.max(1.5, p * (trackH * 0.85));
        ctx2d.fillRect(i * barW, redMid - barH / 2, Math.max(1, barW - 1), barH);
      }
    } else {
      ctx2d.globalAlpha = 0.35;
      for (let i = 0; i < BUCKETS; i++) {
        ctx2d.fillRect(i * barW, redMid - 1, Math.max(1, barW - 1), 2);
      }
      ctx2d.globalAlpha = 1;
    }

    // --- Blue track: either the recorded take (static) or live mic input while recording ---
    if (isRecording && liveAnalyser) {
      const bufferLength = liveAnalyser.fftSize;
      const dataArray = new Uint8Array(bufferLength);
      liveAnalyser.getByteTimeDomainData(dataArray);
      let peak = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = Math.abs(dataArray[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      liveBucketsRef.current.push(peak);
      if (liveBucketsRef.current.length > BUCKETS) liveBucketsRef.current.shift();

      ctx2d.fillStyle = C.blue;
      liveBucketsRef.current.forEach((p, i) => {
        const barH = Math.max(1.5, p * (trackH * 0.85));
        const x = w - (liveBucketsRef.current.length - i) * barW;
        ctx2d.fillRect(x, blueMid - barH / 2, Math.max(1, barW - 1), barH);
      });
    } else if (recordedPeaks && recordedPeaks.length > 0) {
      ctx2d.fillStyle = C.blue;
      for (let i = 0; i < BUCKETS; i++) {
        const p = recordedPeaks[Math.min(recordedPeaks.length - 1, Math.floor((i / BUCKETS) * recordedPeaks.length))];
        const barH = Math.max(1.5, p * (trackH * 0.85));
        ctx2d.fillRect(i * barW, blueMid - barH / 2, Math.max(1, barW - 1), barH);
      }
    } else {
      ctx2d.globalAlpha = 0.25;
      ctx2d.fillStyle = C.blue;
      for (let i = 0; i < BUCKETS; i++) {
        ctx2d.fillRect(i * barW, blueMid - 1, Math.max(1, barW - 1), 2);
      }
      ctx2d.globalAlpha = 1;
    }

    // --- Playhead: vertical line across both tracks ---
    if (playheadRatio != null && playheadRatio >= 0 && playheadRatio <= 1) {
      const x = playheadRatio * w;
      ctx2d.fillStyle = C.text;
      ctx2d.globalAlpha = 0.85;
      ctx2d.fillRect(x - 1, 0, 2, h);
      ctx2d.globalAlpha = 1;
    }

    rafRef.current = requestAnimationFrame(draw);
  }, [originalPeaks, recordedPeaks, isRecording, liveAnalyser, playheadRatio, C]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  return <canvas ref={canvasRef} width={700} height={height} style={{ width: "100%", height, display: "block", borderRadius: 8 }} />;
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
  const [liveAnalyser, setLiveAnalyser] = useState(null);
  const [videoAudioBuffer, setVideoAudioBuffer] = useState(null); // decoded once, sliced per line for the red track
  const [recordedPeaksCache, setRecordedPeaksCache] = useState({}); // idx -> peaks array, for the blue track
  const [playheadTime, setPlayheadTime] = useState(null); // seconds, relative to the current line's own start

  // Theme: defaults to the device/browser preference, but the user can override
  // with the toggle; the override is remembered for next time.
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem("dubbing-theme");
      if (saved === "dark" || saved === "light") return saved;
    } catch {}
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches) {
      return "light";
    }
    return "dark";
  });
  const toggleTheme = () => {
    setTheme(prev => {
      const next = prev === "dark" ? "light" : "dark";
      try { localStorage.setItem("dubbing-theme", next); } catch {}
      return next;
    });
  };

  const videoRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const fileInputRef = useRef(null);
  const srtInputRef = useRef(null);
  const streamRef = useRef(null);
  const liveAudioCtxRef = useRef(null);

  const C = THEMES[theme];
  const S = useMemo(() => buildStyles(C), [theme]); // eslint-disable-line

  const loadVideoFile = (f) => {
    if (!f) return;
    setVideoFile(f);
    setVideoURL(URL.createObjectURL(f));
  };

  const loadSrtFile = (f) => {
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

  const handleVideoUpload = (e) => {
    loadVideoFile(e.target.files?.[0]);
  };

  // Decode the video's own audio once (used to draw the fixed red reference track,
  // sliced per line, without re-decoding the whole file on every line change).
  useEffect(() => {
    if (!videoFile) { setVideoAudioBuffer(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        const arrayBuffer = await videoFile.arrayBuffer();
        const decoded = await ctx.decodeAudioData(arrayBuffer);
        ctx.close();
        if (!cancelled) setVideoAudioBuffer(decoded);
      } catch (err) {
        console.warn("Could not decode video audio for the reference track:", err);
        if (!cancelled) setVideoAudioBuffer(null);
      }
    })();
    return () => { cancelled = true; };
  }, [videoFile]);

  const handleSrtUpload = (e) => {
    loadSrtFile(e.target.files?.[0]);
  };

  // Drag-and-drop: accepts one or both files at once (e.g. dragging the video and
  // the .srt together from the Whisper script's output folder). Sorts by type so
  // it doesn't matter which order they were dropped/selected in.
  const [isDragOver, setIsDragOver] = useState(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    const video = files.find(f => f.type.startsWith("video/"));
    const srt = files.find(f => f.name.toLowerCase().endsWith(".srt"));
    if (video) loadVideoFile(video);
    if (srt) loadSrtFile(srt);
  };
  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragOver(false);
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

  // Red track: peaks for just the current line's time range, sliced from the
  // once-decoded video audio buffer. Recomputes only when the line or buffer changes.
  const originalLinePeaks = useMemo(() => {
    if (!videoAudioBuffer || !currentLine) return null;
    return peaksFromBufferRange(videoAudioBuffer, currentLine.start, currentLine.end, 160);
  }, [videoAudioBuffer, currentLine]);

  // Blue track: peaks for the current line's recorded take, if one exists. Cached
  // per line index so we don't re-decode on every render.
  useEffect(() => {
    const rec = recordings[currentIdx];
    if (!rec) return;
    if (recordedPeaksCache[currentIdx]?.forBlob === rec.blob) return;
    let cancelled = false;
    decodeToPeaks(rec.blob, 160).then(peaks => {
      if (!cancelled) {
        setRecordedPeaksCache(prev => ({ ...prev, [currentIdx]: { peaks, forBlob: rec.blob } }));
      }
    });
    return () => { cancelled = true; };
  }, [currentIdx, recordings]); // eslint-disable-line

  const currentRecordedPeaks = recordedPeaksCache[currentIdx]?.peaks || null;

  useEffect(() => {
    if (filteredIndices.length > 0 && !filteredIndices.includes(currentIdx)) {
      setCurrentIdx(filteredIndices[0]);
    }
  }, [activeCharacter]); // eslint-disable-line

  // Auto-play the current line's clip whenever we land on a new line in the studio,
  // so the person hears/sees it (and the purple waveform shows it) before recording.
  const autoPlayedForRef = useRef(null);
  useEffect(() => {
    if (stage !== "studio" || isRecording) return;
    if (autoPlayedForRef.current === currentIdx) return;
    const line = srtLines[currentIdx];
    if (!line || !videoRef.current) return;
    autoPlayedForRef.current = currentIdx;
    videoRef.current.currentTime = line.start;
    const p = videoRef.current.play();
    if (p && typeof p.catch === "function") p.catch(() => {}); // autoplay can be blocked before first user gesture
    const onTime = () => {
      if (videoRef.current.currentTime >= line.end) {
        videoRef.current.pause();
        videoRef.current.removeEventListener("timeupdate", onTime);
      }
    };
    videoRef.current.addEventListener("timeupdate", onTime);
  }, [stage, currentIdx]); // eslint-disable-line

  // Playhead: mirrors the video's currentTime, expressed as seconds relative to the
  // current line's own start, so the timeline can position it as a 0..1 ratio.
  useEffect(() => {
    if (stage !== "studio" || !videoRef.current) return;
    const v = videoRef.current;
    const onTime = () => {
      const line = srtLines[currentIdx];
      if (!line) { setPlayheadTime(null); return; }
      setPlayheadTime(v.currentTime - line.start);
    };
    const onEndOrPause = () => {}; // keep last position visible; no need to clear
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [stage, currentIdx, srtLines]);

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

      // Live analyser for the blue waveform while recording
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      liveAudioCtxRef.current = audioCtx;
      setLiveAnalyser(analyser);

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
        if (liveAudioCtxRef.current) {
          liveAudioCtxRef.current.close();
          liveAudioCtxRef.current = null;
        }
        setLiveAnalyser(null);
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
    setCleanedPreview(prev => {
      if (!prev[idx]) return prev;
      const next = { ...prev };
      if (next[idx]?.url) URL.revokeObjectURL(next[idx].url);
      delete next[idx];
      return next;
    });
  };

  const [processingIdx, setProcessingIdx] = useState(null); // which line is being auto-synced/cleaned
  const [cleanedPreview, setCleanedPreview] = useState({}); // idx -> { url, blob } — "cleaned" version pending accept

  const runAutoSync = async (idx) => {
    const rec = recordings[idx];
    const line = srtLines[idx];
    if (!rec || !line) return;
    setProcessingIdx(idx);
    try {
      const target = line.end - line.start;
      const { blob, stretched } = await autoSyncRecording(rec.blob, target);
      const url = URL.createObjectURL(blob);
      setRecordings(prev => {
        const old = prev[idx];
        if (old?.url) URL.revokeObjectURL(old.url);
        return { ...prev, [idx]: { blob, url, duration: target } };
      });
      if (stretched) {
        setMicError(null);
      }
    } catch (err) {
      setMicError("ما قدرت أسوي مزامنة تلقائية لهذا المقطع.");
    } finally {
      setProcessingIdx(null);
    }
  };

  const runCleanup = async (idx) => {
    const rec = recordings[idx];
    if (!rec) return;
    setProcessingIdx(idx);
    try {
      const blob = await cleanupRecording(rec.blob);
      const url = URL.createObjectURL(blob);
      setCleanedPreview(prev => ({ ...prev, [idx]: { blob, url } }));
    } catch (err) {
      setMicError("ما قدرت أنظّف الصوت لهذا المقطع.");
    } finally {
      setProcessingIdx(null);
    }
  };

  const acceptCleaned = (idx) => {
    const cleaned = cleanedPreview[idx];
    if (!cleaned) return;
    setRecordings(prev => {
      const old = prev[idx];
      if (old?.url) URL.revokeObjectURL(old.url);
      return { ...prev, [idx]: { blob: cleaned.blob, url: cleaned.url, duration: prev[idx]?.duration } };
    });
    setCleanedPreview(prev => {
      const next = { ...prev };
      delete next[idx];
      return next;
    });
  };

  const discardCleaned = (idx) => {
    setCleanedPreview(prev => {
      const next = { ...prev };
      if (next[idx]?.url) URL.revokeObjectURL(next[idx].url);
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

  // ---------- Export: audio-only (all recordings merged into one WAV, in place, no video) ----------
  const [audioExportState, setAudioExportState] = useState("idle"); // idle | working | done | error
  const [audioExportURL, setAudioExportURL] = useState(null);
  const [audioExportError, setAudioExportError] = useState(null);

  const exportMergedAudio = async () => {
    setAudioExportError(null);
    setAudioExportState("working");
    try {
      const wavBlob = await mergeRecordingsToWav(srtLines, recordings, videoDuration + 1);
      if (audioExportURL) URL.revokeObjectURL(audioExportURL);
      setAudioExportURL(URL.createObjectURL(wavBlob));
      setAudioExportState("done");
    } catch (err) {
      console.error(err);
      setAudioExportError("صار خطأ أثناء دمج الأصوات. جرب مرة ثانية.");
      setAudioExportState("error");
    }
  };

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

      // Build a tiny 1s clip from the video's last frame (fast — encodes only 1s),
      // then stream-copy-concat it onto the original video via the concat demuxer.
      // This never re-encodes the original video, so export stays fast regardless
      // of the source video's length.
      await ffmpeg.exec([
        "-sseof", "-1",
        "-i", "input.mp4",
        "-vframes", "1",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "pad_frame.png",
      ]);
      await ffmpeg.exec([
        "-loop", "1",
        "-i", "pad_frame.png",
        "-t", "1",
        "-r", "30",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-pix_fmt", "yuv420p",
        "pad.mp4",
      ]);
      await ffmpeg.writeFile(
        "concat_list.txt",
        new TextEncoder().encode('file input.mp4\nfile pad.mp4\n')
      );
      await ffmpeg.exec([
        "-f", "concat",
        "-safe", "0",
        "-i", "concat_list.txt",
        "-c", "copy",
        "video_padded.mp4",
      ]);
      await ffmpeg.exec([
        "-i", "video_padded.mp4",
        "-i", "dub.wav",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac",
        "output.mp4",
      ]);

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
        <ThemeToggle theme={theme} onToggle={toggleTheme} S={S} />
        <div style={S.uploadWrap}>
          <div style={S.brandRow}>
            <div style={S.logoMark}>
              <svg width="20" height="16" viewBox="0 0 20 16" fill="none">
                <rect x="0" y="6" width="3" height="4" rx="1" fill="currentColor" />
                <rect x="5" y="2" width="3" height="12" rx="1" fill="currentColor" />
                <rect x="10" y="4" width="3" height="8" rx="1" fill="currentColor" />
                <rect x="15" y="0" width="3" height="16" rx="1" fill="currentColor" />
              </svg>
            </div>
            <div>
              <div style={S.brandTitle}>استوديو الدوبلاج</div>
              <div style={S.brandSub}>قسّم، سجّل، صدّر — بترتيب اللقطات</div>
            </div>
          </div>

          <div
            style={{ ...S.uploadGrid, ...(isDragOver ? S.uploadGridDragOver : {}) }}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <label style={{ ...S.dropZone, ...(videoFile ? S.dropZoneFilled : {}) }}>
              <input ref={fileInputRef} type="file" accept="video/*" onChange={handleVideoUpload} style={{ display: "none" }} />
              <Film size={28} strokeWidth={1.5} color={videoFile ? C.onAir : C.textFaint} />
              <div style={S.dropTitle}>{videoFile ? videoFile.name : "ملف الفيديو"}</div>
              <div style={S.dropHint}>{videoFile ? "تم الرفع — اضغط للتغيير" : "MP4, MOV, WEBM"}</div>
            </label>

            <label style={{ ...S.dropZone, ...(srtLines.length ? S.dropZoneFilled : {}) }}>
              <input ref={srtInputRef} type="file" accept=".srt" onChange={handleSrtUpload} style={{ display: "none" }} />
              <FileText size={28} strokeWidth={1.5} color={srtLines.length ? C.onAir : C.textFaint} />
              <div style={S.dropTitle}>{srtLines.length ? `${srtLines.length} سطر ترجمة` : "ملف الترجمة"}</div>
              <div style={S.dropHint}>{srtLines.length ? "تم التحليل — اضغط للتغيير" : ".srt فقط"}</div>
            </label>
          </div>

          <div style={S.dragHint}>
            {isDragOver
              ? "أفلت الملفين هنا..."
              : "بتقدر تسحب الفيديو وملف الـ SRT مع بعض وتفلتهم هنا دفعة وحدة"}
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
        <ThemeToggle theme={theme} onToggle={toggleTheme} S={S} />
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
        <ThemeToggle theme={theme} onToggle={toggleTheme} S={S} />
      <div className="studio-wrap" style={S.studioWrap}>
        {/* Sidebar: character filter */}
        <div className="studio-sidebar" style={S.sidebar}>
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
        <div className="studio-main" style={S.mainPanel}>
          <div className="studio-video-block">
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
          </div>

          <div className="studio-record-block" style={S.recordZone}>
            <div style={{ ...S.onAirBar, ...(isRecording ? S.onAirBarActive : {}) }}>
              <span style={S.onAirDot} />
              ON AIR — جاري التسجيل
            </div>

            <div style={S.waveformBox}>
              <DubbingTimeline
                isRecording={isRecording}
                liveAnalyser={liveAnalyser}
                originalPeaks={originalLinePeaks}
                recordedPeaks={currentRecordedPeaks}
                playheadRatio={
                  currentLine && playheadTime != null
                    ? Math.max(0, Math.min(1, playheadTime / (currentLine.end - currentLine.start)))
                    : null
                }
                C={C}
              />
              <div style={S.timelineTrackLabels}>
                <span style={S.trackLabel}><span style={{ ...S.legendSwatch, background: C.onAir }} /> الأصلي</span>
                <span style={S.trackLabel}><span style={{ ...S.legendSwatch, background: C.blue }} /> تسجيلك</span>
              </div>
              {currentLine && (
                <div style={S.playheadTimeLabel}>
                  {formatTime(Math.max(0, playheadTime || 0))} / {formatTime(currentLine.end - currentLine.start)}
                </div>
              )}
            </div>

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

            {recordings[currentIdx] && (
              <div style={S.toolsRow}>
                <button
                  style={S.toolBtn}
                  onClick={() => runAutoSync(currentIdx)}
                  disabled={processingIdx === currentIdx}
                >
                  {processingIdx === currentIdx ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : "⏱️"} مزامنة تلقائية
                </button>
                <button
                  style={S.toolBtn}
                  onClick={() => runCleanup(currentIdx)}
                  disabled={processingIdx === currentIdx}
                >
                  {processingIdx === currentIdx ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : "✨"} تنظيف الصوت
                </button>
              </div>
            )}

            {cleanedPreview[currentIdx] && (
              <div style={S.cleanCompareBox}>
                <div style={S.cleanCompareTitle}>مقارنة: الأصلي مقابل المنظّف</div>
                <div style={S.cleanCompareRow}>
                  <span style={S.cleanLabel}>قبل</span>
                  <audio controls src={recordings[currentIdx].url} style={S.audioPlayer} />
                </div>
                <div style={S.cleanCompareRow}>
                  <span style={S.cleanLabel}>بعد</span>
                  <audio controls src={cleanedPreview[currentIdx].url} style={S.audioPlayer} />
                </div>
                <div style={S.cleanActionsRow}>
                  <button style={S.acceptCleanBtn} onClick={() => acceptCleaned(currentIdx)}>
                    <Check size={13} /> استخدم النسخة المنظّفة
                  </button>
                  <button style={S.discardCleanBtn} onClick={() => discardCleaned(currentIdx)}>
                    تجاهل
                  </button>
                </div>
              </div>
            )}

            <div style={S.miniProgress}>{recordedForFilter} / {totalForFilter} مسجّلة {activeCharacter ? `— ${activeCharacter}` : ""}</div>
          </div>
        </div>
      </div>
    </div>
  );
  }

  // ---------- RENDER: Review / Timeline stage ----------
  if (stage === "review") {
    return (
      <div style={S.page}>
        <ThemeToggle theme={theme} onToggle={toggleTheme} S={S} />
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
            <div style={S.exportTitle}>تنزيل الصوت المدموج (بدون فيديو)</div>
            <div style={S.exportHint}>يدمج كل التسجيلات بمسار صوت واحد كامل، بنفس ترتيب وتوقيت الفيديو.</div>

            {audioExportState === "idle" && (
              <button style={S.exportBtn} onClick={exportMergedAudio}>
                <Download size={16} /> دمج وتنزيل الصوت الكامل (WAV)
              </button>
            )}

            {audioExportState === "working" && (
              <div style={S.exportStatusRow}>
                <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} />
                <span>جاري دمج الأصوات...</span>
              </div>
            )}

            {audioExportState === "error" && (
              <div style={S.errorMsg}>{audioExportError}</div>
            )}

            {audioExportState === "done" && audioExportURL && (
              <div style={S.exportDoneRow}>
                <Check size={16} color="#7A8C5C" />
                <span>الصوت جاهز</span>
                <a href={audioExportURL} download="dubbed_audio.wav" style={S.exportDownloadLink}>
                  <Download size={14} /> تنزيل ملف الصوت
                </a>
              </div>
            )}
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

          <button style={S.ghostBtn} onClick={downloadAll}>
            <Download size={13} /> تنزيل التسجيلات منفردة (اختياري، ملف لكل جملة)
          </button>
        </div>
      </div>
    );
  }
}

// ---------- Design tokens: dark broadcast studio, ON-AIR signal as the signature element ----------
const THEMES = {
  dark: {
    bg: "#0D0F12",
    bgGradient: "radial-gradient(ellipse 900px 500px at 50% -10%, rgba(155,126,222,0.06), transparent)",
    surface: "#15181D",
    surfaceRaised: "#1B1F26",
    line: "#262B33",
    lineSoft: "#1F232A",
    text: "#E8EAED",
    textDim: "#889099",
    textFaint: "#565D68",
    onAir: "#E8483A",
    onAirDim: "#7A2820",
    onAirTint: "rgba(232,72,58,0.1)",
    purple: "#9B7EDE",
    blue: "#4FA8E0",
    green: "#5FB88A",
    amber: "#D9A441",
    videoBg: "#000",
    focusRing: "#E8483A",
  },
  light: {
    bg: "#F4F5F7",
    bgGradient: "radial-gradient(ellipse 900px 500px at 50% -10%, rgba(155,126,222,0.08), transparent)",
    surface: "#FFFFFF",
    surfaceRaised: "#ECEEF1",
    line: "#DCDFE4",
    lineSoft: "#E7E9ED",
    text: "#1B1F26",
    textDim: "#5B6270",
    textFaint: "#8B92A0",
    onAir: "#D93A2C",
    onAirDim: "#F3B6AF",
    onAirTint: "rgba(217,58,44,0.08)",
    purple: "#7A5FC4",
    blue: "#2C7FB8",
    green: "#3E9468",
    amber: "#B9832A",
    videoBg: "#111",
    focusRing: "#D93A2C",
  },
};

function buildStyles(C) {
  return {
  page: {
    minHeight: "100vh",
    background: C.bg,
    backgroundImage: C.bgGradient,
    color: C.text,
    fontFamily: "'Space Grotesk', 'Tajawal', 'Segoe UI', sans-serif",
    direction: "rtl",
    display: "flex",
    justifyContent: "center",
    padding: "24px 16px",
    boxSizing: "border-box",
    position: "relative",
    transition: "background 0.2s ease, color 0.2s ease",
  },
  themeToggleBtn: {
    position: "fixed", top: 16, insetInlineStart: 16, zIndex: 50,
    width: 34, height: 34, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
    background: C.surface, border: `1px solid ${C.line}`, color: C.textDim, cursor: "pointer",
    transition: "background 0.15s, color 0.15s",
  },
  uploadWrap: { width: "100%", maxWidth: 560 },
  brandRow: { display: "flex", alignItems: "center", gap: 14, marginBottom: 36 },
  logoMark: {
    width: 44, height: 44, borderRadius: 10, background: C.surfaceRaised, border: `1px solid ${C.line}`,
    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: C.onAir,
    fontFamily: "'JetBrains Mono', monospace",
  },
  brandTitle: { fontSize: 19, fontWeight: 700, letterSpacing: "-0.02em" },
  brandSub: {
    fontSize: 11, color: C.textFaint, marginTop: 3, fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: "0.06em", textTransform: "uppercase",
  },
  uploadGrid: {
    display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10,
    borderRadius: 12, transition: "background 0.15s",
  },
  uploadGridDragOver: { background: C.onAirTint, outline: `1.5px dashed ${C.onAir}`, outlineOffset: 6 },
  dragHint: { fontSize: 11, color: C.textFaint, textAlign: "center", marginBottom: 20 },
  dropZone: {
    border: `1px dashed ${C.line}`, borderRadius: 10, padding: "28px 16px", cursor: "pointer",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center",
    transition: "border-color 0.15s, background 0.15s", background: C.surface,
  },
  dropZoneFilled: { borderColor: C.onAir, borderStyle: "solid", background: C.onAirTint },
  dropTitle: { fontSize: 13.5, fontWeight: 600, color: C.text },
  dropHint: { fontSize: 11, color: C.textFaint, fontFamily: "'JetBrains Mono', monospace" },
  detectNote: {
    fontSize: 12.5, color: C.textDim, background: C.surface, border: `1px solid ${C.line}`,
    borderRadius: 8, padding: "10px 14px", marginBottom: 20, lineHeight: 1.6,
  },
  primaryBtn: {
    width: "100%", background: C.onAir, color: "#FFF", border: "none", borderRadius: 8,
    padding: "14px 20px", fontSize: 14, fontWeight: 700, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    letterSpacing: "0.01em", transition: "filter 0.15s",
  },
  ghostBtn: {
    background: "transparent", color: C.textDim, border: `1px solid ${C.line}`, borderRadius: 8,
    padding: "12px 20px", fontSize: 13.5, fontWeight: 600, cursor: "pointer",
  },

  charWrap: { width: "100%", maxWidth: 720 },
  stageHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22 },
  stageTitle: { fontSize: 19, fontWeight: 700, letterSpacing: "-0.02em" },
  stageSub: { fontSize: 12.5, color: C.textDim, marginTop: 4 },
  progressPill: {
    fontSize: 11, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 6, padding: "6px 12px",
    color: C.textDim, fontFamily: "'JetBrains Mono', monospace",
  },
  charAddRow: { display: "flex", gap: 8, marginBottom: 14 },
  charInput: {
    flex: 1, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 14px",
    color: C.text, fontSize: 13.5, outline: "none",
  },
  addBtn: {
    background: C.surfaceRaised, color: C.text, border: `1px solid ${C.line}`, borderRadius: 8,
    padding: "10px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer",
  },
  charChips: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 },
  charChip: {
    display: "flex", alignItems: "center", gap: 7, border: "1px solid", borderRadius: 6,
    padding: "6px 12px", fontSize: 12.5, background: C.surface,
  },
  chipCount: { fontSize: 10.5, color: C.textFaint, fontFamily: "'JetBrains Mono', monospace" },
  emptyHint: { fontSize: 12.5, color: C.textFaint, fontStyle: "italic" },
  linesList: { maxHeight: 380, overflowY: "auto", border: `1px solid ${C.line}`, borderRadius: 10, marginBottom: 20 },
  lineRow: {
    display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: `1px solid ${C.lineSoft}`,
  },
  lineTime: {
    fontSize: 10.5, color: C.textFaint, width: 46, flexShrink: 0, fontVariantNumeric: "tabular-nums",
    fontFamily: "'JetBrains Mono', monospace",
  },
  lineText: { flex: 1, fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  lineAssign: { flexShrink: 0 },
  select: {
    background: C.surface, border: "1.5px solid", borderRadius: 6, padding: "5px 8px",
    color: C.text, fontSize: 12, outline: "none",
  },
  footerRow: { display: "flex", gap: 10, justifyContent: "space-between" },

  studioWrap: { width: "100%", maxWidth: 900, display: "flex", gap: 16 },

  reviewWrap: { width: "100%", maxWidth: 760, display: "flex", flexDirection: "column", gap: 16 },
  timelineWrap: { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16 },
  timelineTitle: {
    fontSize: 11, color: C.textFaint, fontWeight: 600, marginBottom: 10,
    fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.06em", textTransform: "uppercase",
  },
  timelineTrack: {
    position: "relative", height: 34, background: C.bg, borderRadius: 6, overflow: "hidden",
    border: `1px solid ${C.lineSoft}`,
  },
  timelineBlock: {
    position: "absolute", top: 3, bottom: 3, borderRadius: 3, cursor: "pointer",
    minWidth: 3, transition: "opacity 0.15s",
  },
  timelineLegend: { display: "flex", flexWrap: "wrap", gap: 14, marginTop: 12 },
  legendItem: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: C.textDim },

  exportBox: { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16 },
  exportTitle: { fontSize: 13.5, fontWeight: 700, marginBottom: 4 },
  exportHint: { fontSize: 11.5, color: C.textFaint, marginBottom: 12 },
  exportBtn: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%",
    background: C.onAir, color: "#FFF", border: "none", borderRadius: 8, padding: "12px",
    fontSize: 13.5, fontWeight: 700, cursor: "pointer",
  },
  exportProgressWrap: { display: "flex", flexDirection: "column", gap: 8 },
  exportStatusRow: {
    display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.textDim,
    fontFamily: "'JetBrains Mono', monospace",
  },
  exportDoneRow: { display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: C.textDim },
  exportDownloadLink: {
    display: "flex", alignItems: "center", gap: 6, background: C.surfaceRaised, color: C.text,
    border: `1px solid ${C.line}`, borderRadius: 6, padding: "7px 12px", fontSize: 12,
    textDecoration: "none", marginInlineStart: "auto",
  },
  sidebar: {
    width: 220, flexShrink: 0, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12,
    padding: 14, display: "flex", flexDirection: "column", gap: 6, height: "fit-content",
  },
  sidebarTitle: {
    fontSize: 11, color: C.textFaint, display: "flex", alignItems: "center", gap: 6, marginBottom: 6,
    fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.06em", textTransform: "uppercase",
  },
  filterBtn: {
    display: "flex", justifyContent: "space-between", alignItems: "center", background: "transparent",
    border: "none", borderRadius: 6, padding: "9px 10px", color: C.textDim, fontSize: 12.5, cursor: "pointer",
    textAlign: "right", width: "100%", transition: "background 0.12s",
  },
  filterBtnActive: { background: C.surfaceRaised, color: C.text, fontWeight: 700 },
  filterCount: { fontSize: 10.5, color: C.textFaint, fontFamily: "'JetBrains Mono', monospace" },
  sidebarDivider: { height: 1, background: C.line, margin: "8px 0" },
  overallProgress: { padding: "4px 10px 10px" },
  overallLabel: {
    fontSize: 10.5, color: C.textFaint, marginBottom: 6, fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: "0.05em", textTransform: "uppercase",
  },
  progressTrack: { height: 4, background: C.bg, borderRadius: 99, overflow: "hidden" },
  progressFill: { height: "100%", background: C.green, borderRadius: 99, transition: "width 0.3s" },
  overallNum: { fontSize: 10.5, color: C.textFaint, marginTop: 5, fontFamily: "'JetBrains Mono', monospace" },
  downloadBtn: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 7, background: C.surfaceRaised,
    border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px", color: C.text, fontSize: 12,
    fontWeight: 600, cursor: "pointer", marginTop: 4,
  },

  mainPanel: { flex: 1, display: "flex", flexDirection: "column", gap: 14 },
  videoEl: {
    width: "100%", borderRadius: 10, background: C.videoBg, maxHeight: 380, objectFit: "contain",
    border: `1px solid ${C.line}`,
  },
  subtitleCard: {
    background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "14px 18px",
    borderInlineStart: `3px solid ${C.line}`,
  },
  subtitleChar: {
    fontSize: 11, fontWeight: 700, marginBottom: 4, fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: "0.04em", textTransform: "uppercase",
  },
  subtitleText: { fontSize: 15.5, lineHeight: 1.6, color: C.text },
  subtitleTime: {
    fontSize: 10.5, color: C.textFaint, marginTop: 6, fontVariantNumeric: "tabular-nums",
    fontFamily: "'JetBrains Mono', monospace",
  },
  transportRow: { display: "flex", alignItems: "center", justifyContent: "center", gap: 14 },
  transportBtn: {
    background: "transparent", border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 16px",
    color: C.textDim, fontSize: 12.5, cursor: "pointer",
  },
  playBtn: {
    width: 46, height: 46, borderRadius: 99, background: C.surfaceRaised, color: C.text,
    border: `1px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
  },
  recordZone: { display: "flex", flexDirection: "column", alignItems: "center", gap: 10, width: "100%" },
  waveformBox: { width: "100%", background: C.bg, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10 },
  waveformLegend: { display: "flex", gap: 16, marginTop: 6, justifyContent: "center" },
  legendDot: { display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: C.textFaint },
  timelineTrackLabels: { display: "flex", justifyContent: "space-between", marginTop: 6, padding: "0 2px" },
  trackLabel: { display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: C.textFaint, fontFamily: "'JetBrains Mono', monospace" },
  playheadTimeLabel: {
    textAlign: "center", fontSize: 11, color: C.textDim, marginTop: 6,
    fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: "tabular-nums",
  },
  legendSwatch: { width: 8, height: 8, borderRadius: 2, display: "inline-block" },
  recordBtn: {
    display: "flex", alignItems: "center", gap: 8, background: C.onAir, color: "#FFF", border: "none",
    borderRadius: 10, padding: "13px 26px", fontSize: 14, fontWeight: 700, cursor: "pointer",
    letterSpacing: "0.01em",
  },
  stopBtn: {
    display: "flex", alignItems: "center", gap: 8, background: C.surfaceRaised, color: C.onAir,
    border: `1.5px solid ${C.onAir}`, borderRadius: 10, padding: "13px 26px", fontSize: 14, fontWeight: 700,
    cursor: "pointer", animation: "onairPulse 1.4s ease-in-out infinite",
  },
  errorMsg: { fontSize: 12, color: C.onAir },
  recordedRow: { display: "flex", alignItems: "center", gap: 10, background: C.surface, borderRadius: 8, padding: "8px 12px" },
  toolsRow: { display: "flex", gap: 8 },
  toolBtn: {
    display: "flex", alignItems: "center", gap: 6, background: C.surface, border: `1px solid ${C.line}`,
    borderRadius: 6, padding: "7px 12px", color: C.textDim, fontSize: 12, cursor: "pointer",
  },
  cleanCompareBox: {
    width: "100%", background: C.surface, border: `1px solid ${C.line}`, borderRadius: 8, padding: 12,
    display: "flex", flexDirection: "column", gap: 8,
  },
  cleanCompareTitle: { fontSize: 11.5, fontWeight: 700, color: C.text },
  cleanCompareRow: { display: "flex", alignItems: "center", gap: 10 },
  cleanLabel: { fontSize: 11, color: C.textFaint, width: 32, flexShrink: 0 },
  cleanActionsRow: { display: "flex", gap: 8, marginTop: 4 },
  acceptCleanBtn: {
    display: "flex", alignItems: "center", gap: 6, background: C.green, color: C.bg, border: "none",
    borderRadius: 6, padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer",
  },
  discardCleanBtn: {
    background: "transparent", color: C.textFaint, border: `1px solid ${C.line}`, borderRadius: 6,
    padding: "8px 14px", fontSize: 12, cursor: "pointer",
  },
  audioPlayer: { height: 32, maxWidth: 220 },
  miniProgress: { textAlign: "center", fontSize: 11, color: C.textFaint, fontFamily: "'JetBrains Mono', monospace" },

  // ON-AIR signature bar — the one bold element, only alive while recording
  onAirBar: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    height: 0, overflow: "hidden", opacity: 0, transition: "height 0.25s ease, opacity 0.2s ease",
    marginBottom: 0, borderRadius: 8, fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11, fontWeight: 700, letterSpacing: "0.15em",
  },
  onAirBarActive: {
    height: 34, opacity: 1, marginBottom: 14, background: C.onAirTint,
    border: `1px solid ${C.onAirDim}`, color: C.onAir,
  },
  onAirDot: {
    width: 7, height: 7, borderRadius: 99, background: C.onAir,
    animation: "onairBlink 1s ease-in-out infinite",
  },
  };
}

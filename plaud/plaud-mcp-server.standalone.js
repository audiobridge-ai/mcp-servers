#!/usr/bin/env node

// Generated file. Do not edit directly.
// Source: mcp/plaud-mcp-server.js
// Build command: npm run mcp:build-standalone

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { exec } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const { normalizeTranscriptionToTransResult } = (() => {
  function normalizeSpeaker(value) {
    if (value == null) return "Speaker 1";

    if (typeof value === "number" && Number.isFinite(value)) {
      return `Speaker ${Math.max(1, Math.round(value))}`;
    }

    const raw = String(value || "").trim();
    if (!raw) return "Speaker 1";

    let m = raw.match(/^Speaker\s*(\d+)$/i) || raw.match(/^speaker\s*(\d+)$/i);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n)) return `Speaker ${Math.max(1, n)}`;
    }

    m = raw.match(/^SPEAKER\s*(\d+)$/i) || raw.match(/^SPEAKER(\d+)$/i);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n)) return `Speaker ${Math.max(1, n)}`;
    }

    m = raw.match(/^SPEAKER[_\s-]*(\d+)$/i) || raw.match(/^speaker[_\s-]*(\d+)$/i);
    if (m?.[1]) {
      const idx0 = Number.parseInt(m[1], 10);
      if (Number.isFinite(idx0)) return `Speaker ${Math.max(1, idx0 + 1)}`;
    }

    m = raw.match(/(\d+)/);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n)) return `Speaker ${Math.max(1, n)}`;
    }

    return raw;
  }

  const SPEAKER_SEGMENT_MIN_MS = 10_000;
  const SPEAKER_SEGMENT_MAX_MS = 20_000;
  const SPEAKER_SEGMENT_SOFT_MAX_MS = 22_000;

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function shouldUseRawFallback(value) {
    const raw = String(value || "").trim();
    if (!raw) return false;
    if (raw.startsWith("{") || raw.startsWith("[")) {
      const parsed = safeJsonParse(raw);
      if (parsed && typeof parsed === "object") return false;
    }
    return true;
  }

  function pickNonEmptyString(...values) {
    for (const v of values) {
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  }

  function toMs(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n <= 0) return 0;

    if (n > 24 * 60 * 60 * 1000) return Math.round(n);
    return Math.round(n * 1000);
  }

  function normalizeSegmentTimingMs(value, unit) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (unit === "sec") return Math.round(n * 1000);
    return Math.round(n);
  }

  function joinSegmentTexts(texts) {
    return String(texts.join(" ") || "")
      .replace(/\s+([,.!?;:])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildSpeakerSegmentsFromItems(items, options) {
    const list = Array.isArray(items) ? items : [];
    const minMs = options?.minMs ?? SPEAKER_SEGMENT_MIN_MS;
    const maxMs = options?.maxMs ?? SPEAKER_SEGMENT_MAX_MS;
    const softMaxMs = options?.softMaxMs ?? SPEAKER_SEGMENT_SOFT_MAX_MS;
    const out = [];
    let current = null;

    const flush = () => {
      if (!current?.texts?.length) return;
      const content = joinSegmentTexts(current.texts);
      if (!content) return;
      out.push({
        content,
        start_time: current.startMs,
        end_time: current.endMs,
        speaker: current.speaker,
        embeddingKey: null,
      });
    };

    for (const item of list) {
      if (!item) continue;
      const text = String(item.text || "").trim();
      if (!text) continue;
      const speaker = normalizeSpeaker(item.speaker);
      const startMs = Number.isFinite(item.startMs) ? item.startMs : 0;
      const endMs = Number.isFinite(item.endMs) ? item.endMs : 0;

      if (!current) {
        current = { speaker, startMs, endMs, texts: [text] };
        continue;
      }

      if (speaker !== current.speaker) {
        flush();
        current = { speaker, startMs, endMs, texts: [text] };
        continue;
      }

      const currentDuration =
        current.endMs > current.startMs ? current.endMs - current.startMs : 0;
      const nextEnd = Math.max(current.endMs, endMs);
      const nextDuration =
        nextEnd > current.startMs ? nextEnd - current.startMs : currentDuration;

      if (!current.endMs || !endMs) {
        current.texts.push(text);
        current.endMs = nextEnd || current.endMs;
        continue;
      }

      if (nextDuration <= maxMs) {
        current.texts.push(text);
        current.endMs = nextEnd;
        continue;
      }

      if (currentDuration < minMs && nextDuration <= softMaxMs) {
        current.texts.push(text);
        current.endMs = nextEnd;
        continue;
      }

      flush();
      current = { speaker, startMs, endMs, texts: [text] };
    }

    flush();
    return out;
  }

  function normalizeZeroBasedSpeakerLabel(value) {
    if (value == null) return "Speaker 1";
    if (typeof value === "number" && Number.isFinite(value)) {
      return `Speaker ${Math.max(1, Math.round(value) + 1)}`;
    }
    const raw = String(value || "").trim();
    if (!raw) return "Speaker 1";
    if (/^\d+$/.test(raw)) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) return `Speaker ${Math.max(1, n + 1)}`;
    }
    return value;
  }

  function buildSegmentsFromUtterances(utterances, unit, options = {}) {
    const list = Array.isArray(utterances) ? utterances : [];
    const items = [];
    for (const u of list) {
      const text = pickNonEmptyString(u?.text, u?.content, u?.transcript);
      if (!text) continue;
      const startRaw = u?.start ?? u?.start_time ?? u?.startTime;
      const endRaw = u?.end ?? u?.end_time ?? u?.endTime;
      const speaker = options?.zeroBasedSpeakers
        ? normalizeZeroBasedSpeakerLabel(u?.speaker)
        : u?.speaker;
      items.push({
        text,
        speaker,
        startMs: normalizeSegmentTimingMs(startRaw, unit),
        endMs: normalizeSegmentTimingMs(endRaw, unit),
      });
    }
    return buildSpeakerSegmentsFromItems(items);
  }

  function pickWordText(word) {
    return pickNonEmptyString(
      word?.punctuated_word,
      word?.word,
      word?.text,
      word?.token,
      word?.content
    );
  }

  function buildSegmentsFromWords(words, unit, options = {}) {
    const list = Array.isArray(words) ? words : [];
    const items = [];
    for (const w of list) {
      const text = pickWordText(w);
      if (!text) continue;
      const startRaw = w?.start ?? w?.start_time ?? w?.startTime;
      const endRaw = w?.end ?? w?.end_time ?? w?.endTime;
      const speaker = options?.zeroBasedSpeakers
        ? normalizeZeroBasedSpeakerLabel(w?.speaker)
        : w?.speaker;
      items.push({
        text,
        speaker,
        startMs: normalizeSegmentTimingMs(startRaw, unit),
        endMs: normalizeSegmentTimingMs(endRaw, unit),
      });
    }
    return buildSpeakerSegmentsFromItems(items);
  }

  function normalizeTranscriptionToTransResult(data) {
    const root = data ?? {};

    const normalizeFromList = (list) => {
      if (!Array.isArray(list)) return null;

      const out = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;

        const content = String(
          item?.content ?? item?.text ?? item?.transcript ?? ""
        ).trim();
        if (!content) continue;

        const startMs = Number(item?.start_time ?? item?.startTime ?? 0);
        const endMs = Number(item?.end_time ?? item?.endTime ?? 0);
        out.push({
          content,
          start_time:
            Number.isFinite(startMs) && startMs >= 0 ? Math.round(startMs) : 0,
          end_time: Number.isFinite(endMs) && endMs >= 0 ? Math.round(endMs) : 0,
          speaker: normalizeSpeaker(
            item?.speaker ??
              item?.speaker_label ??
              item?.speakerLabel ??
              item?.speaker_id ??
              item?.speakerId
          ),
          embeddingKey: null,
        });
      }

      return out.length ? out : null;
    };

    const directRootList = normalizeFromList(Array.isArray(root) ? root : null);
    if (directRootList) return directRootList;

    const directDataList = normalizeFromList(
      Array.isArray(root?.data) ? root.data : null
    );
    if (directDataList) return directDataList;

    const directTransResult =
      (Array.isArray(root?.trans_result) && root.trans_result) ||
      (Array.isArray(root?.data?.trans_result) && root.data.trans_result) ||
      null;
    if (directTransResult) {
      const out = [];
      for (const item of directTransResult) {
        const content = String(item?.content ?? item?.text ?? "").trim();
        if (!content) continue;

        const startMs = Number(item?.start_time ?? item?.startTime ?? 0);
        const endMs = Number(item?.end_time ?? item?.endTime ?? 0);
        out.push({
          content,
          start_time:
            Number.isFinite(startMs) && startMs >= 0 ? Math.round(startMs) : 0,
          end_time: Number.isFinite(endMs) && endMs >= 0 ? Math.round(endMs) : 0,
          speaker: normalizeSpeaker(
            item?.speaker ??
              item?.speaker_label ??
              item?.speakerLabel ??
              item?.speaker_id ??
              item?.speakerId
          ),
          embeddingKey: null,
        });
      }
      if (out.length) return out;
    }

    const segments =
      (Array.isArray(root?.segments) && root.segments) ||
      (Array.isArray(root?.data?.segments) && root.data.segments) ||
      null;

    if (segments) {
      const out = [];
      for (const seg of segments) {
        const content = String(
          seg?.text ?? seg?.content ?? seg?.transcript ?? ""
        ).trim();
        if (!content) continue;

        out.push({
          content,
          end_time: toMs(seg?.end ?? seg?.end_time ?? seg?.endTime),
          start_time: toMs(seg?.start ?? seg?.start_time ?? seg?.startTime),
          speaker: normalizeSpeaker(
            seg?.speaker ??
              seg?.speaker_label ??
              seg?.speakerLabel ??
              seg?.speaker_id ??
              seg?.speakerId
          ),
          embeddingKey: null,
        });
      }
      if (out.length) return out;
    }

    const utterances =
      (Array.isArray(root?.utterances) && root.utterances) ||
      (Array.isArray(root?.data?.utterances) && root.data.utterances) ||
      (Array.isArray(root?.results?.utterances) && root.results.utterances) ||
      null;
    if (utterances) {
      const out = [];
      for (const u of utterances) {
        const content = pickNonEmptyString(u?.text, u?.content, u?.transcript);
        if (!content) continue;
        out.push({
          content,
          end_time: toMs(u?.end ?? u?.end_time ?? u?.endTime),
          start_time: toMs(u?.start ?? u?.start_time ?? u?.startTime),
          speaker: normalizeSpeaker(
            u?.speaker ?? u?.speaker_label ?? u?.speaker_id ?? u?.speakerId
          ),
          embeddingKey: null,
        });
      }
      if (out.length) return out;
    }

    const words =
      (Array.isArray(root?.words) && root.words) ||
      (Array.isArray(root?.data?.words) && root.data.words) ||
      (Array.isArray(root?.results?.channels?.[0]?.alternatives?.[0]?.words) &&
        root.results.channels[0].alternatives[0].words) ||
      null;
    if (words) {
      const texts = [];
      let start = null;
      let end = null;
      for (const w of words) {
        const word = pickNonEmptyString(w?.word, w?.text);
        if (word) texts.push(word);
        const s = w?.start ?? w?.start_time ?? w?.startTime;
        const e = w?.end ?? w?.end_time ?? w?.endTime;
        if (start == null && Number.isFinite(Number(s))) start = Number(s);
        if (Number.isFinite(Number(e))) end = Number(e);
      }
      const content = texts.join(" ").trim();
      if (content) {
        return [
          {
            content,
            end_time: toMs(end),
            start_time: toMs(start),
            speaker: "Speaker 1",
            embeddingKey: null,
          },
        ];
      }
    }

    const rawFallback = pickNonEmptyString(root?.raw, root?.data?.raw);
    if (shouldUseRawFallback(rawFallback)) {
      return [
        {
          content: rawFallback,
          end_time: 0,
          start_time: 0,
          speaker: "Speaker 1",
          embeddingKey: null,
        },
      ];
    }

    const text = pickNonEmptyString(
      root?.text,
      root?.transcript,
      root?.output_text,
      root?.data?.text,
      root?.data?.transcript,
      root?.data?.output_text
    );

    if (!text) return [];

    return [
      {
        content: text,
        end_time: 0,
        start_time: 0,
        speaker: "Speaker 1",
        embeddingKey: null,
      },
    ];
  }

  function normalizeAssemblyAiTranscript(transcript) {
    const utterances = Array.isArray(transcript?.utterances)
      ? transcript.utterances
      : null;
    const words = Array.isArray(transcript?.words) ? transcript.words : null;

    if (utterances?.length) {
      const merged = buildSegmentsFromUtterances(utterances, "ms", {
        zeroBasedSpeakers: true,
      });
      if (merged.length > 1) return merged;
      if (merged.length === 1) {
        const duration = merged[0].end_time - merged[0].start_time;
        if (duration > SPEAKER_SEGMENT_MAX_MS && words?.length) {
          const wordSegments = buildSegmentsFromWords(words, "ms", {
            zeroBasedSpeakers: true,
          });
          if (wordSegments.length) return wordSegments;
        }
        return merged;
      }
    }

    if (words?.length) {
      const wordSegments = buildSegmentsFromWords(words, "ms", {
        zeroBasedSpeakers: true,
      });
      if (wordSegments.length) return wordSegments;
    }

    return normalizeTranscriptionToTransResult(transcript);
  }

  function normalizeDeepgramTranscript(transcript) {
    const utterances = Array.isArray(transcript?.results?.utterances)
      ? transcript.results.utterances
      : null;
    const words = Array.isArray(
      transcript?.results?.channels?.[0]?.alternatives?.[0]?.words
    )
      ? transcript.results.channels[0].alternatives[0].words
      : null;

    if (utterances?.length) {
      const merged = buildSegmentsFromUtterances(utterances, "sec", {
        zeroBasedSpeakers: true,
      });
      if (merged.length) return merged;
    }

    if (words?.length) {
      const wordSegments = buildSegmentsFromWords(words, "sec", {
        zeroBasedSpeakers: true,
      });
      if (wordSegments.length) return wordSegments;
    }

    return normalizeTranscriptionToTransResult(transcript);
  }

  return { normalizeTranscriptionToTransResult };
})();

const SERVER_NAME = "plaud-local-mcp";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2024-11-05", "2024-10-07"]);
const DEFAULT_API_ORIGIN = "https://api.plaud.ai";

const TOOL_LIST_FILES = "plaud_list_files";
const TOOL_GET_FILE_DATA = "plaud_get_file_data";
const TOOL_AUTH_BROWSER = "plaud_auth_browser";

const TOOLS = [
  {
    name: TOOL_LIST_FILES,
    description: "List PLAUD files with pagination and optional keyword filters.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
          description: "Number of results. Default 50, max 200.",
        },
        skip: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "Pagination offset.",
        },
        query: {
          type: "string",
          description: "Substring filter on title or file id.",
        },
        is_trash: {
          type: "integer",
          enum: [0, 1, 2],
          default: 2,
          description: "PLAUD param: 0=active, 1=trash, 2=all.",
        },
        only_transcribed: {
          type: "boolean",
          default: false,
          description: "Return only files marked as transcribed.",
        },
        only_summarized: {
          type: "boolean",
          default: false,
          description: "Return only files marked as summarized.",
        },
        include_raw: {
          type: "boolean",
          default: false,
          description: "Include raw API item fields.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: TOOL_GET_FILE_DATA,
    description: "Get PLAUD detail, transcript, and summary content by file_id.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "PLAUD file id.",
        },
        include_transcript: {
          type: "boolean",
          default: true,
          description: "Include transcript content.",
        },
        include_transcript_segments: {
          type: "boolean",
          default: false,
          description: "Include transcript segment array.",
        },
        include_summary: {
          type: "boolean",
          default: true,
          description: "Include summary content.",
        },
        include_detail_raw: {
          type: "boolean",
          default: false,
          description: "Include raw detail response.",
        },
        max_transcript_chars: {
          type: "integer",
          minimum: 1,
          description: "Optional max chars for transcript text.",
        },
        max_summary_chars_per_item: {
          type: "integer",
          minimum: 1,
          description: "Optional max chars for each summary item.",
        },
      },
      required: ["file_id"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_AUTH_BROWSER,
    description: "Opens a local auth page in your browser to capture your PLAUD login token. Works on Windows, macOS, and Linux.",
    inputSchema: {
      type: "object",
      properties: {
        open_browser: {
          type: "boolean",
          default: true,
          description: "Whether to automatically open the auth page in the default browser.",
        },
        port: {
          type: "integer",
          minimum: 1024,
          maximum: 65535,
          default: 0,
          description: "Port for the local auth server. 0 = auto-assign.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 10000,
          maximum: 300000,
          default: 120000,
          description: "How long to wait for token capture (ms). Default 2 minutes.",
        },
        persist: {
          type: "boolean",
          default: true,
          description: "Save token to ~/.plaud/token for reuse across sessions.",
        },
        return_token: {
          type: "boolean",
          default: false,
          description: "Whether to return full token in response.",
        },
      },
      additionalProperties: false,
    },
  },
];

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeToken(rawToken) {
  const token = String(rawToken || "").trim();
  if (!token) return "";
  return token.replace(/^bearer\s+/i, "");
}

function normalizeApiOrigin(rawOrigin) {
  const value = String(rawOrigin || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

function normalizePlaudBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes") return true;
    if (v === "false" || v === "0" || v === "no") return false;
  }
  return Boolean(value);
}

function clampInteger(value, { defaultValue, min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultValue;
  const rounded = Math.floor(n);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function toOptionalPositiveInt(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function toBoolean(value, defaultValue) {
  if (value == null) return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (!lowered) return defaultValue;
    if (["1", "true", "yes", "on"].includes(lowered)) return true;
    if (["0", "false", "no", "off"].includes(lowered)) return false;
  }
  return defaultValue;
}

function maskToken(token) {
  const raw = String(token || "").trim();
  if (raw.length <= 16) return raw;
  return `${raw.slice(0, 8)}...${raw.slice(-6)}`;
}

// --- Cross-platform auth: local HTTP callback server ---

function getDefaultTokenPath() {
  const dir = join(homedir(), ".plaud");
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
  }
  return join(dir, "token");
}

function loadPersistedToken() {
  const tokenPath = getDefaultTokenPath();
  try {
    const text = readFileSync(tokenPath, "utf8");
    return normalizeToken(text);
  } catch {
    return "";
  }
}

function persistToken(token) {
  const tokenPath = getDefaultTokenPath();
  try {
    const dir = join(homedir(), ".plaud");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    return tokenPath;
  } catch (err) {
    return "";
  }
}

function openBrowserCrossPlatform(url) {
  const platform = process.platform;
  let cmd;
  if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  return new Promise((resolve, reject) => {
    exec(cmd, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function buildTokenExtractorSnippet(callbackPort) {
  return `(function(){var t='';function scan(s){try{for(var i=0;i<s.length;i++){var k=s.key(i),v=s.getItem(k);var m=v.match(/eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}/);if(m)return m[0]}}catch(e){}return ''}t=scan(localStorage)||scan(sessionStorage);if(!t){var cm=document.cookie.match(/eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}/);if(cm)t=cm[0]}if(t){fetch('http://localhost:${callbackPort}/callback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})}).then(function(){document.title='Token captured!'}).catch(function(){prompt('Auto-send failed. Copy this token and paste it on the auth page:',t)})}else{alert('No PLAUD token found. Make sure you are logged in to web.plaud.ai first.')}})()`;
}

function buildAuthPageHtml(callbackPort) {
  const snippet = buildTokenExtractorSnippet(callbackPort);
  const bookmarklet = `javascript:${encodeURIComponent(snippet)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PLAUD MCP — Authenticate</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 2rem; }
  .card { background: #1e293b; border-radius: 16px; padding: 2.5rem; max-width: 640px; width: 100%; box-shadow: 0 25px 50px rgba(0,0,0,0.4); }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #f8fafc; }
  .subtitle { color: #94a3b8; margin-bottom: 2rem; font-size: 0.95rem; }
  .step { background: #0f172a; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; border-left: 3px solid #3b82f6; }
  .step-num { display: inline-block; background: #3b82f6; color: white; width: 28px; height: 28px; border-radius: 50%; text-align: center; line-height: 28px; font-size: 0.85rem; font-weight: 600; margin-right: 0.75rem; }
  .step h3 { display: inline; font-size: 1rem; color: #f1f5f9; }
  .step p { margin-top: 0.5rem; color: #94a3b8; font-size: 0.9rem; line-height: 1.5; }
  a.btn { display: inline-block; background: #3b82f6; color: white; padding: 0.6rem 1.25rem; border-radius: 8px; text-decoration: none; font-weight: 500; margin-top: 0.5rem; transition: background 0.2s; }
  a.btn:hover { background: #2563eb; }
  a.btn-outline { background: transparent; border: 1px solid #475569; color: #cbd5e1; }
  a.btn-outline:hover { border-color: #3b82f6; color: #3b82f6; }
  .code-box { background: #020617; border: 1px solid #334155; border-radius: 8px; padding: 0.75rem 1rem; margin-top: 0.75rem; font-family: 'Fira Code', 'Consolas', monospace; font-size: 0.8rem; color: #7dd3fc; word-break: break-all; cursor: pointer; position: relative; max-height: 80px; overflow-y: auto; }
  .code-box:hover { border-color: #3b82f6; }
  .copy-hint { position: absolute; top: 4px; right: 8px; font-size: 0.7rem; color: #475569; }
  .divider { border: none; border-top: 1px solid #334155; margin: 1.5rem 0; }
  .manual { background: #0f172a; border-radius: 12px; padding: 1.25rem; }
  .manual h3 { font-size: 0.95rem; color: #f1f5f9; margin-bottom: 0.75rem; }
  input[type="text"] { width: 100%; background: #020617; border: 1px solid #334155; border-radius: 8px; padding: 0.6rem 1rem; color: #e2e8f0; font-family: monospace; font-size: 0.85rem; margin-bottom: 0.75rem; }
  input[type="text"]:focus { outline: none; border-color: #3b82f6; }
  button { background: #3b82f6; color: white; border: none; padding: 0.6rem 1.25rem; border-radius: 8px; font-weight: 500; cursor: pointer; font-size: 0.9rem; }
  button:hover { background: #2563eb; }
  .status { margin-top: 1rem; padding: 0.75rem 1rem; border-radius: 8px; display: none; font-size: 0.9rem; }
  .status.success { display: block; background: #052e16; border: 1px solid #166534; color: #4ade80; }
  .status.error { display: block; background: #450a0a; border: 1px solid #991b1b; color: #fca5a5; }
  .bookmarklet-area { margin-top: 0.75rem; }
  .bookmarklet-link { display: inline-block; background: #7c3aed; color: white; padding: 0.5rem 1rem; border-radius: 8px; text-decoration: none; font-weight: 500; font-size: 0.85rem; cursor: grab; }
  .bookmarklet-link:hover { background: #6d28d9; }
  .hint { font-size: 0.8rem; color: #64748b; margin-top: 0.4rem; }
</style>
</head>
<body>
<div class="card">
  <h1>PLAUD MCP Authentication</h1>
  <p class="subtitle">Connect your PLAUD account to your MCP client. Choose any method below.</p>

  <div class="step">
    <span class="step-num">1</span><h3>Open PLAUD</h3>
    <p>Log in to your PLAUD account if you are not already logged in.</p>
    <a href="https://web.plaud.ai/file/" target="_blank" class="btn" style="margin-top: 0.75rem;">Open PLAUD Web App &rarr;</a>
  </div>

  <div class="step">
    <span class="step-num">2</span><h3>Extract Token (Option A — Console Snippet)</h3>
    <p>While on <strong>web.plaud.ai</strong>, press <strong>F12</strong> to open DevTools, go to the <strong>Console</strong> tab, and paste this:</p>
    <div class="code-box" id="snippet" onclick="copySnippet()">${snippet}<span class="copy-hint">click to copy</span></div>
    <p class="hint">This extracts your login token and sends it back here automatically.</p>
  </div>

  <div class="step">
    <span class="step-num">2</span><h3>Extract Token (Option B — Bookmarklet)</h3>
    <p>Drag this button to your bookmarks bar. Then click it while on web.plaud.ai:</p>
    <div class="bookmarklet-area">
      <a href="${bookmarklet}" class="bookmarklet-link" onclick="event.preventDefault(); alert('Drag this to your bookmarks bar, then click it while on web.plaud.ai');">&#x1f50d; Extract PLAUD Token</a>
    </div>
    <p class="hint">One-time setup — works for future sessions too.</p>
  </div>

  <hr class="divider">

  <div class="manual">
    <h3>Manual Token Entry</h3>
    <p style="color: #94a3b8; font-size: 0.85rem; margin-bottom: 0.75rem;">If the above methods do not work, paste your PLAUD bearer token here:</p>
    <input type="text" id="tokenInput" placeholder="eyJhbGciOi..." />
    <button onclick="submitToken()">Submit Token</button>
  </div>

  <div id="status" class="status"></div>
</div>

<script>
function copySnippet() {
  var text = document.getElementById('snippet').innerText.replace('click to copy', '').trim();
  navigator.clipboard.writeText(text).then(function() {
    var el = document.querySelector('.copy-hint');
    el.textContent = 'copied!';
    setTimeout(function() { el.textContent = 'click to copy'; }, 2000);
  });
}

function showStatus(msg, ok) {
  var el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + (ok ? 'success' : 'error');
}

function submitToken() {
  var token = document.getElementById('tokenInput').value.trim();
  if (!token) { showStatus('Please paste a token first.', false); return; }
  fetch('/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token })
  }).then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) showStatus('Token captured successfully! You can close this tab.', true);
      else showStatus('Error: ' + (d.error || 'Unknown'), false);
    })
    .catch(function(e) { showStatus('Failed to send token: ' + e.message, false); });
}

// Listen for auto-callback success
var pollId = setInterval(function() {
  fetch('/status').then(function(r) { return r.json(); }).then(function(d) {
    if (d.captured) {
      clearInterval(pollId);
      showStatus('Token captured successfully! You can close this tab.', true);
    }
  }).catch(function() {});
}, 2000);
</script>
</body>
</html>`;
}

function startAuthServer({ port = 0, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let captured = false;
    let capturedToken = "";
    let serverRef = null;
    let timeoutHandle = null;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (serverRef) {
        try { serverRef.close(); } catch { /* ignore */ }
      }
    };

    serverRef = createServer((req, res) => {
      const actualPort = serverRef.address()?.port || port;
      const reqUrl = new URL(req.url || "/", "http://localhost:" + actualPort);

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (reqUrl.pathname === "/" || reqUrl.pathname === "/auth") {
        const html = buildAuthPageHtml(actualPort);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (reqUrl.pathname === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ captured }));
        return;
      }

      if (reqUrl.pathname === "/callback" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            const token = normalizeToken(data?.token);
            if (!token) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "No valid token received" }));
              return;
            }
            capturedToken = token;
            captured = true;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, masked: maskToken(token) }));

            setTimeout(() => {
              cleanup();
              resolve({ token: capturedToken, source: "auth_server" });
            }, 500);
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid request body" }));
          }
        });
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    serverRef.listen(port, "127.0.0.1", () => {
      const actualPort = serverRef.address()?.port;
      process.stderr.write("Auth server listening on http://localhost:" + actualPort + "\n");
    });

    serverRef.on("error", (err) => {
      cleanup();
      reject(new Error("Auth server failed to start: " + err.message));
    });

    timeoutHandle = setTimeout(() => {
      cleanup();
      if (!captured) {
        reject(new Error("Auth timed out after " + Math.round(timeoutMs / 1000) + " seconds. Please try again."));
      }
    }, timeoutMs);
  });
}

function startAuthServerWithBrowser({ port = 0, timeoutMs = 120000, openBrowser = true } = {}) {
  return new Promise((resolve, reject) => {
    let captured = false;
    let capturedToken = "";
    let serverRef = null;
    let timeoutHandle = null;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (serverRef) {
        try { serverRef.close(); } catch { /* ignore */ }
      }
    };

    serverRef = createServer((req, res) => {
      const actualPort = serverRef.address()?.port || port;
      const reqUrl = new URL(req.url || "/", "http://localhost:" + actualPort);

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (reqUrl.pathname === "/" || reqUrl.pathname === "/auth") {
        const html = buildAuthPageHtml(actualPort);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (reqUrl.pathname === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ captured }));
        return;
      }

      if (reqUrl.pathname === "/callback" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            const token = normalizeToken(data?.token);
            if (!token) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "No valid token received" }));
              return;
            }
            capturedToken = token;
            captured = true;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, masked: maskToken(token) }));

            setTimeout(() => {
              cleanup();
              resolve({ token: capturedToken, source: "auth_server" });
            }, 500);
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid request body" }));
          }
        });
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    serverRef.listen(port, "127.0.0.1", async () => {
      const actualPort = serverRef.address()?.port;
      const authUrl = "http://localhost:" + actualPort;
      process.stderr.write("Auth server listening on " + authUrl + "\n");

      if (openBrowser) {
        try {
          await openBrowserCrossPlatform(authUrl);
          process.stderr.write("Opened browser to " + authUrl + "\n");
        } catch (err) {
          process.stderr.write("Could not open browser automatically: " + err.message + "\nPlease open " + authUrl + " manually.\n");
        }
      } else {
        process.stderr.write("Open " + authUrl + " in your browser to authenticate.\n");
      }
    });

    serverRef.on("error", (err) => {
      cleanup();
      reject(new Error("Auth server failed to start: " + err.message));
    });

    timeoutHandle = setTimeout(() => {
      cleanup();
      if (!captured) {
        reject(new Error("Auth timed out after " + Math.round(timeoutMs / 1000) + " seconds. Please try again."));
      }
    }, timeoutMs);
  });
}

function formatDateFromSessionId(sessionId) {
  const n = Number(sessionId);
  if (!Number.isFinite(n) || n <= 0) return "";
  const ms = n >= 1_000_000_000_000 ? n : n * 1000;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString();
}

function normalizeDurationMs(item) {
  const durationMsCandidates = [
    item?.duration_ms,
    item?.durationMs,
    item?.duration,
    item?.duration_sec,
    item?.durationSec,
    item?.audio_duration,
    item?.audioDuration,
  ];

  for (const candidate of durationMsCandidates) {
    const n = Number(candidate);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n < 24 * 60 * 60 * 1000) {
      if (String(candidate).includes(".") || n < 10_000) return Math.round(n * 1000);
      return Math.round(n);
    }
    return Math.round(n);
  }

  return 0;
}

function truncateText(text, maxChars) {
  const raw = String(text || "");
  if (!maxChars || raw.length <= maxChars) {
    return { text: raw, truncated: false, originalLength: raw.length };
  }
  return {
    text: raw.slice(0, maxChars),
    truncated: true,
    originalLength: raw.length,
  };
}

function replaceUrlOrigin(url, newOrigin) {
  try {
    const target = new URL(url);
    const next = new URL(newOrigin);
    target.protocol = next.protocol;
    target.host = next.host;
    return target.toString();
  } catch {
    return url;
  }
}

function getFileDetailDataNode(detailResponse) {
  const root =
    detailResponse && typeof detailResponse === "object" && detailResponse !== null
      ? detailResponse
      : {};
  return root?.data && typeof root.data === "object" && root.data !== null ? root.data : root;
}

function extractTranscriptLinkFromFileDetailResponse(detailResponse) {
  const dataNode = getFileDetailDataNode(detailResponse);
  const list = Array.isArray(dataNode?.content_list) ? dataNode.content_list : [];
  const normalized = [];

  for (const item of list) {
    const type = String(item?.data_type ?? item?.dataType ?? "")
      .trim()
      .toLowerCase();
    const link = String(item?.data_link ?? item?.dataLink ?? "").trim();
    if (!link) continue;
    normalized.push({ type, link });
  }

  const preferred =
    normalized.find((entry) => entry.type === "transaction") ||
    normalized.find((entry) => entry.type.includes("trans")) ||
    normalized[0];

  return preferred?.link || "";
}

function extractTextFromUnknownValue(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return pickNonEmptyString(
    value?.content,
    value?.markdown,
    value?.text,
    value?.summary,
    value?.result,
    value?.value,
    value?.data,
    value?.raw
  );
}

function extractContentListItemInlineText(item) {
  const candidates = [
    item?.data_content,
    item?.dataContent,
    item?.content,
    item?.markdown,
    item?.text,
    item?.value,
    item?.data,
    item?.data_value,
    item?.dataValue,
  ];
  for (const candidate of candidates) {
    const text = extractTextFromUnknownValue(candidate);
    if (text) return text;
  }
  return "";
}

function extractContentListItemLink(item) {
  return pickNonEmptyString(item?.data_link, item?.dataLink, item?.link, item?.url);
}

function sniffGzipHeader(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function fetchJsonFromUrlMaybeGzip(url) {
  const requestUrl = String(url || "").trim();
  if (!requestUrl) throw new Error("Missing downloadable URL");

  const response = await fetch(requestUrl, { method: "GET" });
  const contentType = String(response.headers.get("content-type") || "").trim();
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Download failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const directText = buffer.toString("utf8");
  const directJson = safeJsonParse(directText);
  if (directJson) {
    return {
      data: directJson,
      rawText: directText,
      requestUrl: response.url || requestUrl,
      contentType,
    };
  }

  const mayBeGzip =
    sniffGzipHeader(buffer) || contentType.toLowerCase().includes("gzip");
  if (mayBeGzip) {
    try {
      const decompressedText = gunzipSync(buffer).toString("utf8");
      const decompressedJson = safeJsonParse(decompressedText);
      if (decompressedJson) {
        return {
          data: decompressedJson,
          rawText: decompressedText,
          requestUrl: response.url || requestUrl,
          contentType,
        };
      }
      throw new Error("gzip payload is not valid JSON after decompression");
    } catch (err) {
      const msg = err?.message || String(err);
      throw new Error(`Failed to parse gzip payload: ${msg}`);
    }
  }

  return {
    data: { raw: directText },
    rawText: directText,
    requestUrl: response.url || requestUrl,
    contentType,
  };
}

function formatSpeakerForTranscript(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^SPEAKER\s*(\d+)$/i) || raw.match(/^SPEAKER(\d+)$/i);
  if (match?.[1]) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n)) return `Speaker ${n}`;
  }
  return raw || "Speaker 1";
}

function buildTranscriptTextForSummary(transResult) {
  const list = Array.isArray(transResult) ? transResult : [];
  const lines = [];
  for (const segment of list) {
    const content = String(segment?.content || "").trim();
    if (!content) continue;
    const speaker = formatSpeakerForTranscript(segment?.speaker);
    lines.push(`${speaker}: ${content}`);
  }
  return lines.join("\n").trim();
}

class PlaudClient {
  constructor({ token, apiOrigin }) {
    this.token = normalizeToken(token);
    this.apiOrigin = normalizeApiOrigin(apiOrigin) || DEFAULT_API_ORIGIN;
  }

  buildHeaders(includeJsonBody) {
    const headers = {
      accept: "application/json",
      Authorization: `Bearer ${this.token}`,
      "edit-from": "web",
    };
    if (includeJsonBody) {
      headers["content-type"] = "application/json";
    }
    return headers;
  }

  buildUrl(pathname) {
    return new URL(pathname, this.apiOrigin).toString();
  }

  async requestJson({ method = "GET", pathname = "", absoluteUrl = "", body = null, retry = 0 }) {
    const requestUrl = absoluteUrl || this.buildUrl(pathname);
    const response = await fetch(requestUrl, {
      method,
      headers: this.buildHeaders(body != null),
      body: body == null ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    const parsed = safeJsonParse(text) ?? { raw: text };

    if (parsed?.status === -302 && parsed?.data?.domains?.api && retry < 2) {
      const redirectedOrigin = normalizeApiOrigin(parsed.data.domains.api);
      if (redirectedOrigin && redirectedOrigin !== this.apiOrigin) {
        this.apiOrigin = redirectedOrigin;
        const retriedUrl = absoluteUrl ? replaceUrlOrigin(requestUrl, redirectedOrigin) : "";
        return this.requestJson({
          method,
          pathname,
          absoluteUrl: retriedUrl,
          body,
          retry: retry + 1,
        });
      }
    }

    if (!response.ok) {
      throw new Error(`PLAUD API request failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    if (typeof parsed?.status === "number" && parsed.status !== 0) {
      throw new Error(parsed?.msg || `PLAUD API returned non-zero status: ${parsed.status}`);
    }

    return {
      data: parsed,
      rawText: text,
      requestUrl: response.url || requestUrl,
      statusCode: response.status,
    };
  }

  async listFiles({ skip, limit, isTrash }) {
    const url = new URL("/file/simple/web", this.apiOrigin);
    url.searchParams.set("skip", String(skip));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("is_trash", String(isTrash));
    url.searchParams.set("sort_by", "start_time");
    url.searchParams.set("is_desc", "true");

    const resp = await this.requestJson({ method: "GET", absoluteUrl: url.toString() });
    const list = Array.isArray(resp?.data?.data_file_list) ? resp.data.data_file_list : [];
    return { list, requestUrl: resp.requestUrl };
  }

  async getFileDetail(fileId) {
    const encoded = encodeURIComponent(String(fileId || "").trim());
    const resp = await this.requestJson({ method: "GET", pathname: `/file/detail/${encoded}` });
    return { detail: resp.data, requestUrl: resp.requestUrl };
  }
}

function normalizeFileListEntry(item, includeRaw) {
  const id = pickNonEmptyString(item?.id, item?.file_id, item?.fileId);
  const title = pickNonEmptyString(
    item?.title,
    item?.file_title,
    item?.fileTitle,
    item?.name,
    item?.file_name,
    item?.fileName,
    item?.filename
  );
  const sessionId = pickNonEmptyString(item?.session_id, item?.sessionId);

  const normalized = {
    file_id: id,
    title: title || (id ? `plaud-${id}` : "plaud"),
    session_id: sessionId,
    started_at: formatDateFromSessionId(sessionId),
    duration_ms: normalizeDurationMs(item),
    is_transcribed: normalizePlaudBool(item?.is_trans ?? item?.isTrans),
    is_summarized: normalizePlaudBool(item?.is_summary ?? item?.isSummary),
  };

  if (includeRaw) {
    normalized.raw = item;
  }

  return normalized;
}

async function loadTranscriptFromFileDetail(detailData) {
  const dataNode = getFileDetailDataNode(detailData);

  const directList = Array.isArray(dataNode?.trans_result) ? dataNode.trans_result : null;
  if (directList?.length) {
    const normalized = normalizeTranscriptionToTransResult(directList);
    if (normalized.length) {
      return {
        source: "detail.trans_result",
        transcriptUrl: "",
        transResult: normalized,
      };
    }
  }

  const directText = pickNonEmptyString(
    dataNode?.transcript,
    dataNode?.transcript_text,
    dataNode?.transcriptText
  );
  if (directText) {
    const normalized = normalizeTranscriptionToTransResult({ text: directText });
    if (normalized.length) {
      return {
        source: "detail.transcript_text",
        transcriptUrl: "",
        transResult: normalized,
      };
    }
  }

  const transcriptUrl = extractTranscriptLinkFromFileDetailResponse(detailData);
  if (!transcriptUrl) {
    return {
      source: "none",
      transcriptUrl: "",
      transResult: [],
    };
  }

  const transcriptResp = await fetchJsonFromUrlMaybeGzip(transcriptUrl);
  const normalized = normalizeTranscriptionToTransResult(transcriptResp?.data);
  return {
    source: "content_list.link",
    transcriptUrl,
    transResult: normalized,
  };
}

async function resolveContentListItemText(item) {
  const inlineText = extractContentListItemInlineText(item);
  if (inlineText) {
    return { text: inlineText, source: "content_list.inline", link: "" };
  }

  const link = extractContentListItemLink(item);
  if (!link) {
    return { text: "", source: "none", link: "" };
  }

  const resp = await fetchJsonFromUrlMaybeGzip(link);
  const fromData = extractTextFromUnknownValue(resp?.data);
  if (fromData) {
    return { text: fromData, source: "content_list.link", link };
  }

  return { text: String(resp?.rawText || "").trim(), source: "content_list.link", link };
}

async function extractSummaryEntriesFromFileDetail(detailData, options = {}) {
  const maxCharsPerItem = toOptionalPositiveInt(options.maxCharsPerItem);
  const dataNode = getFileDetailDataNode(detailData);
  const summaries = [];
  const warnings = [];
  const dedupe = new Set();

  const pushSummary = (entry) => {
    const text = String(entry?.content || "").trim();
    if (!text) return;
    const dedupeKey = `${entry.type || ""}:${text}`;
    if (dedupe.has(dedupeKey)) return;
    dedupe.add(dedupeKey);

    const truncated = truncateText(text, maxCharsPerItem);
    summaries.push({
      ...entry,
      content: truncated.text,
      content_truncated: truncated.truncated,
      content_original_length: truncated.originalLength,
    });
  };

  const aiContent = pickNonEmptyString(dataNode?.ai_content, dataNode?.aiContent);
  if (aiContent) {
    pushSummary({
      type: "ai_content",
      tab_name: "AI Content",
      source: "detail.ai_content",
      link: "",
      content: aiContent,
    });
  }

  const list = Array.isArray(dataNode?.content_list) ? dataNode.content_list : [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    const type = String(item?.data_type ?? item?.dataType ?? "")
      .trim()
      .toLowerCase();
    if (type === "transaction") continue;

    const tabName = pickNonEmptyString(
      item?.data_tab_name,
      item?.dataTabName,
      item?.tab_name,
      item?.tabName,
      item?.tab
    );

    try {
      const resolved = await resolveContentListItemText(item);
      if (!resolved.text) continue;
      pushSummary({
        type: type || "summary",
        tab_name: tabName || `summary-${index + 1}`,
        source: resolved.source,
        link: resolved.link || "",
        content: resolved.text,
      });
    } catch (err) {
      warnings.push({
        index,
        type: type || "summary",
        tab_name: tabName || `summary-${index + 1}`,
        error: err?.message || String(err),
      });
    }
  }

  return { summaries, warnings };
}

let runtimePlaudToken = "";
let runtimePlaudTokenSource = "";

function setRuntimePlaudToken(token, source = "runtime") {
  runtimePlaudToken = normalizeToken(token);
  runtimePlaudTokenSource = runtimePlaudToken ? String(source || "runtime") : "";
}

function resolvePlaudToken() {
  const runtimeToken = normalizeToken(runtimePlaudToken);
  if (runtimeToken) return runtimeToken;

  const directToken = normalizeToken(
    process.env.PLAUD_TOKEN || process.env.PLAUD_BEARER_TOKEN || process.env.PLAUD_AUTH_TOKEN
  );
  if (directToken) return directToken;

  const tokenFile = String(process.env.PLAUD_TOKEN_FILE || "").trim();
  if (tokenFile) {
    try {
      const text = readFileSync(tokenFile, "utf8");
      const fileToken = normalizeToken(text);
      if (fileToken) return fileToken;
    } catch { /* ignore */ }
  }

  // Check default persisted token location (~/.plaud/token)
  const persistedToken = loadPersistedToken();
  if (persistedToken) return persistedToken;

  return "";
}

function resolvePlaudTokenSource() {
  if (normalizeToken(runtimePlaudToken)) return runtimePlaudTokenSource || "runtime";
  if (
    normalizeToken(process.env.PLAUD_TOKEN) ||
    normalizeToken(process.env.PLAUD_BEARER_TOKEN) ||
    normalizeToken(process.env.PLAUD_AUTH_TOKEN)
  ) {
    return "env";
  }
  if (String(process.env.PLAUD_TOKEN_FILE || "").trim()) return "token_file";
  if (loadPersistedToken()) return "persisted_file";
  return "";
}

let plaudClient = null;

function getPlaudClient() {
  const token = resolvePlaudToken();
  if (!token) {
    throw new Error(
      "Missing PLAUD token. Set PLAUD_TOKEN (or PLAUD_BEARER_TOKEN / PLAUD_AUTH_TOKEN / PLAUD_TOKEN_FILE), or call plaud_auth_browser first."
    );
  }

  const configuredOrigin = normalizeApiOrigin(process.env.PLAUD_API_ORIGIN) || DEFAULT_API_ORIGIN;
  const keepOrigin = plaudClient?.apiOrigin || configuredOrigin;

  if (!plaudClient || plaudClient.token !== token) {
    plaudClient = new PlaudClient({
      token,
      apiOrigin: keepOrigin,
    });
  }
  return plaudClient;
}

async function handleAuthBrowser(args) {
  const openBrowser = toBoolean(args?.open_browser, true);
  const port = clampInteger(args?.port, { defaultValue: 0, min: 0, max: 65535 });
  const timeoutMs = clampInteger(args?.timeout_ms, { defaultValue: 120000, min: 10000, max: 300000 });
  const shouldPersist = toBoolean(args?.persist, true);
  const returnToken = toBoolean(args?.return_token, false);

  // Check for persisted token first
  const persisted = loadPersistedToken();
  if (persisted) {
    setRuntimePlaudToken(persisted, "persisted_file");
    return {
      ok: true,
      token_loaded: true,
      token_source: "persisted_file",
      token_masked: maskToken(persisted),
      token_path: getDefaultTokenPath(),
      method: "persisted",
      return_token: returnToken,
      token: returnToken ? persisted : "",
    };
  }

  // Start local auth server and open browser
  const result = await startAuthServerWithBrowser({ port, timeoutMs, openBrowser });

  const token = normalizeToken(result?.token);
  if (!token) {
    throw new Error("No PLAUD token was captured. Please try again.");
  }

  setRuntimePlaudToken(token, "auth_server");

  let savedPath = "";
  if (shouldPersist) {
    savedPath = persistToken(token);
  }

  return {
    ok: true,
    token_loaded: true,
    token_source: resolvePlaudTokenSource(),
    token_masked: maskToken(token),
    token_path: savedPath,
    method: "auth_server",
    platform: process.platform,
    return_token: returnToken,
    token: returnToken ? token : "",
  };
}

async function handleListFiles(args) {
  const client = getPlaudClient();
  const limit = clampInteger(args?.limit, { defaultValue: 50, min: 1, max: 200 });
  const skip = clampInteger(args?.skip, { defaultValue: 0, min: 0, max: 1_000_000 });
  const isTrash = clampInteger(args?.is_trash, { defaultValue: 2, min: 0, max: 2 });
  const query = String(args?.query || "")
    .trim()
    .toLowerCase();
  const includeRaw = toBoolean(args?.include_raw, false);
  const onlyTranscribed = toBoolean(args?.only_transcribed, false);
  const onlySummarized = toBoolean(args?.only_summarized, false);

  const { list, requestUrl } = await client.listFiles({ skip, limit, isTrash });
  let files = list.map((item) => normalizeFileListEntry(item, includeRaw));

  if (query) {
    files = files.filter((file) => {
      const id = String(file?.file_id || "").toLowerCase();
      const title = String(file?.title || "").toLowerCase();
      return id.includes(query) || title.includes(query);
    });
  }

  if (onlyTranscribed) {
    files = files.filter((file) => file?.is_transcribed);
  }

  if (onlySummarized) {
    files = files.filter((file) => file?.is_summarized);
  }

  return {
    api_origin: client.apiOrigin,
    request_url: requestUrl,
    count: files.length,
    limit,
    skip,
    is_trash: isTrash,
    query,
    files,
  };
}

async function handleGetFileData(args) {
  const client = getPlaudClient();
  const fileId = pickNonEmptyString(args?.file_id, args?.fileId);
  if (!fileId) throw new Error("Missing file_id");

  const includeTranscript = toBoolean(args?.include_transcript, true);
  const includeTranscriptSegments = toBoolean(args?.include_transcript_segments, false);
  const includeSummary = toBoolean(args?.include_summary, true);
  const includeDetailRaw = toBoolean(args?.include_detail_raw, false);
  const maxTranscriptChars = toOptionalPositiveInt(args?.max_transcript_chars);
  const maxSummaryCharsPerItem = toOptionalPositiveInt(args?.max_summary_chars_per_item);

  const detailResp = await client.getFileDetail(fileId);
  const detailData = detailResp.detail;
  const dataNode = getFileDetailDataNode(detailData);

  const title = pickNonEmptyString(
    dataNode?.title,
    dataNode?.file_title,
    dataNode?.fileTitle,
    dataNode?.name,
    dataNode?.file_name,
    dataNode?.fileName,
    dataNode?.filename
  );
  const sessionId = pickNonEmptyString(dataNode?.session_id, dataNode?.sessionId);

  const result = {
    api_origin: client.apiOrigin,
    request_url: detailResp.requestUrl,
    file: {
      file_id: fileId,
      title: title || `plaud-${fileId}`,
      session_id: sessionId,
      started_at: formatDateFromSessionId(sessionId),
      duration_ms: normalizeDurationMs(dataNode),
      is_transcribed: normalizePlaudBool(dataNode?.is_trans ?? dataNode?.isTrans),
      is_summarized: normalizePlaudBool(dataNode?.is_summary ?? dataNode?.isSummary),
    },
  };

  if (includeTranscript) {
    const transcript = await loadTranscriptFromFileDetail(detailData);
    const transcriptTextFull = buildTranscriptTextForSummary(transcript.transResult);
    const truncatedTranscript = truncateText(transcriptTextFull, maxTranscriptChars);

    result.transcript = {
      source: transcript.source,
      transcript_url: transcript.transcriptUrl,
      segment_count: transcript.transResult.length,
      text: truncatedTranscript.text,
      text_truncated: truncatedTranscript.truncated,
      text_original_length: truncatedTranscript.originalLength,
    };

    if (includeTranscriptSegments) {
      result.transcript.segments = transcript.transResult;
    }
  }

  if (includeSummary) {
    const summary = await extractSummaryEntriesFromFileDetail(detailData, {
      maxCharsPerItem: maxSummaryCharsPerItem,
    });
    result.summary = {
      count: summary.summaries.length,
      items: summary.summaries,
      warnings: summary.warnings,
    };
  }

  if (includeDetailRaw) {
    result.detail_raw = detailData;
  }

  return result;
}

function buildToolTextResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function buildToolErrorResult(error) {
  const message = error?.message || String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

async function executeToolCall(name, args) {
  if (name === TOOL_AUTH_BROWSER) return handleAuthBrowser(args || {});
  if (name === TOOL_LIST_FILES) return handleListFiles(args || {});
  if (name === TOOL_GET_FILE_DATA) return handleGetFileData(args || {});
  throw new Error(`Unknown tool: ${name}`);
}

let negotiatedProtocolVersion = DEFAULT_PROTOCOL_VERSION;
let stdinBuffer = Buffer.alloc(0);
let outboundFraming = "content-length";

function sendMessage(payload) {
  const bodyText = JSON.stringify(payload);
  if (outboundFraming === "newline-json") {
    process.stdout.write(bodyText);
    process.stdout.write("\n");
    return;
  }

  const body = Buffer.from(bodyText, "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  process.stdout.write(header);
  process.stdout.write(body);
}

function sendResponse(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const errorPayload = { code, message };
  if (data !== undefined) errorPayload.data = data;
  sendMessage({
    jsonrpc: "2.0",
    id,
    error: errorPayload,
  });
}

function logError(message, error) {
  const line = String(message || "").trim();
  const detail = error?.stack || error?.message || (error ? String(error) : "");
  const text = detail ? `${line}\n${detail}\n` : `${line}\n`;
  process.stderr.write(text);
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    const requestedVersion = String(params?.protocolVersion || "").trim();
    if (requestedVersion && SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)) {
      negotiatedProtocolVersion = requestedVersion;
    } else {
      negotiatedProtocolVersion = DEFAULT_PROTOCOL_VERSION;
    }

    const token = resolvePlaudToken();
    const tokenSource = resolvePlaudTokenSource();
    sendResponse(id, {
      protocolVersion: negotiatedProtocolVersion,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      instructions: token
        ? `PLAUD token loaded (${maskToken(token)}), source=${tokenSource || "unknown"}.`
        : "No PLAUD token found. Set PLAUD_TOKEN / PLAUD_TOKEN_FILE, or call tool plaud_auth_browser.",
    });
    return;
  }

  if (method === "ping") {
    sendResponse(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResponse(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const toolName = String(params?.name || "").trim();
    const toolArgs = params?.arguments && typeof params.arguments === "object"
      ? params.arguments
      : {};

    try {
      const payload = await executeToolCall(toolName, toolArgs);
      sendResponse(id, buildToolTextResult(payload));
    } catch (err) {
      sendResponse(id, buildToolErrorResult(err));
    }
    return;
  }

  if (method === "resources/list") {
    sendResponse(id, { resources: [] });
    return;
  }

  if (method === "prompts/list") {
    sendResponse(id, { prompts: [] });
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

function handleNotification(message) {
  const method = String(message?.method || "").trim();
  if (method === "notifications/initialized") return;
  if (method === "logging/setLevel") return;
}

function findHeaderBoundary(buffer) {
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  if (crlfIndex !== -1) {
    return { index: crlfIndex, delimiterLength: 4 };
  }

  const lfIndex = buffer.indexOf("\n\n");
  if (lfIndex !== -1) {
    return { index: lfIndex, delimiterLength: 2 };
  }

  return { index: -1, delimiterLength: 0 };
}

function dispatchInboundMessage(message) {
  if (Object.prototype.hasOwnProperty.call(message, "id")) {
    void handleRequest(message).catch((err) => {
      const id = message.id ?? null;
      logError("Failed to handle MCP request.", err);
      sendError(id, -32603, "Internal error", err?.message || String(err));
    });
    return;
  }

  handleNotification(message);
}

function processInputBuffer() {
  while (true) {
    const headPreview = stdinBuffer.slice(0, Math.min(64, stdinBuffer.length)).toString("utf8");
    const startsWithContentLength = /^\s*content-length\s*:/i.test(headPreview);

    if (startsWithContentLength) {
      const { index: headerEnd, delimiterLength } = findHeaderBoundary(stdinBuffer);
      if (headerEnd === -1) return;

      const headerText = stdinBuffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = headerText.match(/content-length:\s*(\d+)/i);
      if (!lengthMatch) {
        logError("MCP input is missing Content-Length; skipped one header block.");
        stdinBuffer = stdinBuffer.slice(headerEnd + delimiterLength);
        continue;
      }

      const contentLength = Number(lengthMatch[1]);
      const messageEnd = headerEnd + delimiterLength + contentLength;
      if (stdinBuffer.length < messageEnd) return;

      const bodyBuffer = stdinBuffer.slice(headerEnd + delimiterLength, messageEnd);
      stdinBuffer = stdinBuffer.slice(messageEnd);

      const bodyText = bodyBuffer.toString("utf8");
      const message = safeJsonParse(bodyText);
      if (!message || typeof message !== "object") {
        logError(`MCP input is not valid JSON: ${bodyText.slice(0, 200)}`);
        continue;
      }

      outboundFraming = "content-length";
      dispatchInboundMessage(message);
      continue;
    }

    const lineEnd = stdinBuffer.indexOf("\n");
    if (lineEnd === -1) return;

    const lineText = stdinBuffer.slice(0, lineEnd).toString("utf8");
    stdinBuffer = stdinBuffer.slice(lineEnd + 1);

    const trimmed = lineText.trim();
    if (!trimmed) continue;

    const message = safeJsonParse(trimmed);
    if (!message || typeof message !== "object") {
      logError(`MCP input line is not valid JSON: ${trimmed.slice(0, 200)}`);
      continue;
    }

    outboundFraming = "newline-json";
    dispatchInboundMessage(message);
  }
}

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  processInputBuffer();
});

process.stdin.on("error", (err) => {
  logError("Failed to read stdin.", err);
});

process.on("uncaughtException", (err) => {
  logError("Uncaught exception.", err);
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled promise rejection.", reason);
});

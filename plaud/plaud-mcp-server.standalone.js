#!/usr/bin/env node

// Generated file. Do not edit directly.
// Source: mcp/plaud-mcp-server.js
// Build command: npm run mcp:build-standalone

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
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
const SERVER_VERSION = "0.2.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2024-10-07"]);
const DEFAULT_API_ORIGIN = "https://api.plaud.ai";
const DEFAULT_WEB_FILE_URL = "https://web.plaud.ai/file/";
const DEFAULT_APP_FILE_URL = "https://app.plaud.ai/file/";
const DEFAULT_AUTO_TOKEN_PATH = join(homedir(), ".plaud", "token");
const API_ORIGIN_STATE_FILE_SUFFIX = ".api-origins.json";

const TOOL_LIST_FILES = "plaud_list_files";
const TOOL_GET_FILE_DATA = "plaud_get_file_data";
const TOOL_GET_FILE_AUDIO = "plaud_get_file_audio";
const TOOL_UPLOAD_TRANSCRIPT_FILE = "plaud_upload_transcript_file";
const TOOL_AUTH_BROWSER = "plaud_auth_browser";
const AUDIO_FORMAT_ORIGINAL = "original";
const AUDIO_FORMAT_WAV = "wav";
const TOOL_HEARTBEAT_INTERVAL_MS = 10_000;
const AUDIO_RESULT_CACHE_TTL_MS = 5 * 60 * 1000;
const AUDIO_RESULT_CACHE_MAX_ENTRIES = 120;
const TRANSCRIPT_FORMAT_JSON = "json";
const TRANSCRIPT_FORMAT_SRT = "srt";
const TRANSCRIPT_FORMAT_VTT = "vtt";
const TRANSCRIPT_FORMAT_TEXT = "text";
const TRANSCRIPT_FORMAT_TEXT_TIMESTAMPED = "text_timestamped";
const TRANSCRIPT_UPLOAD_FORMAT_AUTO = "auto";
const TRANSCRIPT_UPLOAD_FORMAT_PLAIN_TEXT = "plain_text";
const TRANSCRIPT_FORMAT_SET = new Set([
  TRANSCRIPT_FORMAT_JSON,
  TRANSCRIPT_FORMAT_SRT,
  TRANSCRIPT_FORMAT_VTT,
  TRANSCRIPT_FORMAT_TEXT,
  TRANSCRIPT_FORMAT_TEXT_TIMESTAMPED,
]);
const TRANSCRIPT_UPLOAD_FORMAT_SET = new Set([
  TRANSCRIPT_UPLOAD_FORMAT_AUTO,
  TRANSCRIPT_FORMAT_JSON,
  TRANSCRIPT_FORMAT_SRT,
  TRANSCRIPT_FORMAT_VTT,
  TRANSCRIPT_FORMAT_TEXT,
  TRANSCRIPT_FORMAT_TEXT_TIMESTAMPED,
  TRANSCRIPT_UPLOAD_FORMAT_PLAIN_TEXT,
]);

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
        transcript_format: {
          type: "string",
          enum: [
            TRANSCRIPT_FORMAT_JSON,
            TRANSCRIPT_FORMAT_SRT,
            TRANSCRIPT_FORMAT_VTT,
            TRANSCRIPT_FORMAT_TEXT,
            TRANSCRIPT_FORMAT_TEXT_TIMESTAMPED,
          ],
          default: TRANSCRIPT_FORMAT_JSON,
          description:
            "Transcript output format: json/srt/vtt/text/text_timestamped.",
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
          description:
            "Optional max chars for transcript text output. Ignored when transcript_format=json.",
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
    name: TOOL_GET_FILE_AUDIO,
    description:
      "Get PLAUD audio temp_url by file_id(s), and optionally download/save/return the audio bytes.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "Single PLAUD file id.",
        },
        file_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Multiple PLAUD file ids for batch mode.",
        },
        audio_format: {
          type: "string",
          enum: [AUDIO_FORMAT_ORIGINAL, AUDIO_FORMAT_WAV],
          default: AUDIO_FORMAT_ORIGINAL,
          description: "Audio export format: original/wav. wav requires ffmpeg.",
        },
        download: {
          type: "boolean",
          default: false,
          description: "Download audio from temp_url before returning.",
        },
        save_to_file: {
          type: "string",
          description: "Optional local output file path (single-file mode only).",
        },
        save_to_dir: {
          type: "string",
          description:
            "Optional local output directory for batch or single mode; auto-generates filename by file_id.",
        },
        return_base64: {
          type: "boolean",
          default: false,
          description: "Return downloaded audio as base64 (size-limited).",
        },
        include_data_url: {
          type: "boolean",
          default: false,
          description: "When return_base64=true, also include data URL payload.",
        },
        max_bytes: {
          type: "integer",
          minimum: 1,
          description:
            "Max download bytes. Defaults: 20MB when return_base64=true, otherwise 500MB.",
        },
        download_concurrency: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          default: 3,
          description: "Batch download concurrency (only for multi-file mode).",
        },
        continue_on_error: {
          type: "boolean",
          default: true,
          description: "When batch mode fails for one file, continue remaining files.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: TOOL_UPLOAD_TRANSCRIPT_FILE,
    description:
      "Upload transcript content to a PLAUD file from a local file, inline text, or structured transcript data.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "PLAUD file id.",
        },
        file_path: {
          type: "string",
          description:
            "Local transcript file path. Supported auto-detected types include .json, .srt, .vtt, .txt, .md.",
        },
        transcript_text: {
          type: "string",
          description:
            "Inline transcript text. Can be JSON, SRT, VTT, timestamped text, or plain text depending on input_format.",
        },
        transcript_data: {
          description:
            "Structured transcript payload. Can be an array of segments or an object with trans_result/segments/utterances/words/text.",
        },
        input_format: {
          type: "string",
          enum: [
            TRANSCRIPT_UPLOAD_FORMAT_AUTO,
            TRANSCRIPT_FORMAT_JSON,
            TRANSCRIPT_FORMAT_SRT,
            TRANSCRIPT_FORMAT_VTT,
            TRANSCRIPT_FORMAT_TEXT,
            TRANSCRIPT_FORMAT_TEXT_TIMESTAMPED,
            TRANSCRIPT_UPLOAD_FORMAT_PLAIN_TEXT,
          ],
          default: TRANSCRIPT_UPLOAD_FORMAT_AUTO,
          description:
            "How to parse transcript input: auto/json/srt/vtt/text_timestamped/text/plain_text.",
        },
        filename: {
          type: "string",
          description:
            "Optional filename hint when using transcript_text, used for auto format detection.",
        },
        default_speaker: {
          type: "string",
          default: "Speaker 1",
          description: "Fallback speaker label when source data does not include one.",
        },
        include_transcript_segments: {
          type: "boolean",
          default: false,
          description: "Include parsed transcript segments in the response.",
        },
      },
      required: ["file_id"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_AUTH_BROWSER,
    description: "Auto-open PLAUD web app in browser and capture token from page storage.",
    inputSchema: {
      type: "object",
      properties: {
        browser: {
          type: "string",
          enum: ["chrome", "edge", "chromium"],
          default: "chrome",
          description: "Browser app used for automation (macOS/Windows).",
        },
        open_url: {
          type: "boolean",
          default: true,
          description: "Whether to navigate to PLAUD page before extracting token.",
        },
        url: {
          type: "string",
          default: DEFAULT_WEB_FILE_URL,
          description: "Target PLAUD page URL (web/app domains are both supported).",
        },
        wait_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 30000,
          default: 7000,
          description: "Wait time after opening page before extraction.",
        },
        save_to_file: {
          type: "string",
          description: "Optional file path to persist token for reuse.",
        },
        return_token: {
          type: "boolean",
          default: false,
          description: "Deprecated. Full token is never returned in response.",
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
    const sanitized = value.replace(/\/+$/, "");
    if (!sanitized) return "";
    if (sanitized.startsWith("//")) {
      try {
        return new URL(`https:${sanitized}`).origin;
      } catch {
        return `https:${sanitized.replace(/^\/+/, "")}`;
      }
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(sanitized)) {
      try {
        return new URL(`https://${sanitized}`).origin;
      } catch {
        return `https://${sanitized.replace(/^\/+/, "")}`;
      }
    }
    return sanitized;
  }
}

function toTokenFingerprint(token) {
  const normalized = normalizeToken(token);
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex");
}

function resolveApiOriginStateFilePath(tokenFilePath) {
  const pathText = String(tokenFilePath || "").trim();
  if (!pathText) return "";
  return `${pathText}${API_ORIGIN_STATE_FILE_SUFFIX}`;
}

function dedupeApiOrigins(values) {
  const list = Array.isArray(values) ? values : [values];
  const output = [];
  const seen = new Set();
  for (const value of list) {
    const origin = normalizeApiOrigin(value);
    if (!origin) continue;
    const key = origin.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(origin);
  }
  return output;
}

function normalizeApiOriginList(rawValue) {
  if (Array.isArray(rawValue)) {
    return dedupeApiOrigins(rawValue);
  }
  const text = String(rawValue || "").trim();
  if (!text) return [];

  const parsedJson = safeJsonParse(text);
  if (Array.isArray(parsedJson)) {
    return dedupeApiOrigins(parsedJson);
  }

  const parts = text
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return dedupeApiOrigins(parts);
}

function swapPlaudWebAppHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return "";
  if (host.startsWith("web.")) return `app.${host.slice(4)}`;
  if (host.startsWith("app.")) return `web.${host.slice(4)}`;
  if (host.startsWith("web-")) return `app-${host.slice(4)}`;
  if (host.startsWith("app-")) return `web-${host.slice(4)}`;
  return "";
}

function inferApiOriginsFromPlaudPageUrl(pageUrl) {
  const rawUrl = String(pageUrl || "").trim();
  if (!rawUrl) return [];

  let parsed = null;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return [];
  }

  const protocol = parsed.protocol === "http:" ? "http" : "https";
  const host = String(parsed.hostname || "").trim().toLowerCase();
  if (!host) return [];

  const candidates = [];
  const pushHost = (nextHost) => {
    if (!nextHost) return;
    candidates.push(`${protocol}://${nextHost}`);
  };

  if (host.startsWith("api.")) {
    pushHost(host);
  }

  if (host.startsWith("api-")) {
    pushHost(host);
  }

  if (host.startsWith("web.")) {
    pushHost(`api.${host.slice(4)}`);
  }

  if (host.startsWith("app.")) {
    pushHost(`api.${host.slice(4)}`);
  }

  if (host.startsWith("web-")) {
    pushHost(`api-${host.slice(4)}`);
  }

  if (host.startsWith("app-")) {
    pushHost(`api-${host.slice(4)}`);
  }

  return dedupeApiOrigins(candidates);
}

function buildPlaudPageUrlCandidates(rawUrl) {
  const fallback = DEFAULT_WEB_FILE_URL;
  const primary = String(rawUrl || "").trim() || fallback;
  const candidates = [primary, DEFAULT_WEB_FILE_URL, DEFAULT_APP_FILE_URL];

  try {
    const parsed = new URL(primary);
    const swappedHost = swapPlaudWebAppHost(parsed.hostname);
    if (swappedHost) {
      const swapped = new URL(parsed.toString());
      swapped.hostname = swappedHost;
      candidates.push(swapped.toString());
    }
  } catch {
    // ignore invalid URL and keep existing candidates
  }

  return Array.from(new Set(candidates.map((item) => String(item || "").trim()).filter(Boolean)));
}

function resolvePlaudApiOriginCandidates(options = {}) {
  const configured = normalizeApiOrigin(options?.apiOrigin);
  const extraFromOptions = normalizeApiOriginList(options?.apiOrigins);
  const extraFromEnv = normalizeApiOriginList(process.env.PLAUD_API_ORIGINS);
  const inferredFromPageUrl = inferApiOriginsFromPlaudPageUrl(options?.pageUrl);
  const current = normalizeApiOrigin(options?.currentOrigin);

  return dedupeApiOrigins([
    current,
    configured,
    ...extraFromOptions,
    ...extraFromEnv,
    ...inferredFromPageUrl,
    DEFAULT_API_ORIGIN,
  ]);
}

function extractRedirectApiOrigin(payload) {
  return normalizeApiOrigin(
    payload?.data?.domains?.api ||
      payload?.domains?.api ||
      payload?.data?.domain?.api ||
      payload?.data?.api_origin ||
      payload?.data?.apiOrigin ||
      payload?.api_origin ||
      payload?.apiOrigin
  );
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

function isAutoPersistDisabled() {
  return toBoolean(process.env.PLAUD_DISABLE_AUTO_PERSIST, false);
}

function readTokenFromFile(filePath) {
  const pathText = String(filePath || "").trim();
  if (!pathText) return "";
  try {
    const text = readFileSync(pathText, "utf8");
    return normalizeToken(text);
  } catch {
    return "";
  }
}

function readApiOriginStateFromFile(filePath, token = "") {
  const pathText = String(filePath || "").trim();
  if (!pathText) {
    return {
      apiOrigin: "",
      apiOrigins: [],
      path: "",
      matchedToken: false,
      hasFile: false,
    };
  }

  let text = "";
  try {
    text = readFileSync(pathText, "utf8");
  } catch {
    return {
      apiOrigin: "",
      apiOrigins: [],
      path: pathText,
      matchedToken: false,
      hasFile: false,
    };
  }

  const rawText = String(text || "").trim();
  if (!rawText) {
    return {
      apiOrigin: "",
      apiOrigins: [],
      path: pathText,
      matchedToken: false,
      hasFile: true,
    };
  }

  const parsed = safeJsonParse(rawText);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const tokenFingerprint = String(
      parsed?.token_fingerprint || parsed?.tokenFingerprint || ""
    ).trim();
    const expectedFingerprint = toTokenFingerprint(token);
    const matchedToken = !tokenFingerprint || !expectedFingerprint || tokenFingerprint === expectedFingerprint;
    if (!matchedToken) {
      return {
        apiOrigin: "",
        apiOrigins: [],
        path: pathText,
        matchedToken: false,
        hasFile: true,
      };
    }

    const apiOrigins = dedupeApiOrigins([
      parsed?.api_origin,
      parsed?.apiOrigin,
      ...(Array.isArray(parsed?.api_origins) ? parsed.api_origins : []),
      ...normalizeApiOriginList(parsed?.apiOrigins),
    ]);
    return {
      apiOrigin: apiOrigins[0] || "",
      apiOrigins,
      path: pathText,
      matchedToken: Boolean(tokenFingerprint),
      hasFile: true,
    };
  }

  const apiOrigins = normalizeApiOriginList(rawText);
  return {
    apiOrigin: apiOrigins[0] || "",
    apiOrigins,
    path: pathText,
    matchedToken: false,
    hasFile: true,
  };
}

function persistTokenToFile(token, filePath) {
  const pathText = String(filePath || "").trim();
  if (!pathText) return { ok: false, path: "", error: "Missing file path" };
  try {
    const parent = dirname(pathText);
    if (parent) {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
    }
    writeFileSync(pathText, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    return { ok: true, path: pathText, error: "" };
  } catch (err) {
    return { ok: false, path: pathText, error: err?.message || String(err) };
  }
}

function persistApiOriginStateToFile({ token, apiOrigin, apiOrigins, filePath }) {
  const pathText = String(filePath || "").trim();
  if (!pathText) return { ok: false, path: "", error: "Missing file path" };

  const origins = dedupeApiOrigins([apiOrigin, ...normalizeApiOriginList(apiOrigins)]);
  if (!origins.length) {
    return { ok: false, path: pathText, error: "No API origins to persist" };
  }

  const tokenFingerprint = toTokenFingerprint(token);
  const payload = {
    version: 1,
    token_fingerprint: tokenFingerprint,
    api_origin: origins[0],
    api_origins: origins,
    updated_at: new Date().toISOString(),
  };

  try {
    const parent = dirname(pathText);
    if (parent) {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
    }
    writeFileSync(pathText, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { ok: true, path: pathText, error: "" };
  } catch (err) {
    return { ok: false, path: pathText, error: err?.message || String(err) };
  }
}

function persistBinaryToFile(buffer, filePath) {
  const pathText = String(filePath || "").trim();
  if (!pathText) return { ok: false, path: "", error: "Missing file path" };
  try {
    const parent = dirname(pathText);
    if (parent) {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
    }
    writeFileSync(pathText, buffer, { mode: 0o600 });
    return { ok: true, path: pathText, error: "" };
  } catch (err) {
    return { ok: false, path: pathText, error: err?.message || String(err) };
  }
}

function collectAudioFileIds(args) {
  const output = [];
  const dedupe = new Set();
  const push = (value) => {
    const id = String(value || "").trim();
    if (!id) return;
    if (dedupe.has(id)) return;
    dedupe.add(id);
    output.push(id);
  };

  push(pickNonEmptyString(args?.file_id, args?.fileId));

  const list = Array.isArray(args?.file_ids)
    ? args.file_ids
    : Array.isArray(args?.fileIds)
      ? args.fileIds
      : [];
  for (const item of list) {
    push(item);
  }

  const hasFileIdsArray = Array.isArray(args?.file_ids) || Array.isArray(args?.fileIds);
  return {
    fileIds: output,
    hasFileIdsArray,
  };
}

function sanitizeFileNameSegment(value, fallback = "plaud-audio") {
  const raw = String(value || "").trim();
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned.slice(0, 120);
}

function inferFileExtensionFromUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  let pathname = "";
  try {
    pathname = new URL(raw).pathname || "";
  } catch {
    pathname = raw.split(/[?#]/)[0] || "";
  }

  const basename = pathname.split("/").pop() || "";
  const match = basename.match(/\.([A-Za-z0-9]{1,8})$/);
  return match?.[1] ? match[1].toLowerCase() : "";
}

function inferAudioFileExtension(contentType, url) {
  const normalizedType = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const mapped =
    normalizedType === "audio/mpeg" || normalizedType === "audio/mp3"
      ? "mp3"
      : normalizedType === "audio/wav" ||
          normalizedType === "audio/x-wav" ||
          normalizedType === "audio/wave"
        ? "wav"
        : normalizedType === "audio/mp4" || normalizedType === "audio/x-m4a"
          ? "m4a"
          : normalizedType === "audio/aac"
            ? "aac"
            : normalizedType === "audio/ogg"
              ? "ogg"
              : normalizedType === "audio/webm"
                ? "webm"
                : normalizedType === "audio/flac" || normalizedType === "audio/x-flac"
                  ? "flac"
                  : normalizedType === "audio/amr"
                    ? "amr"
                    : normalizedType === "audio/3gpp"
                      ? "3gp"
                      : normalizedType === "audio/3gpp2"
                        ? "3g2"
                        : "";
  if (mapped) return mapped;

  const extFromUrl = inferFileExtensionFromUrl(url);
  if (extFromUrl) return extFromUrl;

  return "bin";
}

function normalizeAudioFormat(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (raw === AUDIO_FORMAT_WAV) return AUDIO_FORMAT_WAV;
  return AUDIO_FORMAT_ORIGINAL;
}

function normalizeFileExtensionToken(value, fallback = "bin") {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  if (!raw) return fallback;
  if (!/^[a-z0-9]{1,10}$/.test(raw)) return fallback;
  return raw;
}

function ensureFilePathExtension(filePath, extension) {
  const pathText = String(filePath || "").trim();
  if (!pathText) return "";
  const ext = normalizeFileExtensionToken(extension, "bin");
  const slashIndex = Math.max(pathText.lastIndexOf("/"), pathText.lastIndexOf("\\"));
  const dotIndex = pathText.lastIndexOf(".");
  const hasExtension = dotIndex > slashIndex;
  if (!hasExtension) return `${pathText}.${ext}`;
  return `${pathText.slice(0, dotIndex)}.${ext}`;
}

function resolveUniqueFilePath(filePath) {
  const pathText = String(filePath || "").trim();
  if (!pathText) return "";
  if (!existsSync(pathText)) return pathText;

  const slashIndex = Math.max(pathText.lastIndexOf("/"), pathText.lastIndexOf("\\"));
  const dotIndex = pathText.lastIndexOf(".");
  const hasExtension = dotIndex > slashIndex;
  const prefix = hasExtension ? pathText.slice(0, dotIndex) : pathText;
  const suffix = hasExtension ? pathText.slice(dotIndex) : "";

  for (let i = 1; i <= 9999; i += 1) {
    const candidate = `${prefix}-${i}${suffix}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${prefix}-${Date.now()}${suffix}`;
}

function buildAudioOutputFilePath({
  saveToFile,
  saveToDir,
  fileId,
  contentType,
  downloadUrl,
  forcedExtension,
}) {
  const normalizedForcedExt = normalizeFileExtensionToken(forcedExtension, "");
  const directFile = String(saveToFile || "").trim();
  if (directFile) {
    if (normalizedForcedExt) {
      return ensureFilePathExtension(directFile, normalizedForcedExt);
    }
    return directFile;
  }

  const directory = String(saveToDir || "").trim();
  if (!directory) return "";

  const stem = sanitizeFileNameSegment(fileId, "plaud-audio");
  const ext = normalizedForcedExt || inferAudioFileExtension(contentType, downloadUrl);
  const candidate = join(directory, `${stem}.${ext}`);
  return resolveUniqueFilePath(candidate);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];

  const limit = clampInteger(concurrency, { defaultValue: 3, min: 1, max: 32 });
  const workerCount = Math.min(limit, list.length);
  const results = new Array(list.length);
  let cursor = 0;

  const workers = [];
  for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
    workers.push(
      (async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= list.length) return;
          results[index] = await mapper(list[index], index);
        }
      })()
    );
  }

  await Promise.all(workers);
  return results;
}

let ffmpegExecutableCache = "";
let ffmpegExecutableCacheKey = "";

function resolveConfiguredFfmpegExecutable() {
  return String(process.env.PLAUD_FFMPEG_PATH || "").trim() || "ffmpeg";
}

function probeFfmpegExecutable(executable) {
  const result = spawnSync(executable, ["-version"], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(result.error?.message || String(result.error));
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(detail || `exit code ${result.status}`);
  }
  return executable;
}

function resolveFfmpegExecutableOrThrow() {
  const configured = resolveConfiguredFfmpegExecutable();
  if (ffmpegExecutableCache && ffmpegExecutableCacheKey === configured) {
    return ffmpegExecutableCache;
  }

  try {
    const resolved = probeFfmpegExecutable(configured);
    ffmpegExecutableCache = resolved;
    ffmpegExecutableCacheKey = configured;
    return resolved;
  } catch (err) {
    const hint = configured === "ffmpeg"
      ? "Install ffmpeg or set PLAUD_FFMPEG_PATH."
      : "Check PLAUD_FFMPEG_PATH.";
    const msg = err?.message || String(err);
    throw new Error(`ffmpeg not found or unavailable (${configured}): ${msg}. ${hint}`);
  }
}

async function convertAudioBufferToWavWithFfmpeg(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error("Missing audio buffer for WAV conversion.");
  }

  const ffmpegExecutable = resolveFfmpegExecutableOrThrow();
  const maxBytes = clampInteger(options?.maxBytes, {
    defaultValue: 500 * 1024 * 1024,
    min: 1,
    max: 1_000_000_000,
  });
  const fileId = String(options?.fileId || "").trim();
  const stem = sanitizeFileNameSegment(fileId || "plaud-audio", "plaud-audio");
  const workDir = mkdtempSync(join(tmpdir(), "plaud-mcp-audio-"));
  const inputPath = join(workDir, `${stem}.input`);
  const outputPath = join(workDir, `${stem}.wav`);

  try {
    writeFileSync(inputPath, buffer, { mode: 0o600 });
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-acodec",
      "pcm_s16le",
      outputPath,
    ];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(ffmpegExecutable, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks = [];
      const stderrChunks = [];

      child.stdout?.on("data", (chunk) => {
        stdoutChunks.push(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderrChunks.push(chunk);
      });
      child.on("error", (err) => {
        reject(err);
      });
      child.on("close", (code) => {
        resolve({
          status: Number.isFinite(code) ? Number(code) : -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      });
    });

    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || "").trim();
      throw new Error(detail || `exit code ${result.status}`);
    }
    if (!existsSync(outputPath)) {
      throw new Error("Output file not found.");
    }
    const converted = readFileSync(outputPath);
    if (converted.length > maxBytes) {
      throw new Error(`Converted WAV exceeds max_bytes (${converted.length} > ${maxBytes}).`);
    }
    return {
      buffer: converted,
      contentType: "audio/wav",
      ffmpegExecutable,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function toAppleScriptString(value) {
  return `"${String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')}"`;
}

function decodeBase64UrlUtf8(value) {
  try {
    const raw = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    if (!raw) return "";
    const padding = raw.length % 4;
    const padded = padding ? `${raw}${"=".repeat(4 - padding)}` : raw;
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function tryParseJwtPayload(token) {
  const raw = String(token || "");
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  const payloadText = decodeBase64UrlUtf8(parts[1]);
  if (!payloadText) return null;
  return safeJsonParse(payloadText);
}

function scoreWindowsTokenCandidate(token, contextText, filePath, source = "generic") {
  const context = String(contextText || "").toLowerCase();
  const file = String(filePath || "").toLowerCase();
  let score = 0;

  const hasSimpleWebPath = context.includes("file/simple/web");
  const hasAuthorization = context.includes("authorization");
  if (context.includes("plaud")) score += 12;
  if (context.includes("web.plaud.ai")) score += 8;
  if (context.includes("app.plaud.ai")) score += 8;
  if (context.includes("api.plaud.ai")) score += 7;
  if (context.includes(".plaud.")) score += 4;
  if (hasSimpleWebPath) score += 30;
  if (hasAuthorization) score += 20;
  if (hasSimpleWebPath && hasAuthorization) score += 25;
  if (context.includes("token")) score += 4;
  if (context.includes("auth")) score += 3;
  if (context.includes("bearer")) score += 2;
  if (file.includes("\\default\\") || file.includes("/default/")) score += 1;
  if (source === "request-header-file-simple-web") score += 120;

  const payload = tryParseJwtPayload(token);
  if (payload && typeof payload === "object") {
    score += 2;
    const payloadText = JSON.stringify(payload).toLowerCase();
    if (payloadText.includes("plaud")) score += 6;
    const exp = Number(payload?.exp);
    if (Number.isFinite(exp)) {
      if (exp * 1000 > Date.now()) score += 2;
      else score -= 2;
    }
  }

  return score;
}

function extractPlaudApiOriginFromText(text) {
  const raw = String(text || "");
  if (!raw) return "";

  const directUrlMatch = raw.match(/https?:\/\/[A-Za-z0-9.-]+\/file\/simple\/web\b/i);
  if (directUrlMatch?.[0]) {
    try {
      const parsed = new URL(directUrlMatch[0]);
      return normalizeApiOrigin(parsed.origin);
    } catch {
      // ignore
    }
  }

  const hostMatch = raw.match(
    /\bhost[\s"'=:,\x00-]{0,24}([A-Za-z0-9.-]*plaud\.[A-Za-z0-9.-]+)/i
  );
  if (hostMatch?.[1]) {
    const host = String(hostMatch[1]).trim().replace(/[^A-Za-z0-9.-].*$/, "");
    if (host) {
      return normalizeApiOrigin(`https://${host}`);
    }
  }

  return "";
}

function collectWindowsRequestHeaderCandidates(text, filePath) {
  const raw = String(text || "");
  const candidates = [];
  if (!raw) return candidates;

  const patterns = [
    /file\/simple\/web[\s\S]{0,3000}?authorization[\s"'=:,\x00-]{0,80}(?:bearer[\s"'=:,\x00-]*)?(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/gi,
    /authorization[\s"'=:,\x00-]{0,80}(?:bearer[\s"'=:,\x00-]*)?(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})[\s\S]{0,3000}?file\/simple\/web/gi,
  ];

  for (const regex of patterns) {
    regex.lastIndex = 0;
    let match = null;
    while ((match = regex.exec(raw)) !== null) {
      const token = normalizeToken(match[1] || "");
      if (!token) continue;
      const contextText = match[0];
      const apiOrigin = extractPlaudApiOriginFromText(contextText);
      candidates.push({
        token,
        apiOrigin,
        source: "request-header-file-simple-web",
        score: scoreWindowsTokenCandidate(
          token,
          contextText,
          filePath,
          "request-header-file-simple-web"
        ),
      });
    }
  }

  return candidates;
}

function collectWindowsJwtCandidatesFromLevelDb(levelDbDir) {
  let entries = [];
  try {
    entries = readdirSync(levelDbDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(log|ldb)$/i.test(entry.name)) continue;

    const filePath = join(levelDbDir, entry.name);
    let text = "";
    try {
      const content = readFileSync(filePath);
      if (!content || content.length === 0) continue;
      const maxBytes = 12 * 1024 * 1024;
      const chunks = [];
      chunks.push(content.subarray(0, Math.min(maxBytes, content.length)));
      if (content.length > maxBytes) {
        chunks.push(content.subarray(Math.max(0, content.length - maxBytes), content.length));
      }
      text = chunks.map((buf) => buf.toString("latin1")).join("\n");
    } catch {
      continue;
    }

    candidates.push(...collectWindowsRequestHeaderCandidates(text, filePath));

    const jwtRegex = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
    let match = null;
    while ((match = jwtRegex.exec(text)) !== null) {
      const token = normalizeToken(match[0]);
      if (!token) continue;
      const start = Math.max(0, match.index - 160);
      const end = Math.min(text.length, match.index + token.length + 160);
      const contextText = text.slice(start, end);
      const apiOrigin = extractPlaudApiOriginFromText(contextText);
      candidates.push({
        token,
        apiOrigin,
        source: "generic",
        score: scoreWindowsTokenCandidate(token, contextText, filePath, "generic"),
      });
    }
  }

  return candidates;
}

function listWindowsProfileLevelDbDirs(userDataDir) {
  let entries = [];
  try {
    entries = readdirSync(userDataDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const profiles = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (name) => name === "Default" || name === "Guest Profile" || /^Profile \d+$/i.test(name)
    )
    .sort((a, b) => {
      if (a === "Default" && b !== "Default") return -1;
      if (b === "Default" && a !== "Default") return 1;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    });

  return profiles.map((name) => join(userDataDir, name, "Local Storage", "leveldb"));
}

function resolveWindowsBrowserConfig(browser) {
  const key = String(browser || "chrome")
    .trim()
    .toLowerCase();
  const localAppData = String(process.env.LOCALAPPDATA || "").trim();
  const programFiles = String(process.env.ProgramFiles || "C:\\Program Files").trim();
  const programFilesX86 = String(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)").trim();

  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not available. Cannot inspect browser profile.");
  }

  if (key === "chrome") {
    return {
      appName: "Google Chrome",
      userDataDir: join(localAppData, "Google", "Chrome", "User Data"),
      executableCandidates: [
        join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      ],
    };
  }

  if (key === "edge") {
    return {
      appName: "Microsoft Edge",
      userDataDir: join(localAppData, "Microsoft", "Edge", "User Data"),
      executableCandidates: [
        join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
      ],
    };
  }

  if (key === "chromium") {
    return {
      appName: "Chromium",
      userDataDir: join(localAppData, "Chromium", "User Data"),
      executableCandidates: [
        join(programFiles, "Chromium", "Application", "chrome.exe"),
        join(programFilesX86, "Chromium", "Application", "chrome.exe"),
        join(localAppData, "Chromium", "Application", "chrome.exe"),
      ],
    };
  }

  throw new Error(`Unsupported browser: ${browser}`);
}

function openWindowsBrowserUrl(browser, url) {
  const config = resolveWindowsBrowserConfig(browser);
  const safeUrl = String(url || "").trim();
  const candidates = Array.from(new Set(config.executableCandidates.filter(Boolean)));

  for (const executable of candidates) {
    const result = spawnSync(executable, [safeUrl], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return;
  }

  const fallback = spawnSync("cmd.exe", ["/c", "start", "", safeUrl], {
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
  });
  if (fallback.error) {
    throw new Error(fallback.error.message || "Failed to open browser on Windows");
  }
  if (fallback.status !== 0) {
    const stderrText = String(fallback.stderr || "").trim();
    const stdoutText = String(fallback.stdout || "").trim();
    throw new Error(stderrText || stdoutText || `cmd start failed with status ${fallback.status}`);
  }
}

function sleepMs(timeoutMs) {
  const waitMs = Math.max(0, Math.floor(Number(timeoutMs) || 0));
  if (!waitMs) return;
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, waitMs);
}

function extractTokenViaWindowsStorage({
  browser = "chrome",
  openUrl = true,
  url = DEFAULT_WEB_FILE_URL,
  waitMs = 7000,
} = {}) {
  const config = resolveWindowsBrowserConfig(browser);
  const safeUrl = String(url || "").trim() || DEFAULT_WEB_FILE_URL;
  const waitDuration = Math.max(0, waitMs);

  if (openUrl) {
    openWindowsBrowserUrl(browser, safeUrl);
  }
  if (waitDuration > 0) {
    sleepMs(waitDuration);
  }

  const levelDbDirs = listWindowsProfileLevelDbDirs(config.userDataDir);
  const deduped = new Map();

  for (const levelDbDir of levelDbDirs) {
    const candidates = collectWindowsJwtCandidatesFromLevelDb(levelDbDir);
    for (const item of candidates) {
      const existing = deduped.get(item.token);
      if (!existing || item.score > existing.score) {
        deduped.set(item.token, item);
      }
    }
  }

  const ranked = Array.from(deduped.values()).sort(
    (a, b) => b.score - a.score || b.token.length - a.token.length
  );
  const requestHeaderRanked = ranked.filter(
    (item) => item?.source === "request-header-file-simple-web"
  );
  const orderedRanked = requestHeaderRanked.length
    ? requestHeaderRanked.concat(
      ranked.filter((item) => item?.source !== "request-header-file-simple-web")
    )
    : ranked;

  const tokenCandidates = orderedRanked
    .map((item) => normalizeToken(item.token))
    .filter(Boolean)
    .slice(0, 30);
  const bestToken = tokenCandidates[0] || "";
  const bestSource = orderedRanked[0]?.source || "";
  const apiOriginCandidates = resolvePlaudApiOriginCandidates({
    apiOrigins: orderedRanked.map((item) => item?.apiOrigin).filter(Boolean),
    pageUrl: safeUrl,
  });

  return {
    token: normalizeToken(bestToken),
    tokenCandidates,
    apiOriginCandidates,
    candidateCount: tokenCandidates.length,
    candidateSource: bestSource,
    requestHeaderCandidateCount: requestHeaderRanked.length,
    appName: config.appName,
    url: safeUrl,
    openUrl,
    waitMs: waitDuration,
  };
}

function resolveBrowserAppName(browser) {
  const key = String(browser || "chrome")
    .trim()
    .toLowerCase();
  if (key === "chrome") return "Google Chrome";
  if (key === "edge") return "Microsoft Edge";
  if (key === "chromium") return "Chromium";
  throw new Error(`Unsupported browser: ${browser}`);
}

function buildBrowserTokenExtractorJs() {
  return `(function () {
  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
  }
  function extractJwtFromString(value) {
    var raw = String(value || "");
    var match = raw.match(/eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}/);
    return match && match[0] ? match[0] : "";
  }
  function findJwtInUnknownValue(value, depth) {
    if (depth > 5) return "";
    if (typeof value === "string") {
      var direct = extractJwtFromString(value);
      if (direct) return direct;
      var parsed = safeJsonParse(value);
      if (parsed) return findJwtInUnknownValue(parsed, depth + 1);
      return "";
    }
    if (!value || typeof value !== "object") return "";
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        var hitFromArray = findJwtInUnknownValue(value[i], depth + 1);
        if (hitFromArray) return hitFromArray;
      }
      return "";
    }
    var keys = Object.keys(value);
    for (var j = 0; j < keys.length; j += 1) {
      var hit = findJwtInUnknownValue(value[keys[j]], depth + 1);
      if (hit) return hit;
    }
    return "";
  }
  function findFromStorage(storage) {
    try {
      var keys = [];
      for (var i = 0; i < storage.length; i += 1) {
        var key = storage.key(i);
        if (key) keys.push(key);
      }
      keys.sort(function (a, b) {
        var al = String(a).toLowerCase();
        var bl = String(b).toLowerCase();
        var ah = al.indexOf("token") >= 0 || al.indexOf("auth") >= 0;
        var bh = bl.indexOf("token") >= 0 || bl.indexOf("auth") >= 0;
        if (ah !== bh) return ah ? -1 : 1;
        return String(a).length - String(b).length;
      });
      for (var k = 0; k < keys.length; k += 1) {
        var raw = storage.getItem(keys[k]);
        if (!raw) continue;
        var direct = extractJwtFromString(raw);
        if (direct) return direct;
        var parsed = safeJsonParse(raw);
        if (parsed) {
          var nested = findJwtInUnknownValue(parsed, 0);
          if (nested) return nested;
        }
      }
    } catch (_) {}
    return "";
  }
  return (
    findFromStorage(window.localStorage) ||
    findFromStorage(window.sessionStorage) ||
    extractJwtFromString(document.cookie) ||
    ""
  );
})();`;
}

function runAppleScript(scriptText, timeoutMs) {
  const result = spawnSync("osascript", ["-e", scriptText], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.error) {
    throw new Error(result.error.message || "Failed to run osascript");
  }
  if (result.status !== 0) {
    const stderrText = String(result.stderr || "").trim();
    const stdoutText = String(result.stdout || "").trim();
    throw new Error(stderrText || stdoutText || `osascript exited with status ${result.status}`);
  }
  return String(result.stdout || "").trim();
}

function extractTokenViaBrowserAutomation({
  browser = "chrome",
  openUrl = true,
  url = DEFAULT_WEB_FILE_URL,
  waitMs = 7000,
} = {}) {
  if (process.platform === "darwin") {
    const appName = resolveBrowserAppName(browser);
    const safeUrl = String(url || "").trim() || DEFAULT_WEB_FILE_URL;
    const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
    const jsScript = buildBrowserTokenExtractorJs();

    const lines = [];
    if (openUrl) {
      lines.push(`tell application ${toAppleScriptString(appName)}`);
      lines.push("  activate");
      lines.push("  if (count of windows) = 0 then make new window");
      lines.push(`  set URL of active tab of front window to ${toAppleScriptString(safeUrl)}`);
      lines.push("end tell");
      lines.push(`delay ${waitSeconds}`);
    }
    lines.push(`tell application ${toAppleScriptString(appName)}`);
    lines.push(
      `  set tokenValue to execute active tab of front window javascript ${toAppleScriptString(jsScript)}`
    );
    lines.push("  if tokenValue is missing value then return \"\"");
    lines.push("  return tokenValue");
    lines.push("end tell");

    const stdout = runAppleScript(lines.join("\n"), waitMs + 20000);
    const token = normalizeToken(stdout === "missing value" ? "" : stdout);
    return {
      token,
      tokenCandidates: token ? [token] : [],
      apiOriginCandidates: resolvePlaudApiOriginCandidates({ pageUrl: safeUrl }),
      appName,
      url: safeUrl,
      openUrl,
      waitMs,
    };
  }

  if (process.platform === "win32") {
    return extractTokenViaWindowsStorage({ browser, openUrl, url, waitMs });
  }

  throw new Error("Browser auto-auth currently supports macOS and Windows only.");
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

async function fetchBinaryFromUrl(url, options = {}) {
  const requestUrl = String(url || "").trim();
  if (!requestUrl) throw new Error("Missing downloadable URL");

  const maxBytes = clampInteger(options?.maxBytes, {
    defaultValue: 500 * 1024 * 1024,
    min: 1,
    max: 1_000_000_000,
  });

  const response = await fetch(requestUrl, { method: "GET" });
  const contentType = String(response.headers.get("content-type") || "").trim();
  const contentLengthHeader = String(response.headers.get("content-length") || "").trim();
  const contentLength = Number(contentLengthHeader);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Audio download failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Audio exceeds max_bytes (${contentLength} > ${maxBytes}).`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(`Audio exceeds max_bytes (${buffer.length} > ${maxBytes}).`);
  }

  return {
    buffer,
    size: buffer.length,
    contentType,
    contentLength: Number.isFinite(contentLength) && contentLength > 0
      ? Math.floor(contentLength)
      : 0,
    requestUrl: response.url || requestUrl,
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

function normalizeTranscriptFormat(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return TRANSCRIPT_FORMAT_JSON;
  if (TRANSCRIPT_FORMAT_SET.has(raw)) return raw;
  throw new Error(
    `Invalid transcript_format: ${value}. Supported values: ${Array.from(TRANSCRIPT_FORMAT_SET).join(", ")}`
  );
}

function normalizeTranscriptUploadFormat(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return TRANSCRIPT_UPLOAD_FORMAT_AUTO;
  if (raw === "txt" || raw === "markdown" || raw === "md") {
    return TRANSCRIPT_FORMAT_TEXT_TIMESTAMPED;
  }
  if (raw === "plain" || raw === "plain-text" || raw === "plaintext") {
    return TRANSCRIPT_UPLOAD_FORMAT_PLAIN_TEXT;
  }
  if (raw === TRANSCRIPT_FORMAT_TEXT) {
    return TRANSCRIPT_UPLOAD_FORMAT_PLAIN_TEXT;
  }
  if (TRANSCRIPT_UPLOAD_FORMAT_SET.has(raw)) return raw;
  throw new Error(
    `Invalid input_format: ${value}. Supported values: ${Array.from(TRANSCRIPT_UPLOAD_FORMAT_SET).join(", ")}`
  );
}

function normalizeTranscriptInputText(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
}

function normalizeDefaultSpeaker(value) {
  return pickNonEmptyString(value) || "Speaker 1";
}

function parseFlexibleTimestampToMs(value) {
  const raw = String(value || "")
    .trim()
    .replace(",", ".");
  if (!raw) return Number.NaN;

  const parts = raw.split(":");
  if (parts.length < 2 || parts.length > 3) return Number.NaN;

  const seconds = Number(parts[parts.length - 1]);
  const minutes = Number(parts[parts.length - 2]);
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (
    !Number.isFinite(seconds) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(hours) ||
    seconds < 0 ||
    minutes < 0 ||
    hours < 0
  ) {
    return Number.NaN;
  }

  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

function normalizeParsedTranscriptSegmentText(lines) {
  const list = Array.isArray(lines) ? lines : [];
  return list
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function finalizeTranscriptSegments(segments, options = {}) {
  const defaultSpeaker = normalizeDefaultSpeaker(options?.defaultSpeaker);
  const list = Array.isArray(segments) ? segments : [];
  const out = [];

  for (const item of list) {
    const content = String(item?.content ?? item?.text ?? "").trim();
    if (!content) continue;

    const startMs = Number(item?.start_time ?? item?.startTime ?? 0);
    const endMs = Number(item?.end_time ?? item?.endTime ?? 0);
    out.push({
      content,
      start_time:
        Number.isFinite(startMs) && startMs >= 0 ? Math.round(startMs) : 0,
      end_time: Number.isFinite(endMs) && endMs >= 0 ? Math.round(endMs) : 0,
      speaker: pickNonEmptyString(
        item?.speaker,
        item?.speaker_label,
        item?.speakerLabel
      ) || defaultSpeaker,
      embeddingKey: null,
    });
  }

  for (let index = 0; index < out.length; index += 1) {
    const segment = out[index];
    if (!segment) continue;
    if (segment.end_time > segment.start_time) continue;

    const next = out[index + 1];
    if (next && next.start_time > segment.start_time) {
      segment.end_time = next.start_time;
      continue;
    }

    const prev = out[index - 1];
    const fallbackDuration = prev
      ? Math.max(1000, Number(prev.end_time || 0) - Number(prev.start_time || 0))
      : 1000;
    segment.end_time = segment.start_time + fallbackDuration;
  }

  return out;
}

function getTranscriptUploadFileExtension(filePath, filename = "") {
  const hint = pickNonEmptyString(filename, filePath);
  return String(extname(hint || "") || "").trim().toLowerCase();
}

function matchTimestampedTextLine(line) {
  return String(line || "").trim().match(
    /^(?:[-*+]\s+|\d+\.\s+)?(?:\[(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]|(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?))\s*(?:[-–—]\s*)?(?:(.+?)\s*[:：]\s*)?(.*)$/u
  );
}

function looksLikeTimestampedText(source) {
  const lines = normalizeTranscriptInputText(source).split("\n");
  return lines.some((line) => {
    const match = matchTimestampedTextLine(line);
    const timestamp = match?.[1] || match?.[2] || "";
    return Number.isFinite(parseFlexibleTimestampToMs(timestamp));
  });
}

function parseTimestampedTextTranscript(source, options = {}) {
  const defaultSpeaker = normalizeDefaultSpeaker(options?.defaultSpeaker);
  const text = normalizeTranscriptInputText(source);
  if (!text.trim()) {
    throw new Error("Transcript input is empty");
  }

  const lines = text.split("\n");
  const out = [];
  let current = null;
  let headerCount = 0;

  const flushCurrent = (nextStartMs = null) => {
    if (!current) return;
    const content = normalizeParsedTranscriptSegmentText(current.lines);
    if (!content) {
      current = null;
      return;
    }

    const startMs = Math.max(0, Math.round(Number(current.startMs) || 0));
    let endMs = startMs;
    if (Number.isFinite(nextStartMs)) {
      const normalizedNext = Math.max(0, Math.round(nextStartMs));
      if (normalizedNext >= startMs) endMs = normalizedNext;
    }

    out.push({
      content,
      start_time: startMs,
      end_time: endMs,
      speaker: pickNonEmptyString(current.speaker) || defaultSpeaker,
      embeddingKey: null,
    });
    current = null;
  };

  for (const rawLine of lines) {
    const trimmed = String(rawLine || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("```")) continue;

    const line = trimmed
      .replace(/^>\s*/, "")
      .replace(/^(?:[-*+]\s+|\d+\.\s+)/, "");
    const headerMatch = matchTimestampedTextLine(line);
    const timeRaw = headerMatch?.[1] || headerMatch?.[2] || "";

    if (headerMatch && timeRaw) {
      const nextStartMs = parseFlexibleTimestampToMs(timeRaw);
      if (Number.isFinite(nextStartMs)) {
        headerCount += 1;
        flushCurrent(nextStartMs);
        current = {
          startMs: nextStartMs,
          speaker: String(headerMatch[3] || "").trim(),
          lines: [],
        };
        const firstText = String(headerMatch[4] || "").trim();
        if (firstText) current.lines.push(firstText);
        continue;
      }
    }

    if (!current) continue;
    current.lines.push(line);
  }

  flushCurrent();

  if (!headerCount) {
    throw new Error(
      "Unrecognized timestamped transcript format. Example: [00:00:12] Speaker 1: Hello"
    );
  }
  if (!out.length) {
    throw new Error("No transcript content could be parsed from timestamped text");
  }

  return finalizeTranscriptSegments(out, { defaultSpeaker });
}

function parseSubtitleTimingLine(line) {
  const parts = String(line || "").split(/\s+-->\s+/);
  if (parts.length < 2) return null;

  const startRaw = String(parts[0] || "").trim();
  const endRaw = String(parts[1] || "")
    .trim()
    .split(/\s+/)[0];
  const startMs = parseFlexibleTimestampToMs(startRaw);
  const endMs = parseFlexibleTimestampToMs(endRaw);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return { startMs, endMs };
}

function looksLikeSubtitleTranscript(source) {
  const lines = normalizeTranscriptInputText(source).split("\n");
  return lines.some((line) => parseSubtitleTimingLine(line));
}

function decodeBasicHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function extractSpeakerFromCueText(text, defaultSpeaker) {
  let raw = String(text || "").trim();
  let speaker = "";

  const voiceMatch = raw.match(/^<v(?:\.[^ >]+)?\s+([^>]+)>([\s\S]*)$/i);
  if (voiceMatch?.[1]) {
    speaker = String(voiceMatch[1] || "").trim();
    raw = String(voiceMatch[2] || "").trim();
  }

  raw = decodeBasicHtmlEntities(raw.replace(/<br\s*\/?>/gi, "\n"));
  raw = raw.replace(/<\/?[^>]+>/g, " ");
  raw = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!speaker) {
    const match = raw.match(/^([\p{L}\p{N}_ .-]{1,40})\s*[:：]\s*(.+)$/u);
    if (match?.[1] && match?.[2]) {
      speaker = String(match[1] || "").trim();
      raw = String(match[2] || "").trim();
    }
  }

  return {
    speaker: speaker || normalizeDefaultSpeaker(defaultSpeaker),
    content: raw,
  };
}

function parseSubtitleTranscript(source, options = {}) {
  const defaultSpeaker = normalizeDefaultSpeaker(options?.defaultSpeaker);
  const text = normalizeTranscriptInputText(source);
  if (!text.trim()) {
    throw new Error("Transcript input is empty");
  }

  const blocks = text.split(/\n{2,}/);
  const out = [];

  for (const block of blocks) {
    const lines = String(block || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) continue;

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;

    const timing = parseSubtitleTimingLine(lines[timingIndex]);
    if (!timing) continue;

    const cueText = lines.slice(timingIndex + 1).join("\n").trim();
    if (!cueText) continue;

    const normalizedCue = extractSpeakerFromCueText(cueText, defaultSpeaker);
    if (!normalizedCue.content) continue;

    out.push({
      content: normalizedCue.content,
      start_time: timing.startMs,
      end_time: timing.endMs,
      speaker: normalizedCue.speaker,
      embeddingKey: null,
    });
  }

  if (!out.length) {
    throw new Error("No subtitle cues could be parsed from transcript input");
  }

  return finalizeTranscriptSegments(out, { defaultSpeaker });
}

function parseJsonTranscript(input, options = {}) {
  let payload = input;
  if (typeof payload === "string") {
    const trimmed = String(payload || "").trim();
    if (!trimmed) throw new Error("Transcript JSON input is empty");
    const parsed = safeJsonParse(trimmed);
    if (parsed == null) throw new Error("Invalid JSON transcript input");
    payload = parsed;
  }

  const normalized = normalizeTranscriptionToTransResult(payload);
  if (!normalized.length) {
    throw new Error("No transcript segments found in JSON input");
  }
  return finalizeTranscriptSegments(normalized, {
    defaultSpeaker: options?.defaultSpeaker,
  });
}

function parsePlainTextTranscript(source, options = {}) {
  const text = normalizeTranscriptInputText(source).trim();
  if (!text) throw new Error("Transcript input is empty");
  const normalized = normalizeTranscriptionToTransResult({ text });
  if (!normalized.length) {
    throw new Error("No transcript content could be parsed from plain text");
  }
  return finalizeTranscriptSegments(normalized, {
    defaultSpeaker: options?.defaultSpeaker,
  });
}

function inferTranscriptUploadFormat({ filePath = "", filename = "", transcriptText = "", transcriptData } = {}) {
  if (transcriptData !== undefined) return TRANSCRIPT_FORMAT_JSON;

  const source = normalizeTranscriptInputText(transcriptText);
  const extension = getTranscriptUploadFileExtension(filePath, filename);

  if (extension === ".json") return TRANSCRIPT_FORMAT_JSON;
  if (extension === ".srt") return TRANSCRIPT_FORMAT_SRT;
  if (extension === ".vtt") return TRANSCRIPT_FORMAT_VTT;
  if (extension === ".lrc") return TRANSCRIPT_FORMAT_TEXT_TIMESTAMPED;

  const trimmed = source.trim();
  if (!trimmed) return TRANSCRIPT_UPLOAD_FORMAT_PLAIN_TEXT;
  if (safeJsonParse(trimmed) != null) return TRANSCRIPT_FORMAT_JSON;
  if (/^WEBVTT\b/im.test(trimmed)) return TRANSCRIPT_FORMAT_VTT;
  if (looksLikeSubtitleTranscript(trimmed)) {
    return extension === ".vtt" ? TRANSCRIPT_FORMAT_VTT : TRANSCRIPT_FORMAT_SRT;
  }
  if (looksLikeTimestampedText(trimmed)) return TRANSCRIPT_FORMAT_TEXT_TIMESTAMPED;
  return TRANSCRIPT_UPLOAD_FORMAT_PLAIN_TEXT;
}

function parseTranscriptUploadInput(args = {}) {
  const filePath = String(args?.file_path || "").trim();
  const transcriptTextInput = args?.transcript_text;
  const hasTranscriptText = typeof transcriptTextInput === "string";
  const hasTranscriptData = args?.transcript_data !== undefined;
  const includeSegments = toBoolean(args?.include_transcript_segments, false);
  const defaultSpeaker = normalizeDefaultSpeaker(args?.default_speaker);
  const requestedFormat = normalizeTranscriptUploadFormat(args?.input_format);
  const filenameHint = String(args?.filename || "").trim();

  const sources = [Boolean(filePath), hasTranscriptText, hasTranscriptData].filter(Boolean).length;
  if (sources === 0) {
    throw new Error("Provide one of file_path, transcript_text, or transcript_data");
  }
  if (sources > 1) {
    throw new Error("Only one of file_path, transcript_text, or transcript_data can be used");
  }

  let transcriptText = "";
  let sourceType = "inline_text";
  let sourceLabel = "";
  let transcriptData = args?.transcript_data;

  if (filePath) {
    if (!existsSync(filePath)) {
      throw new Error(`Transcript file not found: ${filePath}`);
    }
    transcriptText = readFileSync(filePath, "utf8");
    sourceType = "file_path";
    sourceLabel = filePath;
  } else if (hasTranscriptText) {
    transcriptText = String(transcriptTextInput || "");
    sourceType = "transcript_text";
    sourceLabel = filenameHint;
  } else {
    sourceType = "transcript_data";
    sourceLabel = filenameHint;
  }

  if (
    hasTranscriptData &&
    requestedFormat !== TRANSCRIPT_UPLOAD_FORMAT_AUTO &&
    requestedFormat !== TRANSCRIPT_FORMAT_JSON
  ) {
    throw new Error("transcript_data only supports input_format=auto or json");
  }

  const detectedFormat =
    requestedFormat === TRANSCRIPT_UPLOAD_FORMAT_AUTO
      ? inferTranscriptUploadFormat({
          filePath,
          filename: filenameHint,
          transcriptText,
          transcriptData,
        })
      : requestedFormat;

  let transResult = [];
  if (detectedFormat === TRANSCRIPT_FORMAT_JSON) {
    transResult = parseJsonTranscript(
      hasTranscriptData ? transcriptData : transcriptText,
      { defaultSpeaker }
    );
  } else if (
    detectedFormat === TRANSCRIPT_FORMAT_SRT ||
    detectedFormat === TRANSCRIPT_FORMAT_VTT
  ) {
    transResult = parseSubtitleTranscript(transcriptText, { defaultSpeaker });
  } else if (detectedFormat === TRANSCRIPT_FORMAT_TEXT_TIMESTAMPED) {
    transResult = parseTimestampedTextTranscript(transcriptText, { defaultSpeaker });
  } else {
    transResult = parsePlainTextTranscript(transcriptText, { defaultSpeaker });
  }

  return {
    sourceType,
    sourceLabel,
    requestedFormat,
    detectedFormat,
    defaultSpeaker,
    includeSegments,
    transResult,
  };
}

function toNonNegativeInteger(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n);
}

function formatTimestampClock(value, options = {}) {
  const includeMilliseconds = toBoolean(options?.includeMilliseconds, true);
  const millisecondSeparator = String(options?.millisecondSeparator || ".");
  const ms = toNonNegativeInteger(value, 0);
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = ms % 1000;
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  if (!includeMilliseconds) {
    return `${hh}:${mm}:${ss}`;
  }
  const mmm = String(milliseconds).padStart(3, "0");
  return `${hh}:${mm}:${ss}${millisecondSeparator}${mmm}`;
}

function buildTranscriptCues(transResult) {
  const list = Array.isArray(transResult) ? transResult : [];
  const cues = [];
  let cursorMs = 0;

  for (const segment of list) {
    const content = String(segment?.content || "").trim();
    if (!content) continue;

    let startMs = toNonNegativeInteger(segment?.start_time, cursorMs);
    if (startMs < cursorMs) startMs = cursorMs;
    let endMs = toNonNegativeInteger(segment?.end_time, startMs);
    if (endMs <= startMs) endMs = startMs + 2000;

    cues.push({
      speaker: formatSpeakerForTranscript(segment?.speaker),
      content,
      startMs,
      endMs,
    });
    cursorMs = endMs;
  }

  return cues;
}

function renderTranscriptByFormat(transResult, transcriptFormat) {
  const format = normalizeTranscriptFormat(transcriptFormat);
  const list = Array.isArray(transResult) ? transResult : [];
  if (format === TRANSCRIPT_FORMAT_JSON) {
    return JSON.stringify(list, null, 2);
  }

  const cues = buildTranscriptCues(list);

  if (format === TRANSCRIPT_FORMAT_TEXT) {
    return cues.map((cue) => cue.content).join("\n\n").trim();
  }

  if (format === TRANSCRIPT_FORMAT_TEXT_TIMESTAMPED) {
    return cues
      .map((cue) => {
        const ts = formatTimestampClock(cue.startMs, { includeMilliseconds: false });
        return `[${ts}] ${cue.speaker}: ${cue.content}`;
      })
      .join("\n")
      .trim();
  }

  if (format === TRANSCRIPT_FORMAT_SRT) {
    return cues
      .map((cue, index) => {
        const startTs = formatTimestampClock(cue.startMs, {
          includeMilliseconds: true,
          millisecondSeparator: ",",
        });
        const endTs = formatTimestampClock(cue.endMs, {
          includeMilliseconds: true,
          millisecondSeparator: ",",
        });
        return `${index + 1}\n${startTs} --> ${endTs}\n${cue.speaker}: ${cue.content}`;
      })
      .join("\n\n")
      .trim();
  }

  if (format === TRANSCRIPT_FORMAT_VTT) {
    const body = cues
      .map((cue, index) => {
        const startTs = formatTimestampClock(cue.startMs, {
          includeMilliseconds: true,
          millisecondSeparator: ".",
        });
        const endTs = formatTimestampClock(cue.endMs, {
          includeMilliseconds: true,
          millisecondSeparator: ".",
        });
        return `${index + 1}\n${startTs} --> ${endTs}\n${cue.speaker}: ${cue.content}`;
      })
      .join("\n\n");
    return body ? `WEBVTT\n\n${body}` : "WEBVTT";
  }

  return "";
}

function buildPlaudPatchPayload(transResult) {
  const list = Array.isArray(transResult) ? transResult : [];
  const speakerState = {
    map: new Map(),
    next: 1,
  };

  const extractExplicitIndex = (label) => {
    const raw = String(label ?? "").trim();
    if (!raw) return null;

    let match = raw.match(/^SPEAKER\s*(\d+)$/i);
    if (match?.[1]) {
      const num = Number.parseInt(match[1], 10);
      return Number.isFinite(num) ? Math.max(1, num) : null;
    }

    match = raw.match(/^Speaker\s*(\d+)$/i);
    if (match?.[1]) {
      const num = Number.parseInt(match[1], 10);
      return Number.isFinite(num) ? Math.max(1, num) : null;
    }

    match =
      raw.match(/^SPEAKER[_\s-]*(\d+)$/i) || raw.match(/^speaker[_\s-]*(\d+)$/i);
    if (match?.[1]) {
      const idx0 = Number.parseInt(match[1], 10);
      return Number.isFinite(idx0) ? Math.max(1, idx0 + 1) : null;
    }

    return null;
  };

  for (const item of list) {
    const explicit = extractExplicitIndex(item?.speaker);
    if (explicit && explicit >= speakerState.next) {
      speakerState.next = explicit + 1;
    }
  }

  const toPlaudSpeakerStable = (label) => {
    const raw = String(label ?? "").trim();
    const explicit = extractExplicitIndex(raw);
    if (explicit) {
      if (explicit >= speakerState.next) {
        speakerState.next = explicit + 1;
      }
      return `Speaker ${explicit}`;
    }

    if (!raw) return "Speaker 1";
    const key = raw.toLowerCase();
    const existing = speakerState.map.get(key);
    if (existing) return `Speaker ${existing}`;

    const assigned = speakerState.next;
    speakerState.next += 1;
    speakerState.map.set(key, assigned);
    return `Speaker ${assigned}`;
  };

  return {
    trans_result: list
      .map((item) => ({
        content: String(item?.content ?? "").trim(),
        speaker: toPlaudSpeakerStable(item?.speaker),
        end_time: Number(item?.end_time) || 0,
        start_time: Number(item?.start_time) || 0,
      }))
      .filter((item) => item.content),
  };
}

function shouldTryAnotherApiOrigin(error) {
  const statusCode = Number(error?.plaudStatusCode);
  if (Number.isFinite(statusCode)) {
    if (statusCode === 401 || statusCode === 403) return false;
    return true;
  }

  const apiStatus = Number(error?.plaudApiStatus);
  if (Number.isFinite(apiStatus)) {
    if (apiStatus === 401 || apiStatus === 403) return false;
    return true;
  }

  return true;
}

function formatApiOriginAttemptErrors(errors) {
  const list = Array.isArray(errors) ? errors : [];
  if (!list.length) return "unknown error";
  return list
    .slice(0, 4)
    .map((item) => {
      const origin = String(item?.origin || "").trim() || "unknown-origin";
      const message = String(item?.message || "").trim() || "request failed";
      return `${origin}: ${message}`;
    })
    .join(" | ");
}

class PlaudClient {
  constructor({ token, apiOrigin, apiOrigins = [] }) {
    this.token = normalizeToken(token);
    this.apiOrigin = DEFAULT_API_ORIGIN;
    this.apiOrigins = [DEFAULT_API_ORIGIN];
    this.mergeApiOrigins([apiOrigin, ...normalizeApiOriginList(apiOrigins), DEFAULT_API_ORIGIN]);
  }

  mergeApiOrigins(origins) {
    const list = Array.isArray(origins) ? origins : [origins];
    const merged = dedupeApiOrigins([...list, ...this.apiOrigins, DEFAULT_API_ORIGIN]);
    this.apiOrigins = merged.length ? merged : [DEFAULT_API_ORIGIN];
    this.apiOrigin = this.apiOrigins[0];
  }

  setApiOrigin(origin) {
    const normalized = normalizeApiOrigin(origin);
    if (!normalized) return;
    this.mergeApiOrigins([normalized, ...this.apiOrigins]);
  }

  getApiOriginCandidates() {
    return this.apiOrigins.length ? this.apiOrigins : [this.apiOrigin || DEFAULT_API_ORIGIN];
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

  buildUrl(pathname, origin = this.apiOrigin) {
    return new URL(pathname, origin || this.apiOrigin).toString();
  }

  async requestJson({ method = "GET", pathname = "", absoluteUrl = "", body = null, retry = 0 }) {
    const origins = this.getApiOriginCandidates();
    const errors = [];

    for (let index = 0; index < origins.length; index += 1) {
      const attemptOrigin = origins[index];
      const requestUrl = absoluteUrl
        ? replaceUrlOrigin(absoluteUrl, attemptOrigin)
        : this.buildUrl(pathname, attemptOrigin);

      try {
        const response = await fetch(requestUrl, {
          method,
          headers: this.buildHeaders(body != null),
          body: body == null ? undefined : JSON.stringify(body),
        });

        const text = await response.text();
        const parsed = safeJsonParse(text) ?? { raw: text };

        const redirectedOrigin = parsed?.status === -302 && retry < 2
          ? extractRedirectApiOrigin(parsed)
          : "";
        if (redirectedOrigin && redirectedOrigin !== attemptOrigin) {
          this.setApiOrigin(redirectedOrigin);
          const retriedUrl = absoluteUrl ? replaceUrlOrigin(requestUrl, redirectedOrigin) : "";
          return this.requestJson({
            method,
            pathname,
            absoluteUrl: retriedUrl,
            body,
            retry: retry + 1,
          });
        }

        if (!response.ok) {
          const httpError = new Error(
            `PLAUD API request failed (HTTP ${response.status}): ${text.slice(0, 200)}`
          );
          httpError.plaudStatusCode = response.status;
          throw httpError;
        }

        if (typeof parsed?.status === "number" && parsed.status !== 0) {
          const apiError = new Error(
            parsed?.msg || `PLAUD API returned non-zero status: ${parsed.status}`
          );
          apiError.plaudApiStatus = parsed.status;
          throw apiError;
        }

        this.setApiOrigin(attemptOrigin);
        return {
          data: parsed,
          rawText: text,
          requestUrl: response.url || requestUrl,
          statusCode: response.status,
        };
      } catch (err) {
        errors.push({
          origin: attemptOrigin,
          message: err?.message || String(err),
        });
        const hasNextOrigin = index < origins.length - 1;
        if (!hasNextOrigin || !shouldTryAnotherApiOrigin(err)) {
          if (errors.length <= 1) throw err;
          throw new Error(
            `PLAUD API request failed across ${errors.length} origins: ${formatApiOriginAttemptErrors(errors)}`
          );
        }
      }
    }

    throw new Error("PLAUD API request failed (no reachable origin).");
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

  async getFileTempUrl(fileId) {
    const encoded = encodeURIComponent(String(fileId || "").trim());
    const resp = await this.requestJson({ method: "GET", pathname: `/file/temp-url/${encoded}` });
    const tempUrl = pickNonEmptyString(resp?.data?.temp_url, resp?.data?.data?.temp_url);
    if (!tempUrl) {
      throw new Error("temp_url field not found in PLAUD response");
    }
    return { tempUrl, requestUrl: resp.requestUrl, raw: resp.data };
  }

  async patchFileTranscript(fileId, transResult) {
    const encoded = encodeURIComponent(String(fileId || "").trim());
    const payload = buildPlaudPatchPayload(transResult);
    if (!payload?.trans_result?.length) {
      throw new Error("trans_result is empty; upload skipped.");
    }
    const resp = await this.requestJson({
      method: "PATCH",
      pathname: `/file/${encoded}`,
      body: payload,
    });
    return { data: resp.data, requestUrl: resp.requestUrl, payload };
  }
}

async function verifyPlaudTokenCandidate(token, apiOrigin, apiOrigins = []) {
  const normalized = normalizeToken(token);
  if (!normalized) {
    return { ok: false, token: "", requestUrl: "", apiOrigin: "", error: "empty token" };
  }

  const candidateClient = new PlaudClient({
    token: normalized,
    apiOrigin,
    apiOrigins,
  });
  try {
    const response = await candidateClient.listFiles({ skip: 0, limit: 1, isTrash: 2 });
    return {
      ok: true,
      token: normalized,
      requestUrl: response.requestUrl || "",
      apiOrigin: candidateClient.apiOrigin,
      error: "",
    };
  } catch (err) {
    return {
      ok: false,
      token: normalized,
      requestUrl: "",
      apiOrigin: candidateClient.apiOrigin,
      error: err?.message || String(err),
    };
  }
}

async function pickFirstValidPlaudToken(candidates, options = {}) {
  const configuredOrigins = resolvePlaudApiOriginCandidates({
    apiOrigin: options?.apiOrigin,
    apiOrigins: options?.apiOrigins,
    pageUrl: options?.pageUrl,
    currentOrigin: options?.currentOrigin,
  });
  const configuredOrigin = configuredOrigins[0] || DEFAULT_API_ORIGIN;
  const list = Array.isArray(candidates) ? candidates : [candidates];
  const unique = Array.from(new Set(list.map((item) => normalizeToken(item)).filter(Boolean)));
  const maxChecks = clampInteger(options?.maxChecks, {
    defaultValue: 12,
    min: 1,
    max: 60,
  });
  const checked = [];

  for (let index = 0; index < unique.length && index < maxChecks; index += 1) {
    const candidate = unique[index];
    const probe = await verifyPlaudTokenCandidate(candidate, configuredOrigin, configuredOrigins);
    checked.push({
      index,
      ok: probe.ok,
      error: probe.error,
      api_origin: probe.apiOrigin || configuredOrigin,
      token_masked: maskToken(candidate),
    });
    if (probe.ok) {
      return {
        ok: true,
        token: probe.token,
        apiOrigin: probe.apiOrigin,
        apiOrigins: dedupeApiOrigins([probe.apiOrigin, ...configuredOrigins]),
        requestUrl: probe.requestUrl,
        checked,
      };
    }
  }

  return {
    ok: false,
    token: "",
    apiOrigin: configuredOrigin,
    apiOrigins: configuredOrigins,
    requestUrl: "",
    checked,
  };
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
let runtimePlaudApiOrigins = [];

function setRuntimePlaudToken(token, source = "runtime") {
  const normalized = normalizeToken(token);
  const previous = runtimePlaudToken;
  runtimePlaudToken = normalized;
  runtimePlaudTokenSource = runtimePlaudToken ? String(source || "runtime") : "";
  if (!runtimePlaudToken || runtimePlaudToken !== previous) {
    runtimePlaudApiOrigins = [];
  }
}

function setRuntimePlaudApiOrigins(origins) {
  runtimePlaudApiOrigins = dedupeApiOrigins(origins);
}

function resolvePreferredTokenFilePath() {
  const explicit = String(process.env.PLAUD_TOKEN_FILE || "").trim();
  if (explicit) return explicit;
  if (isAutoPersistDisabled()) return "";
  return DEFAULT_AUTO_TOKEN_PATH;
}

function resolvePlaudTokenState() {
  const runtimeToken = normalizeToken(runtimePlaudToken);
  if (runtimeToken) {
    return {
      token: runtimeToken,
      source: runtimePlaudTokenSource || "runtime",
      tokenFilePath: "",
    };
  }

  const directToken = normalizeToken(
    process.env.PLAUD_TOKEN || process.env.PLAUD_BEARER_TOKEN || process.env.PLAUD_AUTH_TOKEN
  );
  if (directToken) {
    return {
      token: directToken,
      source: "env",
      tokenFilePath: resolvePreferredTokenFilePath(),
    };
  }

  const tokenFile = String(process.env.PLAUD_TOKEN_FILE || "").trim();
  const explicitFileToken = readTokenFromFile(tokenFile);
  if (explicitFileToken) {
    return {
      token: explicitFileToken,
      source: "token_file",
      tokenFilePath: tokenFile,
    };
  }

  if (!isAutoPersistDisabled()) {
    const autoFileToken = readTokenFromFile(DEFAULT_AUTO_TOKEN_PATH);
    if (autoFileToken) {
      return {
        token: autoFileToken,
        source: "persisted_file",
        tokenFilePath: DEFAULT_AUTO_TOKEN_PATH,
      };
    }
  }

  return {
    token: "",
    source: "",
    tokenFilePath: resolvePreferredTokenFilePath(),
  };
}

function resolvePlaudToken() {
  return resolvePlaudTokenState().token;
}

function resolvePlaudTokenSource() {
  return resolvePlaudTokenState().source;
}

let plaudClient = null;

function getPlaudClient() {
  const tokenState = resolvePlaudTokenState();
  const token = tokenState.token;
  if (!token) {
    throw new Error(
      "Missing PLAUD token. Set PLAUD_TOKEN (or PLAUD_BEARER_TOKEN / PLAUD_AUTH_TOKEN / PLAUD_TOKEN_FILE), or call plaud_auth_browser first."
    );
  }

  const persistedApiStatePath = resolveApiOriginStateFilePath(tokenState.tokenFilePath);
  const persistedApiState = readApiOriginStateFromFile(persistedApiStatePath, token);
  const runtimeOrigins = tokenState.source === "runtime" ? runtimePlaudApiOrigins : [];
  const configuredOrigins = resolvePlaudApiOriginCandidates({
    apiOrigin: process.env.PLAUD_API_ORIGIN,
    apiOrigins: [...runtimeOrigins, ...(persistedApiState.apiOrigins || [])],
    currentOrigin: plaudClient?.apiOrigin,
  });
  const keepOrigin = configuredOrigins[0] || DEFAULT_API_ORIGIN;

  if (!plaudClient || plaudClient.token !== token) {
    plaudClient = new PlaudClient({
      token,
      apiOrigin: keepOrigin,
      apiOrigins: configuredOrigins,
    });
  } else {
    plaudClient.mergeApiOrigins(configuredOrigins);
  }
  return plaudClient;
}

async function handleAuthBrowser(args) {
  const browser = String(args?.browser || "chrome")
    .trim()
    .toLowerCase();
  const openUrl = toBoolean(args?.open_url, true);
  const targetUrl = String(args?.url || DEFAULT_WEB_FILE_URL).trim();
  const waitMs = clampInteger(args?.wait_ms, { defaultValue: 7000, min: 1000, max: 30000 });
  const saveToFile = String(args?.save_to_file || "").trim();
  const returnToken = toBoolean(args?.return_token, false);
  const autoPersistDisabled = isAutoPersistDisabled();
  const autoPersistEnabled = !autoPersistDisabled;
  const persistTargetPath = autoPersistDisabled
    ? ""
    : (saveToFile || DEFAULT_AUTO_TOKEN_PATH);

  const authUrlCandidates = openUrl
    ? buildPlaudPageUrlCandidates(targetUrl)
    : [targetUrl || DEFAULT_WEB_FILE_URL];
  const attemptedUrls = [];
  let result = null;
  let lastExtractionError = null;

  for (let index = 0; index < authUrlCandidates.length; index += 1) {
    const attemptUrl = authUrlCandidates[index];
    attemptedUrls.push(attemptUrl);
    try {
      const attempt = extractTokenViaBrowserAutomation({
        browser,
        openUrl,
        url: attemptUrl,
        waitMs,
      });
      if (!result) {
        result = attempt;
      }
      const attemptCandidates = Array.isArray(attempt?.tokenCandidates)
        ? attempt.tokenCandidates
        : [attempt?.token];
      const hasValidCandidate = attemptCandidates
        .map((item) => normalizeToken(item))
        .filter(Boolean)
        .length > 0;
      if (hasValidCandidate) {
        result = attempt;
        break;
      }
    } catch (err) {
      lastExtractionError = err;
    }
  }

  if (!result && lastExtractionError) {
    throw lastExtractionError;
  }

  const tokenCandidates = Array.isArray(result?.tokenCandidates)
    ? result.tokenCandidates
    : [result?.token];
  const normalizedCandidates = tokenCandidates.map((item) => normalizeToken(item)).filter(Boolean);
  if (!normalizedCandidates.length) {
    throw new Error(
      "No PLAUD token captured. Please ensure browser is logged in, keep web.plaud.ai or app.plaud.ai open, and retry."
    );
  }

  const apiOriginCandidates = resolvePlaudApiOriginCandidates({
    apiOrigin: process.env.PLAUD_API_ORIGIN,
    apiOrigins: result?.apiOriginCandidates,
    pageUrl: result?.url || targetUrl,
    currentOrigin: plaudClient?.apiOrigin,
  });

  const validation = await pickFirstValidPlaudToken(normalizedCandidates, {
    apiOrigin: apiOriginCandidates[0],
    apiOrigins: apiOriginCandidates,
    pageUrl: result?.url || targetUrl,
    currentOrigin: plaudClient?.apiOrigin,
    maxChecks: 12,
  });
  if (!validation.ok || !validation.token) {
    const firstError = validation.checked.find((item) => !item.ok)?.error || "unknown error";
    throw new Error(
      `Captured token(s) from browser but all failed PLAUD API validation. First error: ${firstError}`
    );
  }

  const token = validation.token;
  setRuntimePlaudToken(token, `browser:${result.appName}`);
  const resolvedOrigins = dedupeApiOrigins([
    validation.apiOrigin,
    ...(validation.apiOrigins || []),
    ...apiOriginCandidates,
  ]);
  setRuntimePlaudApiOrigins(resolvedOrigins);
  plaudClient = new PlaudClient({
    token,
    apiOrigin: validation.apiOrigin || resolvedOrigins[0] || DEFAULT_API_ORIGIN,
    apiOrigins: resolvedOrigins,
  });

  let savedPath = "";
  let savedApiOriginsPath = "";
  let persistMode = "none";
  let persistError = "";
  if (autoPersistDisabled && saveToFile) {
    persistError = "PLAUD_DISABLE_AUTO_PERSIST=1 is set; save_to_file is ignored.";
  }
  if (persistTargetPath) {
    const persisted = persistTokenToFile(token, persistTargetPath);
    if (!persisted.ok) {
      if (saveToFile) {
        throw new Error(`Failed to persist token to save_to_file: ${persisted.error}`);
      }
      persistError = persisted.error;
    } else {
      savedPath = persisted.path;
      persistMode = saveToFile ? "explicit" : "auto_default";
      const apiOriginStatePath = resolveApiOriginStateFilePath(savedPath || persistTargetPath);
      const persistedApiOrigins = persistApiOriginStateToFile({
        token,
        apiOrigin: validation.apiOrigin || resolvedOrigins[0],
        apiOrigins: resolvedOrigins,
        filePath: apiOriginStatePath,
      });
      if (!persistedApiOrigins.ok) {
        if (saveToFile) {
          throw new Error(
            `Failed to persist API origin state file for save_to_file: ${persistedApiOrigins.error}`
          );
        }
        persistError = persistError
          ? `${persistError} | ${persistedApiOrigins.error}`
          : persistedApiOrigins.error;
      } else {
        savedApiOriginsPath = persistedApiOrigins.path;
      }
    }
  }

  return {
    ok: true,
    token_loaded: true,
    token_source: resolvePlaudTokenSource(),
    token_masked: maskToken(token),
    browser: browser,
    browser_app: result.appName,
    opened_url: result.openUrl ? result.url : "",
    attempted_urls: attemptedUrls,
    wait_ms: waitMs,
    token_candidate_source: String(result.candidateSource || ""),
    request_header_candidates: Number(result.requestHeaderCandidateCount || 0),
    api_origin: validation.apiOrigin || "",
    api_origin_candidates: resolvedOrigins,
    validated: true,
    validated_request_url: validation.requestUrl || "",
    token_candidates_checked: validation.checked.length,
    auto_persist_enabled: autoPersistEnabled,
    persist_mode: persistMode,
    persist_error: persistError,
    saved_to_file: savedPath,
    saved_api_origins_file: savedApiOriginsPath,
    return_token_requested: returnToken,
    return_token: false,
    token: "",
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
  const transcriptFormat = includeTranscript
    ? normalizeTranscriptFormat(args?.transcript_format)
    : TRANSCRIPT_FORMAT_JSON;
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
    const transcriptTextFull = renderTranscriptByFormat(transcript.transResult, transcriptFormat);
    const shouldTruncateTranscript = transcriptFormat !== TRANSCRIPT_FORMAT_JSON;
    const truncatedTranscript = shouldTruncateTranscript
      ? truncateText(transcriptTextFull, maxTranscriptChars)
      : {
          text: transcriptTextFull,
          truncated: false,
          originalLength: transcriptTextFull.length,
        };

    result.transcript = {
      source: transcript.source,
      transcript_url: transcript.transcriptUrl,
      segment_count: transcript.transResult.length,
      format: transcriptFormat,
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

async function loadSingleFileAudioPayloadCore(client, fileId, options = {}) {
  const shouldDownload = toBoolean(options?.shouldDownload, false);
  const saveToFile = String(options?.saveToFile || "").trim();
  const saveToDir = String(options?.saveToDir || "").trim();
  const returnBase64 = toBoolean(options?.returnBase64, false);
  const includeDataUrl = returnBase64 && toBoolean(options?.includeDataUrl, false);
  const audioFormat = normalizeAudioFormat(options?.audioFormat);
  const defaultMaxBytes = returnBase64 ? 20 * 1024 * 1024 : 500 * 1024 * 1024;
  const maxBytes = clampInteger(options?.maxBytes, {
    defaultValue: defaultMaxBytes,
    min: 1,
    max: 1_000_000_000,
  });

  const tempUrlResp = await client.getFileTempUrl(fileId);
  const result = {
    api_origin: client.apiOrigin,
    file_id: fileId,
    request_url: tempUrlResp.requestUrl,
    temp_url: tempUrlResp.tempUrl,
    download_performed: shouldDownload,
    audio_format_requested: audioFormat,
  };

  if (!shouldDownload) {
    return result;
  }

  const downloaded = await fetchBinaryFromUrl(tempUrlResp.tempUrl, { maxBytes });
  let outputBuffer = downloaded.buffer;
  let outputContentType = downloaded.contentType;
  let outputSize = downloaded.size;
  let audioFormatApplied = AUDIO_FORMAT_ORIGINAL;
  let ffmpegExecutable = "";

  if (audioFormat === AUDIO_FORMAT_WAV) {
    const converted = await convertAudioBufferToWavWithFfmpeg(downloaded.buffer, {
      fileId,
      maxBytes,
    });
    outputBuffer = converted.buffer;
    outputContentType = converted.contentType;
    outputSize = converted.buffer.length;
    audioFormatApplied = AUDIO_FORMAT_WAV;
    ffmpegExecutable = converted.ffmpegExecutable;
  }

  const audio = {
    final_url: downloaded.requestUrl,
    content_type: outputContentType,
    size: outputSize,
    source_content_type: downloaded.contentType,
    source_size: downloaded.size,
    max_bytes: maxBytes,
    saved_to_file: "",
    returned_base64: returnBase64,
    audio_format_applied: audioFormatApplied,
  };
  if (ffmpegExecutable) audio.ffmpeg_executable = ffmpegExecutable;

  const outputPath = buildAudioOutputFilePath({
    saveToFile,
    saveToDir,
    fileId,
    contentType: outputContentType,
    downloadUrl: downloaded.requestUrl || tempUrlResp.tempUrl,
    forcedExtension: audioFormatApplied === AUDIO_FORMAT_WAV ? "wav" : "",
  });
  if (outputPath) {
    const persisted = persistBinaryToFile(outputBuffer, outputPath);
    if (!persisted.ok) {
      throw new Error(`Failed to save audio file: ${persisted.error}`);
    }
    audio.saved_to_file = persisted.path;
  }

  if (returnBase64) {
    const base64 = outputBuffer.toString("base64");
    audio.base64 = base64;
    if (includeDataUrl) {
      const mimeType = outputContentType || "application/octet-stream";
      audio.data_url = `data:${mimeType};base64,${base64}`;
    }
  }

  result.audio_format_applied = audioFormatApplied;
  result.audio = audio;
  return result;
}

const audioPayloadInFlight = new Map();
const audioPayloadResultCache = new Map();

function buildAudioPayloadExecutionKey(client, fileId, options = {}) {
  const normalized = {
    api_origin: String(client?.apiOrigin || "").trim().toLowerCase(),
    file_id: String(fileId || "").trim(),
    should_download: toBoolean(options?.shouldDownload, false),
    save_to_file: String(options?.saveToFile || "").trim(),
    save_to_dir: String(options?.saveToDir || "").trim(),
    return_base64: toBoolean(options?.returnBase64, false),
    include_data_url: toBoolean(options?.includeDataUrl, false),
    max_bytes: clampInteger(options?.maxBytes, {
      defaultValue: 500 * 1024 * 1024,
      min: 1,
      max: 1_000_000_000,
    }),
    audio_format: normalizeAudioFormat(options?.audioFormat),
  };
  return createHash("sha1").update(JSON.stringify(normalized)).digest("hex");
}

function cloneAudioPayloadResult(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function pruneAudioPayloadResultCache() {
  const now = Date.now();
  for (const [key, entry] of audioPayloadResultCache.entries()) {
    if (!entry || now >= Number(entry.expiresAt || 0)) {
      audioPayloadResultCache.delete(key);
    }
  }
  if (audioPayloadResultCache.size <= AUDIO_RESULT_CACHE_MAX_ENTRIES) return;
  const items = Array.from(audioPayloadResultCache.entries()).sort(
    (a, b) => Number(a?.[1]?.expiresAt || 0) - Number(b?.[1]?.expiresAt || 0)
  );
  while (audioPayloadResultCache.size > AUDIO_RESULT_CACHE_MAX_ENTRIES && items.length) {
    const [key] = items.shift();
    audioPayloadResultCache.delete(key);
  }
}

function shouldCacheAudioPayloadResult(result) {
  return !result?.audio?.base64;
}

async function loadSingleFileAudioPayload(client, fileId, options = {}) {
  const key = buildAudioPayloadExecutionKey(client, fileId, options);
  pruneAudioPayloadResultCache();

  const cached = audioPayloadResultCache.get(key);
  if (cached && Date.now() < Number(cached.expiresAt || 0)) {
    return cloneAudioPayloadResult(cached.result);
  }

  if (audioPayloadInFlight.has(key)) {
    return audioPayloadInFlight.get(key);
  }

  const taskPromise = loadSingleFileAudioPayloadCore(client, fileId, options)
    .then((result) => {
      if (shouldCacheAudioPayloadResult(result)) {
        audioPayloadResultCache.set(key, {
          expiresAt: Date.now() + AUDIO_RESULT_CACHE_TTL_MS,
          result: cloneAudioPayloadResult(result),
        });
      }
      return result;
    })
    .finally(() => {
      if (audioPayloadInFlight.get(key) === taskPromise) {
        audioPayloadInFlight.delete(key);
      }
    });

  audioPayloadInFlight.set(key, taskPromise);
  return taskPromise;
}

async function handleGetFileAudio(args) {
  const client = getPlaudClient();
  const singleFileIdInput = pickNonEmptyString(args?.file_id, args?.fileId);
  const { fileIds, hasFileIdsArray } = collectAudioFileIds(args || {});
  if (!fileIds.length) throw new Error("Missing file_id or file_ids");

  const saveToFile = String(args?.save_to_file || "").trim();
  const saveToDir = String(args?.save_to_dir || "").trim();
  if (saveToFile && saveToDir) {
    throw new Error("save_to_file and save_to_dir cannot be used together.");
  }

  const returnBase64 = toBoolean(args?.return_base64, false);
  const includeDataUrl = returnBase64 && toBoolean(args?.include_data_url, false);
  const audioFormat = normalizeAudioFormat(pickNonEmptyString(args?.audio_format, args?.audioFormat));
  const explicitDownload = toBoolean(args?.download, false);
  const shouldDownload = explicitDownload || Boolean(saveToFile) || Boolean(saveToDir) || returnBase64;
  const defaultMaxBytes = returnBase64 ? 20 * 1024 * 1024 : 500 * 1024 * 1024;
  const maxBytes = clampInteger(args?.max_bytes, {
    defaultValue: defaultMaxBytes,
    min: 1,
    max: 1_000_000_000,
  });
  const isBatchMode = fileIds.length > 1 || (!singleFileIdInput && hasFileIdsArray);
  const downloadConcurrency = clampInteger(args?.download_concurrency, {
    defaultValue: 3,
    min: 1,
    max: 8,
  });
  const continueOnError = toBoolean(args?.continue_on_error, true);

  if (isBatchMode && saveToFile) {
    throw new Error("save_to_file is only supported in single-file mode. Use save_to_dir in batch mode.");
  }

  if (!isBatchMode) {
    return loadSingleFileAudioPayload(client, fileIds[0], {
      shouldDownload,
      saveToFile,
      saveToDir,
      returnBase64,
      includeDataUrl,
      audioFormat,
      maxBytes,
    });
  }

  const normalizeBatchItem = (item) => {
    const out = {
      ok: true,
      file_id: item.file_id,
      request_url: item.request_url,
      temp_url: item.temp_url,
      download_performed: item.download_performed,
      audio_format_requested: item.audio_format_requested,
    };
    if (item.audio_format_applied) out.audio_format_applied = item.audio_format_applied;
    if (item.audio) out.audio = item.audio;
    return out;
  };

  let results = [];
  if (!continueOnError) {
    for (const fileId of fileIds) {
      try {
        const item = await loadSingleFileAudioPayload(client, fileId, {
          shouldDownload,
          saveToDir,
          returnBase64,
          includeDataUrl,
          audioFormat,
          maxBytes,
        });
        results.push(normalizeBatchItem(item));
      } catch (err) {
        const message = err?.message || String(err);
        throw new Error(`Failed to fetch audio for file_id=${fileId}: ${message}`);
      }
    }
  } else {
    results = await mapWithConcurrency(fileIds, downloadConcurrency, async (fileId) => {
      try {
        const item = await loadSingleFileAudioPayload(client, fileId, {
          shouldDownload,
          saveToDir,
          returnBase64,
          includeDataUrl,
          audioFormat,
          maxBytes,
        });
        return normalizeBatchItem(item);
      } catch (err) {
        return {
          ok: false,
          file_id: fileId,
          audio_format_requested: audioFormat,
          error: err?.message || String(err),
        };
      }
    });
  }

  const success = results.filter((item) => item?.ok).length;
  const failed = results.length - success;
  return {
    api_origin: client.apiOrigin,
    mode: "batch",
    count: results.length,
    success,
    failed,
    download_performed: shouldDownload,
    audio_format_requested: audioFormat,
    return_base64: returnBase64,
    save_to_dir: saveToDir,
    max_bytes: maxBytes,
    download_concurrency: downloadConcurrency,
    continue_on_error: continueOnError,
    results,
  };
}

async function handleUploadTranscriptFile(args) {
  const fileId = pickNonEmptyString(args?.file_id, args?.fileId);
  if (!fileId) throw new Error("Missing file_id");

  const parsed = parseTranscriptUploadInput(args || {});
  const client = getPlaudClient();
  const patchResp = await client.patchFileTranscript(fileId, parsed.transResult);

  const result = {
    ok: true,
    api_origin: client.apiOrigin,
    file_id: fileId,
    request_url: patchResp.requestUrl,
    input_source: parsed.sourceType,
    input_label: parsed.sourceLabel,
    input_format_requested: parsed.requestedFormat,
    input_format_detected: parsed.detectedFormat,
    default_speaker: parsed.defaultSpeaker,
    segment_count: parsed.transResult.length,
    uploaded_segment_count: patchResp.payload.trans_result.length,
  };

  if (parsed.includeSegments) {
    result.transcript_segments = parsed.transResult;
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
  if (name === TOOL_GET_FILE_AUDIO) return handleGetFileAudio(args || {});
  if (name === TOOL_UPLOAD_TRANSCRIPT_FILE) return handleUploadTranscriptFile(args || {});
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

function sendNotification(method, params) {
  sendMessage({
    jsonrpc: "2.0",
    method: String(method || "").trim() || "notifications/message",
    params: params && typeof params === "object" ? params : {},
  });
}

function sendProgressNotification(progressToken, detail = "", progress = 0) {
  if (progressToken === undefined || progressToken === null || progressToken === "") return;
  sendNotification("notifications/progress", {
    progressToken,
    progress,
    message: String(detail || "").trim(),
  });
}

function logError(message, error) {
  const line = String(message || "").trim();
  const detail = error?.stack || error?.message || (error ? String(error) : "");
  const text = detail ? `${line}\n${detail}\n` : `${line}\n`;
  process.stderr.write(text);
}

function startToolHeartbeat({ requestId, toolName, progressToken }) {
  const name = String(toolName || "tool").trim() || "tool";
  const idText = String(requestId ?? "").trim();
  const label = idText ? `${name}#${idText}` : name;
  let tick = 0;

  const emit = (phase) => {
    tick += 1;
    const detail = `still running (${phase}), tick=${tick}`;
    process.stderr.write(`[${SERVER_NAME}] ${label} ${detail}\n`);
    sendProgressNotification(progressToken, `${name} ${detail}`, tick);
  };

  emit("start");
  const timer = setInterval(() => emit("heartbeat"), TOOL_HEARTBEAT_INTERVAL_MS);

  return {
    stop(status = "done") {
      clearInterval(timer);
      emit(status);
    },
  };
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
        : "No PLAUD token found. Set PLAUD_TOKEN / PLAUD_TOKEN_FILE, or call tool plaud_auth_browser (auto-saves to ~/.plaud/token unless PLAUD_DISABLE_AUTO_PERSIST=1).",
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
    const rawToolArgs = params?.arguments && typeof params.arguments === "object"
      ? params.arguments
      : {};
    const progressToken =
      params?._meta?.progressToken ?? params?.meta?.progressToken ?? params?.progressToken;
    const toolArgs = {
      ...rawToolArgs,
      __mcpRequestMeta: {
        requestId: id,
        progressToken,
      },
    };
    const heartbeat =
      toolName === TOOL_GET_FILE_AUDIO
        ? startToolHeartbeat({
            requestId: id,
            toolName: toolName || "tools/call",
            progressToken,
          })
        : null;

    try {
      const payload = await executeToolCall(toolName, toolArgs);
      sendResponse(id, buildToolTextResult(payload));
    } catch (err) {
      sendResponse(id, buildToolErrorResult(err));
    } finally {
      if (heartbeat) heartbeat.stop("end");
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


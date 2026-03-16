# PLAUD MCP User Guide

This guide is for end users.  
It explains how to use this MCP in Claude Code or Codex to access and update PLAUD files, transcripts, summaries, and audio.

## What You Get

After setup, Claude Code or Codex can use these MCP tools:

- `plaud_auth_browser`
  - Opens PLAUD in your browser and tries to capture your login token automatically (macOS/Windows).
- `plaud_list_files`
  - Lists your PLAUD files.
- `plaud_get_file_data`
  - Fetches file detail, transcript, and summary for a specific file.
- `plaud_get_file_audio`
  - Fetches audio `temp_url` for a `file_id`, and can optionally download/save/return base64 audio.
- `plaud_upload_transcript_file`
  - Uploads a transcript back into a PLAUD file from a local file, inline text, or structured JSON.

## Prerequisites

- Node.js 18+
- Claude Code CLI (`claude`) or Codex CLI (`codex`) installed
- The distributed file: `plaud-mcp-server.standalone.js`

## Install in Claude Code

Replace the path below with your local path:

```bash
claude mcp add --scope user plaud-local -- node /absolute/path/plaud-mcp-server.standalone.js
```

Verify:

```bash
claude mcp get plaud-local
```

## Install in Codex

Replace the path below with your local path:

```bash
codex mcp add plaud-local -- node /absolute/path/plaud-mcp-server.standalone.js
```

Verify:

```bash
codex mcp list
codex mcp get plaud-local
```

## Start Using It

Start one client:

```bash
claude
```

or:

```bash
codex
```

Then in your Claude/Codex conversation, use these prompts:

1. Authenticate (recommended first)

```text
Call MCP tool plaud_auth_browser with arguments {"browser":"chrome","open_url":true,"url":"https://web.plaud.ai/file/","wait_ms":10000} and return the raw result.
```

`url` can also be set to `https://app.plaud.ai/file/`.

After successful validation, token is auto-saved to `~/.plaud/token` by default.
The API origin state paired with the token is also saved to `~/.plaud/token.api-origins.json`.
To disable this behavior, set env `PLAUD_DISABLE_AUTO_PERSIST=1` when registering the MCP server (`save_to_file` will also be ignored).

2. List files

```text
Call MCP tool plaud_list_files with arguments {"limit":10} and show file_id + title.
```

3. Get transcript and summary for one file

```text
Call MCP tool plaud_get_file_data with arguments {"file_id":"<YOUR_FILE_ID>","include_transcript":true,"include_summary":true}.
```

Supported `transcript_format` values:
- `json` (default)
- `srt`
- `vtt`
- `text`
- `text_timestamped`

Example:

```text
Call MCP tool plaud_get_file_data with arguments {"file_id":"<YOUR_FILE_ID>","include_transcript":true,"transcript_format":"srt"}.
```

4. Get audio for one file

Only return `temp_url`:

```text
Call MCP tool plaud_get_file_audio with arguments {"file_id":"<YOUR_FILE_ID>"}.
```

Download and save to local file:

```text
Call MCP tool plaud_get_file_audio with arguments {"file_id":"<YOUR_FILE_ID>","download":true,"save_to_file":"/absolute/path/plaud-audio.mp3"}.
```

Download, convert, and save as wav:

```text
Call MCP tool plaud_get_file_audio with arguments {"file_id":"<YOUR_FILE_ID>","download":true,"audio_format":"wav","save_to_file":"/absolute/path/plaud-audio.wav"}.
```

Note: `audio_format=wav` needs ffmpeg available in PATH, or set `PLAUD_FFMPEG_PATH`.

Batch download and save into one directory:

```text
Call MCP tool plaud_get_file_audio with arguments {"file_ids":["<FILE_ID_1>","<FILE_ID_2>"],"download":true,"save_to_dir":"/absolute/path/plaud-audios","download_concurrency":3,"continue_on_error":true}.
```

5. Upload a transcript file back to PLAUD

Upload local subtitle/transcript file:

```text
Call MCP tool plaud_upload_transcript_file with arguments {"file_id":"<YOUR_FILE_ID>","file_path":"/absolute/path/transcript.srt"}.
```

Upload local timestamped Markdown/TXT:

```text
Call MCP tool plaud_upload_transcript_file with arguments {"file_id":"<YOUR_FILE_ID>","file_path":"/absolute/path/transcript.md","input_format":"auto"}.
```

Supported timestamped text example:

```text
[00:00:12] Speaker 1: Hello
[00:00:16] Speaker 2: Hi
```

Upload inline plain text:

```text
Call MCP tool plaud_upload_transcript_file with arguments {"file_id":"<YOUR_FILE_ID>","transcript_text":"This is a manually prepared transcript.","input_format":"plain_text"}.
```

Upload structured JSON:

```text
Call MCP tool plaud_upload_transcript_file with arguments {"file_id":"<YOUR_FILE_ID>","transcript_data":[{"content":"Hello","speaker":"Speaker 1","start_time":0,"end_time":1200}]}.
```

## Optional: Use Token Directly (No Browser Auth)

If you already have a PLAUD token:

```bash
claude mcp remove plaud-local
claude mcp add --scope user -e PLAUD_TOKEN=YOUR_TOKEN plaud-local -- node /absolute/path/plaud-mcp-server.standalone.js
```

Codex equivalent:

```bash
codex mcp remove plaud-local
codex mcp add --env PLAUD_TOKEN=YOUR_TOKEN plaud-local -- node /absolute/path/plaud-mcp-server.standalone.js
```

If your region uses a non-default API domain, you can also add:

```bash
claude mcp add --scope user -e PLAUD_TOKEN=YOUR_TOKEN -e PLAUD_API_ORIGINS=https://api.plaud.ai,https://api-eu.plaud.ai plaud-local -- node /absolute/path/plaud-mcp-server.standalone.js
```

Codex equivalent:

```bash
codex mcp remove plaud-local
codex mcp add --env PLAUD_TOKEN=YOUR_TOKEN --env PLAUD_API_ORIGINS=https://api.plaud.ai,https://api-eu.plaud.ai plaud-local -- node /absolute/path/plaud-mcp-server.standalone.js
```

If you want browser auth but custom save path, call:

```text
Call MCP tool plaud_auth_browser with arguments {"browser":"chrome","save_to_file":"/absolute/path/plaud.token"}.
```

This also writes `/absolute/path/plaud.token.api-origins.json`, so MCP can reuse the regional API origin after restart.

## Troubleshooting

1. `plaud_auth_browser` tool not found
- Run `claude mcp get plaud-local`
- Or run `codex mcp get plaud-local`
- Restart your client session

2. `plaud_auth_browser` cannot capture token
- Make sure you are logged in at `https://web.plaud.ai/file/` or `https://app.plaud.ai/file/`
- Increase `wait_ms` to `15000`
- On macOS, allow Terminal/iTerm to control your browser when prompted
- On Windows, if capture still fails, fully close the target browser once and retry

3. `Missing PLAUD token`
- Run `plaud_auth_browser` first
- Or configure `PLAUD_TOKEN` when adding MCP
- If auto-persist was disabled, configure `PLAUD_TOKEN_FILE` or remove `PLAUD_DISABLE_AUTO_PERSIST=1`

4. Empty file list
- Confirm your PLAUD account has files
- Retry `plaud_list_files` without filters

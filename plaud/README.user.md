# PLAUD MCP User Guide

This guide is for end users.  
It explains how to use this MCP in Claude Code to access PLAUD files, transcripts, and summaries.

## What You Get

After setup, Claude can use these MCP tools:

- `plaud_auth_browser`
  - Opens PLAUD in your browser and tries to capture your login token automatically (macOS/Windows).
- `plaud_list_files`
  - Lists your PLAUD files.
- `plaud_get_file_data`
  - Fetches file detail, transcript, and summary for a specific file.

## Prerequisites

- Node.js 18+
- Claude Code CLI (`claude`) installed
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

## Start Using It

Start Claude Code:

```bash
claude
```

Then in your Claude conversation, use these prompts:

1. Authenticate (recommended first)

```text
Call MCP tool plaud_auth_browser with arguments {"browser":"chrome","open_url":true,"url":"https://web.plaud.ai/file/","wait_ms":10000} and return the raw result.
```

2. List files

```text
Call MCP tool plaud_list_files with arguments {"limit":10} and show file_id + title.
```

3. Get transcript and summary for one file

```text
Call MCP tool plaud_get_file_data with arguments {"file_id":"<YOUR_FILE_ID>","include_transcript":true,"include_summary":true}.
```

## Optional: Use Token Directly (No Browser Auth)

If you already have a PLAUD token:

```bash
claude mcp remove plaud-local
claude mcp add --scope user -e PLAUD_TOKEN=YOUR_TOKEN plaud-local -- node /absolute/path/plaud-mcp-server.standalone.js
```

## Troubleshooting

1. `plaud_auth_browser` tool not found
- Run `claude mcp get plaud-local`
- Restart your Claude session

2. `plaud_auth_browser` cannot capture token
- Make sure you are logged in at `https://web.plaud.ai/file/`
- Increase `wait_ms` to `15000`
- On macOS, allow Terminal/iTerm to control your browser when prompted
- On Windows, if capture still fails, fully close the target browser once and retry

3. `Missing PLAUD token`
- Run `plaud_auth_browser` first
- Or configure `PLAUD_TOKEN` when adding MCP

4. Empty file list
- Confirm your PLAUD account has files
- Retry `plaud_list_files` without filters

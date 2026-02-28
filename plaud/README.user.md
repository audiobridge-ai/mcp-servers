# PLAUD MCP User Guide

This guide explains how to set up and use the PLAUD MCP server to access your PLAUD files, transcripts, and summaries from any MCP-compatible client.

**Works on:** Windows, macOS, and Linux.

## What You Get

After setup, your MCP client can use these tools:

- `plaud_auth_browser`
  - Opens a local authentication page in your browser to capture your PLAUD login token. Cross-platform.
- `plaud_list_files`
  - Lists your PLAUD files with pagination and keyword filters.
- `plaud_get_file_data`
  - Fetches file detail, transcript, and summary for a specific file.

## Prerequisites

- Node.js 18+
- An MCP-compatible client (see setup options below)
- The distributed file: `plaud-mcp-server.standalone.js`

## Setup

Choose the setup method that matches your MCP client.

### Option A: MCP CLI (e.g. `claude mcp add`)

Replace the path below with your local path:

```bash
claude mcp add --scope user plaud-local -- node /absolute/path/plaud-mcp-server.standalone.js
```

Verify:

```bash
claude mcp get plaud-local
```

### Option B: Desktop App (JSON config)

Most MCP desktop apps read a JSON configuration file. Add the PLAUD server entry:

```json
{
  "mcpServers": {
    "plaud-local": {
      "command": "node",
      "args": ["/absolute/path/plaud-mcp-server.standalone.js"]
    }
  }
}
```

**Config file locations by app:**

| App | Config path |
|-----|------------|
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `.cursor/mcp.json` in your project root |

> **Windows paths:** Use double backslashes in JSON, e.g. `"C:\\Tools\\plaud-mcp\\plaud-mcp-server.standalone.js"`

After editing the config, restart the app.

### Option C: Pre-configured Token (skip browser auth)

If you already have your PLAUD bearer token, pass it as an environment variable to skip the browser authentication flow entirely.

**CLI:**
```bash
claude mcp add --scope user -e PLAUD_TOKEN=YOUR_TOKEN plaud-local -- node /absolute/path/plaud-mcp-server.standalone.js
```

**JSON config:**
```json
{
  "mcpServers": {
    "plaud-local": {
      "command": "node",
      "args": ["/absolute/path/plaud-mcp-server.standalone.js"],
      "env": {
        "PLAUD_TOKEN": "eyJhbGciOi..."
      }
    }
  }
}
```

## Authentication

The server supports multiple ways to provide your PLAUD token, checked in this order:

1. **Runtime token** — captured via `plaud_auth_browser` during the current session
2. **Environment variable** — `PLAUD_TOKEN`, `PLAUD_BEARER_TOKEN`, or `PLAUD_AUTH_TOKEN`
3. **Token file (env)** — path specified in `PLAUD_TOKEN_FILE`
4. **Persisted token** — saved to `~/.plaud/token` from a previous auth session

### Browser Authentication (recommended first time)

Call the `plaud_auth_browser` tool. This will:

1. Start a temporary local web server on your machine
2. Open your default browser to a local authentication page
3. The page provides three methods to capture your token:
   - **Console snippet** — paste into browser DevTools while on web.plaud.ai
   - **Bookmarklet** — drag to bookmarks bar for reuse
   - **Manual entry** — paste your token directly
4. Once captured, the token is saved to `~/.plaud/token` for future sessions

Example prompt:

```
Authenticate with my PLAUD account
```

Or call the tool directly:

```
Call MCP tool plaud_auth_browser with arguments {}
```

**You only need to authenticate once.** The token is persisted and loaded automatically on subsequent sessions.

### Manual Token Extraction

If browser auth doesn't work, extract your token manually:

1. Open [web.plaud.ai](https://web.plaud.ai/file/) and log in
2. Press **F12** to open Developer Tools → **Console** tab
3. Paste and run:

```javascript
(function(){var t='';for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i),v=localStorage.getItem(k);var m=v.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);if(m){t=m[0];break}}if(t){prompt('Your PLAUD token (Ctrl+C to copy):',t)}else{alert('No token found. Make sure you are logged in.')}})()
```

4. Copy the token and either:
   - Set it as `PLAUD_TOKEN` in your config
   - Save it to `~/.plaud/token`

## Usage

Once authenticated, use natural prompts or call tools directly.

### List files

```
Show me my PLAUD recordings
```

Or directly:

```
Call MCP tool plaud_list_files with arguments {"limit":10}
```

### Get transcript and summary

```
Pull the transcript for my latest recording
```

Or directly:

```
Call MCP tool plaud_get_file_data with arguments {"file_id":"<YOUR_FILE_ID>","include_transcript":true,"include_summary":true}
```

### Tool Parameters

**plaud_list_files:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 50 | Number of results (1–200) |
| skip | integer | 0 | Pagination offset |
| query | string | — | Substring filter on title or file ID |
| is_trash | integer | 2 | 0=active, 1=trash, 2=all |
| only_transcribed | boolean | false | Return only transcribed files |
| only_summarized | boolean | false | Return only summarised files |

**plaud_get_file_data:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| file_id | string | *(required)* | PLAUD file ID |
| include_transcript | boolean | true | Include transcript text |
| include_transcript_segments | boolean | false | Include segment array with timing |
| include_summary | boolean | true | Include summary content |
| max_transcript_chars | integer | — | Truncate transcript to N chars |

**plaud_auth_browser:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| open_browser | boolean | true | Auto-open auth page in default browser |
| port | integer | 0 (auto) | Local server port (1024–65535) |
| timeout_ms | integer | 120000 | Auth timeout in ms (10s–5min) |
| persist | boolean | true | Save token to ~/.plaud/token |

## Troubleshooting

### Tool not found
- Verify the server is registered: check your MCP config or run `claude mcp get plaud-local`
- Restart your MCP client

### Cannot capture token
- Make sure you are logged in at [web.plaud.ai](https://web.plaud.ai/file/)
- Try increasing `timeout_ms` to `180000`
- Use the manual token extraction method
- On Windows, ensure your browser allows localhost connections

### Missing PLAUD token
- Run `plaud_auth_browser` first
- Or set `PLAUD_TOKEN` environment variable in your config

### Empty file list
- Confirm your PLAUD account has files at web.plaud.ai
- Retry `plaud_list_files` without filters
- Your token may have expired — delete `~/.plaud/token` and re-authenticate

### Token expired
- Delete the persisted token:
  - **Windows:** `del %USERPROFILE%\.plaud\token`
  - **macOS/Linux:** `rm ~/.plaud/token`
- Re-run the auth flow

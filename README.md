[English](#) | [简体中文](./README.zh-Hans.md)

# EasyEDA API Skill

An EasyEDA Pro API skill package for AI coding tools such as Claude Code, OpenCode, QwenCode, and any other tool that supports the [Agent Skills](https://agentskills.io/) standard.

This skill supports both online debugging of EasyEDA Pro through AI and extension development for EasyEDA Pro.
When developing EasyEDA extensions, AI can use the extension-development documentation, API references, type information, usage examples, and bridge debugging capabilities provided by this skill to help with API lookup, code generation, and integration debugging.
If you want to analyze or modify EasyEDA document source files directly instead of operating through the API, this project also provides documentation for the source file formats.

- 📚 **Structured API documentation** — Automatically builds hierarchical indexes from reference docs for fast AI lookup
- 🧾 **Document source format specifications** — Explains project, schematic, and PCB source formats for direct source analysis and modification
- 🔌 **WebSocket Bridge** — A Node.js server that bridges AI tools and the EasyEDA client
- 🤖 **SKILL.md** — A complete skill instruction file

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Build API documentation

```bash
npm run build:docs
```

This reads the raw API documentation from the `reference/` directory and generates structured docs into the `docs/` directory.

### 3. Start the WebSocket Bridge server

```bash
npm run server
```

The server automatically chooses an available port in the `49620-49629` range and waits for the EasyEDA client to connect.

### 4. Connect from EasyEDA

Install the `run-api-gateway.eext` extension in EasyEDA. Download:

- https://jlcext.com/item/oshwhub-official/run-api-gateway

After the extension is loaded, it connects to the Bridge server automatically by scanning the port range and verifying the handshake.

### 5. Use from an AI coding tool

AI coding tools such as Claude Code, OpenCode, and QwenCode automatically read `SKILL.md` for instructions, then use the HTTP API to send code to EasyEDA:

```bash
# Check EasyEDA connection status (assuming the service is on port 49620)
curl http://localhost:49620/health

# Execute EasyEDA code
curl -X POST http://localhost:49620/execute \
  -H "Content-Type: application/json" \
  -d '{"code": "return await eda.dmt_Project.getCurrentProjectInfo();"}'
```

## Change Events

The bridge can relay unsolicited notifications from the EDA client — a document
saved, a selection changed, a DRC run finished — to anything watching, so a
daemon does not have to poll the client for state.

An EDA client sends:

```json
{ "type": "event", "event": "document-saved", "docId": "…", "timestamp": 1700000000000 }
```

The bridge stamps the originating `windowId` on it and fans it out unchanged to
every connected agent WebSocket and every open `/events` stream. It does not
interpret the event name or payload, so new event types need no server change.

**Detecting support** — `GET /health` lists the optional features the running
bridge provides:

```json
{ "service": "easyeda-bridge", "status": "ok", "capabilities": ["events"], "…": "…" }
```

Check for `"events"` in `capabilities` rather than probing `/events` and reading
a `404`, which cannot distinguish an older bridge from a transient error. The
field is always present, whatever the authentication settings, and older bridges
simply omit it — treat a missing `capabilities` as an empty list.

**Subscribing over HTTP** — `GET /events` is a
[Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events)
stream:

```bash
curl -N http://localhost:49620/events
```

```text
event: document-saved
data: {"type":"event","event":"document-saved","docId":"…","windowId":"abc-123","timestamp":1700000000000}
```

SSE rather than long-polling: it is one connection that stays open, so there is
no gap between polls in which an event can be missed and no cursor bookkeeping
on either side; it is plain HTTP on the port that already exists, so it passes
through the same reverse proxy as everything else; browsers reconnect
automatically via `EventSource`; and `curl -N` is enough for a shell-based
agent. Long-polling would have required a per-subscriber queue in the bridge to
cover the interval between requests.

Notes:

- Delivery is **live-only and best effort** — there is no buffer and no replay,
  so a subscriber sees only events that arrive while it is connected.
- A keep-alive comment is sent every 25s to stop idle proxies closing the
  stream, and the response carries `X-Accel-Buffering: no`. Reverse proxies must
  not buffer this route (`proxy_buffering off;` in nginx).
- **This depends on EDA-side support.** The bridge is ready for `event`
  messages, but they only appear if the installed extension emits them; with an
  extension that does not, `/events` simply stays quiet.

## Bridge Server Configuration

The bridge server is configured through environment variables. **Every variable
is optional**, and the defaults reproduce the server's original behaviour, so
`npm run server` with a clean environment works exactly as before.

| Variable | Default | Why you would change it |
|----------|---------|--------------------------|
| `BRIDGE_HOST` | `127.0.0.1` | Interface to bind. Keep the loopback default unless you deliberately expose the bridge — it executes arbitrary JavaScript inside the EDA client, so anyone who can reach it controls the client. |
| `BRIDGE_PORT` | *(unset — scan `49620-49629`)* | Pin a fixed port when something else must know the address up front (a reverse proxy, a firewall rule, a container port mapping). When set, the server binds **exactly** that port and exits with an error if it is taken, instead of silently moving to another port. |
| `BRIDGE_TIMEOUT_MS` | `30000` | How long to wait for the EDA client to answer an `execute` request. Raise it for long-running operations — generating a 3D/STEP model or a full manufacturing export of a large board can take several minutes and will otherwise fail with a timeout. |
| `BRIDGE_MAX_PAYLOAD_MB` | `100` | Maximum WebSocket frame size (100 MB is the `ws` library default). Raise it when a single result is large — a base64-encoded 3D model or gerber archive can exceed 100 MB, and the socket then dies with `Max payload size exceeded`. |
| `BRIDGE_IPV6_LOOPBACK` | on for a loopback `BRIDGE_HOST`, off otherwise | Also listen on `[::1]` and forward to the main listener. **Symptom this fixes:** on Windows the EasyEDA client (Electron) resolves `localhost` to `::1` first; a server bound only to `127.0.0.1` is invisible to it and the extension reports *"Bridge not found"* even though `curl http://127.0.0.1:<port>/health` works. Set to `0` to disable, `1` to force it on. |

Booleans accept `1/0`, `true/false`, `yes/no`, `on/off`.

Example — a long-running export session on a pinned port:

```bash
BRIDGE_PORT=49620 BRIDGE_TIMEOUT_MS=600000 BRIDGE_MAX_PAYLOAD_MB=1024 npm run server
```

## One-Command Packaging

```bash
npm run pack
```

This performs the following steps:
1. Build API documentation (`docs/`)
2. Package `SKILL.md`, documentation, and the server into `dist/easyeda-api/`
3. Generate `dist/easyeda-api.zip` for upload

If the documentation has already been built, you can skip that step:

```bash
npm run pack:fast
```

### Publish to ClawHub

```bash
npx clawhub@latest publish dist/easyeda-api/
```

Or upload the zip file at https://clawhub.ai/upload

## Architecture

```text
┌──────────────┐   HTTP/WS     ┌────────────────┐   WebSocket    ┌──────────┐
│   AI Agent   │ ◄───────────► │ Bridge Server  │ ◄───────────► │  EasyEDA │
│ (Skill Tool) │  Port Range   │   (Node.js)    │  Port Range   │ (Client) │
└──────────────┘  49620-49629   └────────────────┘  49620-49629   └──────────┘
```

## Communication Protocol

| Message Type | Direction | Description |
|--------------|-----------|-------------|
| `execute` | AI → EDA | Execute JavaScript code |
| `result` | EDA → AI | Return execution result |
| `error` | EDA → AI | Return execution error |
| `handshake` | Server → Client | Connection verification (includes `service: "easyeda-bridge"`) |
| `ping/pong` | Bidirectional | Heartbeat |

## Directory Structure

```text
easyeda-api-skill/
  SKILL.md              # AgentSkills standard skill definition
  AGENTS.md             # Agent prompt guide
  package.json          # Project configuration
  reference/            # Raw API reference docs (gitignored)
  docs/                 # Built structured docs (gitignored)
  format/               # EasyEDA document source format specs (project/schematic/pcb)
  guide/                # API development guides
  user-guide/           # User guides
  server/index.mjs      # WebSocket Bridge server
  scripts/
    build-docs.mjs      # Documentation build script
    pack.mjs            # Packaging script
  dist/                 # Packaging output (gitignored)
    easyeda-api/        # Publishable skill directory
    easyeda-api.zip     # Zip archive for ClawHub upload
```
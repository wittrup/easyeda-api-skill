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

### Execution Mode

`POST /execute` accepts an optional `mode` field, `"read"` or `"write"`
(default `"write"`, i.e. the previous behaviour):

```bash
curl -X POST http://localhost:49620/execute \
  -H "Content-Type: application/json" \
  -d '{"mode": "read", "code": "return await eda.dmt_Project.getCurrentProjectInfo();"}'
```

The bridge only forwards the value verbatim in the `execute` message it sends
to the EDA client — **enforcement happens in the EDA extension**, which refuses
mutating APIs in read mode. Sending `"read"` is therefore a request, not a
guarantee, and an older extension that does not know the field will simply
ignore it. Any value other than `read` or `write` is rejected with `400`.

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
| `BRIDGE_AUTH_TOKEN` | *(unset — no authentication)* | Shared secret required on every HTTP route except `GET /health`, and on every WebSocket connection. Leave unset for the usual local setup; **set it whenever the bridge is reachable from anything but the local machine.** See [Security](#security). |

Booleans accept `1/0`, `true/false`, `yes/no`, `on/off`.

Example — a long-running export session on a pinned port:

```bash
BRIDGE_PORT=49620 BRIDGE_TIMEOUT_MS=600000 BRIDGE_MAX_PAYLOAD_MB=1024 npm run server
```

### Authentication

Setting `BRIDGE_AUTH_TOKEN` turns on bearer-token authentication. With the
variable unset nothing changes — no credential is checked anywhere.

When it is set:

- **HTTP routes** require `Authorization: Bearer <token>` and answer `401`
  otherwise.
- **`GET /health` stays open** so port discovery and health probes keep working
  without a credential. Its JSON gains `"authRequired": true`; the token itself
  is never exposed.
- **Agent WebSocket connections** (`ws://…/agent`) send the same
  `Authorization: Bearer <token>` header on the upgrade request. An
  unauthenticated upgrade is rejected with `401` before the socket opens.
- **EDA client WebSocket connections** (`ws://…/eda`) authenticate in-band,
  because the extension uses the browser WebSocket API and cannot set request
  headers. The `register` message carries the token:

  ```json
  { "type": "register", "windowId": "…", "token": "…", "timestamp": 1700000000000 }
  ```

  On success the server replies `{ "type": "registered", "windowId": "…" }`. On
  a missing or wrong token it replies `{ "type": "error", "error": "auth-failed" }`
  and closes the socket; the client is never registered. The server's
  `handshake` message includes `"authRequired": true` so a client knows a token
  is expected before it registers.

Tokens are compared in constant time. Generate one with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

```bash
# server
BRIDGE_AUTH_TOKEN=$MY_TOKEN npm run server

# client
curl -H "Authorization: Bearer $MY_TOKEN" \
     -X POST http://127.0.0.1:49620/execute \
     -H "Content-Type: application/json" \
     -d '{"code": "return await eda.dmt_Project.getCurrentProjectInfo();"}'
```

## Security

**The bridge executes arbitrary JavaScript inside the user's EDA client.**
Anyone who can open a connection to it can read, modify, and export the user's
projects. Treat reachability of the bridge port as equivalent to control of the
EDA client.

- The default bind is `127.0.0.1`. Keep it there whenever you can.
- If the bridge must be reachable from another machine, a token **and**
  transport encryption are both mandatory: `BRIDGE_AUTH_TOKEN` alone sends the
  secret in cleartext over plain HTTP/WS, where it can be captured and replayed.
- The recommended layout is to leave the bridge on loopback and put a reverse
  proxy (nginx, Caddy, Traefik, …) in front of it that terminates TLS and
  forwards to `127.0.0.1:<port>`, so clients connect over `https://` and
  `wss://`. Prefer this over setting `BRIDGE_HOST=0.0.0.0`, which exposes the
  raw, unencrypted port on every interface.
- Better still, put the remote hop on a private overlay network or an SSH
  tunnel and let the bridge see only loopback traffic.
- Keep the token out of shell history, source control and URLs — pass it
  through the environment or a secrets file, and send it in the `Authorization`
  header, never as a query parameter.

The server prints a warning at startup if it binds a non-loopback address with
authentication disabled.

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
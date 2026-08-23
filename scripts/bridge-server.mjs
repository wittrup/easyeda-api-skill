/**
 * EasyEDA WebSocket Bridge Server
 *
 * 这是一个 Node.js WebSocket 服务端，用于桥接 AI 编程工具和 EasyEDA Pro 客户端。
 * 支持所有兼容 Agent Skills 标准的工具（Claude Code、OpenCode、QwenCode 等）。
 *
 * 架构：
 *   ┌──────────────┐   HTTP/WS     ┌────────────────┐   WebSocket    ┌──────────┐
 *   │   AI Agent    │ ◄───────────► │  Bridge Server  │ ◄───────────► │  EasyEDA  │
 *   │  (Skill Tool) │  Port Range   │  (This Server)  │  Port Range   │  (Client) │
 *   └──────────────┘  49620-49629   └────────────────┘  49620-49629   └──────────┘
 *
 * 端口范围 49620-49629，启动时自动检测可用端口。
 * EasyEDA 扩展通过 eda.sys_WebSocket.register() 连接到此服务。
 * AI 通过 HTTP API 或直接 WebSocket 发送代码执行请求。
 *
 * 握手验证协议：
 * - GET /health 返回 { service: "easyeda-bridge", ... }
 * - WebSocket 连接后服务端发送 { type: "handshake", service: "easyeda-bridge" }
 * - 客户端需验证 service 字段匹配后才确认连接有效
 *
 * 协议格式（JSON）：
 * {
 *   "type": "execute" | "result" | "error" | "ping" | "pong" | "handshake",
 *   "id": "<request-uuid>",
 *   "code": "<js code string>",           // execute 时
 *   "result": <any>,                       // result 时
 *   "error": "<error message>",            // error 时
 *   "timestamp": <unix ms>
 * }
 */

import { WebSocketServer } from 'ws';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, get as httpGet } from 'node:http';
import { createConnection, createServer as createTcpServer, connect as tcpConnect } from 'node:net';

// ─── Port Configuration ─────────────────────────────────────────────
const PORT_START = 49620;
const PORT_END = 49629;
const SERVICE_ID = 'easyeda-bridge';

// ─── Environment configuration ──────────────────────────────────────
// Every option below defaults to the historical behaviour, so running the
// server with no environment variables set behaves exactly as before.
// See the "Bridge server configuration" section of the README.

/**
 * Read a positive integer from the environment.
 * @param {string} name Environment variable name
 * @param {number|null} fallback Value used when unset/blank
 * @returns {number|null}
 */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`❌ ${name} must be a positive number (got "${raw}")`);
    process.exit(1);
  }
  return value;
}

/**
 * Read a boolean from the environment ("1"/"true"/"yes"/"on" and negations).
 * @param {string} name Environment variable name
 * @param {boolean} fallback Value used when unset/blank
 * @returns {boolean}
 */
function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  console.error(`❌ ${name} must be a boolean (got "${raw}")`);
  process.exit(1);
}

/**
 * Whether a host string refers to the local machine only.
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

/** Interface the HTTP server binds to. */
const LISTEN_HOST = process.env.BRIDGE_HOST?.trim() || '127.0.0.1';

/** Fixed port, or null to scan PORT_START..PORT_END for a free one. */
const FIXED_PORT = envInt('BRIDGE_PORT', null);

/**
 * Host used for outgoing probes (singleton detection, port-in-use checks).
 * A wildcard bind address cannot be connected to, so probe loopback instead.
 */
const PROBE_HOST = (LISTEN_HOST === '0.0.0.0' || LISTEN_HOST === '::' || LISTEN_HOST === '[::]')
  ? '127.0.0.1'
  : LISTEN_HOST;

/**
 * How long to wait for the EDA client to answer an execute request.
 * Manufacturing exports (e.g. generating a STEP model of a large board) can
 * take several minutes — raise this when driving such operations.
 */
const REQUEST_TIMEOUT_MS = envInt('BRIDGE_TIMEOUT_MS', 30_000);

/**
 * Maximum WebSocket frame size. 100 MiB matches the `ws` default; large
 * base64-encoded exports (3D models, full gerber sets) can exceed it and kill
 * the socket with "Max payload size exceeded".
 */
const MAX_PAYLOAD_BYTES = envInt('BRIDGE_MAX_PAYLOAD_MB', 100) * 1024 * 1024;

/**
 * Additionally listen on the IPv6 loopback and forward to the main listener.
 * EasyEDA runs on Electron, which on Windows resolves "localhost" to `::1`
 * first; a server bound only to 127.0.0.1 is then invisible to it and the
 * extension reports "Bridge not found". Only meaningful for loopback binds,
 * so it is enabled by default there and off for a non-loopback host.
 */
const IPV6_LOOPBACK = envBool('BRIDGE_IPV6_LOOPBACK', isLoopbackHost(LISTEN_HOST));

// ─── Authentication ─────────────────────────────────────────────────
// Unset BRIDGE_AUTH_TOKEN = no authentication, exactly as before. Set it to
// require a shared secret on every HTTP route (except GET /health) and on
// every WebSocket connection. Mandatory whenever the bridge is reachable from
// anywhere but the local machine — it executes arbitrary JavaScript inside the
// user's EDA client.
const AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN?.trim() || null;
const AUTH_REQUIRED = AUTH_TOKEN !== null;

/**
 * Compare a candidate secret against the configured token without leaking
 * timing information about how many characters matched.
 * @param {string|null|undefined} candidate
 * @returns {boolean}
 */
function tokenIsValid(candidate) {
  if (!AUTH_REQUIRED) return true;
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(AUTH_TOKEN, 'utf8');
  // timingSafeEqual throws on differing lengths; a length mismatch is already
  // observable from the request itself, so short-circuit before comparing.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Extract the credential from an `Authorization: Bearer <token>` header.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
function bearerToken(req) {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function formatBannerLine(label, value) {
  return `║  ${`${label}:`.padEnd(12)} ${String(value).padEnd(44)}║`;
}

// ─── State ──────────────────────────────────────────────────────────
/** @type {Map<string, import('ws').WebSocket>} EDA window ID -> WebSocket */
const edaClients = new Map();

/** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
const pendingRequests = new Map();

/** @type {string | null} 当前AI端选中的EDA窗口ID */
let activeEdaWindowId = null;

// ─── Port Detection ─────────────────────────────────────────────────

/**
 * Check if a TCP port is already in use.
 * @param {number} port
 * @returns {Promise<boolean>} true if port is in use
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: PROBE_HOST });
    socket.setTimeout(300);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Check if a port is already running our bridge service.
 * Sends HTTP GET /health and verifies { service: "easyeda-bridge" }.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isBridgeRunning(port) {
  return new Promise((resolve) => {
    const host = PROBE_HOST.includes(':') && !PROBE_HOST.startsWith('[') ? `[${PROBE_HOST}]` : PROBE_HOST;
    const req = httpGet(`http://${host}:${port}/health`, { timeout: 800 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.service === SERVICE_ID);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Detect if an existing bridge instance is already running.
 * With BRIDGE_PORT set only that port is checked, otherwise the whole range.
 * @returns {Promise<number|null>} The port of the existing instance, or null
 */
async function findExistingInstance() {
  if (FIXED_PORT !== null) {
    return (await isBridgeRunning(FIXED_PORT)) ? FIXED_PORT : null;
  }
  for (let port = PORT_START; port <= PORT_END; port++) {
    if (await isBridgeRunning(port)) return port;
  }
  return null;
}

/**
 * Pick the port to listen on: the one pinned by BRIDGE_PORT, or the first
 * free port in the default range.
 * @returns {Promise<number>}
 */
async function findAvailablePort() {
  if (FIXED_PORT !== null) {
    if (await isPortInUse(FIXED_PORT)) {
      throw new Error(`BRIDGE_PORT=${FIXED_PORT} is already in use by another process`);
    }
    return FIXED_PORT;
  }
  for (let port = PORT_START; port <= PORT_END; port++) {
    const inUse = await isPortInUse(port);
    if (!inUse) return port;
  }
  throw new Error(`All ports in range ${PORT_START}-${PORT_END} are in use`);
}

// ─── HTTP Server (for AI to submit code via HTTP POST) ─────────────
const httpServer = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check — includes service identifier for client handshake verification
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: SERVICE_ID,
      status: 'ok',
      edaConnected: edaClients.size > 0,
      edaWindowCount: edaClients.size,
      activeWindowId: activeEdaWindowId,
      pendingRequests: pendingRequests.size,
      // Advertise the requirement so clients know to present a token.
      // Never expose the token itself.
      authRequired: AUTH_REQUIRED,
      timestamp: Date.now(),
    }));
    return;
  }

  // Every other route requires the bearer token when authentication is on.
  if (AUTH_REQUIRED && !tokenIsValid(bearerToken(req))) {
    console.warn(`[HTTP] 401 ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="easyeda-bridge"',
    });
    res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid bearer token' }));
    return;
  }

  // List all connected EDA windows
  if (req.method === 'GET' && req.url === '/eda-windows') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const windows = [];
    for (const [windowId, ws] of edaClients) {
      windows.push({
        windowId,
        connected: ws.readyState === 1,
        active: windowId === activeEdaWindowId,
      });
    }
    res.end(JSON.stringify({
      windows,
      activeWindowId: activeEdaWindowId,
      count: edaClients.size,
    }));
    return;
  }

  // Set active EDA window
  if (req.method === 'POST' && req.url === '/eda-windows/select') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const payload = JSON.parse(body);
      const { windowId } = payload;
      if (!edaClients.has(windowId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `EDA window "${windowId}" not found` }));
        return;
      }
      activeEdaWindowId = windowId;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, activeWindowId }));
    }
    catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  // Execute code on EDA
  if (req.method === 'POST' && req.url === '/execute') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const payload = JSON.parse(body);
      const code = payload.code;
      const windowId = payload.windowId; // optional, uses active window if not specified
      const mode = payload.mode ?? 'write'; // optional, "read" | "write"
      if (!code || typeof code !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "code" field (string)' }));
        return;
      }
      if (mode !== 'read' && mode !== 'write') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '"mode" must be "read" or "write"' }));
        return;
      }

      const result = await executeOnEda(code, windowId, mode);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result, windowId: windowId || activeEdaWindowId }));
    } catch (err) {
      const status = err.message?.includes('not connected') ? 503 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── WebSocket Server ───────────────────────────────────────────────
// Agent sockets authenticate with an `Authorization: Bearer <token>` header on
// the upgrade request, which is rejected before the connection is established.
// EDA client sockets cannot set headers (the extension uses the browser
// WebSocket API), so they authenticate in-band via the `register` message.
const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: MAX_PAYLOAD_BYTES,
  verifyClient: ({ req }, done) => {
    if (!AUTH_REQUIRED || req.url === '/eda') return done(true);
    if (tokenIsValid(bearerToken(req))) return done(true);
    console.warn(`[WS] Rejected unauthenticated agent connection from ${req.socket.remoteAddress}`);
    done(false, 401, 'Unauthorized');
  },
});

wss.on('connection', (ws, req) => {
  const clientType = req.url === '/eda' ? 'eda' : 'agent';
  console.log(`[WS] New ${clientType} connection from ${req.socket.remoteAddress}`);

  // Send handshake message for client verification
  ws.send(JSON.stringify({
    type: 'handshake',
    service: SERVICE_ID,
    clientType,
    // Tells the EDA client whether its `register` message must carry a token.
    authRequired: AUTH_REQUIRED,
    timestamp: Date.now(),
  }));

  if (clientType === 'eda') {
    let registeredWindowId = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register' && msg.windowId) {
          // EDA client registering with window ID
          if (AUTH_REQUIRED && !tokenIsValid(msg.token)) {
            console.warn(`[WS] EDA registration rejected (auth) from ${req.socket.remoteAddress}`);
            ws.send(JSON.stringify({ type: 'error', error: 'auth-failed', timestamp: Date.now() }));
            ws.close(1008, 'auth-failed');
            return;
          }
          registeredWindowId = msg.windowId;
          edaClients.set(registeredWindowId, ws);
          // Auto-select if first window or if no active window
          if (edaClients.size === 1 || !activeEdaWindowId) {
            activeEdaWindowId = registeredWindowId;
          }
          console.log(`[WS] EDA window registered: ${registeredWindowId}, total: ${edaClients.size}`);
          ws.send(JSON.stringify({ type: 'registered', windowId: registeredWindowId, timestamp: Date.now() }));
          return;
        }
        // With authentication on, nothing is accepted before a valid register.
        if (AUTH_REQUIRED && !registeredWindowId) {
          ws.send(JSON.stringify({ type: 'error', error: 'auth-failed', timestamp: Date.now() }));
          ws.close(1008, 'auth-failed');
          return;
        }
        // Always pass a valid windowId (use registeredWindowId if available, otherwise log warning)
        const effectiveWindowId = registeredWindowId || 'unregistered';
        handleEdaMessage(msg, effectiveWindowId);
      } catch (err) {
        console.error('[WS] Failed to parse EDA message:', err.message);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`[WS] EDA window disconnected: ${registeredWindowId} (${code} ${reason})`);
      if (registeredWindowId) {
        edaClients.delete(registeredWindowId);
        if (activeEdaWindowId === registeredWindowId) {
          // Select another window if available
          activeEdaWindowId = edaClients.keys().next().value || null;
        }
        // Reject pending requests for this window
        for (const [id, req] of pendingRequests) {
          if (req.windowId === registeredWindowId) {
            clearTimeout(req.timer);
            req.reject(new Error(`EDA window "${registeredWindowId}" disconnected`));
            pendingRequests.delete(id);
          }
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] EDA client error:', err.message);
    });
  } else {
    // Agent / AI client connection
    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'execute') {
          try {
            const result = await executeOnEda(msg.code, msg.windowId, msg.mode === 'read' ? 'read' : 'write');
            ws.send(JSON.stringify({
              type: 'result',
              id: msg.id,
              result,
              timestamp: Date.now(),
            }));
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'error',
              id: msg.id,
              error: err.message,
              timestamp: Date.now(),
            }));
          }
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', id: msg.id, timestamp: Date.now() }));
        }
      } catch (err) {
        console.error('[WS] Failed to parse agent message:', err.message);
      }
    });

    ws.on('close', () => {
      console.log('[WS] Agent client disconnected');
    });
  }
});

// ─── Core logic ─────────────────────────────────────────────────────

/**
 * Send a message to the connected EDA client
 * @param {string} windowId - Target EDA window ID
 * @param {object} msg - Message to send
 */
function sendToEda(windowId, msg) {
  const edaClient = edaClients.get(windowId);
  if (!edaClient) {
    throw new Error(`EDA window "${windowId}" not found in connected clients`);
  }
  if (edaClient.readyState !== 1) {
    throw new Error(`EDA window "${windowId}" is not in connected state (readyState: ${edaClient.readyState})`);
  }
  try {
    edaClient.send(JSON.stringify(msg));
  } catch (err) {
    throw new Error(`Failed to send to EDA window "${windowId}": ${err.message}`);
  }
}

/**
 * Execute JavaScript code on the EDA client and return the result
 * @param {string} code - JavaScript code to execute in EDA context
 * @param {string} [windowId] - Specific EDA window ID (uses active window if not specified)
 * @param {'read'|'write'} [mode] - Requested access level, forwarded to the EDA
 *   client, which is what actually enforces read-only. The bridge only relays it.
 * @returns {Promise<any>}
 */
function executeOnEda(code, windowId, mode = 'write') {
  return new Promise((resolve, reject) => {
    const targetWindowId = windowId || activeEdaWindowId;

    if (!targetWindowId) {
      reject(new Error('No EDA window connected. Please connect an EDA window first.'));
      return;
    }

    if (!edaClients.has(targetWindowId) || edaClients.get(targetWindowId).readyState !== 1) {
      reject(new Error(`EDA window "${targetWindowId}" is no longer connected. Please select another window.`));
      return;
    }

    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timer, windowId: targetWindowId });

    try {
      sendToEda(targetWindowId, {
        type: 'execute',
        id,
        code,
        mode,
        windowId: targetWindowId,
        timestamp: Date.now(),
      });
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(err);
    }
  });
}

/**
 * Handle messages received from EDA client
 * @param {object} msg - Message from EDA
 * @param {string} windowId - EDA window ID that sent the message
 */
function handleEdaMessage(msg, windowId) {
  if (msg.type === 'ping') {
    console.log(`[WS] Ping received from ${windowId}, sending pong`);
    const edaClient = edaClients.get(windowId);
    if (edaClient && edaClient.readyState === 1) {
      try {
        edaClient.send(JSON.stringify({
          type: 'pong',
          id: msg.id,
          timestamp: Date.now(),
        }));
      } catch (err) {
        console.error(`[WS] Failed to send pong to ${windowId}:`, err.message);
      }
    } else {
      console.warn(`[WS] Cannot send pong: window ${windowId} not found or disconnected`);
    }
    return;
  }

  if (msg.type === 'pong') {
    console.log('[EDA] Pong received from window', windowId, '- connection healthy');
    return;
  }

  if (msg.type === 'result' || msg.type === 'error') {
    const pending = pendingRequests.get(msg.id);
    if (pending) {
      clearTimeout(pending.timer);
      pendingRequests.delete(msg.id);
      if (msg.type === 'result') {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error || 'Unknown EDA error'));
      }
    }
    return;
  }

  console.log('[EDA] Unknown message type:', msg.type, 'from window:', windowId);
}

// ─── Start ──────────────────────────────────────────────────────────

/**
 * Optionally also accept connections on the IPv6 loopback and forward them to
 * the main listener.
 *
 * Why: EasyEDA is an Electron app, and on Windows Electron resolves
 * "localhost" to `::1` before trying `127.0.0.1`. A server bound only to the
 * IPv4 loopback is invisible to it and the extension reports "Bridge not
 * found". Forwarding keeps the service loopback-only while answering on both
 * families. Controlled by BRIDGE_IPV6_LOOPBACK.
 *
 * @param {number} port Port the main listener is bound to
 */
function startIpv6LoopbackForwarder(port) {
  if (!IPV6_LOOPBACK) return;
  // Nothing to forward if the main listener already answers on IPv6.
  const bound = LISTEN_HOST.replace(/^\[|\]$/g, '');
  if (bound === '::1' || bound === '::') return;

  const forwarder = createTcpServer((sock) => {
    const upstream = tcpConnect(port, PROBE_HOST);
    sock.pipe(upstream);
    upstream.pipe(sock);
    sock.on('error', () => upstream.destroy());
    upstream.on('error', () => sock.destroy());
  });
  forwarder.on('error', (err) => console.log('[ipv6] loopback forwarder disabled:', err.code));
  forwarder.listen(port, '::1', () => console.log(`[ipv6] also listening on [::1]:${port}`));
}

async function start() {
  try {
    // ── Singleton check: exit if an identical bridge is already running ──
    const existingPort = await findExistingInstance();
    if (existingPort) {
      console.log(`✅ Bridge server is already running on port ${existingPort}, no need to start another instance.`);
      process.exit(0);
    }

    const port = await findAvailablePort();

    httpServer.listen(port, LISTEN_HOST, () => {
      console.log(`
╔══════════════════════════════════════════════════════════════╗
║         EasyEDA WebSocket Bridge Server                      ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
${formatBannerLine('Port', FIXED_PORT !== null ? `${port} (pinned by BRIDGE_PORT)` : port)}
${formatBannerLine('Listen Host', `${LISTEN_HOST}${isLoopbackHost(LISTEN_HOST) ? ' (localhost only)' : ''}`)}
${formatBannerLine('Port Range', FIXED_PORT !== null ? 'n/a (fixed port)' : `${PORT_START}-${PORT_END}`)}
${formatBannerLine('Timeout', `${REQUEST_TIMEOUT_MS} ms`)}
${formatBannerLine('Max Payload', `${MAX_PAYLOAD_BYTES / 1024 / 1024} MB`)}
${formatBannerLine('Auth', AUTH_REQUIRED ? 'bearer token required' : 'disabled (no token set)')}
${formatBannerLine('Service ID', SERVICE_ID)}
║                                                              ║
║  HTTP API:    http://localhost:${port}                         ║
║  WS (EDA):   ws://localhost:${port}/eda                       ║
║  WS (Agent): ws://localhost:${port}/agent                     ║
║                                                              ║
║  Endpoints:                                                  ║
║    GET  /health     - 健康检查 & EDA 连接状态                ║
║    POST /execute    - 执行代码 {"code": "..."}               ║
║                                                              ║
║  Handshake:                                                  ║
║    /health returns { service: "${SERVICE_ID}" }       ║
║    WS sends { type: "handshake", service: "..." }            ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
      `);
    });

    if (!isLoopbackHost(LISTEN_HOST) && !AUTH_REQUIRED) {
      console.warn(
        `⚠️  Listening on ${LISTEN_HOST} without authentication. Anyone who can reach this\n` +
        `    port can execute arbitrary JavaScript in the EDA client. Set BRIDGE_AUTH_TOKEN\n` +
        `    and terminate TLS in front of the bridge, or bind to 127.0.0.1 and use a proxy.`,
      );
    }

    startIpv6LoopbackForwarder(port);

    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        if (FIXED_PORT !== null) {
          console.error(`❌ Port ${port} (BRIDGE_PORT) is occupied — refusing to fall back to another port.`);
          process.exit(1);
        }
        console.error(`❌ Port ${port} became occupied. Restarting...`);
        httpServer.close();
        start(); // Retry
      } else {
        throw err;
      }
    });
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

start();

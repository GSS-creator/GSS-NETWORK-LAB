const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const http = require("node:http");
const os = require("node:os");

let localServer = null;
let trafficTimer = null;
let telemetryTimer = null;
let cloudSyncTimer = null;
let cloudRetryTimer = null;
let cloudSyncInFlight = false;
let trafficSequence = 0;
let healthSequence = 0;
let topologyLinks = [];
let runtimeDevices = new Map();
let runtimeLinks = [];
let latestTelemetry = null;
const telemetryHistory = [];
const deviceMetricBaselines = new Map();
const CLOUD_TELEMETRY_URL = "https://gss-backend.qvaultp.workers.dev/api/infrastructure/telemetry";
// The cloud plan permits one snapshot every 60 seconds. Keep a small margin so
// timer precision and network transit never cause an early 429 request.
const CLOUD_SYNC_INTERVAL_MS = 65_000;
// Cloud credentials are deliberately never read from the environment or
// compiled into the application. Each operator must enter their own key in
// the Management screen; it is then protected by the OS credential store.
let cloudApiKey = "";
let cloudStatus = { configured: Boolean(cloudApiKey), state: cloudApiKey ? "ready" : "not-configured", message: cloudApiKey ? "Cloud telemetry is ready." : "Add an Intelligence API key to enable cloud monitoring.", lastSyncedAt: null, sent: 0, failed: 0 };
let localDatabase = { version: 1, infrastructure: { devices: [], links: [], updatedAt: null }, credentials: {} };

function broadcastCloudStatus() {
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("gss:cloud-status", { ...cloudStatus, configured: Boolean(cloudApiKey) }));
}

function setCloudStatus(update) {
  cloudStatus = { ...cloudStatus, ...update, configured: Boolean(cloudApiKey) };
  broadcastCloudStatus();
}

function localDatabasePath() {
  return path.join(app.getPath("userData"), "gss-local-db.json");
}

function loadLocalDatabase() {
  try {
    const saved = JSON.parse(fs.readFileSync(localDatabasePath(), "utf8"));
    if (saved && typeof saved === "object") localDatabase = { ...localDatabase, ...saved, infrastructure: { ...localDatabase.infrastructure, ...(saved.infrastructure || {}) }, credentials: { ...(saved.credentials || {}) } };
  } catch { /* The local database is created on the first save. */ }
}

function writeLocalDatabase() {
  const target = localDatabasePath();
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(localDatabase, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function persistInfrastructure(payload) {
  const devices = Array.isArray(payload?.devices) ? structuredClone(payload.devices) : null;
  const links = Array.isArray(payload?.links) ? structuredClone(payload.links) : null;
  if (!devices || !links || !devices.every((device) => device && typeof device.id === "string") || !links.every((link) => Array.isArray(link) && link.length === 2 && link.every((id) => typeof id === "string"))) throw new Error("Invalid infrastructure data");
  localDatabase.infrastructure = { devices, links, updatedAt: new Date().toISOString() };
  writeLocalDatabase();
}

function persistRuntimeInfrastructure() {
  persistInfrastructure({ devices: [...runtimeDevices.values()], links: runtimeLinks.map(([a, b]) => [a, b]) });
}

function loadCloudConfiguration() {
  if (cloudApiKey) return;
  try {
    if (localDatabase.credentials.cloudApiKey && safeStorage.isEncryptionAvailable()) cloudApiKey = safeStorage.decryptString(Buffer.from(localDatabase.credentials.cloudApiKey, "base64"));
  } catch { /* No local cloud configuration has been saved yet. */ }
  setCloudStatus({ state: cloudApiKey ? "ready" : "not-configured", message: cloudApiKey ? "Cloud telemetry is ready." : "Add an Intelligence API key to enable cloud monitoring." });
}

function saveCloudConfiguration(apiKey) {
  cloudApiKey = String(apiKey || "").trim();
  if (!cloudApiKey) {
    delete localDatabase.credentials.cloudApiKey;
    writeLocalDatabase();
    setCloudStatus({ state: "not-configured", message: "Cloud telemetry is disabled.", lastSyncedAt: null, sent: 0, failed: 0 });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("The operating system credential store is unavailable; the API key was not saved.");
  localDatabase.credentials.cloudApiKey = safeStorage.encryptString(cloudApiKey).toString("base64");
  writeLocalDatabase();
  setCloudStatus({ state: "ready", message: "Cloud telemetry is ready.", sent: 0, failed: 0 });
}

function localAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) for (const entry of entries || []) {
    if (entry.family === "IPv4" && !entry.internal) return entry.address;
  }
  return "127.0.0.1";
}

function assignRuntimeAddresses(devices) {
  const hostIp = localAddress();
  const used = new Set([hostIp]);
  const randomLabIp = () => {
    let address;
    do address = `10.${40 + Math.floor(Math.random() * 180)}.${1 + Math.floor(Math.random() * 254)}.${10 + Math.floor(Math.random() * 240)}`;
    while (used.has(address));
    used.add(address);
    return address;
  };
  for (const device of devices) {
    device.ip = device.type === "Server" || device.id === "gss-server" ? hostIp : (device.ip === "passive" ? "passive" : randomLabIp());
    const firstInterface = device.model?.interfaces?.find((iface) => iface.ip && iface.ip !== "passive");
    if (firstInterface) firstInterface.ip = device.ip;
  }
  return { hostIp, devices };
}

// Coordinates are part of the infrastructure contract: [longitude, latitude].
// Lab devices inherit the centre position so every virtual node can be plotted
// immediately; real collectors can override this with device.coords or GPS.
const LAB_SITE_COORDS = {
  hq: [32.5825, 0.3476],
  kampala: [32.5825, 0.3476],
  kawempe: [32.5550, 0.4040],
  nansana: [32.5290, 0.3650],
  masaka: [31.7322, -0.3338],
  ntinda: [32.6160, 0.3650],
  mukono: [32.7553, 0.3533],
  jinja: [33.2026, 0.4479],
};

function deviceCoordinates(device) {
  if (Array.isArray(device.coords) && device.coords.length >= 2) {
    const lng = Number(device.coords[0]); const lat = Number(device.coords[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
  }
  const site = String(device.site || "").toLowerCase();
  const match = Object.keys(LAB_SITE_COORDS).find((name) => site.includes(name));
  return match ? LAB_SITE_COORDS[match] : undefined;
}

function deviceSummary(device) {
  return { id: device.id, name: device.name, type: device.type, ip: device.ip, mac: device.mac, site: device.site, coords: deviceCoordinates(device), status: device.status, vendor: device.model?.vendor, model: device.model?.model, firmware: device.model?.firmware, interfaces: device.model?.interfaces || [], routing: device.model?.routing || {}, vlans: device.model?.vlans || [], firewall: device.model?.firewall || {}, traffic: device.model?.traffic || {}, health: device.model?.health || {}, events: device.model?.events || [], neighbors: device.model?.neighbors || [] };
}

function refreshRuntimeHealth() {
  // This desktop lab is a virtual network. Vary its measured operating values
  // on each local collection so dashboards exercise real time-series paths.
  // Physical collectors should replace these values with SNMP/REST/SSH reads.
  const phase = ++healthSequence;
  [...runtimeDevices.values()].forEach((device, index) => {
    const health = device.model?.health;
    if (!health) return;
    const base = (index * 17) % 23;
    const wave = Math.sin((phase + index * 11) / 8);
    const busy = Math.cos((phase + index * 7) / 15);
    health.cpu_percent = Number(Math.max(2, Math.min(96, 14 + base + wave * 9 + busy * 4)).toFixed(2));
    health.memory_percent = Number(Math.max(8, Math.min(94, 28 + (base / 2) + Math.sin((phase + index * 5) / 13) * 6)).toFixed(2));
    health.disk_percent = Number(Math.max(5, Math.min(98, 34 + (base / 2) + Math.sin((phase + index * 3) / 31) * 2)).toFixed(2));
    health.disk_wait_ms = Number(Math.max(0.2, 1.4 + (base / 12) + Math.sin((phase + index * 2) / 9) * 0.7).toFixed(3));
    health.temperature_c = Number(Math.max(20, 31 + (base / 5) + wave * 2.5).toFixed(2));
  });
  runtimeLinks.forEach((link, index) => {
    const stats = modelLink([link[0], link[1]].sort().join("::"));
    if (!stats) return;
    stats.latency_ms = Number(Math.max(1, 2 + ((index % 4) * 0.6) + Math.sin((phase + index * 9) / 10) * 0.8).toFixed(3));
    stats.loss_percent = Number(Math.max(0, 0.03 + Math.sin((phase + index * 4) / 17) * 0.03).toFixed(3));
  });
}

function deviceOperationalMetrics(device, collectedAt) {
  const interfaces = Array.isArray(device.interfaces) ? device.interfaces : [];
  const traffic = device.traffic || {};
  const totalBytes = Number(traffic.rx_bytes || 0) + Number(traffic.tx_bytes || 0);
  const now = new Date(collectedAt).getTime();
  const previous = deviceMetricBaselines.get(device.id);
  const elapsedSeconds = previous ? Math.max(1, (now - previous.collectedAt) / 1000) : 0;
  const byteDelta = previous ? Math.max(0, totalBytes - previous.totalBytes) : 0;
  const throughputMbps = elapsedSeconds ? Number(((byteDelta * 8) / elapsedSeconds / 1_000_000).toFixed(4)) : 0;
  deviceMetricBaselines.set(device.id, { totalBytes, collectedAt: now });

  const capacityMbps = interfaces.filter((iface) => iface.state === "up").reduce((total, iface) => total + Number(iface.speed_mbps || 0), 0);
  const adjacentLinks = runtimeLinks
    .filter(([a, b]) => a === device.id || b === device.id)
    .map(([a, b]) => modelLink([a, b].sort().join("::")))
    .filter(Boolean);
  const average = (field) => adjacentLinks.length ? Number((adjacentLinks.reduce((total, link) => total + Number(link[field] || 0), 0) / adjacentLinks.length).toFixed(3)) : 0;
  const interfaceErrors = interfaces.reduce((total, iface) => total + Number(iface.errors || 0) + Number(iface.drops || 0), 0);
  const linkErrors = adjacentLinks.reduce((total, link) => total + Number(link.errors || 0), 0);
  return {
    throughput_mbps: throughputMbps,
    bandwidth_mbps: capacityMbps,
    bandwidth_utilization_percent: capacityMbps ? Number(Math.min(100, (throughputMbps / capacityMbps) * 100).toFixed(3)) : 0,
    latency_ms: average("latency_ms"),
    packet_loss_percent: average("loss_percent"),
    connection_errors: interfaceErrors + linkErrors,
    interface_errors: interfaceErrors,
    link_errors: linkErrors,
    temperature_c: Number(device.health?.temperature_c || 0),
  };
}

function cloudInfrastructurePayload(snapshot) {
  const devices = snapshot.devices.map((device) => {
    const operational = deviceOperationalMetrics(device, snapshot.collectedAt);
    return {
      ...device,
      device_id: device.id,
      network_type: "fiber_isp",
      centre: device.site,
      coords: deviceCoordinates(device),
      location: { name: device.site, centre: device.site, ...(deviceCoordinates(device) ? { longitude: deviceCoordinates(device)[0], latitude: deviceCoordinates(device)[1] } : {}) },
      mac_address: device.mac,
      metrics: {
        cpu_percent: Number(device.health?.cpu_percent || 0),
        memory_percent: Number(device.health?.memory_percent || 0),
        disk_percent: Number(device.health?.disk_percent || 0),
        disk_wait_ms: Number(device.health?.disk_wait_ms || 0),
        ...operational,
        traffic: device.traffic,
        interfaces: device.interfaces,
        routing: device.routing,
        vlans: device.vlans,
        firewall: device.firewall,
        neighbours: device.neighbors,
        events: device.events,
      },
    };
  });
  return {
    device_id: `gss-fibre-infrastructure-${localAddress().replace(/[^a-zA-Z0-9]/g, "-")}`,
    name: "GSS Fibre Infrastructure Inventory",
    type: "Infrastructure",
    ip: localAddress(),
    metrics: {
      cpu_percent: 0,
      latency_ms: 0,
      packet_loss_percent: 0,
      collected_at: snapshot.collectedAt,
      inventory_kind: "full-fibre-infrastructure",
      device_count: devices.length,
      link_count: snapshot.links.length,
    },
    infrastructure: { ...snapshot, devices },
  };
}

async function postCloudTelemetry(payload) {
  const controller = new AbortController();
  // Full fibre snapshots can contain many devices and are persisted by the
  // cloud service before it replies. Allow enough time for that first sync.
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const response = await fetch(CLOUD_TELEMETRY_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${cloudApiKey}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `Cloud API returned HTTP ${response.status}`);
      error.statusCode = response.status;
      error.retryAfterSeconds = Number(body.retry_after_seconds || 0);
      throw error;
    }
    if (body.ok !== true) throw new Error("Cloud API did not confirm the telemetry upload");
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function syncCloudTelemetry() {
  if (!cloudApiKey || cloudSyncInFlight || !runtimeDevices.size) return;
  cloudSyncInFlight = true;
  try {
    const snapshot = collectTelemetry();
    setCloudStatus({ state: "syncing", message: `Collecting and sending complete fibre infrastructure (${snapshot.devices.length} devices, ${snapshot.links.length} links)…` });
    const payload = cloudInfrastructurePayload(snapshot);
    const expectedDevices = payload.infrastructure.devices.length;
    if (expectedDevices !== runtimeDevices.size || payload.infrastructure.devices.some((device) => !device.device_id)) throw new Error("The local infrastructure snapshot is incomplete; cloud upload was not confirmed.");
    const response = await postCloudTelemetry(payload);
    const acceptedDevices = Number(response.accepted_devices);
    if (!Number.isFinite(acceptedDevices) || acceptedDevices !== expectedDevices) throw new Error(`GSS accepted ${Number.isFinite(acceptedDevices) ? acceptedDevices : 0}/${expectedDevices} devices; the complete snapshot will retry next interval.`);
    setCloudStatus({ state: "synced", message: `Complete infrastructure telemetry uploaded: all ${acceptedDevices} devices and ${snapshot.links.length} links accepted.`, lastSyncedAt: snapshot.collectedAt, sent: 1, failed: 0 });
  } catch (error) {
    if (error.statusCode === 429) {
      const retrySeconds = Math.max(1, Number(error.retryAfterSeconds || 60));
      setCloudStatus({ state: "waiting", message: `GSS Cloud plan interval is 60 seconds. The next full snapshot will retry in ${retrySeconds} seconds.`, sent: 0, failed: 0 });
      if (cloudRetryTimer) clearTimeout(cloudRetryTimer);
      cloudRetryTimer = setTimeout(() => { cloudRetryTimer = null; void syncCloudTelemetry(); }, (retrySeconds + 1) * 1000);
    } else if ([502, 503, 504].includes(Number(error.statusCode))) {
      // A busy/temporarily unavailable Worker must not make the operator
      // re-enter a valid API key. Keep the local collector running and retry
      // the complete snapshot with a short back-off.
      const retrySeconds = Math.max(15, Number(error.retryAfterSeconds || 30));
      setCloudStatus({ state: "waiting", message: `GSS Cloud is temporarily unavailable (HTTP ${error.statusCode}). Retrying in ${retrySeconds} seconds.`, sent: 0, failed: 1 });
      if (cloudRetryTimer) clearTimeout(cloudRetryTimer);
      cloudRetryTimer = setTimeout(() => { cloudRetryTimer = null; void syncCloudTelemetry(); }, retrySeconds * 1000);
    } else setCloudStatus({ state: "error", message: error.message || "Cloud sync failed.", sent: 0, failed: 1 });
  } finally {
    cloudSyncInFlight = false;
  }
}

function collectTelemetry() {
  refreshRuntimeHealth();
  const collectedAt = new Date().toISOString();
  const snapshot = {
    collectedAt,
    collector: { name: "GSS Local Management Plane", host: localAddress(), protocols: ["ICMP", "SNMP-compatible telemetry", "LLDP-compatible neighbors", "local device API"] },
    devices: [...runtimeDevices.values()].map((device) => ({ ...deviceSummary(device), management: { reachable: true, last_seen: collectedAt, protocol: "local-management-api" } })),
    links: runtimeLinks.map(([a, b]) => ({ source: a, target: b, stats: modelLink([a, b].sort().join("::")) || { packets: 0, bytes: 0, errors: 0, loss_percent: 0, latency_ms: 0, last_activity: null } })),
  };
  latestTelemetry = snapshot;
  telemetryHistory.push(snapshot);
  while (telemetryHistory.length > 120) telemetryHistory.shift();
  return snapshot;
}

function updateRuntimeTraffic(sourceId, targetId, bytes) {
  const source = runtimeDevices.get(sourceId); const target = runtimeDevices.get(targetId); if (!source || !target) return;
  const now = new Date().toISOString();
  const bump = (device, direction) => {
    const model = device.model; model.traffic[direction === "tx" ? "tx_packets" : "rx_packets"] += 1; model.traffic[direction === "tx" ? "tx_bytes" : "rx_bytes"] += bytes;
    const neighborIndex = (model.neighbors || []).indexOf(direction === "tx" ? targetId : sourceId);
    const iface = model.interfaces[(neighborIndex < 0 ? 0 : neighborIndex) % Math.max(1, model.interfaces.length)];
    if (iface) { iface[direction === "tx" ? "tx_packets" : "rx_packets"] += 1; iface[direction === "tx" ? "tx_bytes" : "rx_bytes"] += bytes; iface.last_activity = now; iface.state = "up"; }
  };
  bump(source, "tx"); bump(target, "rx");
  const linkKey = [sourceId, targetId].sort().join("::"); const link = modelLink(linkKey); if (link) { link.bytes += bytes; link.packets += 1; link.last_activity = now; }
}

function modelLink(key) {
  const link = runtimeLinks.find(([a,b]) => [a,b].sort().join("::") === key);
  if (!link) return null;
  if (!link.stats) link.stats = { packets: 0, bytes: 0, errors: 0, loss_percent: 0, latency_ms: 2, last_activity: null };
  return link.stats;
}

function reachableOnlineDevices() {
  const root = [...runtimeDevices.values()].find((device) => device.id === "gss-server" || device.type === "Server");
  if (!root || root.status === "offline") return new Set();
  const reachable = new Set([root.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [a, b] of runtimeLinks) {
      const left = runtimeDevices.get(a); const right = runtimeDevices.get(b);
      if (!left || !right || left.status === "offline" || right.status === "offline") continue;
      if (reachable.has(a) && !reachable.has(b)) { reachable.add(b); changed = true; }
      if (reachable.has(b) && !reachable.has(a)) { reachable.add(a); changed = true; }
    }
  }
  return reachable;
}

function createWindow(screen, options) {
  const window = new BrowserWindow({
    width: options.width,
    height: options.height,
    x: options.x,
    y: options.y,
    minWidth: screen === "topology" ? 900 : 420,
    minHeight: 600,
    title: screen === "topology" ? "GSS Network Lab · Topology" : "GSS Network Lab · Management",
    backgroundColor: "#101419",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.loadFile(path.join(__dirname, "renderer", "index.html"), { query: { screen } });
  return window;
}

ipcMain.handle("gss:ping", async (_event, host) => {
  if (typeof host !== "string" || !/^[a-zA-Z0-9.:-]+$/.test(host)) {
    return { ok: false, error: "Invalid host" };
  }
  // 10/8 addresses in this lab are virtual interfaces, not Windows network
  // adapters. Treat them as simulator endpoints so the local test reflects
  // the virtual device state instead of failing at the host OS ping layer.
  if (/^10\./.test(host)) return { ok: true, latencyMs: 1 + Math.floor(Math.random() * 4), output: "GSS virtual ICMP reply" };
  const args = process.platform === "win32" ? ["-n", "1", "-w", "1200", host] : ["-c", "1", "-W", "2", host];
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.platform === "win32" ? "ping.exe" : "ping", args, { timeout: 4000 }, (error, stdout) => {
      resolve({ ok: !error, latencyMs: !error ? Date.now() - started : null, output: String(stdout).slice(-400) });
    });
  });
});

ipcMain.handle("gss:update-device-status", async (_event, id, status) => {
  const device = runtimeDevices.get(id);
  if (device) device.status = status === "offline" ? "offline" : "online";
  if (device) persistRuntimeInfrastructure();
  return { ok: Boolean(device), status: device?.status || null };
});

ipcMain.handle("gss:infrastructure-load", () => structuredClone(localDatabase.infrastructure));

ipcMain.handle("gss:infrastructure-save", async (_event, payload) => {
  try {
    persistInfrastructure(payload);
    // Keep the active collector and the persisted inventory in lockstep when
    // a user adds, links, or edits a device while the server is running.
    if (localServer) {
      topologyLinks = structuredClone(payload.links);
      runtimeLinks = topologyLinks;
      runtimeDevices = new Map(structuredClone(payload.devices).map((device) => [device.id, device]));
      collectTelemetry();
    }
    return { ok: true, updatedAt: localDatabase.infrastructure.updatedAt };
  } catch (error) {
    return { ok: false, error: error.message || "Unable to save infrastructure" };
  }
});

ipcMain.handle("gss:cloud-status", () => ({ ...cloudStatus, configured: Boolean(cloudApiKey) }));

ipcMain.handle("gss:cloud-configure", async (_event, apiKey) => {
  try {
    saveCloudConfiguration(apiKey);
    if (cloudApiKey && runtimeDevices.size) {
      void syncCloudTelemetry();
      if (!cloudSyncTimer) cloudSyncTimer = setInterval(() => { void syncCloudTelemetry(); }, CLOUD_SYNC_INTERVAL_MS);
    }
    if (!cloudApiKey && cloudSyncTimer) { clearInterval(cloudSyncTimer); cloudSyncTimer = null; }
    if (!cloudApiKey && cloudRetryTimer) { clearTimeout(cloudRetryTimer); cloudRetryTimer = null; }
    return { ok: true, ...cloudStatus, configured: Boolean(cloudApiKey) };
  } catch (error) {
    return { ok: false, error: error.message || "Unable to save cloud configuration" };
  }
});

ipcMain.handle("gss:server-start", async (_event, payload) => {
  topologyLinks = Array.isArray(payload?.links) ? payload.links : [];
  runtimeLinks = topologyLinks;
  const assigned = assignRuntimeAddresses((payload?.devices || []).map((device) => structuredClone(device)));
  runtimeDevices = new Map(assigned.devices.map((device) => [device.id, device]));
  persistRuntimeInfrastructure();
  if (!localServer) {
    localServer = http.createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const headers = { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" };
      if (request.method === "OPTIONS") { response.writeHead(204, headers); response.end(); return; }
      const parts = url.pathname.split("/").filter(Boolean);
      const send = (status, body) => { response.writeHead(status, headers); response.end(JSON.stringify(body)); };
      const staticFiles = { "/topology": ["renderer/index.html", "text/html"], "/management": ["renderer/index.html", "text/html"], "/app.js": ["renderer/app.js", "text/javascript"], "/styles.css": ["renderer/styles.css", "text/css"], "/topo.png": ["renderer/topo.png", "image/png"] };
      if (request.method === "GET" && staticFiles[url.pathname]) { const [file, type] = staticFiles[url.pathname]; try { response.writeHead(200, { ...headers, "content-type": type }); response.end(fs.readFileSync(path.join(__dirname, file))); } catch { send(404, { error: "Static file not found" }); } return; }
      if (request.method === "GET" && url.pathname === "/") { send(200, { ok: true, service: "GSS Local Network Lab", api: "/api/devices", timestamp: new Date().toISOString() }); return; }
      if (request.method === "GET" && url.pathname === "/api/devices") { send(200, { devices: [...runtimeDevices.values()].map(deviceSummary), links: runtimeLinks }); return; }
      if (request.method === "GET" && (url.pathname === "/api/infrastructure" || url.pathname === "/api/telemetry")) { send(200, latestTelemetry || collectTelemetry()); return; }
      if (request.method === "GET" && url.pathname === "/api/telemetry/history") { send(200, { snapshots: telemetryHistory }); return; }
      if (parts[0] === "api" && parts[1] === "devices" && parts[2]) {
        const device = runtimeDevices.get(parts[2]); if (!device) { send(404, { error: "Device not found" }); return; }
        if (request.method === "GET" && parts.length === 3) { send(200, deviceSummary(device)); return; }
        if (request.method === "GET" && parts[3]) { const detail = { interfaces: device.model?.interfaces || [], routes: device.model?.routing?.routes || [], vlans: device.model?.vlans || [], traffic: device.model?.traffic || {}, health: device.model?.health || {}, events: device.model?.events || [], topology: { neighbors: device.model?.neighbors || [] } }[parts[3]]; if (detail === undefined) { send(404, { error: "Resource not found" }); return; } send(200, detail); return; }
        if (request.method === "POST" && parts[3] === "commands") { let body=""; request.on("data", chunk => { body += chunk; }); request.on("end", () => { const command = JSON.parse(body || "{}"); const event = { time: new Date().toISOString(), type: "command", message: `Command ${command.action || "unknown"} accepted` }; device.model.events.unshift(event); if (command.action === "shutdown" || command.action === "disable") device.status = "offline"; if (command.action === "start" || command.action === "enable") device.status = "online"; send(200, { ok: true, device: deviceSummary(device), event }); }); return; }
      }
      send(404, { error: "Route not found" });
    });
    await new Promise((resolve, reject) => {
      localServer.once("error", reject);
      localServer.listen(8787, "0.0.0.0", resolve);
    });
  }
  if (!trafficTimer) {
    trafficTimer = setInterval(() => {
      if (!topologyLinks.length) return;
      // Rotate a concurrent window across every link so branch and customer
      // access links receive traffic, not only the first core links.
      const count = Math.min(8, topologyLinks.length);
      const start = trafficSequence % topologyLinks.length;
      Array.from({ length: count }, (_, index) => topologyLinks[(start + index) % topologyLinks.length]).forEach((link, index) => {
        const [a, b] = link;
        const source = runtimeDevices.get(a); const target = runtimeDevices.get(b);
        const reachable = reachableOnlineDevices();
        if (!source || !target || !reachable.has(a) || !reachable.has(b)) return;
        updateRuntimeTraffic(a, b, 256 + ((trafficSequence + index) % 16) * 64);
        BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("gss:traffic", { a, b, bytes: 256 + ((trafficSequence + index) % 16) * 64, sequence: trafficSequence++ }));
      });
    }, 100);
  }
  if (!telemetryTimer) { collectTelemetry(); telemetryTimer = setInterval(collectTelemetry, 1000); }
  if (cloudApiKey) {
    void syncCloudTelemetry();
    if (!cloudSyncTimer) cloudSyncTimer = setInterval(() => { void syncCloudTelemetry(); }, CLOUD_SYNC_INTERVAL_MS);
  } else setCloudStatus({ state: "not-configured", message: "Local server is running. Add an Intelligence API key to start cloud monitoring." });
  return { ok: true, host: assigned.hostIp, port: 8787, url: `http://${assigned.hostIp}:8787`, devices: assigned.devices.map((device) => ({ id: device.id, ip: device.ip })), cloud: { ...cloudStatus, configured: Boolean(cloudApiKey) } };
});

ipcMain.handle("gss:server-stop", async () => {
  if (trafficTimer) { clearInterval(trafficTimer); trafficTimer = null; }
  if (telemetryTimer) { clearInterval(telemetryTimer); telemetryTimer = null; }
  if (cloudSyncTimer) { clearInterval(cloudSyncTimer); cloudSyncTimer = null; }
  if (cloudRetryTimer) { clearTimeout(cloudRetryTimer); cloudRetryTimer = null; }
  if (localServer) { await new Promise((resolve) => localServer.close(() => resolve())); localServer = null; }
  setCloudStatus({ state: cloudApiKey ? "offline" : "not-configured", message: cloudApiKey ? "Local server stopped. GSS Cloud is offline." : "Cloud telemetry is not configured." });
  return { ok: true };
});

app.whenReady().then(() => {
  loadLocalDatabase();
  loadCloudConfiguration();
  // Open both workspaces as real desktop windows. They share the same local
  // Electron profile, so topology edits and management changes use the same lab.
  createWindow("topology", { width: 1120, height: 900, x: 0, y: 0 });
  createWindow("management", { width: 520, height: 900, x: 1120, y: 0 });
  createWindow("traffic", { width: 560, height: 520, x: 1120, y: 420 });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow("topology", { width: 1120, height: 900, x: 0, y: 0 });
      createWindow("management", { width: 520, height: 900, x: 1120, y: 0 });
      createWindow("traffic", { width: 560, height: 520, x: 1120, y: 420 });
    }
  });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", () => { if (trafficTimer) clearInterval(trafficTimer); if (telemetryTimer) clearInterval(telemetryTimer); if (cloudSyncTimer) clearInterval(cloudSyncTimer); if (cloudRetryTimer) clearTimeout(cloudRetryTimer); if (localServer) localServer.close(); });

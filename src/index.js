try {
  require("dotenv").config({
    path: require("path").resolve(__dirname, "..", ".env"),
  });
} catch {}
const http = require("http");

// ─── Config ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const COOLIFY_URL = process.env.COOLIFY_URL;
const COOLIFY_API_TOKEN = process.env.COOLIFY_API_TOKEN;
const UPLOAD_API_KEY = process.env.UPLOAD_API_KEY || "";

// ─── Validate config ─────────────────────────────────────────────────
function validateConfig() {
  const required = { COOLIFY_URL, COOLIFY_API_TOKEN, UPLOAD_API_KEY };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

// ─── Update Coolify env vars ─────────────────────────────────────────
async function updateCoolifyEnvs(
  appUuid,
  secrets,
  resourceType = "application",
) {
  const basePath =
    resourceType === "service"
      ? `/api/v1/services/${appUuid}/envs/bulk`
      : `/api/v1/applications/${appUuid}/envs/bulk`;

  const res = await fetch(`${COOLIFY_URL}${basePath}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${COOLIFY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: secrets.map((s) => ({
        key: s.key,
        value: s.value,
        is_preview: false,
      })),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Coolify env update failed (${res.status}): ${text}`);
  }

  console.log(
    `Coolify: Updated ${secrets.length} env vars for ${resourceType} ${appUuid}`,
  );
}

// ─── Restart Coolify app ─────────────────────────────────────────────
async function restartCoolifyApp(appUuid, resourceType = "application") {
  const basePath =
    resourceType === "service"
      ? `/api/v1/services/${appUuid}/restart`
      : `/api/v1/applications/${appUuid}/restart`;

  const res = await fetch(`${COOLIFY_URL}${basePath}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${COOLIFY_API_TOKEN}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Coolify restart failed (${res.status}): ${text}`);
  }

  console.log(`Coolify: Restart queued for ${resourceType} ${appUuid}`);
}

// ─── Parse .env file content ─────────────────────────────────────────
function parseEnvFile(content) {
  const secrets = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) secrets.push({ key, value });
  }
  return secrets;
}

// ─── Fetch apps from Coolify ─────────────────────────────────────────
async function fetchCoolifyApps() {
  const res = await fetch(`${COOLIFY_URL}/api/v1/applications`, {
    headers: { Authorization: `Bearer ${COOLIFY_API_TOKEN}` },
  });
  if (!res.ok) return [];
  const apps = await res.json();
  return apps.map((a) => ({
    uuid: a.uuid,
    name: a.name || a.fqdn || a.uuid,
    fqdn: a.fqdn || "",
    status: a.status || "unknown",
  }));
}

// ─── Fetch single app status from Coolify ────────────────────────────
async function fetchAppStatus(appUuid) {
  // Fetch container status and active deployments in parallel
  // Note: per-app deployments endpoint is /deployments/applications/{uuid} (not /applications/{uuid}/deployments)
  const [appRes, deployRes] = await Promise.all([
    fetch(`${COOLIFY_URL}/api/v1/applications/${appUuid}`, {
      headers: { Authorization: `Bearer ${COOLIFY_API_TOKEN}` },
    }),
    fetch(
      `${COOLIFY_URL}/api/v1/deployments/applications/${appUuid}?skip=0&take=1`,
      {
        headers: { Authorization: `Bearer ${COOLIFY_API_TOKEN}` },
      },
    ),
  ]);

  const containerStatus = appRes.ok
    ? (await appRes.json()).status || "unknown"
    : "unknown";

  let deploying = false;
  if (deployRes.ok) {
    const deployments = await deployRes.json();
    // Response is { count, deployments: [...] }
    const list = Array.isArray(deployments)
      ? deployments
      : deployments.deployments || deployments.data || [];
    const active = list.find(
      (d) =>
        d.status === "in_progress" ||
        d.status === "queued" ||
        d.status === "building",
    );
    if (active) deploying = true;
  }

  return { container: containerStatus, deploying };
}

// ─── HTML UI ─────────────────────────────────────────────────────────
function renderUI(apps) {
  const appOptions = apps
    .map(
      (a) =>
        `<option value="${a.uuid}" data-status="${a.status}">${a.name}</option>`,
    )
    .join("\n            ");

  const appsJson = JSON.stringify(
    apps.map((a) => ({ uuid: a.uuid, name: a.name, status: a.status })),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Coolify Manager</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a; color: #e2e8f0; min-height: 100vh;
      display: flex; align-items: flex-start; justify-content: center; padding: 32px 16px;
    }
    .card {
      background: #1e293b; border-radius: 12px; padding: 32px;
      width: 100%; max-width: 680px; box-shadow: 0 4px 24px rgba(0,0,0,0.3);
    }
    h1 { font-size: 20px; margin-bottom: 4px; color: #f8fafc; }
    .subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 24px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #94a3b8; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
    select, input, textarea {
      width: 100%; padding: 10px 12px; background: #0f172a; border: 1px solid #334155;
      border-radius: 8px; color: #e2e8f0; font-size: 14px; margin-bottom: 16px;
      font-family: inherit; transition: border-color 0.2s;
    }
    select:focus, input:focus, textarea:focus { outline: none; border-color: #3b82f6; }
    textarea { min-height: 200px; font-family: "SF Mono", "Fira Code", monospace; font-size: 13px; resize: vertical; }
    .row { display: flex; gap: 12px; }
    .row > div { flex: 1; }
    .file-hint { font-size: 12px; color: #64748b; margin: -12px 0 16px; }
    button {
      width: 100%; padding: 12px; background: #3b82f6; color: white; border: none;
      border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #2563eb; }
    button:disabled { background: #334155; cursor: not-allowed; }
    .result {
      margin-top: 16px; padding: 12px; border-radius: 8px; font-size: 13px;
      font-family: "SF Mono", monospace; display: none; word-break: break-word;
    }
    .result.success { display: block; background: #064e3b; border: 1px solid #059669; color: #6ee7b7; }
    .result.error { display: block; background: #450a0a; border: 1px solid #dc2626; color: #fca5a5; white-space: pre-wrap; }
    .or-divider { text-align: center; color: #475569; font-size: 12px; margin: -8px 0 12px; }
    .status-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; min-height: 28px; }
    .status-badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 12px; border-radius: 20px; font-size: 12px;
      font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .status-badge .dot { width: 8px; height: 8px; border-radius: 50%; }
    .status-running { background: #064e3b; color: #6ee7b7; }
    .status-running .dot { background: #10b981; box-shadow: 0 0 6px #10b981; }
    .status-stopped { background: #450a0a; color: #fca5a5; }
    .status-stopped .dot { background: #ef4444; }
    .status-deploying, .status-restarting { background: #422006; color: #fcd34d; }
    .status-deploying .dot, .status-restarting .dot { background: #f59e0b; animation: pulse 1.5s infinite; }
    .status-unknown { background: #1e293b; color: #64748b; border: 1px solid #334155; }
    .status-unknown .dot { background: #64748b; }
    .status-exited { background: #450a0a; color: #fca5a5; }
    .status-exited .dot { background: #ef4444; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .app-name-label { font-size: 13px; color: #94a3b8; }
    .tabs { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 2px solid #1e293b; }
    .tab { flex: 1; padding: 10px; background: none; border: none; color: #64748b; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.2s; }
    .tab:hover { color: #94a3b8; }
    .tab.active { color: #3b82f6; border-bottom-color: #3b82f6; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .deploy-list { display: flex; flex-direction: column; gap: 6px; max-height: 500px; overflow-y: auto; }
    .deploy-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; cursor: pointer; transition: border-color 0.2s; }
    .deploy-item:hover { border-color: #3b82f6; }
    .deploy-status { font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 3px 8px; border-radius: 4px; white-space: nowrap; min-width: 80px; text-align: center; }
    .deploy-status.finished { background: #064e3b; color: #6ee7b7; }
    .deploy-status.in_progress { background: #422006; color: #fcd34d; }
    .deploy-status.queued { background: #1e293b; color: #94a3b8; border: 1px solid #334155; }
    .deploy-status.failed, .deploy-status.error { background: #450a0a; color: #fca5a5; }
    .deploy-status.cancelled { background: #1e293b; color: #94a3b8; border: 1px solid #334155; }
    .deploy-info { flex: 1; min-width: 0; }
    .deploy-commit { font-family: "SF Mono", "Fira Code", monospace; font-size: 12px; color: #93c5fd; }
    .deploy-msg { font-size: 12px; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; margin-top: 2px; }
    .deploy-time { font-size: 11px; color: #475569; white-space: nowrap; }
    .deploy-empty { text-align: center; color: #475569; padding: 40px 0; font-size: 13px; }
    .log-viewer { border-radius: 8px; overflow: hidden; border: 1px solid #334155; }
    .log-header { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #1e293b; }
    .log-back { background: none; border: 1px solid #334155; color: #94a3b8; cursor: pointer; font-size: 12px; padding: 4px 10px; border-radius: 6px; }
    .log-back:hover { background: #334155; color: #e2e8f0; }
    .log-title { font-size: 12px; color: #64748b; flex: 1; }
    .log-status { font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 3px 8px; border-radius: 4px; }
    .log-terminal { padding: 12px; max-height: 500px; overflow-y: auto; background: #0a0e17; font-family: "SF Mono", "Fira Code", monospace; font-size: 12px; line-height: 1.6; }
    .log-line { white-space: pre-wrap; word-break: break-all; }
    .log-line.stderr { color: #fca5a5; }
    .log-line.stdout { color: #cbd5e1; }
    .log-ts { color: #475569; margin-right: 8px; font-size: 11px; }
    .log-cmd { color: #7dd3fc; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Coolify Manager</h1>
    <p class="subtitle">Manage applications, environments, and deployments</p>

    <label for="app">Application</label>
    <select id="app">
      <option value="">Select an app...</option>
      ${appOptions}
    </select>

    <div class="status-bar" id="statusBar"></div>

    <div class="tabs">
      <button class="tab active" onclick="switchTab('env')" id="tabBtn-env">Environment</button>
      <button class="tab" onclick="switchTab('deployments')" id="tabBtn-deployments">Deployments</button>
    </div>

    <div id="tab-env" class="tab-content active">
    <label for="apiKey">API Key</label>
    <input type="password" id="apiKey" placeholder="Enter your API key">

    <label for="envContent">Paste .env contents</label>
    <textarea id="envContent" placeholder="DB_HOST=localhost&#10;DB_PORT=5432&#10;SECRET_KEY=abc123"></textarea>

    <div class="or-divider">— or upload a file —</div>
    <input type="file" id="envFile" accept=".env,.txt">
    <p class="file-hint">Select a .env file from your computer</p>

    <button id="submitBtn" onclick="submitEnv()">Upload & Restart</button>

    <div class="or-divider">— or —</div>
    <button id="restartBtn" onclick="restartOnly()" style="background:#f59e0b">Restart Only</button>

    <div id="result" class="result"></div>
    </div>

    <div id="tab-deployments" class="tab-content">
      <div id="deploymentPanel">
        <div id="deploymentList" class="deploy-empty">Select an app to view deployments</div>
      </div>
      <div id="logViewer" class="log-viewer" style="display:none">
        <div class="log-header">
          <button class="log-back" onclick="closeLogViewer()">&#8592; Back</button>
          <span class="log-title" id="logTitle"></span>
          <span class="log-status" id="logStatus"></span>
        </div>
        <div id="logContent" class="log-terminal"></div>
      </div>
    </div>
  </div>

  <script>
    const fileInput = document.getElementById("envFile");
    const textarea = document.getElementById("envContent");

    fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => { textarea.value = ev.target.result; };
      reader.readAsText(file);
    });

    const appsData = ${appsJson};
    let statusInterval = null;

    function getStatusClass(status) {
      if (!status) return "status-unknown";
      const s = status.toLowerCase().replace(":", "");
      if (s.includes("running")) return "status-running";
      if (s.includes("exited") || s.includes("error")) return "status-exited";
      if (s.includes("stop")) return "status-stopped";
      if (s.includes("deploy") || s.includes("building") || s.includes("starting")) return "status-deploying";
      if (s.includes("restart")) return "status-restarting";
      return "status-unknown";
    }

    function getStatusLabel(status) {
      if (!status || status === "unknown") return "Unknown";
      return status.replace(/:/g, " ").replace(/_/g, " ").trim();
    }

    function renderStatus(status, deploying) {
      const bar = document.getElementById("statusBar");
      if (!status) { bar.innerHTML = ""; return; }
      let html = '';
      // Show container status badge
      const cls = getStatusClass(status);
      const label = getStatusLabel(status);
      html += '<span class="status-badge ' + cls + '"><span class="dot"></span>' + label + '</span>';
      // Show deploying badge if a deployment is in progress
      if (deploying) {
        html += ' <span class="status-badge status-deploying"><span class="dot"></span>deploying</span>';
      }
      bar.innerHTML = html;
    }

    async function refreshStatus(uuid) {
      try {
        const res = await fetch("/app-status?app=" + encodeURIComponent(uuid));
        if (res.ok) {
          const data = await res.json();
          renderStatus(data.status, data.deploying);
        }
      } catch (e) {}
    }

    function startStatusPolling(uuid) {
      if (statusInterval) clearInterval(statusInterval);
      refreshStatus(uuid);
      statusInterval = setInterval(() => refreshStatus(uuid), 5000);
    }

    function stopStatusPolling() {
      if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
      document.getElementById("statusBar").innerHTML = "";
    }

    // ── Tab Switching ──
    function switchTab(tab) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
      document.getElementById('tab-' + tab).classList.add('active');
      document.getElementById('tabBtn-' + tab).classList.add('active');
      if (tab === 'deployments') {
        const uuid = document.getElementById('app').value;
        if (uuid) loadDeployments(uuid);
      }
    }

    // ── Deployments ──
    let currentLogUuid = null;
    let logRefreshInterval = null;

    function timeAgo(dateStr) {
      if (!dateStr) return '';
      const diff = Date.now() - new Date(dateStr).getTime();
      const secs = Math.floor(diff / 1000);
      if (secs < 60) return 'just now';
      const mins = Math.floor(secs / 60);
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      const days = Math.floor(hrs / 24);
      return days + 'd ago';
    }

    function deployStatusClass(status) {
      if (!status) return 'queued';
      if (status === 'finished') return 'finished';
      if (status === 'in_progress' || status === 'building') return 'in_progress';
      if (status === 'queued') return 'queued';
      if (status === 'failed' || status === 'error') return 'failed';
      return 'cancelled';
    }

    function deployStatusLabel(status) {
      return (status || 'unknown').replace(/_/g, ' ').replace(/-/g, ' ');
    }

    function escHtml(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    async function loadDeployments(uuid) {
      const list = document.getElementById('deploymentList');
      document.getElementById('deploymentPanel').style.display = 'block';
      document.getElementById('logViewer').style.display = 'none';
      if (!uuid) { list.innerHTML = '<div class="deploy-empty">Select an app to view deployments</div>'; return; }
      list.innerHTML = '<div class="deploy-empty">Loading deployments...</div>';
      try {
        const res = await fetch('/deployment-logs?app=' + encodeURIComponent(uuid) + '&take=15');
        if (!res.ok) throw new Error('Failed to load');
        const data = await res.json();
        if (!data.deployments || !data.deployments.length) {
          list.innerHTML = '<div class="deploy-empty">No deployments found</div>';
          return;
        }
        list.innerHTML = '<div class="deploy-list">' + data.deployments.map(function(d) {
          var msg = d.commit_message ? d.commit_message.split('\\n')[0] : '';
          return '<div class="deploy-item" onclick="viewDeploymentLog(\'' + d.deployment_uuid + '\')">'
            + '<span class="deploy-status ' + deployStatusClass(d.status) + '">' + deployStatusLabel(d.status) + '</span>'
            + '<div class="deploy-info">'
            + (d.commit ? '<span class="deploy-commit">' + d.commit + '</span> ' : '')
            + (msg ? '<span class="deploy-msg">' + escHtml(msg) + '</span>' : '')
            + '</div>'
            + '<span class="deploy-time">' + timeAgo(d.created_at) + '</span>'
            + '</div>';
        }).join('') + '</div>';
      } catch (e) {
        list.innerHTML = '<div class="deploy-empty">Error loading deployments</div>';
      }
    }

    async function viewDeploymentLog(deployUuid) {
      document.getElementById('deploymentPanel').style.display = 'none';
      const viewer = document.getElementById('logViewer');
      const content = document.getElementById('logContent');
      const title = document.getElementById('logTitle');
      viewer.style.display = 'block';
      content.innerHTML = '<div class="deploy-empty">Loading logs...</div>';
      title.textContent = deployUuid;
      currentLogUuid = deployUuid;
      await refreshLogContent(deployUuid);
    }

    async function refreshLogContent(deployUuid) {
      const content = document.getElementById('logContent');
      const title = document.getElementById('logTitle');
      const statusEl = document.getElementById('logStatus');
      try {
        const res = await fetch('/deployment-log/' + encodeURIComponent(deployUuid));
        if (!res.ok) throw new Error('Failed to load log');
        const data = await res.json();
        title.textContent = deployUuid;
        statusEl.textContent = deployStatusLabel(data.status);
        statusEl.className = 'log-status deploy-status ' + deployStatusClass(data.status);
        if (!data.logs || !data.logs.length) {
          content.innerHTML = '<div class="deploy-empty">No logs yet</div>';
        } else {
          content.innerHTML = data.logs.map(function(l) {
            var line = '';
            if (l.command) line += '<div class="log-line"><span class="log-cmd">$ ' + escHtml(l.command) + '</span></div>';
            if (l.output) line += '<div class="log-line ' + (l.type || 'stdout') + '">'
              + (l.timestamp ? '<span class="log-ts">' + new Date(l.timestamp).toLocaleTimeString() + '</span>' : '')
              + escHtml(l.output) + '</div>';
            return line;
          }).join('');
          content.scrollTop = content.scrollHeight;
        }
        // Auto-refresh if deployment is still in progress
        if (logRefreshInterval) clearInterval(logRefreshInterval);
        if (data.status === 'in_progress' || data.status === 'queued' || data.status === 'building') {
          logRefreshInterval = setInterval(function() {
            if (currentLogUuid === deployUuid) refreshLogContent(deployUuid);
            else clearInterval(logRefreshInterval);
          }, 3000);
        }
      } catch (e) {
        content.innerHTML = '<div class="deploy-empty">Error loading logs</div>';
      }
    }

    function closeLogViewer() {
      document.getElementById('logViewer').style.display = 'none';
      document.getElementById('deploymentPanel').style.display = 'block';
      currentLogUuid = null;
      if (logRefreshInterval) { clearInterval(logRefreshInterval); logRefreshInterval = null; }
      const uuid = document.getElementById('app').value;
      if (uuid) loadDeployments(uuid);
    }

    document.getElementById("app").addEventListener("change", async (e) => {
      const uuid = e.target.value;
      if (!uuid) { textarea.value = ""; stopStatusPolling(); closeLogViewer(); document.getElementById('deploymentList').innerHTML = '<div class="deploy-empty">Select an app to view deployments</div>'; return; }

      // Show initial status from page data
      const appData = appsData.find(a => a.uuid === uuid);
      if (appData) renderStatus(appData.status, false);
      startStatusPolling(uuid);

      // Load deployments if that tab is active
      if (document.getElementById('tab-deployments').classList.contains('active')) {
        loadDeployments(uuid);
      }

      textarea.value = "Loading current env vars...";
      try {
        const res = await fetch("/app-envs?app=" + encodeURIComponent(uuid));
        if (res.ok) {
          textarea.value = await res.text();
        } else {
          textarea.value = "# Could not load current env vars";
        }
      } catch (err) {
        textarea.value = "# Error loading env vars";
      }
    });

    function validateEnvContent(text) {
      const lines = text.split(/\\r?\\n/);
      const errors = [];
      const keys = new Set();
      let varCount = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith("#")) continue;
        const eqIndex = line.indexOf("=");
        if (eqIndex === -1) {
          errors.push("Line " + (i + 1) + ": Missing '=' sign - " + line.substring(0, 40));
          continue;
        }
        const key = line.substring(0, eqIndex).trim();
        if (!key) {
          errors.push("Line " + (i + 1) + ": Empty key name");
          continue;
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          errors.push("Line " + (i + 1) + ": Invalid key '" + key + "' - use letters, numbers, underscores only");
          continue;
        }
        if (keys.has(key)) {
          errors.push("Line " + (i + 1) + ": Duplicate key '" + key + "'");
        }
        keys.add(key);
        varCount++;
      }
      return { errors, varCount };
    }

    async function submitEnv() {
      const app = document.getElementById("app").value;
      const apiKey = document.getElementById("apiKey").value;
      const envContent = textarea.value;
      const resultEl = document.getElementById("result");
      const btn = document.getElementById("submitBtn");

      resultEl.className = "result";
      resultEl.style.display = "none";

      if (!app) return showError("Please select an application");
      if (!apiKey) return showError("Please enter your API key");
      if (!envContent.trim()) return showError("Please paste or upload .env contents");

      const { errors, varCount } = validateEnvContent(envContent);
      if (errors.length) return showError("Validation errors:\\n" + errors.join("\\n"));
      if (varCount === 0) return showError("No valid env vars found");

      btn.disabled = true;
      btn.textContent = "Uploading...";

      try {
        const res = await fetch("/upload-env?app=" + encodeURIComponent(app), {
          method: "POST",
          headers: { "x-api-key": apiKey, "Content-Type": "text/plain" },
          body: envContent,
        });
        const data = await res.json();
        if (res.ok) {
          resultEl.className = "result success";
          resultEl.textContent = data.message;
          resultEl.style.display = "block";
        } else {
          showError(data.error || "Upload failed");
        }
      } catch (err) {
        showError("Network error: " + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "Upload & Restart";
      }

      function showError(msg) {
        resultEl.className = "result error";
        resultEl.textContent = msg;
        resultEl.style.display = "block";
      }
    }

    async function restartOnly() {
      const app = document.getElementById("app").value;
      const apiKey = document.getElementById("apiKey").value;
      const resultEl = document.getElementById("result");
      const btn = document.getElementById("restartBtn");

      resultEl.className = "result";
      resultEl.style.display = "none";

      if (!app) { resultEl.className = "result error"; resultEl.textContent = "Please select an application"; resultEl.style.display = "block"; return; }
      if (!apiKey) { resultEl.className = "result error"; resultEl.textContent = "Please enter your API key"; resultEl.style.display = "block"; return; }

      btn.disabled = true;
      btn.textContent = "Restarting...";

      try {
        const res = await fetch("/restart-app?app=" + encodeURIComponent(app), {
          method: "POST",
          headers: { "x-api-key": apiKey },
        });
        const data = await res.json();
        if (res.ok) {
          resultEl.className = "result success";
          resultEl.textContent = data.message;
          resultEl.style.display = "block";
        } else {
          resultEl.className = "result error";
          resultEl.textContent = data.error || "Restart failed";
          resultEl.style.display = "block";
        }
      } catch (err) {
        resultEl.className = "result error";
        resultEl.textContent = "Network error: " + err.message;
        resultEl.style.display = "block";
      } finally {
        btn.disabled = false;
        btn.textContent = "Restart Only";
      }
    }
  </script>
</body>
</html>`;
}

// ─── HTTP Server ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // UI
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    try {
      const apps = await fetchCoolifyApps();
      const html = renderUI(apps);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(`<h1>Error loading apps: ${err.message}</h1>`);
    }
    return;
  }

  // Restart app endpoint
  if (req.method === "POST" && req.url.startsWith("/restart-app")) {
    const apiKey = req.headers["x-api-key"];
    if (!UPLOAD_API_KEY || apiKey !== UPLOAD_API_KEY) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing API key" }));
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const appUuid = url.searchParams.get("app");
    if (!appUuid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing app param" }));
      return;
    }
    try {
      await restartCoolifyApp(appUuid);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: `Restart queued for ${appUuid}` }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Fetch envs for an app
  if (req.method === "GET" && req.url.startsWith("/app-envs")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const appUuid = url.searchParams.get("app");
    if (!appUuid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing app param" }));
      return;
    }
    try {
      const apiRes = await fetch(
        `${COOLIFY_URL}/api/v1/applications/${appUuid}/envs`,
        { headers: { Authorization: `Bearer ${COOLIFY_API_TOKEN}` } },
      );
      if (!apiRes.ok) {
        res.writeHead(apiRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to fetch envs" }));
        return;
      }
      const envs = await apiRes.json();
      const envText = envs
        .filter((e) => !e.is_preview)
        .map((e) => `${e.key}=${e.value}`)
        .join("\n");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(envText);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // App status endpoint
  if (req.method === "GET" && req.url.startsWith("/app-status")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const appUuid = url.searchParams.get("app");
    if (!appUuid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing app param" }));
      return;
    }
    try {
      const { container, deploying } = await fetchAppStatus(appUuid);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ uuid: appUuid, status: container, deploying }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Deployment history for an app
  if (req.method === "GET" && req.url.startsWith("/deployment-logs")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const appUuid = url.searchParams.get("app");
    const take = url.searchParams.get("take") || "15";
    const skip = url.searchParams.get("skip") || "0";
    if (!appUuid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing app param" }));
      return;
    }
    try {
      const apiRes = await fetch(
        `${COOLIFY_URL}/api/v1/deployments/applications/${appUuid}?skip=${skip}&take=${take}`,
        { headers: { Authorization: `Bearer ${COOLIFY_API_TOKEN}` } },
      );
      if (!apiRes.ok) {
        res.writeHead(apiRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to fetch deployments" }));
        return;
      }
      const data = await apiRes.json();
      const deployments = (data.deployments || []).map((d) => ({
        deployment_uuid: d.deployment_uuid,
        status: d.status,
        commit: d.commit ? d.commit.substring(0, 7) : null,
        commit_message: d.commit_message || null,
        created_at: d.created_at,
        finished_at: d.finished_at,
        is_webhook: d.is_webhook,
        force_rebuild: d.force_rebuild,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: data.count || 0, deployments }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Single deployment log
  if (req.method === "GET" && req.url.startsWith("/deployment-log/")) {
    const deployUuid = req.url.split("/deployment-log/")[1]?.split("?")[0];
    if (!deployUuid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing deployment UUID" }));
      return;
    }
    try {
      const apiRes = await fetch(
        `${COOLIFY_URL}/api/v1/deployments/${deployUuid}`,
        { headers: { Authorization: `Bearer ${COOLIFY_API_TOKEN}` } },
      );
      if (!apiRes.ok) {
        res.writeHead(apiRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to fetch deployment" }));
        return;
      }
      const deployment = await apiRes.json();
      let logs = [];
      try {
        logs = typeof deployment.logs === "string"
          ? JSON.parse(deployment.logs)
          : deployment.logs || [];
      } catch (e) {
        logs = [{ output: deployment.logs || "", type: "stdout" }];
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          deployment_uuid: deployment.deployment_uuid,
          status: deployment.status,
          logs: logs
            .filter((l) => !l.hidden)
            .map((l) => ({
              output: l.output || "",
              type: l.type || "stdout",
              timestamp: l.timestamp || null,
              command: l.command || null,
            })),
        }),
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Upload .env endpoint
  if (req.method === "POST" && req.url.startsWith("/upload-env")) {
    // Auth check
    const apiKey = req.headers["x-api-key"];
    if (!UPLOAD_API_KEY || apiKey !== UPLOAD_API_KEY) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing API key" }));
      return;
    }

    // Get coolifyAppUuid from query string
    const url = new URL(req.url, `http://${req.headers.host}`);
    const appUuid = url.searchParams.get("app");
    if (!appUuid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Missing 'app' query parameter (Coolify app UUID)",
        }),
      );
      return;
    }

    const resourceType = url.searchParams.get("type") || "application";

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const secrets = parseEnvFile(body);
        if (!secrets.length) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No valid env vars found in body" }));
          return;
        }

        console.log(
          `\nUpload-env: ${secrets.length} vars for ${resourceType} ${appUuid}`,
        );
        await updateCoolifyEnvs(appUuid, secrets, resourceType);
        await restartCoolifyApp(appUuid, resourceType);
        console.log(`✓ Upload-env synced & restarted: ${appUuid}`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            message: `Updated ${secrets.length} env vars and restarted ${appUuid}`,
          }),
        );
      } catch (err) {
        console.error(`Upload-env error: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// ─── Start ───────────────────────────────────────────────────────────
validateConfig();
server.listen(PORT, () => {
  console.log(`Coolify Manager listening on port ${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  GET  /                  - Manager UI`);
  console.log(`  POST /upload-env        - Upload .env file to Coolify app`);
  console.log(`  GET  /deployment-logs   - Deployment history for an app`);
  console.log(`  GET  /deployment-log/:id - Single deployment log`);
  console.log(`  GET  /health            - Health check`);
});

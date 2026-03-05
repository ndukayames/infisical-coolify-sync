require("dotenv").config({
  path: require("path").resolve(__dirname, "..", ".env"),
});
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
  }));
}

// ─── HTML UI ─────────────────────────────────────────────────────────
function renderUI(apps) {
  const appOptions = apps
    .map((a) => `<option value="${a.uuid}">${a.name}</option>`)
    .join("\n            ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Env Upload</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a; color: #e2e8f0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
    }
    .card {
      background: #1e293b; border-radius: 12px; padding: 32px;
      width: 100%; max-width: 520px; box-shadow: 0 4px 24px rgba(0,0,0,0.3);
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
  </style>
</head>
<body>
  <div class="card">
    <h1>Upload Environment Variables</h1>
    <p class="subtitle">Push a .env file to a Coolify application</p>

    <label for="app">Application</label>
    <select id="app">
      <option value="">Select an app...</option>
      ${appOptions}
    </select>

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

    document.getElementById("app").addEventListener("change", async (e) => {
      const uuid = e.target.value;
      if (!uuid) { textarea.value = ""; return; }
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
  console.log(`Coolify env upload service listening on port ${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  POST /upload-env - Upload .env file to Coolify app`);
  console.log(`  GET  /health     - Health check`);
});

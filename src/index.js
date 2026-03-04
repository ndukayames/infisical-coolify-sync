const http = require("http");
const crypto = require("crypto");

// ─── Config ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const INFISICAL_URL = process.env.INFISICAL_URL; 
const INFISICAL_CLIENT_ID = process.env.INFISICAL_CLIENT_ID;
const INFISICAL_CLIENT_SECRET = process.env.INFISICAL_CLIENT_SECRET;
const COOLIFY_URL = process.env.COOLIFY_URL; 
const COOLIFY_API_TOKEN = process.env.COOLIFY_API_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ""; 
const APP_MAPPING = JSON.parse(process.env.APP_MAPPING || "[]");

// APP_MAPPING format:
// [
//   {
//     "workspaceId": "infisical-project-id",
//     "environment": "production",
//     "secretPath": "/twingle-backend",
//     "coolifyAppUuid": "coolify-app-uuid",
//     "coolifyResourceType": "application"  // "application" or "service"
//   }
// ]

// ─── Validate config ─────────────────────────────────────────────────
function validateConfig() {
  const required = {
    INFISICAL_URL,
    INFISICAL_CLIENT_ID,
    INFISICAL_CLIENT_SECRET,
    COOLIFY_URL,
    COOLIFY_API_TOKEN,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!APP_MAPPING.length) {
    console.warn("WARNING: APP_MAPPING is empty. No secrets will be synced.");
  }
}

// ─── Infisical Auth ──────────────────────────────────────────────────
let accessToken = null;
let tokenExpiresAt = 0;

async function getInfisicalToken() {
  if (accessToken && Date.now() < tokenExpiresAt) {
    return accessToken;
  }

  const res = await fetch(`${INFISICAL_URL}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      clientId: INFISICAL_CLIENT_ID,
      clientSecret: INFISICAL_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Infisical auth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  accessToken = data.accessToken;
  // Refresh 60s before expiry
  tokenExpiresAt = Date.now() + (data.expiresIn - 60) * 1000;
  console.log("Infisical: Authenticated successfully");
  return accessToken;
}

// ─── Fetch secrets from Infisical ────────────────────────────────────
async function fetchSecrets(workspaceId, environment, secretPath) {
  const token = await getInfisicalToken();
  const params = new URLSearchParams({
    projectId: workspaceId,
    environment: environment,
    secretPath: secretPath || "/",
    viewSecretValue: "true",
    expandSecretReferences: "true",
    includeImports: "true",
  });

  const res = await fetch(`${INFISICAL_URL}/api/v4/secrets?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Infisical fetch secrets failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.secrets.map((s) => ({
    key: s.secretKey,
    value: s.secretValue,
  }));
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

// ─── Verify webhook signature ────────────────────────────────────────
function verifySignature(payload, signatureHeader) {
  if (!WEBHOOK_SECRET) return true; // Skip if no secret configured

  if (!signatureHeader) {
    console.warn("No x-infisical-signature header found");
    return false;
  }

  // Format: t=<timestamp>;<signature>
  const parts = signatureHeader.split(";");
  if (parts.length < 2) return false;

  const signature = parts[1];
  const expectedSig = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(expectedSig, "hex"),
  );
}

// ─── Find matching app mapping ───────────────────────────────────────
function findMapping(workspaceId, environment, secretPath) {
  return APP_MAPPING.filter(
    (m) =>
      m.workspaceId === workspaceId &&
      m.environment === environment &&
      (m.secretPath || "/") === (secretPath || "/"),
  );
}

// ─── Handle webhook ──────────────────────────────────────────────────
async function handleWebhook(body, signatureHeader) {
  const payload = JSON.parse(body);

  // Only handle secrets.modified events
  if (payload.event !== "secrets.modified") {
    console.log(`Ignoring event: ${payload.event}`);
    return { status: 200, message: "Event ignored" };
  }

  const { workspaceId, environment, secretPath } = payload.project;
  console.log(
    `\nWebhook received: secrets.modified | workspace=${workspaceId} env=${environment} path=${secretPath}`,
  );

  // Find matching Coolify apps
  const mappings = findMapping(workspaceId, environment, secretPath);
  if (!mappings.length) {
    console.warn(
      `No mapping found for workspace=${workspaceId} env=${environment} path=${secretPath}`,
    );
    return { status: 200, message: "No matching apps" };
  }

  // Fetch updated secrets from Infisical
  const secrets = await fetchSecrets(workspaceId, environment, secretPath);
  console.log(`Fetched ${secrets.length} secrets from Infisical`);

  // Update each matched Coolify app
  for (const mapping of mappings) {
    try {
      const resourceType = mapping.coolifyResourceType || "application";
      await updateCoolifyEnvs(mapping.coolifyAppUuid, secrets, resourceType);
      await restartCoolifyApp(mapping.coolifyAppUuid, resourceType);
      console.log(`✓ Synced & restarted: ${mapping.coolifyAppUuid}`);
    } catch (err) {
      console.error(`✗ Failed for ${mapping.coolifyAppUuid}: ${err.message}`);
    }
  }

  return { status: 200, message: `Synced ${mappings.length} app(s)` };
}

// ─── HTTP Server ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", mappings: APP_MAPPING.length }));
    return;
  }

  // Webhook endpoint
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        // Verify signature
        const sig = req.headers["x-infisical-signature"];
        if (!verifySignature(body, sig)) {
          console.error("Webhook signature verification failed");
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid signature" }));
          return;
        }

        const result = await handleWebhook(body, sig);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: result.message }));
      } catch (err) {
        console.error(`Webhook error: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Manual sync endpoint (for testing)
  if (req.method === "POST" && req.url === "/sync-all") {
    try {
      console.log("\nManual sync triggered");
      for (const mapping of APP_MAPPING) {
        const secrets = await fetchSecrets(
          mapping.workspaceId,
          mapping.environment,
          mapping.secretPath || "/",
        );
        const resourceType = mapping.coolifyResourceType || "application";
        await updateCoolifyEnvs(mapping.coolifyAppUuid, secrets, resourceType);
        await restartCoolifyApp(mapping.coolifyAppUuid, resourceType);
        console.log(`✓ Synced: ${mapping.coolifyAppUuid}`);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ message: `Synced ${APP_MAPPING.length} app(s)` }),
      );
    } catch (err) {
      console.error(`Sync error: ${err.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// ─── Start ───────────────────────────────────────────────────────────
validateConfig();
server.listen(PORT, () => {
  console.log(`Infisical → Coolify sync service listening on port ${PORT}`);
  console.log(`Mappings loaded: ${APP_MAPPING.length}`);
  console.log(`Endpoints:`);
  console.log(`  POST /webhook    - Infisical webhook receiver`);
  console.log(`  POST /sync-all   - Manual full sync`);
  console.log(`  GET  /health     - Health check`);
});

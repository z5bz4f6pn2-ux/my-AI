const MAX_RESULT_LENGTH = 1000;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function cleanText(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

async function authenticateDevice(request, db) {
  const authorization = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+([A-Za-z0-9_-]{32,})$/i.exec(authorization);
  if (!match) return null;

  const tokenHash = await sha256(match[1]);
  return db.prepare(`
    SELECT id, user_id, name, platform
    FROM devices
    WHERE token_hash = ? AND revoked_at IS NULL
    LIMIT 1
  `).bind(tokenHash).first();
}

async function expireOldCommands(db, deviceId) {
  await db.prepare(`
    UPDATE device_commands
    SET status = 'expired', completed_at = current_timestamp,
        error_text = 'The command expired before the computer collected it.'
    WHERE device_id = ? AND status = 'pending'
      AND created_at < datetime('now', '-5 minutes')
  `).bind(deviceId).run();
}

let deviceSchemaPromise = null;

function ensureDeviceSchema(db) {
  if (!deviceSchemaPromise) {
    deviceSchemaPromise = db.batch([
      db.prepare(`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE, platform TEXT NOT NULL DEFAULT 'windows',
          last_seen TEXT, created_at TEXT NOT NULL DEFAULT current_timestamp, revoked_at TEXT
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_devices_user_active
        ON devices(user_id, revoked_at, last_seen)
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS device_commands (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN (
            'open_app', 'open_url', 'open_file', 'volume_up', 'volume_down',
            'volume_mute', 'screenshot', 'lock', 'restart', 'shutdown'
          )),
          payload_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
            'pending', 'claimed', 'completed', 'failed', 'rejected', 'expired'
          )),
          requires_approval INTEGER NOT NULL DEFAULT 0,
          result_text TEXT, error_text TEXT,
          created_at TEXT NOT NULL DEFAULT current_timestamp,
          claimed_at TEXT, completed_at TEXT,
          FOREIGN KEY(device_id) REFERENCES devices(id)
        )
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_device_commands_next
        ON device_commands(device_id, status, created_at)
      `),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_device_commands_owner
        ON device_commands(user_id, id)
      `)
    ]).catch(error => {
      deviceSchemaPromise = null;
      throw error;
    });
  }
  return deviceSchemaPromise;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "Tom's AI Windows companion" });
    }

    if (!url.pathname.startsWith("/api/device/")) {
      return json({ error: "Not found." }, 404);
    }

    await ensureDeviceSchema(env.DB);

    let device;
    try {
      device = await authenticateDevice(request, env.DB);
    } catch (error) {
      console.error("Device authentication failed", error);
      return json({ error: "Authentication is temporarily unavailable." }, 503);
    }

    if (!device) return json({ error: "Invalid or revoked device token." }, 401);

    if (url.pathname === "/api/device/heartbeat" && request.method === "POST") {
      await env.DB.prepare(`
        UPDATE devices SET last_seen = current_timestamp
        WHERE id = ? AND revoked_at IS NULL
      `).bind(device.id).run();
      return json({ ok: true, deviceId: device.id });
    }

    if (url.pathname === "/api/device/commands/next" && request.method === "GET") {
      await env.DB.prepare(`
        UPDATE devices SET last_seen = current_timestamp
        WHERE id = ? AND revoked_at IS NULL
      `).bind(device.id).run();
      await expireOldCommands(env.DB, device.id);

      const pending = await env.DB.prepare(`
        SELECT id, action, payload_json, requires_approval, created_at
        FROM device_commands
        WHERE device_id = ? AND user_id = ? AND status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
      `).bind(device.id, device.user_id).first();

      if (!pending) return new Response(null, { status: 204 });

      const claimed = await env.DB.prepare(`
        UPDATE device_commands
        SET status = 'claimed', claimed_at = current_timestamp
        WHERE id = ? AND device_id = ? AND status = 'pending'
      `).bind(pending.id, device.id).run();

      if (Number(claimed.meta?.changes || 0) !== 1) {
        return new Response(null, { status: 204 });
      }

      let payload = {};
      try {
        payload = JSON.parse(pending.payload_json || "{}");
      } catch {}

      return json({
        command: {
          id: pending.id,
          action: pending.action,
          payload,
          requiresApproval: Boolean(pending.requires_approval),
          createdAt: pending.created_at
        }
      });
    }

    const resultMatch = /^\/api\/device\/commands\/([0-9a-f-]{36})\/result$/i.exec(url.pathname);
    if (resultMatch && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "A JSON result is required." }, 400);
      }

      const status = ["completed", "failed", "rejected"].includes(body?.status)
        ? body.status
        : "failed";
      const resultText = cleanText(body?.result, MAX_RESULT_LENGTH);
      const errorText = cleanText(body?.error, MAX_RESULT_LENGTH);

      const updated = await env.DB.prepare(`
        UPDATE device_commands
        SET status = ?, result_text = ?, error_text = ?, completed_at = current_timestamp
        WHERE id = ? AND device_id = ? AND user_id = ? AND status = 'claimed'
      `).bind(
        status,
        resultText || null,
        errorText || null,
        resultMatch[1],
        device.id,
        device.user_id
      ).run();

      if (Number(updated.meta?.changes || 0) !== 1) {
        return json({ error: "Command not found or already finished." }, 409);
      }

      return json({ ok: true });
    }

    return json({ error: "Not found." }, 404);
  }
};

import os from "node:os";
import path from "node:path";

function databasePath() {
  const configured = process.env.DATA_DIR;
  const dataDir = configured || (process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router")
    : path.join(os.homedir(), ".9router"));
  return path.join(dataDir, "db", "data.sqlite");
}

async function withDatabase(callback) {
  // The realtime process is a normal Node 22 service. Read through node:sqlite
  // rather than pulling Next's module aliases into the custom HTTP server.
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath(), { open: true, readOnly: true });
  try { return callback(database); } finally { database.close(); }
}

export async function validateRuntimeApiKey(key) {
  try {
    return await withDatabase((database) => {
      const row = database.prepare("SELECT isActive FROM apiKeys WHERE key = ?").get(key);
      return row?.isActive === 1 || row?.isActive === true;
    });
  } catch {
    return false;
  }
}

export async function getRuntimeProviderCredential(provider) {
  try {
    return await withDatabase((database) => {
      const rows = database.prepare(
        "SELECT id, data FROM providerConnections WHERE provider = ? AND isActive = 1 ORDER BY priority ASC"
      ).all(provider);
      for (const row of rows) {
        let data = {};
        try { data = JSON.parse(row.data || "{}"); } catch { continue; }
        const token = typeof data.apiKey === "string" ? data.apiKey : data.accessToken;
        if (typeof token === "string" && token.trim()) return { token: token.trim(), connectionId: row.id, source: "database" };
      }
      return null;
    });
  } catch {
    return null;
  }
}

export async function recordRuntimeSttUsage({ provider, model, mode, connectionId, status, metadata }) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databasePath());
    try {
      database.prepare(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
         VALUES(?, ?, ?, ?, NULL, ?, 0, 0, 0, ?, ?, ?)`
      ).run(
        new Date().toISOString(), provider, model, connectionId,
        `/v1/${mode === "batch" ? "audio/transcriptions" : "realtime"}`,
        status, JSON.stringify({}), JSON.stringify(metadata),
      );
    } finally {
      database.close();
    }
  } catch {
    // The caller handles observability failures as non-fatal.
    throw new Error("runtime usage unavailable");
  }
}

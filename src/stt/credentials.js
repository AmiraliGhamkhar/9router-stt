const ENVIRONMENT_KEY = {
  speechmatics: "SPEECHMATICS_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
};

export async function getProviderCredential(provider, { runtime = false } = {}) {
  const envName = ENVIRONMENT_KEY[provider];
  const environmentKey = envName ? process.env[envName]?.trim() : "";
  if (environmentKey) {
    return { token: environmentKey, connectionId: null, source: "environment" };
  }

  // Existing secure provider connections remain supported. The first active
  // connection is deterministic because the repository sorts by priority.
  try {
    if (runtime) {
      const { getRuntimeProviderCredential } = await import("./runtimeDb.js");
      return await getRuntimeProviderCredential(provider);
    }
    const { getProviderConnections } = await import("../lib/db/repos/connectionsRepo.js");
    const connection = (await getProviderConnections({ provider, isActive: true }))
      .find((item) => typeof (item.apiKey || item.accessToken) === "string" && (item.apiKey || item.accessToken).trim());
    if (!connection) return null;
    return {
      token: (connection.apiKey || connection.accessToken).trim(),
      connectionId: connection.id,
      source: "database",
    };
  } catch {
    return null;
  }
}

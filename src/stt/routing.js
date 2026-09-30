import { SttError } from "./error.js";

const BUILTIN_MODELS = {
  speechmatics: ["enhanced", "standard", "melia-1"],
  deepgram: ["nova-3", "nova-2", "nova", "whisper-large"],
};

const DEFAULT_ROUTES = [
  { mode: "realtime", language: "fa", profile: "medical", provider: "speechmatics" },
  { mode: "batch", language: "fa", profile: "medical", provider: "speechmatics" },
  { mode: "realtime", language: "en", profile: "general", provider: "deepgram" },
  { mode: "batch", language: "en", profile: "general", provider: "deepgram" },
  { mode: "realtime", provider: "deepgram" },
  { mode: "batch", provider: "deepgram" },
];

function parseJsonEnvironment(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function configuredRoutes() {
  const configured = parseJsonEnvironment("STT_ROUTING_JSON", null);
  if (!configured) return DEFAULT_ROUTES;
  if (Array.isArray(configured.routes)) return configured.routes;
  if (configured.routes && typeof configured.routes === "object") {
    return Object.entries(configured.routes).map(([name, route]) => ({ name, ...route }));
  }
  return DEFAULT_ROUTES;
}

function modelAliases() {
  const raw = parseJsonEnvironment("STT_MODEL_ALIASES_JSON", {});
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === "string"));
}

function normalizeLanguage(language) {
  return String(language || "").trim().toLowerCase();
}

function parseModel(model) {
  const aliases = modelAliases();
  const resolved = aliases[model] || model;
  const value = String(resolved || "").trim();
  if (!value) throw new SttError("Missing model", { status: 400, code: "missing_model" });
  const slash = value.indexOf("/");
  if (slash === -1) return { provider: null, model: value };
  return { provider: value.slice(0, slash).toLowerCase(), model: value.slice(slash + 1) };
}

function chooseAutoRoute({ mode, language, profile }) {
  const routes = configuredRoutes();
  const candidates = routes.filter((route) => route && route.provider && (!route.mode || route.mode === mode));
  const route = candidates.find((item) => normalizeLanguage(item.language) === language && (item.profile || "general") === profile)
    || candidates.find((item) => normalizeLanguage(item.language) === language && !item.profile)
    || candidates.find((item) => !item.language && (item.profile || "general") === profile)
    || candidates.find((item) => !item.language && !item.profile);
  return route?.provider || null;
}

function allowedModels(provider) {
  const overrides = parseJsonEnvironment("STT_ALLOWED_MODELS_JSON", {});
  const extra = Array.isArray(overrides[provider]) ? overrides[provider] : [];
  return new Set([...(BUILTIN_MODELS[provider] || []), ...extra]);
}

export function listSttModels() {
  return [
    { id: "speechmatics/enhanced", object: "model", owned_by: "speechmatics", kind: "stt" },
    { id: "speechmatics/standard", object: "model", owned_by: "speechmatics", kind: "stt" },
    { id: "deepgram/nova-3", object: "model", owned_by: "deepgram", kind: "stt" },
    { id: "deepgram/nova-2", object: "model", owned_by: "deepgram", kind: "stt" },
  ];
}

export function resolveSttRoute({ provider = "auto", model, language, profile = "general", mode }) {
  const normalizedMode = String(mode || "").toLowerCase();
  if (normalizedMode !== "batch" && normalizedMode !== "realtime") {
    throw new SttError("Invalid STT mode", { status: 400, code: "invalid_mode" });
  }
  const normalizedLanguage = normalizeLanguage(language);
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(normalizedLanguage)) {
    throw new SttError("A valid language code is required", { status: 400, code: "invalid_language" });
  }
  const parsed = parseModel(model);
  const requestedProvider = String(provider || "auto").trim().toLowerCase();
  if (!["auto", "speechmatics", "deepgram"].includes(requestedProvider)) {
    throw new SttError("Unsupported STT provider", { status: 400, code: "invalid_provider" });
  }
  if (parsed.provider && !BUILTIN_MODELS[parsed.provider]) {
    throw new SttError("Unsupported STT provider", { status: 400, code: "invalid_provider" });
  }
  if (requestedProvider !== "auto" && parsed.provider && parsed.provider !== requestedProvider) {
    throw new SttError("Provider conflicts with the model identifier", { status: 400, code: "provider_model_mismatch" });
  }

  const normalizedProfile = String(profile || "general").trim().toLowerCase() || "general";
  const resolvedProvider = requestedProvider === "auto"
    ? (parsed.provider || chooseAutoRoute({ mode: normalizedMode, language: normalizedLanguage, profile: normalizedProfile }))
    : requestedProvider;
  if (!resolvedProvider) {
    throw new SttError("No deterministic route matches this STT request", { status: 400, code: "route_not_found" });
  }
  if (!allowedModels(resolvedProvider).has(parsed.model)) {
    throw new SttError("Unsupported model for selected provider", { status: 400, code: "invalid_model" });
  }
  if (normalizedMode === "realtime" && resolvedProvider === "speechmatics" && parsed.model === "melia-1") {
    throw new SttError("speechmatics/melia-1 is batch-only", { status: 400, code: "invalid_model" });
  }
  return {
    provider: resolvedProvider,
    model: parsed.model,
    language: normalizedLanguage,
    profile: normalizedProfile,
    mode: normalizedMode,
  };
}

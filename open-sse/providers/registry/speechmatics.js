// Speechmatics STT provider registration. The gateway adapters own the provider
// protocol; this registry entry keeps existing credential/dashboard storage aware
// of the provider without exposing a provider key through any public API.
export default {
  id: "speechmatics",
  priority: 21,
  alias: "speechmatics",
  aliases: ["sm"],
  uiAlias: "sm",
  display: {
    name: "Speechmatics",
    icon: "mic",
    color: "#6D5DFB",
    textIcon: "SM",
    website: "https://speechmatics.com",
    notice: {
      text: "Speech-to-text for batch and realtime transcription.",
      apiKeyUrl: "https://portal.speechmatics.com/",
    },
  },
  category: "apikey",
  authType: "apikey",
  models: [
    { id: "enhanced", name: "Enhanced", params: ["language"], kind: "stt" },
    { id: "standard", name: "Standard", params: ["language"], kind: "stt" },
    { id: "melia-1", name: "Melia 1 (batch)", params: ["language"], kind: "stt" },
  ],
  serviceKinds: ["stt"],
  sttConfig: { authType: "apikey", authHeader: "bearer", format: "speechmatics" },
};

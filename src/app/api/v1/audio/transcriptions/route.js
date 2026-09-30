import { batchCorsHeaders, handleBatchTranscription } from "@/stt/batchGateway.js";

// Speechmatics batch jobs may take longer than a typical function invocation.
export const maxDuration = 300;

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: batchCorsHeaders() });
}

/** POST /v1/audio/transcriptions — provider-independent, OpenAI-compatible STT. */
export async function POST(request) {
  return handleBatchTranscription(request);
}

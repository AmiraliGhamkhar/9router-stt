import { authenticateGatewayRequest, isTrustedLoopbackRequest } from "@/stt/auth.js";
import { createSttRequestId } from "@/stt/requestId.js";
import { listSttModels } from "@/stt/routing.js";

export async function GET(request) {
  const requestId = createSttRequestId();
  const auth = await authenticateGatewayRequest(request.headers, {
    isLoopback: isTrustedLoopbackRequest(request.headers),
  });
  if (!auth.ok) {
    return Response.json({ error: { message: "Invalid or missing gateway API key", type: "authentication_error", code: "invalid_api_key", request_id: requestId } }, { status: 401 });
  }
  return Response.json({ object: "list", data: listSttModels() });
}

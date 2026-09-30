import { NextResponse } from "next/server";

// Public liveness endpoint: deliberately does not call providers or expose configuration.
export async function GET() {
  return NextResponse.json({ status: "ok" }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}

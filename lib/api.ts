import { NextResponse, type NextRequest } from "next/server";
import { createRequestClient } from "@/lib/supabase/server";

export function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export function safeError(error: unknown, fallback = "The request could not be completed.") {
  return error instanceof Error ? error.message : fallback;
}

export async function requireAdmin(request: NextRequest) {
  const scoped = createRequestClient(request);
  const { data: { user }, error: authError } = await scoped.client.auth.getUser();
  if (authError || !user) return { error: errorResponse("Administrator sign-in required.", 401), scoped };
  const { data: isAdmin, error } = await scoped.client.rpc("is_admin");
  if (error || !isAdmin) return { error: errorResponse("Administrator access required.", 403), scoped };
  return { user, scoped };
}

export async function requireParticipant(request: NextRequest) {
  const scoped = createRequestClient(request);
  const { data: { user }, error } = await scoped.client.auth.getUser();
  if (error || !user || user.is_anonymous !== true) {
    return { error: errorResponse("Participant session required.", 401), scoped };
  }
  return { user, scoped };
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient, createRequestClient } from "@/lib/supabase/server";
import { safeError } from "@/lib/api";

const startSchema = z.object({
  participantId: z.string().trim().min(1).max(200),
  consented: z.literal(true),
});

export async function POST(request: NextRequest) {
  const scoped = createRequestClient(request);
  try {
    const body = startSchema.parse(await request.json());
    const admin = createAdminClient();
    const { data: status, error: statusError } = await admin.rpc("participant_code_status", {
      p_code: body.participantId,
    });
    if (statusError) throw statusError;
    const codeStatus = status as { claimable?: boolean; reason?: string } | null;
    if (!codeStatus?.claimable) {
      const message = codeStatus?.reason === "completed"
        ? "This participant ID has already completed the assessment."
        : codeStatus?.reason === "aborted"
          ? "This participant ID requires a researcher reset."
          : "This participant ID is invalid or unavailable.";
      return errorWithCookies(scoped, message, 409);
    }

    const { data: existing } = await scoped.client.auth.getUser();
    if (existing.user && existing.user.is_anonymous !== true) await scoped.client.auth.signOut();
    if (!existing.user || existing.user.is_anonymous !== true) {
      const { error: signInError } = await scoped.client.auth.signInAnonymously();
      if (signInError) throw signInError;
    }

    const { data: attemptId, error: claimError } = await scoped.client.rpc("claim_participant_code", {
      p_code: body.participantId,
      p_consented: true,
    });
    if (claimError) throw claimError;
    const response = NextResponse.json({ attemptId });
    return scoped.applyCookies(response);
  } catch (error) {
    return errorWithCookies(scoped, safeError(error), 400);
  }
}

function errorWithCookies(
  scoped: ReturnType<typeof createRequestClient>,
  message: string,
  status: number,
) {
  return scoped.applyCookies(NextResponse.json({ error: message }, { status }));
}

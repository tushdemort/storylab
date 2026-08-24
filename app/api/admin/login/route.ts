import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { allowedAdminEmails, createAdminClient, createRequestClient } from "@/lib/supabase/server";
import { safeError } from "@/lib/api";

const schema = z.object({ email: z.email(), password: z.string().min(8).max(500) });

export async function POST(request: NextRequest) {
  const scoped = createRequestClient(request);
  try {
    const credentials = schema.parse(await request.json());
    const allowed = allowedAdminEmails();
    if (!allowed.has(credentials.email.toLowerCase())) {
      return scoped.applyCookies(NextResponse.json({ error: "Administrator access is not configured for this email." }, { status: 403 }));
    }
    const { data, error } = await scoped.client.auth.signInWithPassword(credentials);
    if (error || !data.user.email) throw error ?? new Error("Sign-in failed.");
    const admin = createAdminClient();
    const { error: registrationError } = await admin.rpc("register_admin", {
      p_user_id: data.user.id,
      p_email: data.user.email,
    });
    if (registrationError) throw registrationError;
    return scoped.applyCookies(NextResponse.json({ ok: true }));
  } catch (error) {
    return scoped.applyCookies(NextResponse.json({ error: safeError(error, "Sign-in failed.") }, { status: 401 }));
  }
}

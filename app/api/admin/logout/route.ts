import { NextResponse, type NextRequest } from "next/server";
import { createRequestClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const scoped = createRequestClient(request);
  await scoped.client.auth.signOut();
  return scoped.applyCookies(NextResponse.json({ ok: true }));
}

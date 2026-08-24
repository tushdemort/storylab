import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { NextRequest, NextResponse } from "next/server";
import { supabaseEnv, supabaseSecret } from "./env";

type CookieChange = { name: string; value: string; options?: Record<string, unknown> };

export function createRequestClient(request: NextRequest) {
  const { url, publishableKey } = supabaseEnv();
  const cookieChanges: CookieChange[] = [];
  const client = createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookies) => { cookieChanges.push(...cookies); },
    },
  });
  return {
    client,
    applyCookies(response: NextResponse) {
      for (const cookie of cookieChanges) {
        response.cookies.set(cookie.name, cookie.value, cookie.options);
      }
      return response;
    },
  };
}

export function createAdminClient() {
  const { url, secretKey } = supabaseSecret();
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function allowedAdminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

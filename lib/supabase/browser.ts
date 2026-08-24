"use client";

import { createBrowserClient } from "@supabase/ssr";
import { supabaseEnv } from "./env";

let browserClient: ReturnType<typeof createBrowserClient> | undefined;

export function getBrowserSupabase() {
  if (!browserClient) {
    const { url, publishableKey } = supabaseEnv();
    browserClient = createBrowserClient(url, publishableKey);
  }
  return browserClient;
}

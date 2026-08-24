export function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !publishableKey) {
    throw new Error("Supabase is not configured. Copy .env.example to .env.local and add project credentials.");
  }
  return { url, publishableKey };
}

export function supabaseSecret() {
  const secretKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secretKey) throw new Error("SUPABASE_SECRET_KEY is not configured.");
  return { ...supabaseEnv(), secretKey };
}

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { safeError } from "@/lib/api";
import { camelizeRow } from "@/lib/utils";
import type { StudyConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("study_versions")
      .select("id,version,consent_markdown,keystroke_disclosure,attention_prompt,instruction_markdown,wait_seconds,chat_seconds,reconnect_seconds,quiz_questions")
      .eq("status", "active")
      .single();
    if (error) throw error;
    return NextResponse.json({ config: camelizeRow<StudyConfig>(data) });
  } catch (error) {
    return NextResponse.json({ error: safeError(error, "Study configuration is unavailable.") }, { status: 503 });
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin, safeError } from "@/lib/api";

const optionSchema = z.object({ value: z.string().min(1), label: z.string().min(1) });
const configSchema = z.object({
  consentMarkdown: z.string().trim().min(1),
  keystrokeDisclosure: z.string().trim().min(1),
  attentionPrompt: z.string().trim().min(1),
  instructionMarkdown: z.string().trim().min(1),
  waitSeconds: z.number().int().min(10).max(3600),
  chatSeconds: z.number().int().min(10).max(14400),
  reconnectSeconds: z.number().int().min(30).max(3600),
  quizQuestions: z.array(z.object({ id: z.string().min(1), prompt: z.string().min(1), options: z.array(optionSchema).min(2) })).min(1),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if ("error" in auth) return auth.error;
    const config = configSchema.parse(await request.json());
    const { data, error } = await auth.scoped.client.rpc("admin_publish_study", { p_config: config });
    if (error) throw error;
    return NextResponse.json({ ok: true, studyVersionId: data });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 400 });
  }
}

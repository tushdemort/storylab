import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin, safeError } from "@/lib/api";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("resetCode"), codeId: z.uuid() }),
  z.object({ action: z.literal("deletePair"), pairId: z.uuid(), confirmation: z.literal("DELETE") }),
]);

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if ("error" in auth) return auth.error;
    const body = schema.parse(await request.json());
    const result = body.action === "resetCode"
      ? await auth.scoped.client.rpc("admin_reset_code", { p_code_id: body.codeId })
      : await auth.scoped.client.rpc("admin_delete_pair", { p_pair_id: body.pairId });
    if (result.error) throw result.error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 400 });
  }
}

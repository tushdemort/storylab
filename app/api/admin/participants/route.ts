import { NextResponse, type NextRequest } from "next/server";
import Papa from "papaparse";
import { requireAdmin, safeError } from "@/lib/api";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if ("error" in auth) return auth.error;
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Choose a CSV file." }, { status: 400 });
    if (file.size > 2_000_000) return NextResponse.json({ error: "CSV files must be smaller than 2 MB." }, { status: 400 });
    const parsed = Papa.parse<string[]>(await file.text(), { skipEmptyLines: true });
    if (parsed.errors.length) throw new Error(parsed.errors[0].message);
    const rows = parsed.data;
    const headerNames = new Set(["id", "participant id", "participant_id", "participant code", "participant_code", "code"]);
    const hasHeader = rows[0]?.some((cell) => headerNames.has(String(cell).trim().toLowerCase()));
    const codes = (hasHeader ? rows.slice(1) : rows)
      .map((row) => String(row[0] ?? "").trim())
      .filter(Boolean);
    if (!codes.length) throw new Error("No participant IDs were found in the first CSV column.");
    if (codes.length > 10_000) throw new Error("Import at most 10,000 IDs at once.");
    const { data, error } = await auth.scoped.client.rpc("admin_import_codes", { p_codes: codes });
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 400 });
  }
}

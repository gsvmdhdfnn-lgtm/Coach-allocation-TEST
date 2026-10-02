/**
 * sheets-sandbox - a TEST-ONLY Google Sheets v4 emulator (Finance Foundation
 * F19; see TEST-ENV.md "Finance Foundation - F19"). It lets the Finance
 * reporting writer be proven end to end without any real Google credential
 * or workbook. It is NOT Google: REAL GOOGLE WRITE IS NOT PROVEN by it.
 *
 * The semantics live in emulator.ts (shared with the offline suite); this
 * file only authenticates, loads / stores the workbook, takes injected
 * faults and logs every request:
 *   - Auth: `Authorization: Bearer <key>`, matched by sha256 against
 *     public.sheets_sandbox_accounts (the key is never stored or logged).
 *   - Workbooks: public.sheets_sandbox_spreadsheets (one row per workbook;
 *     `doc` holds title, sharedWith, deleted and the tabs' cell grids).
 *   - Faults: public.sheets_sandbox_faults via sheets_sandbox_take_fault(op)
 *     (op get | values_batch_get | values_batch_update | batch_update).
 *   - Log: public.sheets_sandbox_requests (method, path, op, status, note -
 *     never the key or cell values) - the "no per-row Google call" evidence.
 * verify_jwt is false (the emulated client sends its own bearer key, like
 * stripe-sandbox / xero-sandbox). It refuses to start against production.
 */
import { type Spreadsheet, handle, opOf } from "./emulator.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
if (["bkkukymqaxawnudoxdjs"].some((ref) => (SUPABASE_URL || "").includes(ref))) {
  throw new Error("sheets-sandbox refusing to start: this is a TEST-only emulator and SUPABASE_URL is the production project.");
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const enc = encodeURIComponent;

async function db(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`sandbox db ${path}: ${res.status} ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function logReq(method: string, path: string, op: string | null, status: number | null, note: string) {
  await db("sheets_sandbox_requests", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ method, path, op, status, note }) }).catch((e) => console.error(e));
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/sheets-sandbox/, "") || "/";
  const method = req.method.toUpperCase();
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
    const acct = m ? (await db(`sheets_sandbox_accounts?key_sha256=eq.${await sha256(m[1])}&select=account_id`))[0] : null;
    const which = opOf(method, path);
    const fault = which ? ((await db("rpc/sheets_sandbox_take_fault", { method: "POST", body: JSON.stringify({ p_op: which.op }) })) as string | null) : null;
    const rows = which ? await db(`sheets_sandbox_spreadsheets?spreadsheet_id=eq.${enc(which.spreadsheetId)}&select=doc`) : [];
    const sheet = rows.length ? (rows[0].doc as Spreadsheet) : null;
    let body: unknown = null;
    if (method === "POST") {
      try {
        body = JSON.parse((await req.text()) || "null");
      } catch {
        await logReq(method, path, which?.op ?? null, 400, "body is not JSON");
        return json({ error: { code: 400, message: "Invalid JSON payload", status: "INVALID_ARGUMENT" } }, 400);
      }
    }
    const r = handle({ method, path, query: url.searchParams, body, account: acct ? acct.account_id : null }, sheet, (fault as any) ?? null);
    if (r.next && r.spreadsheetId) {
      await db(`sheets_sandbox_spreadsheets?spreadsheet_id=eq.${enc(r.spreadsheetId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ doc: r.next, updated_at: new Date().toISOString() }) });
    }
    await logReq(method, path, r.op, r.status, r.note);
    return json(r.body, r.status);
  } catch (e) {
    console.error(e);
    await logReq(method, path, null, 500, "sandbox internal error");
    return json({ error: { code: 500, message: "Sandbox error", status: "INTERNAL" } }, 500);
  }
});

/**
 * Google Sheets connector - the provider boundary (Finance Foundation F19;
 * see TEST-ENV.md "Finance Foundation - F19"). The Finance reporting domain
 * never calls Google directly: it talks to a SheetsProvider.
 *
 * httpSheetsProvider speaks the Google Sheets v4 REST subset the writer
 * needs (spreadsheets.get, values.batchGet, values.batchUpdate RAW,
 * spreadsheets.batchUpdate addSheet). The same adapter serves:
 *   - endpoint "sandbox": the TEST sheets-sandbox emulator (Supabase Edge
 *     Function) - the only target enabled in F19;
 *   - endpoint "google": https://sheets.googleapis.com - NOT enabled / NOT
 *     PROVEN in F19 (no credential, no TEST workbook exists yet).
 * Authentication is a separate TokenSource so the auth model can change
 * (platform service account now, organisation OAuth later) without touching
 * the writer. Tokens are never logged, stored, audited or returned.
 *
 * Every call is bounded (timeout) and counted: one sync is a fixed number of
 * requests whatever the number of Finance rows (no per-row Google call).
 */
import type { Cell, Endpoint } from "./finance-reporting-sheets.ts";

export type SheetsFailKind = "unauthorised" | "forbidden" | "not_found" | "rate_limited" | "unavailable" | "malformed" | "rejected" | "auth_unavailable";
export type SheetsFail = { ok: false; kind: SheetsFailKind; status: number | null; message: string };
export type SR<T> = { ok: true; value: T } | SheetsFail;

export interface WorkbookMeta {
  spreadsheetId: string;
  title: string;
  tabs: { sheetId: number; title: string; index: number }[];
}
export interface SheetsProvider {
  getSpreadsheet(id: string): Promise<SR<WorkbookMeta>>;
  batchGet(id: string, ranges: string[]): Promise<SR<{ range: string; values: Cell[][] }[]>>;
  batchUpdateValues(id: string, data: { range: string; values: Cell[][] }[]): Promise<SR<{ updatedRanges: number }>>;
  addTabs(id: string, titles: string[]): Promise<SR<{ title: string; sheetId: number }[]>>;
  /** requests made so far (evidence that the work is batched) */
  readonly requests: number;
}

/** Where the adapter points. "google" is listed for the future real connector - F19 never enables it. */
export function baseUrlFor(endpoint: Endpoint, supabaseUrl: string): string {
  return endpoint === "sandbox" ? `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/sheets-sandbox` : "https://sheets.googleapis.com";
}

/** A source of the bearer token for one connector session (never persisted by the adapter). */
export type TokenSource = () => Promise<{ ok: true; token: string } | SheetsFail>;

const fail = (kind: SheetsFailKind, status: number | null, message: string): SheetsFail => ({ ok: false, kind, status, message });

export function httpSheetsProvider(o: { baseUrl: string; token: TokenSource; timeoutMs?: number }): SheetsProvider {
  let requests = 0;
  let cached: string | null = null;
  const timeoutMs = o.timeoutMs ?? 20_000;
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<SR<any>> {
    if (!cached) {
      const t = await o.token();
      if (!t.ok) return t;
      cached = t.token;
    }
    requests++;
    let res: Response;
    try {
      res = await fetch(`${o.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${cached}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return fail("unavailable", null, `no response (${e instanceof Error ? e.name : "error"})`);
    }
    let parsed: any = null;
    const text = await res.text().catch(() => "");
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const msg = typeof parsed?.error?.message === "string" ? parsed.error.message.slice(0, 300) : `HTTP ${res.status}`;
      if (res.status === 401) return fail("unauthorised", 401, msg);
      if (res.status === 403) return fail("forbidden", 403, msg);
      if (res.status === 404) return fail("not_found", 404, msg);
      if (res.status === 429) return fail("rate_limited", 429, msg);
      if (res.status >= 500) return fail("unavailable", res.status, msg);
      return fail("rejected", res.status, msg);
    }
    if (parsed === undefined || parsed === null || typeof parsed !== "object") return fail("malformed", res.status, "the response was not a JSON object");
    return { ok: true, value: parsed };
  }
  const enc = encodeURIComponent;
  return {
    get requests() {
      return requests;
    },
    async getSpreadsheet(id) {
      const r = await call("GET", `/v4/spreadsheets/${enc(id)}?fields=spreadsheetId,properties.title,sheets.properties`);
      if (!r.ok) return r;
      const v = r.value;
      if (v.spreadsheetId !== id || !Array.isArray(v.sheets)) return fail("malformed", 200, "the workbook metadata is not the expected shape (or is another workbook)");
      const tabs = v.sheets.map((s: any) => s?.properties).filter((p: any) => p && typeof p.title === "string" && Number.isInteger(p.sheetId));
      return { ok: true, value: { spreadsheetId: v.spreadsheetId, title: typeof v.properties?.title === "string" ? v.properties.title : "", tabs: tabs.map((p: any) => ({ sheetId: p.sheetId, title: p.title, index: Number(p.index ?? 0) })) } };
    },
    async batchGet(id, ranges) {
      const qs = ranges.map((r) => `ranges=${enc(r)}`).join("&");
      const r = await call("GET", `/v4/spreadsheets/${enc(id)}/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS`);
      if (!r.ok) return r;
      const vr = r.value.valueRanges;
      if (!Array.isArray(vr) || vr.length !== ranges.length) return fail("malformed", 200, "the values response did not return one value range per requested range");
      const out: { range: string; values: Cell[][] }[] = [];
      for (const x of vr) {
        const values = x?.values === undefined ? [] : x.values;
        if (!Array.isArray(values) || !values.every((row: unknown) => Array.isArray(row) && row.every((c) => typeof c === "string" || typeof c === "number" || typeof c === "boolean"))) return fail("malformed", 200, "a value range is not rows of cells");
        out.push({ range: String(x?.range ?? ""), values });
      }
      return { ok: true, value: out };
    },
    async batchUpdateValues(id, data) {
      const r = await call("POST", `/v4/spreadsheets/${enc(id)}/values:batchUpdate`, { valueInputOption: "RAW", data });
      if (!r.ok) return r;
      return { ok: true, value: { updatedRanges: Number(r.value.totalUpdatedRanges ?? 0) } };
    },
    async addTabs(id, titles) {
      const r = await call("POST", `/v4/spreadsheets/${enc(id)}:batchUpdate`, { requests: titles.map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })) });
      if (!r.ok) return r;
      const replies = Array.isArray(r.value.replies) ? r.value.replies : [];
      return { ok: true, value: replies.map((x: any) => ({ title: String(x?.addSheet?.properties?.title ?? ""), sheetId: Number(x?.addSheet?.properties?.sheetId ?? -1) })) };
    },
  };
}

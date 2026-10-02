/**
 * sheets-sandbox emulator core (Finance Foundation F19; see TEST-ENV.md
 * "Finance Foundation - F19"). TEST ONLY. A pure, deterministic model of the
 * Google Sheets v4 subset the Finance reporting writer uses, shared by the
 * sheets-sandbox Edge Function (Supabase-backed) and the offline suite
 * (in-memory), so the exact same semantics are proven offline and live:
 *
 *   GET  /v4/spreadsheets/{id}                        metadata (title, tabs, grid sizes, frozen rows)
 *   GET  /v4/spreadsheets/{id}/values:batchGet        ?ranges=..&ranges=..  UNFORMATTED values, ROWS
 *   POST /v4/spreadsheets/{id}/values:batchUpdate     { valueInputOption: "RAW", data: [{ range, values }] }
 *   POST /v4/spreadsheets/{id}:batchUpdate            { requests: [{ addSheet: { properties } }] }
 *
 * Google-shaped behaviour: values come back as stored (numbers stay
 * numbers), trailing empty rows / cells are omitted, "" clears a cell, an
 * unknown tab in a range is 400, a write wider than its range is 400, a
 * duplicate tab title is 400. Access: the caller's account must be in the
 * workbook's sharedWith list (403), a missing / deleted workbook is 404.
 * Faults (TEST fault injection): fail_401 / fail_403 / fail_404 / fail_429 /
 * fail_500, partial_write (first range applied, then 500), corrupt_read (one
 * numeric cell in a read is off by 0.01), malformed (a read with no
 * valueRanges).
 */
export type Cell = string | number | boolean;
export interface SheetTab {
  sheetId: number;
  title: string;
  index: number;
  frozenRows: number;
  values: Cell[][];
}
export interface Spreadsheet {
  spreadsheetId: string;
  title: string;
  sharedWith: string[];
  deleted: boolean;
  sheets: SheetTab[];
}
export type Op = "get" | "values_batch_get" | "values_batch_update" | "batch_update";
export const FAULT_MODES = ["fail_401", "fail_403", "fail_404", "fail_429", "fail_500", "partial_write", "corrupt_read", "malformed"] as const;
export type FaultMode = (typeof FAULT_MODES)[number];
export interface EmuRequest {
  method: string;
  /** path after the function root, e.g. /v4/spreadsheets/ABC/values:batchGet */
  path: string;
  query: URLSearchParams;
  body: unknown;
  /** the authenticated emulator account id; null = no / unknown key */
  account: string | null;
}
export interface EmuResult {
  status: number;
  body: unknown;
  op: Op | null;
  spreadsheetId: string | null;
  /** the new workbook state when this request changed it (persist it), else null */
  next: Spreadsheet | null;
  note: string;
}

const MAX_ROWS = 100_000;
const MAX_COLS = 702; // A..ZZ

const gErr = (status: number, gstatus: string, message: string) => ({ error: { code: status, message, status: gstatus } });
const out = (status: number, body: unknown, op: Op | null, id: string | null, next: Spreadsheet | null, note: string): EmuResult => ({ status, body, op, spreadsheetId: id, next, note });

export function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export function indexToCol(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export interface A1 {
  title: string;
  c1: number;
  r1: number;
  /** inclusive; null = to the last column / row */
  c2: number | null;
  r2: number | null;
}
/** 'Tab Title'!A1:R100 | Tab!A1:R | 'Tab' (whole tab). Rows / columns are 0-based here. null = unparseable. */
export function parseA1(range: string): A1 | null {
  let title: string;
  let rest = "";
  if (range.startsWith("'")) {
    let i = 1;
    let t = "";
    while (i < range.length) {
      if (range[i] === "'" && range[i + 1] === "'") {
        t += "'";
        i += 2;
        continue;
      }
      if (range[i] === "'") break;
      t += range[i++];
    }
    if (range[i] !== "'") return null;
    title = t;
    rest = range.slice(i + 1);
  } else {
    const bang = range.indexOf("!");
    title = bang < 0 ? range : range.slice(0, bang);
    rest = bang < 0 ? "" : range.slice(bang);
  }
  if (!title) return null;
  if (rest === "") return { title, c1: 0, r1: 0, c2: null, r2: null };
  const m = /^!([A-Z]{1,2})([0-9]+)(?::([A-Z]{1,2})([0-9]+)?)?$/.exec(rest);
  if (!m) return null;
  const c1 = colToIndex(m[1]);
  const r1 = Number(m[2]) - 1;
  const c2 = m[3] ? colToIndex(m[3]) : c1;
  const r2 = m[3] ? (m[4] ? Number(m[4]) - 1 : null) : r1;
  if (r1 < 0 || r1 >= MAX_ROWS || c2 < c1 || c2 >= MAX_COLS || (r2 !== null && (r2 < r1 || r2 >= MAX_ROWS))) return null;
  return { title, c1, r1, c2, r2 };
}

const clone = (s: Spreadsheet): Spreadsheet => JSON.parse(JSON.stringify(s));
const isEmpty = (v: unknown) => v === undefined || v === null || v === "";

/** Trailing empty cells dropped per row, trailing empty rows dropped - Google's values shape. */
export function trimGrid(rows: readonly (readonly unknown[])[]): Cell[][] {
  const res = rows.map((r) => {
    const a = [...r].map((v) => (isEmpty(v) ? "" : (v as Cell)));
    while (a.length && a[a.length - 1] === "") a.pop();
    return a;
  });
  while (res.length && res[res.length - 1].length === 0) res.pop();
  return res;
}

function readRange(tab: SheetTab, a: A1): Cell[][] {
  const lastRow = a.r2 === null ? tab.values.length - 1 : Math.min(a.r2, tab.values.length - 1);
  const rows: Cell[][] = [];
  for (let r = a.r1; r <= lastRow; r++) {
    const src = tab.values[r] ?? [];
    const lastCol = a.c2 === null ? src.length - 1 : a.c2;
    const row: Cell[] = [];
    for (let c = a.c1; c <= lastCol; c++) row.push(isEmpty(src[c]) ? "" : src[c]);
    rows.push(row);
  }
  return trimGrid(rows);
}

function validCell(v: unknown): v is Cell | null {
  return v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

function writeRange(tab: SheetTab, a: A1, values: unknown[][]): string | null {
  if (!Array.isArray(values)) return "values must be an array of rows";
  const width = a.c2 === null ? null : a.c2 - a.c1 + 1;
  const height = a.r2 === null ? null : a.r2 - a.r1 + 1;
  if (height !== null && values.length > height) return `Requested writing within range [${a.title}], but tried writing ${values.length} rows`;
  for (const row of values) {
    if (!Array.isArray(row)) return "each row must be an array";
    if (width !== null && row.length > width) return `Requested writing within range [${a.title}], but tried writing to column beyond the range`;
    if (!row.every(validCell)) return "cell values must be strings, numbers, booleans or null";
  }
  values.forEach((row, i) => {
    const r = a.r1 + i;
    while (tab.values.length <= r) tab.values.push([]);
    const dst = tab.values[r];
    row.forEach((v, j) => {
      const c = a.c1 + j;
      while (dst.length <= c) dst.push("");
      dst[c] = isEmpty(v) ? "" : (v as Cell);
    });
  });
  tab.values = tab.values.map((r) => {
    const x = [...r];
    while (x.length && x[x.length - 1] === "") x.pop();
    return x;
  });
  while (tab.values.length && tab.values[tab.values.length - 1].length === 0) tab.values.pop();
  return null;
}

function meta(s: Spreadsheet) {
  return {
    spreadsheetId: s.spreadsheetId,
    properties: { title: s.title },
    sheets: [...s.sheets]
      .sort((a, b) => a.index - b.index)
      .map((t) => ({
        properties: {
          sheetId: t.sheetId,
          title: t.title,
          index: t.index,
          sheetType: "GRID",
          gridProperties: { rowCount: Math.max(1000, t.values.length), columnCount: Math.max(26, ...t.values.map((r) => r.length), 0), frozenRowCount: t.frozenRows },
        },
      })),
  };
}

const ROUTE = /^\/v4\/spreadsheets\/([A-Za-z0-9_-]{1,128})(\/values:batchGet|\/values:batchUpdate|:batchUpdate)?$/;

/** Which operation a request is (for fault lookup) - before any access check. */
export function opOf(method: string, path: string): { op: Op; spreadsheetId: string } | null {
  const m = ROUTE.exec(path);
  if (!m) return null;
  if (!m[2] && method === "GET") return { op: "get", spreadsheetId: m[1] };
  if (m[2] === "/values:batchGet" && method === "GET") return { op: "values_batch_get", spreadsheetId: m[1] };
  if (m[2] === "/values:batchUpdate" && method === "POST") return { op: "values_batch_update", spreadsheetId: m[1] };
  if (m[2] === ":batchUpdate" && method === "POST") return { op: "batch_update", spreadsheetId: m[1] };
  return null;
}

/**
 * One request against one workbook (`sheet` = the stored workbook for the
 * id in the path, or null). `fault` = the injected fault for this op, if any.
 */
export function handle(req: EmuRequest, sheet: Spreadsheet | null, fault: FaultMode | null): EmuResult {
  const which = opOf(req.method, req.path);
  if (!which) return out(404, gErr(404, "NOT_FOUND", "Unknown sheets-sandbox route"), null, null, "unknown route");
  const { op, spreadsheetId: id } = which;
  if (fault === "fail_401") return out(401, gErr(401, "UNAUTHENTICATED", "Request had invalid authentication credentials (fault injection)"), op, id, null, "fault fail_401");
  if (fault === "fail_403") return out(403, gErr(403, "PERMISSION_DENIED", "The caller does not have permission (fault injection)"), op, id, null, "fault fail_403");
  if (fault === "fail_404") return out(404, gErr(404, "NOT_FOUND", "Requested entity was not found (fault injection)"), op, id, null, "fault fail_404");
  if (fault === "fail_429") return out(429, gErr(429, "RESOURCE_EXHAUSTED", "Quota exceeded (fault injection)"), op, id, null, "fault fail_429");
  if (fault === "fail_500") return out(500, gErr(500, "INTERNAL", "Internal error (fault injection)"), op, id, null, "fault fail_500");
  if (!req.account) return out(401, gErr(401, "UNAUTHENTICATED", "Request had invalid authentication credentials"), op, id, null, "no / unknown key");
  if (!sheet || sheet.deleted) return out(404, gErr(404, "NOT_FOUND", "Requested entity was not found."), op, id, null, "no such workbook");
  if (!sheet.sharedWith.includes(req.account)) return out(403, gErr(403, "PERMISSION_DENIED", "The caller does not have permission"), op, id, null, "not shared with this account");

  if (op === "get") return out(200, meta(sheet), op, id, null, "metadata");

  if (op === "values_batch_get") {
    if (fault === "malformed") return out(200, { spreadsheetId: id }, op, id, null, "fault malformed");
    const ranges = req.query.getAll("ranges");
    if (!ranges.length) return out(400, gErr(400, "INVALID_ARGUMENT", "At least one range is required"), op, id, null, "no ranges");
    const valueRanges: { range: string; majorDimension: "ROWS"; values?: Cell[][] }[] = [];
    let corrupted = false;
    for (const r of ranges) {
      const a = parseA1(r);
      if (!a) return out(400, gErr(400, "INVALID_ARGUMENT", `Unable to parse range: ${r}`), op, id, null, "bad range");
      const tab = sheet.sheets.find((t) => t.title === a.title);
      if (!tab) return out(400, gErr(400, "INVALID_ARGUMENT", `Unable to parse range: ${r}`), op, id, null, "unknown tab");
      const values = readRange(tab, a);
      if (fault === "corrupt_read" && !corrupted) {
        outer: for (let i = 1; i < values.length; i++)
          for (let j = 0; j < values[i].length; j++)
            if (typeof values[i][j] === "number") {
              values[i][j] = Math.round(((values[i][j] as number) + 0.01) * 100) / 100;
              corrupted = true;
              break outer;
            }
      }
      valueRanges.push({ range: r, majorDimension: "ROWS", ...(values.length ? { values } : {}) });
    }
    return out(200, { spreadsheetId: id, valueRanges }, op, id, null, fault === "corrupt_read" ? "fault corrupt_read" : `read ${ranges.length} range(s)`);
  }

  if (op === "values_batch_update") {
    const b = req.body as { valueInputOption?: unknown; data?: unknown } | null;
    if (!b || typeof b !== "object" || b.valueInputOption !== "RAW" || !Array.isArray(b.data) || !b.data.length) return out(400, gErr(400, "INVALID_ARGUMENT", "valueInputOption RAW and a non-empty data array are required"), op, id, null, "bad body");
    const next = clone(sheet);
    let applied = 0;
    let cells = 0;
    for (const d of b.data as { range?: unknown; values?: unknown }[]) {
      if (fault === "partial_write" && applied === 1) return out(500, gErr(500, "INTERNAL", "Internal error part-way through the write (fault injection)"), op, id, next, `fault partial_write after ${applied} range(s)`);
      const a = typeof d?.range === "string" ? parseA1(d.range) : null;
      if (!a) return out(400, gErr(400, "INVALID_ARGUMENT", `Unable to parse range: ${String(d?.range)}`), op, id, null, "bad range");
      const tab = next.sheets.find((t) => t.title === a.title);
      if (!tab) return out(400, gErr(400, "INVALID_ARGUMENT", `Unable to parse range: ${d.range}`), op, id, null, "unknown tab");
      const problem = writeRange(tab, a, d.values as unknown[][]);
      if (problem) return out(400, gErr(400, "INVALID_ARGUMENT", problem), op, id, null, "bad values");
      applied++;
      cells += (d.values as unknown[][]).reduce((n, r) => n + r.length, 0);
    }
    return out(200, { spreadsheetId: id, totalUpdatedRanges: applied, totalUpdatedCells: cells }, op, id, next, `wrote ${applied} range(s)`);
  }

  // :batchUpdate - addSheet / updateSheetProperties (frozen rows) only
  const b = req.body as { requests?: unknown } | null;
  if (!b || typeof b !== "object" || !Array.isArray(b.requests) || !b.requests.length) return out(400, gErr(400, "INVALID_ARGUMENT", "requests must be a non-empty array"), op, id, null, "bad body");
  const next = clone(sheet);
  const replies: unknown[] = [];
  for (const r of b.requests as Record<string, any>[]) {
    if (r && r.addSheet) {
      const p = r.addSheet.properties ?? {};
      if (typeof p.title !== "string" || !p.title.trim() || p.title.length > 100) return out(400, gErr(400, "INVALID_ARGUMENT", "addSheet needs a title"), op, id, null, "bad addSheet");
      if (next.sheets.some((t) => t.title.toLowerCase() === p.title.toLowerCase())) return out(400, gErr(400, "INVALID_ARGUMENT", `A sheet with the name "${p.title}" already exists. Please enter another name.`), op, id, null, "duplicate tab");
      const sheetId = Math.max(0, ...next.sheets.map((t) => t.sheetId)) + 1;
      const frozen = Number(p.gridProperties?.frozenRowCount ?? 0);
      next.sheets.push({ sheetId, title: p.title, index: next.sheets.length, frozenRows: Number.isInteger(frozen) && frozen >= 0 ? frozen : 0, values: [] });
      replies.push({ addSheet: { properties: { sheetId, title: p.title, index: next.sheets.length - 1 } } });
    } else if (r && r.updateSheetProperties) {
      const p = r.updateSheetProperties.properties ?? {};
      const tab = next.sheets.find((t) => t.sheetId === p.sheetId);
      if (!tab) return out(400, gErr(400, "INVALID_ARGUMENT", "No grid with id"), op, id, null, "unknown sheetId");
      if (p.gridProperties && Number.isInteger(p.gridProperties.frozenRowCount)) tab.frozenRows = p.gridProperties.frozenRowCount;
      replies.push({});
    } else return out(400, gErr(400, "INVALID_ARGUMENT", "Only addSheet / updateSheetProperties are supported by sheets-sandbox"), op, id, null, "unsupported request");
  }
  return out(200, { spreadsheetId: id, replies }, op, id, next, `applied ${replies.length} request(s)`);
}

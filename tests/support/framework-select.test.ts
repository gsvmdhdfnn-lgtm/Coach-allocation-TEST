// Regression test for the Group/Feedback Mode Airtable field-parsing bug
// in player-feedback's loadFrameworkAndSettings(): Airtable's REST API
// returns a singleSelect field's value as a plain option-name string
// (e.g. "Characteristics"), never an {id,name,color} object. The
// deployed function used to assume the object shape via `.name` on
// every read, which silently produced an empty group for every
// framework item (the reported "Other - 10 areas") and always disabled
// Feedback Mode detection (every mode fell back to the combined
// default, since `.name` on a plain string is undefined).
//
// selectName() below is this test file's own copy of the exact fix
// deployed to player-feedback/index.ts, kept in sync by hand - the same
// duplication convention already used for player-access.ts (see
// tests/support/player-access.ts's own header comment).
function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}
function nameKey(s: string): string {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}
type FeedbackMode = "ratings_written" | "written_only" | "ratings_only";
function normalizeMode(name: string): FeedbackMode {
  const n = nameKey(name);
  if (n.indexOf("written only") >= 0) return "written_only";
  if (n.indexOf("ratings only") >= 0) return "ratings_only";
  return "ratings_written";
}

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

// --- The real shape: Airtable's REST API returns a plain string ---------
ck("A real Airtable singleSelect Group value (plain string) parses correctly", selectName("Characteristics") === "Characteristics", selectName("Characteristics"));
ck("A second Group value parses correctly too, proving this isn't a one-string fluke", selectName("Football Pillars") === "Football Pillars");
ck("A real Airtable singleSelect Feedback Mode value (plain string) resolves to written_only", normalizeMode(selectName("Written Only")) === "written_only");
ck("Ratings Only mode resolves from a plain string", normalizeMode(selectName("Ratings Only")) === "ratings_only");
ck("An unset Feedback Mode falls back to the combined default", normalizeMode(selectName(undefined as any)) === "ratings_written");

// --- Defensive fallback: an {id,name,color}-shaped value still works ----
ck("An object-shaped select value ({name}) still resolves via .name (forward-compatible)", selectName({ id: "selX", name: "Football Pillars", color: "grayLight2" }) === "Football Pillars");

// --- Proves this is a real fix, not a no-op: the OLD naive `.name`
// access (what was actually deployed) silently loses every plain-string
// value, which is exactly the "Other - 10 areas" bug report.
const naiveNameAccess = (v: any) => (v && v.name) || "";
ck("Sanity check: the OLD naive `.name` access is what caused the bug", naiveNameAccess("Characteristics") === "", naiveNameAccess("Characteristics"));
ck("selectName() does not share that blind spot", selectName("Characteristics") !== "");

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);

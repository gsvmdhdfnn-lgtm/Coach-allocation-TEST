/**
 * Test-suite copy of the canonical needs-attention/registry.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./needs-attention|repository|registry.ts become needs-attention-*.ts.
 */
/**
 * Needs Attention - the code-side evaluator registry (see TEST-ENV.md
 * "Needs Attention Foundation - Slice 2").
 *
 * A rule is evaluated only if it is registered HERE and its catalogue row
 * is Active / Evaluation Status Active / module-enabled / enabled. A row
 * merely existing in the Airtable Rules table never causes evaluation.
 *
 * Slice 2 ships the engine only: no real domain evaluator is registered,
 * so live TEST always returns Clear. Later slices append registrations
 * (e.g. staffing rules in Slice 3), each declaring the Airtable tables it
 * reads in `sources`, so shared domain reads are loaded once per request
 * and never loaded at all for rules that are gated off.
 *
 * Drift protection: validateRegistry() (needs-attention.ts) reports
 * duplicate registrations, registrations with no catalogue row, and Rule
 * ID mismatches - both at runtime (as configIssues) and in the unit tests
 * against the TEST catalogue fixture.
 */
import type { EvaluatorRegistration } from "./needs-attention-engine.ts";

export const IMPLEMENTED_EVALUATORS: readonly EvaluatorRegistration[] = [];

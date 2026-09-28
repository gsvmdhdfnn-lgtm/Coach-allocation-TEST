/**
 * Needs Attention - the code-side evaluator registry (see TEST-ENV.md
 * "Needs Attention Foundation - Slice 2" / "Slice 3").
 *
 * A rule is evaluated only if it is registered HERE and its catalogue row
 * is Active / Evaluation Status Active / module-enabled / enabled. A row
 * merely existing in the Airtable Rules table never causes evaluation.
 *
 * Slice 3 registers exactly the four occurrence staffing rules
 * (session_no_coach, no_lead_coach, learning_coach_only,
 * session_understaffed). They declare identical `sources`, so the engine
 * loads each staffing table once per request, and they share one
 * memoised staffing pass (staffing.ts). Slice 4 adds cover_open
 * (cover.ts): one case per open cover date. Its sources overlap the
 * staffing ones (Session Occurrences / Sessions / Coaches), and the engine
 * loads the union of runnable sources once each. Later slices append their
 * own registrations; gated-off rules never cause any domain read.
 *
 * Drift protection: validateRegistry() (needs-attention.ts) reports
 * duplicate registrations, registrations with no catalogue row, and Rule
 * ID mismatches - both at runtime (as configIssues) and in the unit tests
 * against the TEST catalogue fixture.
 */
import type { EvaluatorRegistration } from "./needs-attention.ts";
import { STAFFING_EVALUATORS } from "./staffing.ts";
import { COVER_EVALUATOR } from "./cover.ts";

export const IMPLEMENTED_EVALUATORS: readonly EvaluatorRegistration[] = [...STAFFING_EVALUATORS, COVER_EVALUATOR];

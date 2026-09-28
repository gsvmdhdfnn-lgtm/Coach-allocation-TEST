/**
 * Test-suite copy of the canonical needs-attention/registry.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./needs-attention|repository|registry|staffing|cover|compliance|exceptions|lock-client.ts become needs-attention-*.ts.
 */
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
 * loads the union of runnable sources once each. Slice 6 adds the three
 * compliance rules (compliance.ts): coach_compliance_expiry and
 * compliance_verification_pending share one memoised compliance pass;
 * non_compliant_coach_assigned combines that pass with the shared staffing
 * pass. Later slices append their own registrations; gated-off rules never
 * cause any domain read.
 *
 * Drift protection: validateRegistry() (needs-attention.ts) reports
 * duplicate registrations, registrations with no catalogue row, and Rule
 * ID mismatches - both at runtime (as configIssues) and in the unit tests
 * against the TEST catalogue fixture.
 */
import type { EvaluatorRegistration } from "./needs-attention-engine.ts";
import { STAFFING_EVALUATORS } from "./needs-attention-staffing.ts";
import { COVER_EVALUATOR } from "./needs-attention-cover.ts";
import { COMPLIANCE_EVALUATORS } from "./needs-attention-compliance.ts";

export const IMPLEMENTED_EVALUATORS: readonly EvaluatorRegistration[] = [...STAFFING_EVALUATORS, COVER_EVALUATOR, ...COMPLIANCE_EVALUATORS];

/**
 * Parent identity resolution for parent-hub (whole-backend audit P1-2).
 *
 * The authenticated Supabase user id is the identity. The Parents &
 * Guardians record in Airtable is the operational Parent, found by its
 * "Supabase User ID". `profiles.airtable_person_id` holds the same link
 * from the Supabase side (the field Coach approval writes for coaches).
 *
 * The old find-then-create had no serialisation, so two first requests
 * from one new parent could both find nothing and both create a record.
 * That happened in TEST: two rows share Parent ID PARENT-ED3BDF220DC2.
 *
 * Now:
 *  1. Read-only first. Gather every Parent row owned by this user: the
 *     rows found by Supabase User ID, plus the row the profile already
 *     links to. Exactly one -> use it. More than one, or a profile link
 *     that points at a row this user does not own -> fail closed with
 *     `parent_id_ambiguous`. Never pick array[0].
 *  2. None -> take the `parent_identity_locks` lock for
 *     organisation_id + user_id, then repeat step 1 inside the lock.
 *  3. Still none -> the existing email compatibility path: one row with
 *     this email and no Supabase User ID is adopted. A row with this email
 *     that already belongs to another user is never taken over
 *     (`parent_id_ambiguous`). Otherwise create exactly one record.
 *  4. Record the link on the profile before releasing the lock. Later
 *     callers then find the record through the profile even if they
 *     arrive straight away.
 *
 * A create that fails with an unclear outcome (the record may exist) is
 * re-read inside the lock before the error is returned, so a retry never
 * adds a second record. The lock is always released.
 *
 * Portable: plain fetch only, so the deployed function (Deno) and the
 * tests (Node) run this same file.
 */

export type ParentRecord = { id: string; fields: Record<string, any>; createdTime?: string };

export class ParentIdentityError extends Error {
  code: string;
  status: number;
  reason: string;
  constructor(code: string, status: number, reason: string) {
    super(`${code}: ${reason}`);
    this.name = "ParentIdentityError";
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

export interface ParentStore {
  findByUserId(userId: string): Promise<ParentRecord[]>;
  findByEmail(email: string): Promise<ParentRecord[]>;
  findByParentId(parentId: string): Promise<ParentRecord[]>;
  /** The record, or null when it does not exist. */
  get(recordId: string): Promise<ParentRecord | null>;
  create(fields: Record<string, unknown>): Promise<ParentRecord>;
  setUserId(recordId: string, userId: string): Promise<void>;
}

export interface ProfileLinkStore {
  /** profiles.airtable_person_id for this user (null when empty). */
  read(userId: string): Promise<string | null>;
  /** Sets airtable_person_id only while it is empty; returns the value stored afterwards. */
  fillIfEmpty(userId: string, recordId: string): Promise<string | null>;
}

export interface ParentIdentityLock {
  acquire(organisationId: string, userId: string): Promise<string | null>;
  release(organisationId: string, userId: string, token: string): Promise<boolean>;
}

export interface ParentIdentityDeps {
  parents: ParentStore;
  profiles: ProfileLinkStore;
  lock: ParentIdentityLock;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** Lock wait: attempts x interval. Defaults 24 x 250 ms (about 6 s). */
  lockAttempts?: number;
  lockIntervalMs?: number;
}

export interface ParentCaller {
  userId: string;
  email: string;
  organisationId: string;
}

const AMBIGUOUS_MESSAGE = "We couldn't match your account to a single parent record. Please contact us so we can fix this.";
const BUSY_MESSAGE = "Your account is still being set up. Please try again in a moment.";

function ambiguous(reason: string): ParentIdentityError {
  return new ParentIdentityError("parent_id_ambiguous", 409, reason);
}

const NO_ORGANISATION_MESSAGE = "Your account isn't linked to an organisation yet. Please contact us.";

export function parentErrorBody(err: ParentIdentityError): { error: string; code: string } {
  const message = err.code === "parent_identity_busy" ? BUSY_MESSAGE : err.code === "organisation_missing" ? NO_ORGANISATION_MESSAGE : AMBIGUOUS_MESSAGE;
  return { error: message, code: err.code };
}

export function makeParentId(userId: string): string {
  return "PARENT-" + userId.replace(/-/g, "").toUpperCase().slice(0, 12);
}

function ownedBy(record: ParentRecord, userId: string): boolean {
  return String(record.fields["Supabase User ID"] || "") === userId;
}

/** Every Parent row this user owns, checked against the profile link. Read-only. */
async function ownedRecords(deps: ParentIdentityDeps, userId: string): Promise<{ records: ParentRecord[]; link: string | null }> {
  const [link, found] = await Promise.all([deps.profiles.read(userId), deps.parents.findByUserId(userId)]);
  const byId = new Map<string, ParentRecord>();
  for (const r of found) if (ownedBy(r, userId)) byId.set(r.id, r);
  if (link && !byId.has(link)) {
    const linked = await deps.parents.get(link);
    if (!linked || !ownedBy(linked, userId)) throw ambiguous("profile_link_mismatch");
    byId.set(linked.id, linked);
  }
  return { records: [...byId.values()], link };
}

async function ensureProfileLink(deps: ParentIdentityDeps, userId: string, recordId: string, current: string | null): Promise<void> {
  if (current === recordId) return;
  const stored = await deps.profiles.fillIfEmpty(userId, recordId);
  if (stored !== recordId) throw ambiguous("profile_link_mismatch");
}

/** Read-only resolution: the one owned record, null when none, or an ambiguity error. */
async function resolveExisting(deps: ParentIdentityDeps, userId: string): Promise<ParentRecord | null> {
  const { records, link } = await ownedRecords(deps, userId);
  if (records.length > 1) throw ambiguous("multiple_parent_records");
  if (records.length === 0) return null;
  await ensureProfileLink(deps, userId, records[0].id, link);
  return records[0];
}

async function acquireWithWait(deps: ParentIdentityDeps, caller: ParentCaller): Promise<string> {
  const attempts = deps.lockAttempts ?? 24;
  const interval = deps.lockIntervalMs ?? 250;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    const token = await deps.lock.acquire(caller.organisationId, caller.userId);
    if (token) return token;
    await sleep(interval);
  }
  throw new ParentIdentityError("parent_identity_busy", 409, "lock_wait_timeout");
}

async function uniqueParentId(deps: ParentIdentityDeps, userId: string): Promise<string> {
  const base = makeParentId(userId);
  let candidate = base;
  for (let attempt = 0; attempt < 6; attempt++) {
    const matches = await deps.parents.findByParentId(candidate);
    if (!matches.length) return candidate;
    candidate = `${base}-${attempt + 1}`;
  }
  throw new Error("Could not generate a unique Parent ID");
}

/**
 * The single Parent record for this authenticated user, creating it at
 * most once. Throws ParentIdentityError (409) when ownership is ambiguous
 * or the lock stays busy.
 */
export async function resolveParentIdentity(deps: ParentIdentityDeps, caller: ParentCaller): Promise<ParentRecord> {
  if (!caller.userId) throw new Error("resolveParentIdentity needs a user id");
  if (!caller.organisationId) throw new ParentIdentityError("organisation_missing", 403, "profile_has_no_organisation");

  const existing = await resolveExisting(deps, caller.userId);
  if (existing) return existing;

  const token = await acquireWithWait(deps, caller);
  try {
    const again = await resolveExisting(deps, caller.userId);
    if (again) return again;

    let record: ParentRecord | null = null;
    if (caller.email) {
      const byEmail = await deps.parents.findByEmail(caller.email);
      if (byEmail.length === 1) {
        const owner = String(byEmail[0].fields["Supabase User ID"] || "");
        if (owner && owner !== caller.userId) throw ambiguous("email_record_owned_by_another_user");
        if (!owner) await deps.parents.setUserId(byEmail[0].id, caller.userId);
        record = { ...byEmail[0], fields: { ...byEmail[0].fields, "Supabase User ID": caller.userId } };
      }
    }

    if (!record) {
      const parentId = await uniqueParentId(deps, caller.userId);
      try {
        record = await deps.parents.create({
          "Parent / Guardian Name": caller.email ? caller.email.split("@")[0] : "New Parent",
          "Parent ID": parentId,
          ...(caller.email ? { Email: caller.email } : {}),
          "Supabase User ID": caller.userId,
          Active: true,
        });
      } catch (createError) {
        // The create may have landed even though it reported failure.
        // Re-read inside the lock: adopt it if it is there, never create twice.
        const recovered = await resolveExisting(deps, caller.userId).catch((e) => {
          if (e instanceof ParentIdentityError) throw e;
          return null;
        });
        if (recovered) return recovered;
        throw createError;
      }
    }

    await ensureProfileLink(deps, caller.userId, record.id, null);
    return record;
  } finally {
    try {
      await deps.lock.release(caller.organisationId, caller.userId, token);
    } catch (e) {
      deps.log?.(`parent identity lock release failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------
// Supabase adapters (PostgREST over plain fetch, service role).
// ---------------------------------------------------------------------

export interface SupabaseServiceConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
}

function serviceHeaders(config: SupabaseServiceConfig): Record<string, string> {
  return {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

async function rpc(config: SupabaseServiceConfig, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: serviceHeaders(config),
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Supabase RPC ${fn} error: ${res.status} ${await res.text()}`);
  return res.json();
}

export function createParentIdentityLock(config: SupabaseServiceConfig): ParentIdentityLock {
  return {
    async acquire(organisationId, userId) {
      const result = await rpc(config, "acquire_parent_identity_lock", { p_organisation_id: organisationId, p_user_id: userId });
      return typeof result === "string" && result ? result : null;
    },
    async release(organisationId, userId, token) {
      const result = await rpc(config, "release_parent_identity_lock", { p_organisation_id: organisationId, p_user_id: userId, p_lock_token: token });
      return result === true;
    },
  };
}

export function createProfileLinkStore(config: SupabaseServiceConfig): ProfileLinkStore {
  const url = (userId: string) => `${config.supabaseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}`;
  async function read(userId: string): Promise<string | null> {
    const res = await fetch(`${url(userId)}&select=airtable_person_id`, { headers: serviceHeaders(config) });
    if (!res.ok) throw new Error(`profiles read error: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error("profiles read did not return exactly one row");
    return rows[0].airtable_person_id || null;
  }
  return {
    read,
    async fillIfEmpty(userId, recordId) {
      const res = await fetch(`${url(userId)}&airtable_person_id=is.null`, {
        method: "PATCH",
        headers: { ...serviceHeaders(config), Prefer: "return=minimal" },
        body: JSON.stringify({ airtable_person_id: recordId }),
      });
      if (!res.ok) throw new Error(`profiles link write error: ${res.status} ${await res.text()}`);
      return read(userId);
    },
  };
}

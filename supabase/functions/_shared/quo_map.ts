// Quo records -> communications rows. Message text is reduced to two short
// fingerprints (used to recognise the automated lead text) and then dropped.
import { normalizePhone } from "./mapping.ts";

const isPhone = (s: unknown): s is string => typeof s === "string" && /^\+?\d{10,15}$/.test(s.replace(/[^\d+]/g, ""));
const e164 = (s: string | null | undefined) => (isPhone(s) ? normalizePhone(s) : null);

/** First outside number on the conversation (not one of our Quo lines). */
export function externalNumber(candidates: (string | null | undefined)[], ours: Set<string>): string | null {
  for (const c of candidates) {
    const p = e164(c ?? null);
    if (p && !ours.has(p)) return p;
  }
  return null;
}

async function md5ish(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fingerprints of a text's wording, ignoring the first two words (greeting + name) and digits. */
export async function textFingerprints(text: string | null | undefined): Promise<{ head: string | null; tail: string | null }> {
  const words = (text ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length < 6) return { head: null, tail: null };
  return { head: await md5ish(words.slice(2, 10).join(" ")), tail: await md5ish(words.slice(-8).join(" ")) };
}

export function mapCall(c: any, ours: Set<string>) {
  const incoming = c.direction === "incoming";
  const external = externalNumber((c.participants ?? []).filter((p: any) => !p?.actorId).map((p: any) => p?.phoneNumber), ours)
    ?? externalNumber((c.participants ?? []).map((p: any) => p?.phoneNumber), ours);
  const who = incoming ? c.answeredBy : (c.initiatedBy ?? c.actorId);
  return {
    id: c.id,
    kind: "call",
    direction: incoming ? "inbound" : "outbound",
    status: c.status ?? null,
    answered: !!c.answeredAt,
    answered_at: c.answeredAt ?? null,
    completed_at: c.completedAt ?? null,
    occurred_at: c.createdAt,
    duration_sec: Number.isFinite(c.duration) ? c.duration : null,
    contact_phone: external,
    quo_user_id: typeof who === "string" && who.startsWith("US") ? who : null,
    phone_number_id: c.phoneNumberId ?? null,
    conversation_id: null,
    has_voicemail: !!c.voicemail,
    ai_handled: !!c.aiHandled || (typeof c.answeredBy === "string" && c.answeredBy.startsWith("SYU")),
    is_system: typeof who === "string" && who.startsWith("SYU"),
    text_head_hash: null,
    text_tail_hash: null,
    synced_at: new Date().toISOString(),
  };
}

export async function mapMessage(m: any, ours: Set<string>) {
  const incoming = m.direction === "incoming";
  const external = incoming ? externalNumber([m.from], ours) : externalNumber(m.to ?? [], ours);
  const fp = incoming ? { head: null, tail: null } : await textFingerprints(m.text);
  return {
    id: m.id,
    kind: "message",
    direction: incoming ? "inbound" : "outbound",
    status: m.status ?? null,
    answered: null,
    answered_at: null,
    completed_at: null,
    occurred_at: m.createdAt,
    duration_sec: null,
    contact_phone: external,
    quo_user_id: typeof m.userId === "string" && m.userId.startsWith("US") ? m.userId : null,
    phone_number_id: m.phoneNumberId ?? null,
    conversation_id: m.conversationId ?? null,
    has_voicemail: false,
    ai_handled: false,
    is_system: typeof m.userId === "string" && m.userId.startsWith("SYU"),
    text_head_hash: fp.head,
    text_tail_hash: fp.tail,
    synced_at: new Date().toISOString(),
  };
}

export const mapUser = (u: any) => ({
  id: u.id, email: u.email ?? null, role: u.role ?? null,
  name: [u.firstName, u.lastName].filter(Boolean).join(" ") || null, synced_at: new Date().toISOString(),
});
export const mapNumber = (p: any) => ({
  id: p.id, phone_number: normalizePhone(p.phoneNumber) ?? null, name: p.name ?? null, synced_at: new Date().toISOString(),
});

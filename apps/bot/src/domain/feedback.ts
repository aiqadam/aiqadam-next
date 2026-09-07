import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { feedback } from "../db/schema.js";

// docs/agents/design/REQ-031.md §2-§4 — field model, resumability
// derivation, validation, mutations, message render/parse pair. Framework-
// free (decisions/0004): no grammY import anywhere in this file. Every
// time-dependent write takes the write time as an explicit parameter
// (decisions/0006) — this file never calls SQL now()/current_timestamp
// inside a predicate (createdAt/updatedAt defaults are the exempted
// audit/bookkeeping case).

// ---------------------------------------------------------------------------
// §2.1 — fixed field order.
// ---------------------------------------------------------------------------
export type FeedbackField = "nps" | "liked" | "improve" | "topicVotes";
export const FEEDBACK_FIELD_ORDER: readonly FeedbackField[] = [
  "nps",
  "liked",
  "improve",
  "topicVotes",
];

export type FeedbackOptionalField = "liked" | "improve" | "topicVotes";

// ---------------------------------------------------------------------------
// §2.2 — reading current state and deriving the next step.
// ---------------------------------------------------------------------------
export interface FeedbackRecord {
  registrationId: string;
  nps: number | null;
  liked: string | null;
  improve: string | null;
  topicVotes: string[] | null;
  likedSkipped: boolean;
  improveSkipped: boolean;
  topicVotesSkipped: boolean;
}

export async function getFeedbackByRegistrationId(
  db: DbClient["db"],
  registrationId: string,
): Promise<FeedbackRecord | null> {
  const rows = await db
    .select({
      registrationId: feedback.registrationId,
      nps: feedback.nps,
      liked: feedback.liked,
      improve: feedback.improve,
      topicVotes: feedback.topicVotes,
      likedSkipped: feedback.likedSkipped,
      improveSkipped: feedback.improveSkipped,
      topicVotesSkipped: feedback.topicVotesSkipped,
    })
    .from(feedback)
    .where(eq(feedback.registrationId, registrationId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    ...row,
    topicVotes: (row.topicVotes as string[] | null) ?? null,
  };
}

export type FeedbackFieldStep = { kind: "field"; field: FeedbackField } | { kind: "complete" };

// §2.2's rule table, stated exactly (first-match-wins).
export function determineNextFeedbackField(feedback: FeedbackRecord | null): FeedbackFieldStep {
  if (feedback === null || feedback.nps === null) {
    return { kind: "field", field: "nps" };
  }
  if (feedback.liked === null && !feedback.likedSkipped) {
    return { kind: "field", field: "liked" };
  }
  if (feedback.improve === null && !feedback.improveSkipped) {
    return { kind: "field", field: "improve" };
  }
  if (feedback.topicVotes === null && !feedback.topicVotesSkipped) {
    return { kind: "field", field: "topicVotes" };
  }
  return { kind: "complete" };
}

// §2.2 — thin, separately named predicate. Never reimplements the table
// above independently.
export function isFeedbackComplete(feedback: FeedbackRecord | null): boolean {
  return determineNextFeedbackField(feedback).kind === "complete";
}

// ---------------------------------------------------------------------------
// §2.3 — writing the NPS answer, the one and only INSERT path.
// ---------------------------------------------------------------------------
export function isValidNpsValue(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 10;
}

export async function writeFeedbackNps(
  db: DbClient["db"],
  registrationId: string,
  nps: number,
  at: Date,
): Promise<void> {
  await db
    .insert(feedback)
    .values({ registrationId, nps, createdAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: feedback.registrationId,
      set: { nps, updatedAt: at },
    });
}

// ---------------------------------------------------------------------------
// §2.4 — writing an optional answer, or marking it skipped. UPDATE only,
// never INSERT — reachable, by §2.2's own ordering, only once a row already
// exists (nps answered).
// ---------------------------------------------------------------------------
export async function writeFeedbackOptionalField(
  db: DbClient["db"],
  registrationId: string,
  field: FeedbackOptionalField,
  value: string | string[],
  at: Date,
): Promise<void> {
  const skippedKey = `${field}Skipped` as const;
  await db
    .update(feedback)
    .set({ [field]: value, [skippedKey]: false, updatedAt: at } as Record<string, unknown>)
    .where(eq(feedback.registrationId, registrationId));
}

export async function markFeedbackFieldSkipped(
  db: DbClient["db"],
  registrationId: string,
  field: FeedbackOptionalField,
  at: Date,
): Promise<void> {
  const skippedKey = `${field}Skipped` as const;
  await db
    .update(feedback)
    .set({ [skippedKey]: true, updatedAt: at } as Record<string, unknown>)
    .where(eq(feedback.registrationId, registrationId));
}

// ---------------------------------------------------------------------------
// §2.7 — the composed flow step: layers the broadcast-opt-in ask on top of
// §2.2's field progression.
// ---------------------------------------------------------------------------
export type FeedbackFlowStep =
  | { kind: "feedback-field"; field: FeedbackField }
  | { kind: "broadcast-ask" }
  | { kind: "complete" };

export function determineFeedbackFlowStep(
  feedback: FeedbackRecord | null,
  broadcastOptInAskedAt: Date | null,
): FeedbackFlowStep {
  const fieldStep = determineNextFeedbackField(feedback);
  if (fieldStep.kind === "field") {
    return { kind: "feedback-field", field: fieldStep.field };
  }
  if (broadcastOptInAskedAt === null) {
    return { kind: "broadcast-ask" };
  }
  return { kind: "complete" };
}

// ---------------------------------------------------------------------------
// §3.1 — free-text prompts: force_reply, plus the disambiguating ref/field
// lines (§1.2). Both prefixes are fixed, not localized — machine-parseable
// anchors, the same treatment REQ-030 §7.1 gives its own "Name: "/
// "Company: "/"Phone: " prefixes (domain/walkin.ts).
// ---------------------------------------------------------------------------
export const FEEDBACK_REF_LINE_PREFIX = "Feedback ref: ";
export const FEEDBACK_FIELD_LINE_PREFIX = "Feedback field: ";

const FEEDBACK_OPTIONAL_FIELDS: readonly FeedbackOptionalField[] = [
  "liked",
  "improve",
  "topicVotes",
];

function isFeedbackOptionalField(value: string): value is FeedbackOptionalField {
  return (FEEDBACK_OPTIONAL_FIELDS as readonly string[]).includes(value);
}

export function formatFeedbackTextPrompt(
  promptBody: string,
  registrationId: string,
  field: FeedbackOptionalField,
): string {
  return [
    promptBody,
    "",
    `${FEEDBACK_REF_LINE_PREFIX}${registrationId}`,
    `${FEEDBACK_FIELD_LINE_PREFIX}${field}`,
  ].join("\n");
}

export type ParseFeedbackReplyResult =
  | { ok: true; registrationId: string; field: FeedbackOptionalField }
  | { ok: false };

export function parseFeedbackReplyContext(repliedToText: string): ParseFeedbackReplyResult {
  const lines = repliedToText.split("\n");
  const refLine = lines.find((line) => line.startsWith(FEEDBACK_REF_LINE_PREFIX));
  const fieldLine = lines.find((line) => line.startsWith(FEEDBACK_FIELD_LINE_PREFIX));
  if (refLine === undefined || fieldLine === undefined) {
    return { ok: false };
  }

  const registrationId = refLine.slice(FEEDBACK_REF_LINE_PREFIX.length).trim();
  const rawField = fieldLine.slice(FEEDBACK_FIELD_LINE_PREFIX.length).trim();
  if (!isFeedbackOptionalField(rawField)) {
    return { ok: false };
  }

  return { ok: true, registrationId, field: rawField };
}

// ---------------------------------------------------------------------------
// §3.4 — parsing a free-text answer for topicVotes.
// ---------------------------------------------------------------------------
export function parseTopicVotes(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

// ---------------------------------------------------------------------------
// §4 — skip-token matching, one rule reused for all three optional fields.
// ---------------------------------------------------------------------------
export function isFeedbackSkipReply(text: string, skipKeyword: string): boolean {
  return text.trim().toLowerCase() === skipKeyword.trim().toLowerCase();
}

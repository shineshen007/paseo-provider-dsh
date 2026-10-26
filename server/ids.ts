/**
 * Identity helpers shared by both halves.
 *
 * Paseo and DSH each mint ids. The mapping rules here exist so the two
 * namespaces never get confused: a DSH session id is always the authoritative
 * `session-<uuid>` string, and Paseo-side ids are derived deterministically from
 * it so a restart recreates the same keys instead of duplicating rows.
 */

import { randomUUID } from "node:crypto";

/** DSH session identity shape. */
const DSH_SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a string is a well-formed DSH session id. */
export function isDshSessionId(value: string): boolean {
  return DSH_SESSION_ID.test(value);
}

/** Mint a fresh DSH session id. */
export function newDshSessionId(): string {
  return `session-${randomUUID()}`;
}

/** Stable Paseo timeline id for one DSH assistant attempt. */
export function assistantItemId(dshSessionId: string, attemptId: string): string {
  return `dsh:${dshSessionId}:assistant:${attemptId}`;
}

/** Stable Paseo timeline id for one DSH reasoning attempt. */
export function reasoningItemId(dshSessionId: string, attemptId: string): string {
  return `dsh:${dshSessionId}:reasoning:${attemptId}`;
}

/** Stable Paseo timeline id for one DSH tool call. */
export function toolItemId(dshSessionId: string, toolCallId: string): string {
  return `dsh:${dshSessionId}:tool:${toolCallId}`;
}

/** Stable Paseo permission request id for one DSH approval id. */
export function permissionId(dshSessionId: string, approvalId: string): string {
  return `dsh:${dshSessionId}:permission:${approvalId}`;
}

/** Stable Paseo permission request id for one DSH question id. */
export function questionId(dshSessionId: string, questionRequestId: string): string {
  return `dsh:${dshSessionId}:question:${questionRequestId}`;
}

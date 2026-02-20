import { nanoid } from "nanoid";

export function generateSessionId(): string {
  return `ses_${nanoid(21)}`;
}

export function generateTraceId(): string {
  return `tr_${nanoid(21)}`;
}

export function generateEventId(): string {
  return crypto.randomUUID();
}

import type { ExtractedSpan } from "./maintenance-extraction";
export type RelationFinding = { span: ExtractedSpan; subject: ExtractedSpan & { type: string }; predicate: ExtractedSpan; object: ExtractedSpan & { type: string }; confidence: number; validFrom?: string; validUntil?: string };
export type RelationDetails = { subject: string; subjectType: string; predicate: string; object: string; objectType: string; confidence: number; validFrom?: string; validUntil?: string };
function checkedSpan(input: unknown, content: string, within?: ExtractedSpan, maximum = 128): ExtractedSpan {
 const value = input as ExtractedSpan;
 if (!value || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || value.start < (within?.start ?? 0) || value.end > (within?.end ?? content.length) || value.end <= value.start || value.end - value.start > maximum || !content.slice(value.start, value.end).trim() || Buffer.from(content.slice(value.start, value.end), "utf8").toString("utf8") !== content.slice(value.start, value.end)) throw new Error("Relationship extraction returned an invalid source span.");
 return { start: value.start, end: value.end };
}
export function validateRelationFindings(input: unknown, content: string): RelationFinding[] {
 if (input === undefined) return [];
 if (!Array.isArray(input) || input.length > 10) throw new Error("Relationship extraction exceeded its ten item budget.");
 const result: RelationFinding[] = [];
 for (const item of input) {
  const value = item as RelationFinding;
  const span = checkedSpan(value?.span, content, undefined, 2000);
  const subject = checkedSpan(value.subject, content, span), object = checkedSpan(value.object, content, span), predicate = checkedSpan(value.predicate, content, span);
  for (const entity of [value.subject, value.object]) if (!["person", "organization", "project", "place", "other"].includes(entity.type)) throw new Error("Relationship extraction returned an invalid entity type.");
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new Error("Relationship extraction returned invalid confidence.");
  const dates: { validFrom?: string; validUntil?: string } = {};
  for (const name of ["validFrom", "validUntil"] as const) if (value[name] !== undefined) {
   const date = value[name]!;
   if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(date) || !Number.isFinite(Date.parse(date)) || !content.slice(span.start, span.end).includes(date)) throw new Error("Relationship validity must appear literally in its source span.");
   dates[name] = date;
  }
  if (dates.validFrom && dates.validUntil && Date.parse(dates.validUntil) <= Date.parse(dates.validFrom)) throw new Error("Relationship validity interval is empty.");
  const finding: RelationFinding = { span, subject: { ...subject, type: value.subject.type }, predicate, object: { ...object, type: value.object.type }, confidence: value.confidence, ...dates };
  if (!result.some((prior) => JSON.stringify(prior) === JSON.stringify(finding))) result.push(finding);
 }
 return result.sort((a, b) => a.span.start - b.span.start || a.subject.start - b.subject.start || a.object.start - b.object.start);
}
export function relationDetails(value: RelationFinding, content: string): RelationDetails {
 return { subject: content.slice(value.subject.start, value.subject.end).trim(), subjectType: value.subject.type, predicate: content.slice(value.predicate.start, value.predicate.end).trim(), object: content.slice(value.object.start, value.object.end).trim(), objectType: value.object.type, confidence: value.confidence, ...(value.validFrom ? { validFrom: value.validFrom } : {}), ...(value.validUntil ? { validUntil: value.validUntil } : {}) };
}

import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "sources", "generic-imports"].join(String.fromCharCode(47));
const { importEml, importIcs, importMbox, importMeeting } = await import(modulePath);

describe("generic source imports", () => {
	test("normalizes EML, ICS, and JSON meeting records", () => {
		const email = importEml("Message-ID: <one@example.test>\nSubject: Hello\nFrom: sender@example.test\n\nBody");
		expect(email).toMatchObject({ externalId: "<one@example.test>", suggestedPath: expect.stringContaining("email") });
		expect(email.content).toContain("Body");
		const events = importIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:event-1\nSUMMARY:Standup\nDTSTART:20260101T100000Z\nEND:VEVENT\nEND:VCALENDAR");
		expect(events).toMatchObject([{ externalId: "event-1", content: expect.stringContaining("Standup") }]);
		const meeting = importMeeting(JSON.stringify({ id: "meeting-1", title: "Planning", transcript: "Decisions" }));
		expect(meeting).toMatchObject({ externalId: "meeting-1", content: expect.stringContaining("Decisions") });
	});

	test("normalizes MBOX messages while retaining stable message identities", () => {
		const messages = importMbox("From sender@example.test Fri Jan 01 00:00:00 2026\nMessage-ID: <one@example.test>\nSubject: First\n\nOne\nFrom sender@example.test Fri Jan 02 00:00:00 2026\nMessage-ID: <two@example.test>\nSubject: Second\n\nTwo\n");
		expect(messages).toMatchObject([
			{ externalId: "<one@example.test>", provenance: { sourceType: "email:mbox" }, content: expect.stringContaining("One") },
			{ externalId: "<two@example.test>", provenance: { sourceType: "email:mbox" }, content: expect.stringContaining("Two") },
		]);
	});
});

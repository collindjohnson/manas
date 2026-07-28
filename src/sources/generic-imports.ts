import { createHash } from "node:crypto";

type ImportedDocument = {
	externalId: string;
	suggestedPath: string;
	content: string;
	provenance: { sourceType: string; retrievedAt: string; metadata?: Record<string, string> };
	deleted: boolean;
};

function id(prefix: string, value: string): string {
	return createHash("sha256").update(`${prefix}\0${value}`).digest("hex");
}

function header(text: string, name: string): string | undefined {
	const line = text.split("\n").find((value) => value.toLowerCase().startsWith(`${name.toLowerCase()}:`));
	return line?.slice(name.length + 1).trim();
}

export function importEml(text: string): ImportedDocument {
	const separator = text.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
	const [headers = "", ...body] = text.split(separator);
	const subject = header(headers, "Subject") ?? "Untitled email";
	const messageId = header(headers, "Message-ID") ?? id("email", text);
	return {
		externalId: messageId,
		suggestedPath: `email/${id("email-path", messageId)}.md`,
		content: `# ${subject}\n\n${body.join(separator).trim()}\n`,
		provenance: { sourceType: "email:eml", retrievedAt: new Date().toISOString(), metadata: Object.fromEntries([["from", header(headers, "From")], ["to", header(headers, "To")], ["date", header(headers, "Date")]].filter(([, value]) => Boolean(value)) as Array<[string, string]>) },
		deleted: false,
	};
}

export function importMbox(text: string): ImportedDocument[] {
	const messages: string[][] = [];
	let current: string[] | undefined;
	for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
		if (line.startsWith("From ")) { current = []; messages.push(current); continue; }
		current?.push(line);
	}
	if (!messages.length) {
		if (!text.trim()) return [];
		const document = importEml(text);
		return [{ ...document, provenance: { ...document.provenance, sourceType: "email:mbox" } }];
	}
	return messages.map((message) => {
		const document = importEml(message.join("\n").trimEnd());
		return { ...document, provenance: { ...document.provenance, sourceType: "email:mbox" } };
	});
}

export function importIcs(text: string): ImportedDocument[] {
	return text.split("BEGIN:VEVENT").slice(1).map((section) => {
		const end = section.indexOf("END:VEVENT");
		const event = end >= 0 ? section.slice(0, end) : section;
		const uid = header(event, "UID") ?? id("calendar", event);
		const summary = header(event, "SUMMARY") ?? "Untitled event";
		const start = header(event, "DTSTART");
		const description = header(event, "DESCRIPTION") ?? "";
		return {
			externalId: uid,
			suggestedPath: `meetings/${id("calendar-path", uid)}.md`,
			content: `# ${summary}\n\n${start ? `When: ${start}\n\n` : ""}${description.replaceAll("\\n", "\n")}\n`,
			provenance: { sourceType: "calendar:ics", retrievedAt: new Date().toISOString() },
			deleted: false,
		};
	});
}

export function importMeeting(value: string): ImportedDocument {
	let title = "Meeting";
	let content = value;
	try {
		const parsed = JSON.parse(value) as { title?: unknown; transcript?: unknown; id?: unknown };
		if (typeof parsed.title === "string") title = parsed.title;
		if (typeof parsed.transcript === "string") content = parsed.transcript;
		if (typeof parsed.id === "string") return { externalId: parsed.id, suggestedPath: `meetings/${id("meeting-path", parsed.id)}.md`, content: `# ${title}\n\n${content}\n`, provenance: { sourceType: "meeting:json", retrievedAt: new Date().toISOString() }, deleted: false };
	} catch { title = value.split("\n").find((line) => line.startsWith("# "))?.slice(2) ?? title; }
	const externalId = id("meeting", value);
	return { externalId, suggestedPath: `meetings/${id("meeting-path", externalId)}.md`, content: `# ${title}\n\n${content}\n`, provenance: { sourceType: "meeting:markdown", retrievedAt: new Date().toISOString() }, deleted: false };
}

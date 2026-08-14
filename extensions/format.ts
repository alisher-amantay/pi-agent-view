/** Shared formatting helpers for the agent view components. */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function formatAge(timestamp: number): string {
	const diffMs = Date.now() - timestamp;
	const mins = Math.floor(diffMs / 60_000);
	const hours = Math.floor(diffMs / 3_600_000);
	const days = Math.floor(diffMs / 86_400_000);
	if (mins < 1) return "now";
	if (mins < 60) return `${mins}m`;
	if (hours < 24) return `${hours}h`;
	if (days < 7) return `${days}d`;
	return `${Math.floor(days / 7)}w`;
}

/** Pad a line to exactly `width` so an overlay fully covers what is underneath. */
export function padToWidth(line: string, width: number): string {
	const clipped = truncateToWidth(line, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Build an opaque full-screen frame from content lines. */
export function opaqueFrame(lines: string[], width: number, rows: number): string[] {
	const framed = lines.map((line) => padToWidth(line, width));
	while (framed.length < rows) framed.push(" ".repeat(width));
	return framed.slice(0, rows);
}

/** Wrap plain text to a width, preserving explicit newlines. */
export function wrapPlain(text: string, width: number): string[] {
	const out: string[] = [];
	for (const rawLine of text.split("\n")) {
		if (rawLine.length === 0) {
			out.push("");
			continue;
		}
		let line = "";
		for (const word of rawLine.split(/\s+/)) {
			if (line.length === 0) {
				line = word;
			} else if (line.length + 1 + word.length <= width) {
				line = `${line} ${word}`;
			} else {
				out.push(line);
				line = word;
			}
			while (line.length > width) {
				out.push(line.slice(0, width));
				line = line.slice(width);
			}
		}
		if (line.length > 0) out.push(line);
	}
	return out;
}

export function terminalRows(): number {
	return Math.max(12, process.stdout.rows ?? 24);
}

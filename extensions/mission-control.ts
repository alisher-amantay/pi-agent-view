/** Mission control — one screen listing every live session in this pi process. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	type KeybindingsManager,
	matchesKey,
	type OverlayHandle,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { formatAge, opaqueFrame, terminalRows } from "./format.ts";
import type { AgentHost, LiveSession } from "./host.ts";

/** A transcript on disk that is not live in this process. */
export interface DormantSession {
	/** Session file path — the handle used to bring it back. */
	path: string;
	id: string;
	name: string;
	modified: number;
}

export type MissionControlResult =
	| { type: "activate"; id: string }
	| { type: "spawn"; prompt: string }
	| { type: "resume"; session: DormantSession }
	| { type: "dismiss" };

type GroupKey = "working" | "unread" | "read" | "dormant";

/** Order the groups are laid out in, top to bottom. */
const GROUP_ORDER: GroupKey[] = ["working", "unread", "read", "dormant"];

/** How many on-disk sessions to offer. Older ones stay reachable via `/resume`. */
const MAX_DORMANT_ROWS = 20;

const GROUP_TITLE: Record<GroupKey, string> = {
	working: "Working",
	unread: "Unread",
	read: "Read",
	dormant: "On disk",
};
const GROUP_ICON: Record<GroupKey, string> = {
	working: "✽",
	unread: "●",
	read: "·",
	dormant: "○",
};

interface Row {
	kind: "header" | "session";
	group: GroupKey;
	label: string;
	/** Stable identity, used to keep the cursor on the same entry across rebuilds. */
	key?: string;
	session?: LiveSession;
	dormant?: DormantSession;
}

function rowTimestamp(row: Row): number {
	return row.session?.lastActivityAt ?? row.dormant?.modified ?? 0;
}

function groupOf(session: LiveSession): GroupKey {
	if (session.activity === "working") return "working";
	return session.unread ? "unread" : "read";
}

export class MissionControlComponent implements Component, Focusable {
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private requestRender: () => void;
	private done: (result: MissionControlResult) => void;
	private host: AgentHost;
	private activeId: string;

	private dormant: DormantSession[] = [];
	private loadingDormant = true;
	private rows: Row[] = [];
	private selectedIndex = 0;
	private scrollOffset = 0;
	private input = new Input();
	private statusMessage: string | null = null;
	private confirmingStopId: string | null = null;
	private unsubscribe: () => void;
	private ticker: ReturnType<typeof setInterval>;
	private focusPin: ReturnType<typeof setInterval> | null = null;
	private _focused = false;

	constructor(options: {
		theme: Theme;
		keybindings: KeybindingsManager;
		requestRender: () => void;
		done: (result: MissionControlResult) => void;
		host: AgentHost;
		activeId: string;
		loadDormant: () => Promise<DormantSession[]>;
	}) {
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.requestRender = options.requestRender;
		this.done = options.done;
		this.host = options.host;
		this.activeId = options.activeId;

		this.input.onSubmit = () => this.submit();
		this.input.onEscape = () => this.done({ type: "dismiss" });

		this.unsubscribe = this.host.subscribe(() => {
			this.rebuild();
			this.requestRender();
		});
		// Scanning the session directory is I/O: the live list renders immediately
		// and the on-disk group fills in when it arrives.
		void options
			.loadDormant()
			.then((sessions) => {
				this.dormant = sessions;
			})
			.catch((error: unknown) => {
				this.statusMessage = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				this.loadingDormant = false;
				this.rebuild();
				this.requestRender();
			});
		// Keeps ages and activity fresh even when no event fires.
		this.ticker = setInterval(() => {
			this.rebuild();
			this.requestRender();
		}, 1000);

		this.rebuild();
	}

	/** Keep reclaiming overlay focus until this view is closed. */
	attachOverlay(overlay: OverlayHandle): void {
		if (this.focusPin) clearInterval(this.focusPin);
		const pin = () => {
			if (!overlay.isFocused()) overlay.focus();
		};
		pin();
		this.focusPin = setInterval(pin, 50);
		this.focusPin.unref?.();
	}

	dispose(): void {
		this.unsubscribe();
		clearInterval(this.ticker);
		if (this.focusPin) clearInterval(this.focusPin);
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	invalidate(): void {}

	private rebuild(): void {
		const query = this.input.getValue().trim().toLowerCase();
		const buckets: Record<GroupKey, Row[]> = { working: [], unread: [], read: [], dormant: [] };

		const liveSessionIds = new Set<string>();
		for (const session of this.host.list()) {
			if (session.sessionId) liveSessionIds.add(session.sessionId);
			if (query.length > 0 && !session.name.toLowerCase().includes(query)) continue;
			const group = groupOf(session);
			buckets[group].push({ kind: "session", group, label: session.name, key: session.id, session });
		}

		for (const dormant of this.dormant) {
			// A transcript that is already live belongs to its live row, not here.
			if (liveSessionIds.has(dormant.id)) continue;
			if (query.length > 0 && !dormant.name.toLowerCase().includes(query)) continue;
			buckets.dormant.push({ kind: "session", group: "dormant", label: dormant.name, key: dormant.path, dormant });
		}

		for (const key of GROUP_ORDER) {
			buckets[key].sort((a, b) => rowTimestamp(b) - rowTimestamp(a));
		}
		buckets.dormant = buckets.dormant.slice(0, MAX_DORMANT_ROWS);

		const previousKey = this.rows[this.selectedIndex]?.key;

		this.rows = [];
		for (const key of GROUP_ORDER) {
			const items = buckets[key];
			// The on-disk group is noise until it has something to offer.
			if (key === "dormant" && items.length === 0) continue;
			this.rows.push({ kind: "header", group: key, label: `${GROUP_TITLE[key]}  (${items.length})` });
			this.rows.push(...items);
		}

		let next = this.rows.findIndex((row) => row.key !== undefined && row.key === previousKey);
		if (next < 0) next = this.rows.findIndex((row) => row.kind === "session");
		this.selectedIndex = Math.max(0, next);
	}

	private selectableIndexes(): number[] {
		return this.rows.map((row, i) => (row.kind === "session" ? i : -1)).filter((i) => i >= 0);
	}

	private move(delta: number): void {
		const selectable = this.selectableIndexes();
		if (selectable.length === 0) return;
		const pos = selectable.indexOf(this.selectedIndex);
		const nextPos =
			pos < 0
				? delta >= 0
					? 0
					: selectable.length - 1
				: (pos + delta + selectable.length * 10) % selectable.length;
		this.selectedIndex = selectable[nextPos]!;
		this.requestRender();
	}

	private selectedRow(): Row | undefined {
		return this.rows[this.selectedIndex];
	}

	private selectedSession(): LiveSession | undefined {
		return this.rows[this.selectedIndex]?.session;
	}

	/** Enter: typed text always dispatches a new session, as it always has. */
	private submit(): void {
		const prompt = this.input.getValue().trim();
		if (prompt.length > 0) {
			this.done({ type: "spawn", prompt });
			return;
		}
		this.openSelection();
	}

	/** Right arrow: act on the highlighted row, even while a filter is typed. */
	private openSelection(): void {
		const dormant = this.selectedRow()?.dormant;
		if (dormant) {
			this.done({ type: "resume", session: dormant });
			return;
		}
		const session = this.selectedSession();
		if (!session) {
			this.done({ type: "dismiss" });
			return;
		}
		if (session.state === "error") {
			this.statusMessage = session.error ?? "Session failed to start";
			this.requestRender();
			return;
		}
		this.done({ type: "activate", id: session.id });
	}

	private stopOrConfirm(): void {
		const session = this.selectedSession();
		if (!session) {
			if (this.selectedRow()?.dormant) {
				this.statusMessage = "That session isn't running; press enter to bring it back";
				this.requestRender();
			}
			return;
		}
		if (session.kind === "host") {
			this.statusMessage = "The original session can't be stopped from here";
			this.requestRender();
			return;
		}
		if (this.confirmingStopId === session.id) {
			const id = session.id;
			this.confirmingStopId = null;
			this.statusMessage = "Stopping…";
			void this.host
				.stop(id)
				.then(() => {
					this.statusMessage = "Session stopped";
					this.rebuild();
					this.requestRender();
				})
				.catch((error: unknown) => {
					this.statusMessage = error instanceof Error ? error.message : String(error);
					this.requestRender();
				});
			this.requestRender();
			return;
		}
		this.confirmingStopId = session.id;
		this.statusMessage = "Press Ctrl+X again to stop this session";
		this.requestRender();
	}

	handleInput(data: string): void {
		const stopKey = matchesKey(data, Key.ctrl("x"));
		if (this.confirmingStopId && !stopKey) {
			this.confirmingStopId = null;
			this.statusMessage = null;
		}

		if (matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel")) {
			this.done({ type: "dismiss" });
			return;
		}
		if (matchesKey(data, Key.up) || this.keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down) || this.keybindings.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.move(-10);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.move(10);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.openSelection();
			return;
		}
		if (matchesKey(data, Key.enter) || this.keybindings.matches(data, "tui.select.confirm")) {
			this.submit();
			return;
		}
		if (stopKey) {
			this.stopOrConfirm();
			return;
		}

		const before = this.input.getValue();
		this.input.handleInput(data);
		if (before !== this.input.getValue()) this.rebuild();
		this.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const rows = terminalRows();
		const lines: string[] = [];

		const running = this.host.runningCount;
		const title = t.bold(t.fg("accent", "Agent view"));
		const right = truncateToWidth(
			running > 0 ? t.fg("accent", `${running} running`) : t.fg("dim", "all idle"),
			Math.floor(width * 0.4),
			"",
		);
		const left = truncateToWidth(title, Math.max(0, width - visibleWidth(right) - 1), "");
		lines.push(left + " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right))) + right);
		lines.push(
			t.fg("dim", truncateToWidth("Every session keeps running. Switching only moves the terminal.", width, "…")),
		);
		lines.push("");

		const footerReserve = 6;
		const body = Math.max(4, rows - 3 - footerReserve);

		if (!this.rows.some((row) => row.kind === "session")) {
			lines.push(
				t.fg(
					"muted",
					this.loadingDormant ? "  Loading sessions…" : "  No sessions. Type a task and press Enter to start one.",
				),
			);
		} else {
			if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
			else if (this.selectedIndex >= this.scrollOffset + body) {
				this.scrollOffset = this.selectedIndex - body + 1;
			}
			const end = Math.min(this.rows.length, this.scrollOffset + body);
			for (let i = this.scrollOffset; i < end; i++) {
				lines.push(this.renderRow(this.rows[i]!, i === this.selectedIndex, width));
			}
		}

		while (lines.length < 3 + body) lines.push("");

		lines.push("");
		lines.push(
			this.statusMessage
				? t.fg(this.confirmingStopId ? "error" : "accent", truncateToWidth(this.statusMessage, width, "…"))
				: "",
		);
		const label = t.fg("muted", "task / filter > ");
		const inputLines = this.input.render(Math.max(10, width - visibleWidth(label)));
		lines.push(label + (inputLines[0] ?? ""));

		lines.push("");
		lines.push(
			t.fg(
				"dim",
				truncateToWidth(
					"↑↓ move · enter switch (or dispatch with text) · → open selected · ctrl+x stop · esc stay",
					width,
					"…",
				),
			),
		);

		return opaqueFrame(lines, width, rows);
	}

	private renderRow(row: Row, selected: boolean, width: number): string {
		const t = this.theme;
		if (row.kind === "header") {
			const color = row.group === "working" ? "accent" : row.group === "unread" ? "warning" : "muted";
			return t.bold(t.fg(color, truncateToWidth(row.label, width, "…")));
		}

		if (row.dormant) return this.renderDormantRow(row.dormant, selected, width);

		const session = row.session!;
		const icon = GROUP_ICON[row.group];
		const cursor = selected ? t.fg("accent", "› ") : "  ";

		const tags: string[] = [];
		if (session.id === this.activeId) tags.push("current");
		if (session.kind === "host") tags.push("original");
		if (session.state === "error") tags.push("error");
		const right = `${tags.length ? `[${tags.join(",")}] ` : ""}${formatAge(session.lastActivityAt)}`;

		const available = width - 2 - visibleWidth(icon) - 1 - visibleWidth(right) - 2;
		const text = truncateToWidth(session.name, Math.max(8, available), "…");

		let styled: string;
		if (session.state === "error") styled = t.fg("error", text);
		else if (row.group === "working") styled = t.fg("accent", text);
		else if (row.group === "unread") styled = t.fg("text", text);
		else styled = t.fg("muted", text);
		if (this.confirmingStopId === session.id) styled = t.fg("error", text);
		if (selected) styled = t.bold(styled);

		const iconStyled =
			row.group === "working"
				? t.fg("accent", icon)
				: row.group === "unread"
					? t.fg("warning", icon)
					: t.fg("dim", icon);

		const leftPart = `${cursor}${iconStyled} ${styled}`;
		const gap = Math.max(1, width - visibleWidth(leftPart) - visibleWidth(right));
		const line = leftPart + " ".repeat(gap) + t.fg("dim", right);
		return selected ? t.bg("selectedBg", truncateToWidth(line, width, "")) : truncateToWidth(line, width, "");
	}

	/** An on-disk session: no live state to show, just a name and how stale it is. */
	private renderDormantRow(session: DormantSession, selected: boolean, width: number): string {
		const t = this.theme;
		const icon = t.fg("dim", GROUP_ICON.dormant);
		const cursor = selected ? t.fg("accent", "› ") : "  ";
		const right = formatAge(session.modified);

		const available = width - 2 - visibleWidth(icon) - 1 - visibleWidth(right) - 2;
		const text = truncateToWidth(session.name, Math.max(8, available), "…");
		const styled = selected ? t.bold(t.fg("muted", text)) : t.fg("muted", text);

		const leftPart = `${cursor}${icon} ${styled}`;
		const gap = Math.max(1, width - visibleWidth(leftPart) - visibleWidth(right));
		const line = leftPart + " ".repeat(gap) + t.fg("dim", right);
		return selected ? t.bg("selectedBg", truncateToWidth(line, width, "")) : truncateToWidth(line, width, "");
	}
}

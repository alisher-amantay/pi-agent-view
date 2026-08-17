/**
 * Agent view — mission control for truly parallel pi sessions.
 *
 * One pi process hosts several real `InteractiveMode` sessions at once. Exactly
 * one owns the terminal; the rest keep running in the background. Switching is
 * just a terminal handoff, so nothing is stopped, replaced, or lost.
 *
 * Entry points:
 *   /agents · /agent-view · Ctrl+Shift+A · ← on an empty prompt · `pi --agents`
 */

import { execSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, CustomEditor, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	type EditorTheme,
	Key,
	type KeybindingsManager,
	matchesKey,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";
import { type AgentHost, deriveName, getHost, type LiveSession } from "./host.ts";
import { type DormantSession, MissionControlComponent, type MissionControlResult } from "./mission-control.ts";

/** Name shown for a session before it has a user-supplied title. */
function hostName(ctx: ExtensionContext): string {
	const explicit = ctx.sessionManager.getSessionName();
	if (explicit) return explicit;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((part): part is { type: "text"; text: string } => part.type === "text")
						.map((part) => part.text)
						.join(" ");
		const trimmed = text.replace(/\s+/g, " ").trim();
		if (trimmed.length > 0) return deriveName(trimmed);
	}
	return "original session";
}

/**
 * Transcripts for this folder that exist on disk.
 *
 * The view filters out the ones that are already live, so what is left is the
 * set of sessions that can be brought back: work from an earlier pi process, or
 * anything that fell out of the registry.
 */
async function loadDormantSessions(ctx: ExtensionContext): Promise<DormantSession[]> {
	const sessions = await SessionManager.list(ctx.sessionManager.getCwd(), ctx.sessionManager.getSessionDir());
	return sessions
		.filter((info) => info.messageCount > 0)
		.map((info) => ({
			path: info.path,
			id: info.id,
			name: info.name?.trim() || deriveName(info.firstMessage),
			modified: info.modified.getTime(),
		}));
}

async function showMissionControl(ctx: ExtensionContext): Promise<MissionControlResult> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("Agent view requires interactive mode", "error");
		return { type: "dismiss" };
	}

	const host = getHost();
	const record = host.recordForSessionId(ctx.sessionManager.getSessionId());
	const activeId = record?.id ?? host.activeId;

	let component: MissionControlComponent | undefined;
	return await ctx.ui.custom<MissionControlResult>(
		(tui: TUI, theme: Theme, keybindings: KeybindingsManager, done) => {
			component = new MissionControlComponent({
				theme,
				keybindings,
				requestRender: () => tui.requestRender(),
				done,
				host,
				activeId,
				loadDormant: () => loadDormantSessions(ctx),
			});
			return component;
		},
		{
			overlay: true,
			overlayOptions: { width: "100%", row: 0, col: 0, margin: 0 },
			onHandle: (handle: OverlayHandle) => {
				component?.attachOverlay(handle);
			},
		},
	);
}

async function runMissionControl(ctx: ExtensionContext): Promise<void> {
	const host = getHost();
	const result = await showMissionControl(ctx);

	if (result.type === "dismiss") return;

	if (result.type === "spawn") {
		const name = deriveName(result.prompt);
		const created = await host.spawn({ cwd: ctx.cwd, name });
		await enter(ctx, host, created, "Failed to start session");
		return;
	}

	if (result.type === "resume") {
		const adopted = await host.adopt({
			cwd: ctx.cwd,
			sessionFile: result.session.path,
			name: result.session.name,
		});
		await enter(ctx, host, adopted, "Failed to bring that session back");
		return;
	}

	const target = host.get(result.id);
	if (!target) {
		ctx.ui.notify("Session no longer exists", "warning");
		await runMissionControl(ctx);
		return;
	}
	// Switching to the session we are already in is a no-op.
	if (target.id === (host.recordForSessionId(ctx.sessionManager.getSessionId())?.id ?? host.activeId)) {
		return;
	}
	await host.activateFrom(ctx, target.id);
}

/** Hand the terminal to a freshly created child, or report why we can't. */
async function enter(
	ctx: ExtensionContext,
	host: AgentHost,
	child: LiveSession,
	fallbackError: string,
): Promise<void> {
	if (child.state === "error") {
		ctx.ui.notify(child.error ?? fallbackError, "error");
		await runMissionControl(ctx);
		return;
	}
	await host.activateFrom(ctx, child.id);
}

function readClipboardText(): string {
	try {
		return execSync("pbpaste", { encoding: "utf8", timeout: 2000 });
	} catch {
		return "";
	}
}

interface EditorLike {
	getText(): string;
	insertTextAtCursor?(text: string): void;
	handleInput?(data: string): void;
	onSubmit?: (text: string) => void | Promise<void>;
}

/** True only for bare ←. Option/Command+← must keep moving the cursor. */
function isBareLeftArrow(data: string): boolean {
	return matchesKey(data, Key.left) && !matchesKey(data, Key.alt("left")) && !matchesKey(data, Key.ctrl("left")) && !matchesKey(data, Key.super("left"));
}

function handleEditorChords(editor: EditorLike, data: string): boolean {
	if (isBareLeftArrow(data) && editor.getText().length === 0) {
		void editor.onSubmit?.("/agents");
		return true;
	}
	if (matchesKey(data, Key.super("c"))) {
		const text = editor.getText();
		if (text) void copyToClipboard(text).catch(() => {});
		return true;
	}
	if (matchesKey(data, Key.super("v"))) {
		const text = readClipboardText();
		if (text) editor.insertTextAtCursor?.(text);
		return true;
	}
	return false;
}

/** Empty-prompt ← opens agent view; Option/Command chords stay normal editor keys. */
class AgentViewEditor extends CustomEditor {
	handleInput(data: string): void {
		if (handleEditorChords(this, data)) return;
		super.handleInput(data);
	}
}

function installBackArrow(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;

	const previous = ctx.ui.getEditorComponent();
	ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		if (previous) {
			const inner = previous(tui, theme, keybindings);
			const originalHandle = inner.handleInput?.bind(inner);
			inner.handleInput = (data: string) => {
				if (handleEditorChords(inner, data)) return;
				originalHandle?.(data);
			};
			return inner;
		}
		return new AgentViewEditor(tui, theme, keybindings);
	});

	ctx.ui.setStatus("agent-view", ctx.ui.theme.fg("dim", "← agents"));
}

export default function (pi: ExtensionAPI) {
	const host = getHost();

	pi.registerFlag("agents", {
		description: "Open agent view on startup",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("agents", {
		description: "Agent view — switch between parallel live sessions",
		handler: async (_args, ctx) => {
			await runMissionControl(ctx);
		},
	});

	pi.registerCommand("agent-view", {
		description: "Alias for /agents",
		handler: async (_args, ctx) => {
			await runMissionControl(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlShift("a"), {
		description: "Open agent view",
		handler: async (ctx) => {
			await runMissionControl(ctx);
		},
	});

	// Every live session loads this extension, so each one registers itself and
	// reports its own activity into the shared host.
	pi.on("session_start", (event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		installBackArrow(ctx);

		const sessionId = ctx.sessionManager.getSessionId();
		const existing = host.recordForSessionId(sessionId);
		if (existing) {
			if (existing.kind === "child" && existing.name.startsWith("new session")) {
				existing.name = hostName(ctx);
			}
			host.notify();
			return;
		}
		// First session in the process is the host/original one.
		host.ensureHostRecord({
			cwd: ctx.cwd,
			sessionId,
			sessionFile: ctx.sessionManager.getSessionFile(),
			name: hostName(ctx),
		});

		// Only open on an explicit `pi --agents`. Auto-opening on empty sessions
		// left a ghost overlay that stole Option/Command chords from the editor.
		if (pi.getFlag("agents") === true && event.reason === "startup") {
			setTimeout(() => {
				void runMissionControl(ctx);
			}, 50);
		}
	});

	pi.on("session_info_changed", (event, ctx) => {
		const record = host.recordForSessionId(ctx.sessionManager.getSessionId());
		if (record && event.name) {
			record.name = event.name;
			host.notify();
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		host.setActivity(ctx.sessionManager.getSessionId(), "working");
	});

	pi.on("agent_end", (_event, ctx) => {
		host.setActivity(ctx.sessionManager.getSessionId(), "idle");
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setStatus("agent-view", undefined);
	});
}

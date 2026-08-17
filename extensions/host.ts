/**
 * Live-session multiplexer.
 *
 * One pi process hosts several real `InteractiveMode` instances — the original
 * ("host") plus any number of children. Exactly one owns the terminal at a time.
 * Switching away calls `ui.stop()` on that TUI only; the agent runtime behind it
 * keeps running, so work continues while you are looking at another chat.
 *
 * This is why we do NOT use `ctx.newSession()` / `ctx.switchSession()`: those
 * replace pi's single active runtime, which tears down whatever was running.
 *
 * Approach follows the model proven by the `pi-parallel-sessions` package.
 */

import {
	type AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	getAgentDir,
	InteractiveMode,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";

export const HOST_ID = "__host__";

/**
 * Shape version of the live registry stored on `globalThis`.
 *
 * `/reload` re-evaluates this module, so a running pi process holds a registry
 * that was built by the *previous* copy of `AgentHost`. That copy is adopted as
 * is (see `getHost`), which is the only reason live sessions survive a reload.
 * Bump this only for a genuinely incompatible change to the class, and accept
 * that the bump orphans the children of any process that reloads into it.
 */
export const HOST_VERSION = 2;

export type Activity = "idle" | "working";
export type LiveState = "active" | "suspended" | "starting" | "stopped" | "error";

export interface LiveSession {
	id: string;
	kind: "host" | "child";
	name: string;
	cwd: string;
	state: LiveState;
	activity: Activity;
	/** Output arrived while this session did not own the terminal. */
	unread: boolean;
	createdAt: number;
	lastActivityAt: number;
	sessionId?: string;
	sessionFile?: string;
	error?: string;
	runtime?: AgentSessionRuntime;
	mode?: InteractiveMode;
	adapter?: ModeAdapter;
	sessionManager?: SessionManager;
	started?: boolean;
	expectedStop?: boolean;
	runPromise?: Promise<void>;
}

/**
 * Kitty/xterm extended keyboard modes are per-TUI. Reset them when handing the
 * terminal between TUIs or the next owner inherits a broken input mode.
 *
 * Use the same pop sequence TUI.stop() uses (`CSI < u`) and clear the process-
 * wide flag. Popping 999 times used to desync Cursor/VS Code: the terminal
 * stopped reporting Option/Command chords, so word-jump and Cmd+C/V died.
 */
function resetKeyboardModesForHandoff(): void {
	try {
		process.stdout.write("\x1b[<u\x1b[>4;0m");
		setKittyProtocolActive(false);
	} catch {
		// terminal may be gone; nothing to restore
	}
}

/**
 * The TUI handle owned by an `InteractiveMode`.
 *
 * `InteractiveMode.ui` is private in the type definitions but is the documented
 * handoff point at runtime, so it is reached through a narrow structural type
 * rather than `any`.
 */
interface ModeTui {
	start?: () => void;
	stop?: () => void;
	requestRender?: (force?: boolean) => void;
	terminal?: {
		setProgress?: (active: boolean) => void;
		setTitle?: (title: string) => void;
	};
}

/** Owns start/suspend/resume for one child `InteractiveMode`. */
class ModeAdapter {
	state: "never-started" | "active" | "suspended" | "stopped" = "never-started";
	private gateInstalled = false;
	private originalSetProgress?: (active: boolean) => void;
	private originalSetTitle?: (title: string) => void;

	constructor(
		readonly id: string,
		readonly runtime: AgentSessionRuntime,
		readonly mode: InteractiveMode,
		private readonly host: AgentHost,
	) {}

	private get ui(): ModeTui | undefined {
		return (this.mode as unknown as { ui?: ModeTui }).ui;
	}

	/** Suppress terminal-wide effects from sessions that are not in front. */
	private installTerminalGate(): void {
		if (this.gateInstalled) return;
		const terminal = this.ui?.terminal;
		if (!terminal) return;
		this.gateInstalled = true;

		if (terminal.setProgress) {
			this.originalSetProgress = terminal.setProgress.bind(terminal);
			terminal.setProgress = (active: boolean) => {
				if (this.host.activeId === this.id) this.originalSetProgress?.(active);
			};
		}
		if (terminal.setTitle) {
			this.originalSetTitle = terminal.setTitle.bind(terminal);
			terminal.setTitle = (title: string) => {
				if (this.host.activeId === this.id) this.originalSetTitle?.(title);
			};
		}
	}

	start(): void {
		if (this.state !== "never-started") {
			this.resume();
			return;
		}
		this.installTerminalGate();
		this.state = "active";
		const record = this.host.get(this.id);
		if (!record) {
			void this.mode.run();
			return;
		}
		record.started = true;
		record.state = "active";
		// run() owns the terminal loop for this session until it is suspended.
		record.runPromise = this.mode.run().catch((error: unknown) => {
			record.state = record.expectedStop ? "stopped" : "error";
			record.error = error instanceof Error ? error.message : String(error);
			this.host.notify();
		});
	}

	suspend(): void {
		if (this.state === "stopped") return;
		try {
			this.ui?.stop?.();
			resetKeyboardModesForHandoff();
		} catch {
			// best effort
		}
		this.state = "suspended";
		const record = this.host.get(this.id);
		if (record && record.state !== "stopped" && record.state !== "error") {
			record.state = "suspended";
		}
	}

	resume(): void {
		if (this.state === "stopped") return;
		this.installTerminalGate();
		try {
			this.ui?.start?.();
			this.ui?.requestRender?.(true);
		} catch {
			// best effort
		}
		this.state = "active";
		const record = this.host.get(this.id);
		if (record) record.state = "active";
	}

	async dispose(): Promise<void> {
		this.state = "stopped";
		const ui = this.ui;
		const originalStop = ui?.stop?.bind(ui);
		const ownsTerminal = this.host.activeId === this.id;
		try {
			// Never let a background session's teardown touch the live terminal.
			if (ui && originalStop && !ownsTerminal) ui.stop = () => {};
			(this.mode as unknown as { stop?: () => void }).stop?.();
		} catch {
			// best effort
		} finally {
			if (ui && originalStop) ui.stop = originalStop;
		}
		try {
			await (this.runtime as unknown as { dispose?: () => Promise<void> }).dispose?.();
		} catch {
			// best effort
		}
	}
}

const createRuntime: CreateAgentSessionRuntimeFactory = async ({
	cwd,
	agentDir,
	sessionManager,
	sessionStartEvent,
}) => {
	const services = await createAgentSessionServices({ cwd, agentDir });
	return {
		...(await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
		})),
		services,
		diagnostics: services.diagnostics,
	};
};

function makeId(name: string): string {
	const safe =
		name
			.trim()
			.replace(/[^a-zA-Z0-9_.-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "session";
	return `${safe}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function deriveName(prompt: string): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	if (oneLine.length === 0) return "new session";
	return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 57)}…`;
}

/**
 * How a child's transcript came to exist.
 *
 * A `new` child owns a fresh file and gets its derived name written into it; a
 * `resumed` child is attached to a transcript that already exists on disk and
 * keeps whatever name that file carries.
 */
type ChildOrigin = "new" | "resumed";

export class AgentHost {
	readonly version = HOST_VERSION;
	readonly records = new Map<string, LiveSession>();
	activeId = HOST_ID;

	private subscribers = new Set<() => void>();
	private activation: Promise<void> | null = null;
	private queuedActivation: string | null = null;

	/** Terminal handle borrowed from the host TUI while a child is in front. */
	private hostTui: ModeTui | null = null;
	private hostRelease: (() => void) | null = null;
	private hostHandoffActive = false;

	ensureHostRecord(options: { cwd: string; sessionId?: string; sessionFile?: string; name: string }): LiveSession {
		const existing = this.records.get(HOST_ID);
		if (existing) {
			existing.cwd = options.cwd;
			existing.sessionId = options.sessionId;
			existing.sessionFile = options.sessionFile;
			if (options.name) existing.name = options.name;
			return existing;
		}
		const record: LiveSession = {
			id: HOST_ID,
			kind: "host",
			name: options.name,
			cwd: options.cwd,
			state: this.activeId === HOST_ID ? "active" : "suspended",
			activity: "idle",
			unread: false,
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
			sessionId: options.sessionId,
			sessionFile: options.sessionFile,
		};
		this.records.set(HOST_ID, record);
		this.notify();
		return record;
	}

	subscribe(listener: () => void): () => void {
		this.subscribers.add(listener);
		return () => this.subscribers.delete(listener);
	}

	notify(): void {
		for (const listener of [...this.subscribers]) listener();
	}

	get(idOrName: string): LiveSession | undefined {
		const direct = this.records.get(idOrName);
		if (direct) return direct;
		return [...this.records.values()].find((record) => record.name === idOrName);
	}

	list(): LiveSession[] {
		return [...this.records.values()];
	}

	get runningCount(): number {
		return this.list().filter((record) => record.activity === "working").length;
	}

	/** Find the record owning a given session id (used by per-session hooks). */
	recordForSessionId(sessionId: string | undefined): LiveSession | undefined {
		if (!sessionId) return undefined;
		return this.list().find((record) => record.sessionId === sessionId);
	}

	setActivity(sessionId: string | undefined, activity: Activity): void {
		const record = this.recordForSessionId(sessionId);
		if (!record) return;
		record.activity = activity;
		record.lastActivityAt = Date.now();
		// Finishing while in the background is what makes a session "unread".
		if (activity === "idle" && this.activeId !== record.id) record.unread = true;
		this.notify();
	}

	markRead(id: string): void {
		const record = this.records.get(id);
		if (!record) return;
		record.unread = false;
		this.notify();
	}

	/** Create a child session; it starts suspended until activated. */
	async spawn(options: { cwd: string; name: string }): Promise<LiveSession> {
		return await this.createChild({
			cwd: options.cwd,
			name: options.name,
			sessionManager: SessionManager.create(options.cwd),
			origin: "new",
		});
	}

	/**
	 * Bring a transcript that already exists on disk back in as a live child.
	 *
	 * This is the recovery path for sessions that are no longer in the registry —
	 * children orphaned by an older reload, or anything left over from a previous
	 * pi process. The full history is restored, so the session picks up where it
	 * stopped instead of starting empty.
	 */
	async adopt(options: { cwd: string; sessionFile: string; name: string }): Promise<LiveSession> {
		const alreadyLive = this.list().find((record) => record.sessionFile === options.sessionFile);
		if (alreadyLive) return alreadyLive;
		return await this.createChild({
			cwd: options.cwd,
			name: options.name,
			sessionManager: SessionManager.open(options.sessionFile),
			origin: "resumed",
		});
	}

	private async createChild(options: {
		cwd: string;
		name: string;
		sessionManager: SessionManager;
		origin: ChildOrigin;
	}): Promise<LiveSession> {
		const { cwd, name, sessionManager, origin } = options;
		const id = makeId(name);
		const record: LiveSession = {
			id,
			kind: "child",
			name,
			cwd,
			state: "starting",
			activity: "idle",
			unread: false,
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
			sessionManager,
			sessionId: sessionManager.getSessionId(),
			sessionFile: sessionManager.getSessionFile(),
		};
		this.records.set(id, record);
		this.notify();

		try {
			if (origin === "new") sessionManager.appendSessionInfo(name);
			const runtime = await createAgentSessionRuntime(createRuntime, {
				cwd,
				agentDir: getAgentDir(),
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: origin === "new" ? "startup" : "resume" },
			});
			const mode = new InteractiveMode(runtime, {
				migratedProviders: [],
				modelFallbackMessage: runtime.modelFallbackMessage,
				initialImages: [],
				initialMessages: [],
			});
			record.runtime = runtime;
			record.mode = mode;
			record.adapter = new ModeAdapter(id, runtime, mode, this);
			record.state = "suspended";
		} catch (error) {
			record.state = "error";
			record.error = error instanceof Error ? error.message : String(error);
		}
		this.notify();
		return record;
	}

	async stop(idOrName: string): Promise<void> {
		const record = this.get(idOrName);
		if (!record || record.kind !== "child") {
			throw new Error("Only child sessions can be stopped here");
		}
		const wasActive = this.activeId === record.id;
		record.expectedStop = true;
		record.state = "stopped";
		try {
			if (wasActive) record.adapter?.suspend();
			await record.adapter?.dispose();
		} catch {
			// best effort
		}
		this.records.delete(record.id);
		this.notify();
		if (wasActive) await this.activate(HOST_ID);
	}

	async activate(idOrName: string): Promise<void> {
		const target = this.get(idOrName);
		if (!target) throw new Error(`Session not found: ${idOrName}`);
		if (this.activation) {
			this.queuedActivation = target.id;
			await this.activation;
			return;
		}
		this.activation = this.doActivate(target).finally(() => {
			this.activation = null;
		});
		await this.activation;
		const queued = this.queuedActivation;
		this.queuedActivation = null;
		if (queued && queued !== this.activeId) await this.activate(queued);
	}

	private async doActivate(target: LiveSession): Promise<void> {
		if (target.id === this.activeId) return;
		if (target.state === "error") throw new Error(target.error ?? "Session failed to start");

		const current = this.get(this.activeId);
		if (current?.kind === "child") current.adapter?.suspend();
		else if (current?.kind === "host") current.state = "suspended";

		if (target.kind === "host") {
			this.activeId = HOST_ID;
			target.state = "active";
			target.unread = false;
			try {
				this.hostTui?.terminal?.setProgress?.(false);
				this.hostTui?.start?.();
				this.hostTui?.requestRender?.(true);
			} catch {
				// best effort
			}
			const release = this.hostRelease;
			this.hostTui = null;
			this.hostRelease = null;
			this.hostHandoffActive = false;
			this.notify();
			// Closes the placeholder overlay that was holding the host terminal.
			release?.();
			return;
		}

		this.activeId = target.id;
		target.state = "active";
		target.unread = false;
		if (!target.started) target.adapter?.start();
		else target.adapter?.resume();
		this.notify();
	}

	/**
	 * Hand the terminal from the host TUI to a child.
	 *
	 * The host TUI cannot simply be stopped from a command handler, so we park it
	 * inside an empty `ctx.ui.custom()` overlay: that gives us the `tui` handle
	 * and a `done` callback to resume it later.
	 */
	private async handOffFromHost(ctx: { ui: { custom: (factory: unknown) => Promise<unknown>; notify: (message: string, type?: string) => void } }, targetId: string): Promise<void> {
		if (this.hostHandoffActive) {
			await this.activate(targetId);
			return;
		}
		await ctx.ui.custom(
			(
				tui: { stop: () => void; start: () => void; requestRender: (force?: boolean) => void },
				_theme: unknown,
				_keybindings: unknown,
				done: () => void,
			) => {
				this.hostTui = tui;
				this.hostRelease = done;
				this.hostHandoffActive = true;
				try {
					tui.stop();
					resetKeyboardModesForHandoff();
				} catch {
					// best effort
				}
				void this.activate(targetId).catch((error: unknown) => {
					try {
						tui.start();
						tui.requestRender(true);
					} catch {
						// best effort
					}
					this.hostHandoffActive = false;
					this.hostTui = null;
					this.hostRelease = null;
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					done();
				});
				// Placeholder: renders nothing, just holds the host terminal.
				return { render: () => [], invalidate: () => {}, dispose: () => {} };
			},
		);
	}

	/** Switch from whichever session issued the command to `targetId`. */
	async activateFrom(
		ctx: { sessionManager: { getSessionId(): string }; ui: { custom: (factory: unknown) => Promise<unknown>; notify: (message: string, type?: string) => void } },
		targetId: string,
	): Promise<void> {
		const callerId = this.recordForSessionId(ctx.sessionManager.getSessionId())?.id ?? this.activeId;
		if (callerId === HOST_ID && targetId !== HOST_ID) {
			await this.handOffFromHost(ctx, targetId);
			return;
		}
		await this.activate(targetId);
	}
}

const HOST_KEY = "__PI_AGENT_VIEW_HOST__";

/**
 * The one registry for this pi process, kept on `globalThis` so it outlives the
 * module.
 *
 * The check is deliberately **not** `instanceof`. `/reload` re-evaluates this
 * file, so `AgentHost` here is a different class object than the one that built
 * the running registry, and `instanceof` reports false for a perfectly good
 * host. That mismatch used to replace every live session with an empty registry
 * — sessions vanishing from agent view after `/reload`. Matching on the version
 * brand adopts the running host instead.
 */
export function getHost(): AgentHost {
	const globals = globalThis as Record<string, unknown>;
	const existing = globals[HOST_KEY] as AgentHost | undefined;
	if (existing?.version === HOST_VERSION) return existing;
	const host = new AgentHost();
	globals[HOST_KEY] = host;
	return host;
}

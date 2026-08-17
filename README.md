# pi-agent-view

[![npm version](https://img.shields.io/npm/v/pi-agent-view)](https://www.npmjs.com/package/pi-agent-view)
[![license](https://img.shields.io/npm/l/pi-agent-view)](LICENSE)

A [pi](https://github.com/badlogic/pi-mono) extension that hosts several **real** live sessions in one process. Exactly one owns the terminal; the rest keep running in the background. Switching is a terminal handoff — nothing is stopped, replaced, or lost.

## Install

```bash
pi install npm:pi-agent-view
```

From git, if you prefer not to use npm:

```bash
pi install git:github.com/alisher-amantay/pi-agent-view
```

Restart pi (or `/reload`) after install.

## Runtime model

```text
pi process
  └─ agent-view multiplexer
      ├─ original : the InteractiveMode pi started with
      ├─ child A  : AgentSessionRuntime + InteractiveMode
      └─ child B  : AgentSessionRuntime + InteractiveMode
```

Each child is a full native `InteractiveMode`, so slash commands, model switching, and every other pi feature work normally inside it.

Switching away calls `ui.stop()` on that TUI only. The agent runtime behind it keeps streaming, and its output is waiting for you when you come back.

> This is deliberately **not** `ctx.newSession()` / `ctx.switchSession()`. Those replace pi's single active runtime, which tears down whatever was running — the cause of vanishing chats and "session is still being saved" messages.

The live registry lives on `globalThis`. `/reload` re-evaluates the extension without restarting pi; the reloaded copy re-adopts the running registry by version brand rather than `instanceof`.

## Statuses

| Group | Meaning |
| --- | --- |
| **Working** | Agent is streaming right now |
| **Unread** | Finished while you were looking at another session |
| **Read** | Seen and idle |
| **On disk** | Transcript in this folder that is not live here; `Enter` brings it back with its full history |

## Entry points

```bash
pi --agents         # open agent view on startup
```

Inside any session:

| Input | Action |
| --- | --- |
| `←` on an empty prompt | Open agent view |
| `/agents` or `/agent-view` | Open agent view |
| `Ctrl+Shift+A` | Open agent view |

## Keys

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move |
| `Enter` | Switch to the selected session, or bring back a selected **On disk** one |
| `Enter` with text | Start a new parallel session with that text as its name |
| `→` | Open the selected session even while filter text is typed |
| `Ctrl+X` | Stop selected child session (twice to confirm) |
| `Esc` | Stay in the current session |

Typing filters the list.

## Limits

- Sessions are **in-process**: quitting pi ends every live session. Their transcripts persist on disk and come back through the **On disk** group (or `/resume`).
- Nothing locks a transcript. Bringing back a session that another pi process has open gives it two writers.
- The original session can't be stopped from the view; use `/quit`.
- No path locking between sessions yet — two sessions editing the same files can conflict. Give parallel work non-overlapping scopes.

## Compatibility

Requires [pi](https://github.com/badlogic/pi-mono) with the `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` APIs (0.82+ is what this was built against).

## License

MIT

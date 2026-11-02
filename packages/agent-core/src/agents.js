// Coding-agent sessions (Claude Code) as reported by their hooks: state, a bounded timeline,
// and the permission prompts and questions they are blocked on. See PROTOCOL.md, "Agents".
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { HttpError } from './sandbox.js';
import { RolloutTail, codexItem } from './codex-rollout.js';
import { readTranscript, readTranscriptSince } from './transcript.js';
import { attachedFiles } from './uploads.js';

const MAX_ENTRIES = 500;
// Entries of a session without a transcript to read them again from, kept across restarts.
const SAVED_ENTRIES = 200;
const MAX_TEXT = 16 * 1024;
const MAX_TITLE = 80;
const ENDED_TTL = 24 * 60 * 60 * 1000;
const REQUEST_TTL = 60 * 60 * 1000;
const START_TIMEOUT = 15 * 1000;
// How long a turn Codex's rollout says ended waits for Stop before it ends without it.
const STOP_GRACE = 3 * 1000;
// A request held for the phone blocks a Codex terminal, so it is held for less long.
const SEQUENTIAL_REQUEST_TTL = 10 * 60 * 1000;

/**
 * What each coding agent's hooks can do. Claude Code shows its approval dialog alongside a waiting
 * hook ("parallel"); Codex only after the hook declines ("presence": hold for the phone only while
 * nobody is at the computer). Their hook payloads share Claude Code's field names.
 */
export const ADAPTERS = {
	claude: {
		name: 'Claude Code',
		capabilities: { approvals: 'parallel', alwaysAllow: true, keys: ['interrupt', 'cycle_mode', 'set_mode', '/compact', '/clear', '/model'] },
		normalize: (e) => e,
	},
	codex: {
		name: 'Codex',
		// Codex reports a session only once it gets its first prompt.
		startsOnPrompt: true,
		setupHint: ', then trust its hooks with `/hooks` in Codex',
		capabilities: { approvals: 'presence', alwaysAllow: false, keys: ['interrupt', '/compact', '/model'] },
		normalize: (e) => ({
			...e,
			// Codex's patch tool carries the patch where Bash has its command.
			tool_input: e.tool_name === 'apply_patch' && typeof e.tool_input === 'string' ? { command: e.tool_input } : e.tool_input,
		}),
	},
};

/** A prompt as Claude Code reports it back: image paths become `[Image #N]`; spacing may differ. */
function comparable(text, paths = []) {
	let t = String(text);
	for (const p of paths) t = t.split(p).join(' ');
	return t.replace(/\[Image #\d+\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The first `MAX_TEXT` bytes of `text`, and whether anything was cut. */
function clip(text) {
	const buf = Buffer.from(text, 'utf8');
	if (buf.length <= MAX_TEXT) return { text, truncated: false };
	// Cutting at a byte offset can split a character; drop the half that is left.
	return { text: buf.subarray(0, MAX_TEXT).toString('utf8').replace(/�+$/, ''), truncated: true };
}

/** Tool input with long strings (a Write's content) clipped, so one entry stays small. */
function clipInput(input) {
	if (!input || typeof input !== 'object') return input ?? null;
	const out = Array.isArray(input) ? [] : {};
	for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' ? clip(v).text : v;
	return out;
}

/** A tool result as text: Bash's stdout and stderr, a string as is, anything else as JSON. */
function resultText(response) {
	if (response == null) return '';
	if (typeof response === 'string') return response;
	if (typeof response.stdout === 'string' || typeof response.stderr === 'string') {
		return [response.stdout, response.stderr].filter(Boolean).join('\n');
	}
	return JSON.stringify(response, null, 2);
}

/** Whether a prompt is a note Claude Code added (a background task finished), not one typed. */
function isNotice(prompt) {
	return prompt.trimStart().startsWith('<task-notification>');
}

/** Claude Code's permission modes, as `--permission-mode` and its hooks name them. */
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'];

/** A hook's `permission_mode`; older Claude Code called manual `default`. */
function modeOf(value) {
	if (value === 'default') return 'manual';
	return PERMISSION_MODES.includes(value) ? value : null;
}

// Claude Code's footer names the mode after ⏸ or ⏵⏵ ("⏵⏵ accept edits on (shift+tab to cycle)").
// Its renderer moves the cursor over blank cells instead of writing spaces.
const FOOTER_MODES = {
	'manual mode': 'manual',
	'accept edits': 'acceptEdits',
	'plan mode': 'plan',
	'auto mode': 'auto',
	'bypass permissions': 'bypassPermissions',
	"don't ask": 'dontAsk',
};
const FOOTER = /(?:⏸|⏵⏵) *(manual mode|accept edits|plan mode|auto mode|bypass permissions|don't ask) on/g;
const CURSOR_RIGHT = /\x1b\[(\d*)C/g;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[()][0-9A-B]|\x1b./g;

/** Terminal output as plain text, with cursor moves to the right as spaces. */
function plain(text) {
	return text.replace(CURSOR_RIGHT, (_, n) => ' '.repeat(Math.min(Number(n) || 1, 200))).replace(ANSI, '');
}

/** The last permission mode the footer shows in `text`, if any. */
export function footerMode(text) {
	let mode = null;
	for (const m of plain(text).matchAll(FOOTER)) mode = FOOTER_MODES[m[1]];
	return mode;
}

function titleOf(prompt) {
	const line = prompt.trim().split('\n')[0].trim();
	return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

class AgentSession {
	constructor({ id, agent, cwd, terminal, now }) {
		this.id = id;
		this.agent = agent;
		this.cwd = cwd;
		this.title = path.basename(cwd || '') || 'Session';
		this.capabilities = (ADAPTERS[agent] ?? ADAPTERS.claude).capabilities;
		this.titled = false;
		this.state = 'idle';
		this.terminal = terminal;
		this.startedAt = now;
		this.lastActivityAt = now;
		this.endedAt = null;
		// Started from the phone and not heard from yet; `error` says why it never started.
		this.starting = false;
		this.error = null;
		// Ended by `/clear`: the next session in its terminal takes its place.
		this.cleared = false;
		this.turnStartedAt = null;
		this.entries = [];
		this.seq = 0;
		// message_id -> { parts: index -> delta, last: index of the final batch }. Async hooks can
		// deliver a message's batches out of order, so they are joined once all have arrived.
		this.streaming = new Map();
		this.requests = new Map();
		// Prompts typed in from a client, waiting for Claude Code to report them: { id, text }.
		this.prompts = [];
		// Follows Codex's rollout for what its hooks don't report (see codex-rollout.js).
		this.tail = null;
		// Settles once history from the transcript (if any) is in; later events wait for it.
		this.ready = Promise.resolve();
		// As the hooks, the transcript and the terminal's footer last showed them (null: unknown).
		this.permissionMode = null;
		this.model = null;
	}

	toJSON() {
		return {
			id: this.id,
			agent: this.agent,
			cwd: this.cwd,
			title: this.title,
			state: this.state,
			terminal: this.terminal,
			startedAt: this.startedAt,
			lastActivityAt: this.lastActivityAt,
			pending: this.requests.size,
			starting: this.starting,
			error: this.error,
			capabilities: this.capabilities,
			permissionMode: this.permissionMode,
			model: this.model,
		};
	}
}

/**
 * Emits `message` with the frames of the agents socket (`session`, `entry`, `request`,
 * `request_resolved`), which is also what push notifications follow.
 */
export class AgentHub extends EventEmitter {
	#sessions = new Map();
	#requests = new Map();
	#now;
	#requestTtl;
	#transcript;
	#transcriptSince;
	#startTimeout;
	#sequentialTtl;
	#rolloutTail;
	// Terminal id -> the tail of its output, for a footer split across chunks.
	#footers = new Map();
	// Session id -> callbacks waiting for the footer to show a mode.
	#modeWaiters = new Map();

	/**
	 * `present` says whether someone is at the computer or looking at it in a client; agents whose
	 * approvals are sequential ask there instead of holding the request for the phone.
	 */
	constructor({
		now = Date.now,
		requestTtl = REQUEST_TTL,
		sequentialTtl = SEQUENTIAL_REQUEST_TTL,
		transcript = readTranscript,
		transcriptSince = readTranscriptSince,
		startTimeout = START_TIMEOUT,
		present = async () => false,
		rolloutTail = (file, onItem, onTurnEnd) => new RolloutTail(file, onItem, onTurnEnd),
		// Keeps an image from a transcript where clients can fetch it: (bytes, type) => { id, type }.
		keepImage = null,
		// Where files sent from clients are kept, and the media type of one by its name: prompts
		// show the files they name there as attachments instead of paths.
		uploadsDir = null,
		fileType = undefined,
	} = {}) {
		super();
		this.#now = now;
		this.#requestTtl = requestTtl;
		this.#sequentialTtl = sequentialTtl;
		this.#transcript = transcript;
		this.#transcriptSince = transcriptSince;
		this.#startTimeout = startTimeout;
		this.present = present;
		this.#rolloutTail = rolloutTail;
		this.keepImage = keepImage;
		this.uploadsDir = uploadsDir;
		this.fileType = fileType;
		// A server leaves `present` alone when the hub was given one.
		this.presenceSet = arguments[0]?.present !== undefined;
	}

	/**
	 * A prompt a client typed into a session's terminal. Once Claude Code reports a matching
	 * `UserPromptSubmit`, the socket gets `prompt_confirmed` with this id.
	 */
	prompted(sessionId, { id, text, paths = [], images = [] }) {
		const s = this.#sessions.get(sessionId);
		if (!s) return;
		s.prompts.push({ id, text: comparable(text, paths), images, at: this.#now() });
		// Unconfirmed prompts don't pile up: the client gives up on them after 10 seconds anyway.
		s.prompts = s.prompts.filter((p) => this.#now() - p.at < 60_000).slice(-20);
	}

	/**
	 * A client pressed Esc in a running session. Claude Code reports no hook for an interrupted
	 * turn (only an idle notification a minute later), so the turn ends here; a hook that shows
	 * it still going starts a turn again.
	 */
	interrupted(sessionId) {
		const s = this.#sessions.get(sessionId);
		if (!s || s.state !== 'running' || s.starting) return;
		this.#endTurn(s, this.#now());
		this.#emitSession(s);
	}

	/**
	 * Output of one of the agent's terminals. Shift+Tab reports no hook, so a Claude Code session's
	 * permission mode follows its footer.
	 */
	terminalOutput(terminal, buf) {
		const s = [...this.#sessions.values()].find((x) => x.terminal === terminal && x.agent === 'claude' && x.state !== 'ended');
		if (!s) {
			this.#footers.delete(terminal);
			return;
		}
		const text = (this.#footers.get(terminal) ?? '') + buf.toString('utf8');
		this.#footers.set(terminal, text.slice(-256));
		const mode = footerMode(text);
		if (!mode) return;
		const waiters = this.#modeWaiters.get(s.id) ?? [];
		const left = waiters.filter((w) => w.from === mode);
		if (left.length) this.#modeWaiters.set(s.id, left);
		else this.#modeWaiters.delete(s.id);
		for (const w of waiters) if (w.from !== mode) w.done(mode);
		if (mode !== s.permissionMode) {
			s.permissionMode = mode;
			this.#emitSession(s);
		}
	}

	/**
	 * The mode the footer shows next that isn't `from` (a running session redraws its footer
	 * unchanged all the time), or null if none shows within `ms`.
	 */
	waitForMode(sessionId, ms, from = this.#sessions.get(sessionId)?.permissionMode ?? null) {
		return new Promise((resolve) => {
			const waiter = {
				from,
				done: (mode) => {
					clearTimeout(timer);
					resolve(mode);
				},
			};
			const timer = setTimeout(() => {
				const left = (this.#modeWaiters.get(sessionId) ?? []).filter((w) => w !== waiter);
				if (left.length) this.#modeWaiters.set(sessionId, left);
				else this.#modeWaiters.delete(sessionId);
				resolve(null);
			}, ms);
			this.#modeWaiters.set(sessionId, [...(this.#modeWaiters.get(sessionId) ?? []), waiter]);
		});
	}

	/** The model a client switched a session to with `/model`, until its transcript names it. */
	modelChosen(sessionId, model) {
		const s = this.#sessions.get(sessionId);
		if (!s || !model || model === s.model) return;
		s.model = model;
		this.#emitSession(s);
	}

	/** Whether `resume` may reopen a session: only one no process runs any more. */
	canResume(id) {
		const s = this.#sessions.get(id);
		return !s || s.state === 'ended';
	}

	/**
	 * A session the agent just started in `terminal` (`id`: the id it passed with --session-id,
	 * or the one it resumes). It shows right away; if Claude Code reports nothing within the
	 * start timeout, it ends with an error.
	 */
	launched({ id, terminal, cwd, agent = 'claude' }) {
		const now = this.#now();
		let s = this.#sessions.get(id);
		if (!s) {
			s = new AgentSession({ id, agent, cwd, terminal, now });
			this.#sessions.set(id, s);
		}
		const adapter = ADAPTERS[agent] ?? ADAPTERS.claude;
		// One that reports only on its first prompt waits for it, ready to be typed into.
		const state = adapter.startsOnPrompt ? 'idle' : 'running';
		Object.assign(s, { terminal, state, starting: true, error: null, endedAt: null, lastActivityAt: now });
		if (adapter.startsOnPrompt) {
			this.#emitSession(s);
			return s.toJSON();
		}
		const timer = setTimeout(() => {
			if (!s.starting || this.#sessions.get(id) !== s) return;
			s.starting = false;
			// Usually the plugin isn't installed: the agent runs but never reports.
			s.error = `${adapter.name} didn't report back. If it runs in the terminal, run \`coderemote setup ${agent}\` once on the computer${adapter.setupHint ?? ''}.`;
			this.#end(s);
			this.#emitSession(s);
		}, this.#startTimeout);
		timer.unref?.();
		this.#emitSession(s);
		return s.toJSON();
	}

	sessions() {
		return [...this.#sessions.values()].map((s) => s.toJSON()).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
	}

	requests() {
		return [...this.#requests.values()].map((r) => r.request);
	}

	session(id) {
		return this.#sessions.get(id)?.toJSON() ?? null;
	}

	/** Where a session runs: `terminal` is one of the agent's terminals, null for one started outside Code Remote. */
	host(id) {
		const s = this.#sessions.get(id);
		return s ? { terminal: s.terminal } : null;
	}

	/**
	 * `after` skips entries up to that `seq`. `limit` keeps only the newest that many, and `before`
	 * only those older than that `seq` (the page before one already held); `more` says whether
	 * entries older than the first one returned are left.
	 */
	timeline(id, after = 0, { limit = 0, before = 0 } = {}) {
		const s = this.#sessions.get(id);
		if (!s) throw new HttpError(404, 'no such session');
		let entries = s.entries.filter((e) => e.seq > after && (!before || e.seq < before));
		if (limit > 0) entries = entries.slice(-limit);
		const first = entries[0]?.seq ?? before;
		const more = first > 0 && s.entries.some((e) => e.seq > after && e.seq < first);
		return { entries, next: s.seq, more, requests: [...s.requests.values()].map((r) => r.request) };
	}

	/** Settles once a session's history (read from its transcript) is in. */
	async ready(id) {
		await this.#sessions.get(id)?.ready;
	}

	/**
	 * The sessions as `restore` takes them back after the agent restarts. Claude Code's transcript
	 * holds a session's whole timeline, so its entries are read again from there (with whatever
	 * happened while the agent was down); others keep their latest entries.
	 */
	snapshot() {
		return [...this.#sessions.values()]
			.filter((s) => !s.starting)
			.map((s) => ({
				id: s.id,
				agent: s.agent,
				cwd: s.cwd,
				title: s.title,
				titled: s.titled,
				state: s.state,
				terminal: s.terminal,
				startedAt: s.startedAt,
				lastActivityAt: s.lastActivityAt,
				endedAt: s.endedAt,
				error: s.error,
				cleared: s.cleared,
				transcriptPath: s.transcriptPath ?? null,
				permissionMode: s.permissionMode,
				model: s.model,
				seq: s.seq,
				entries: s.agent === 'claude' && s.transcriptPath ? [] : s.entries.slice(-SAVED_ENTRIES),
			}));
	}

	/**
	 * Brings back the sessions of `snapshot`. Those that ran in the agent's terminals ended with
	 * them; others may still run, and their next hook event says how they are doing.
	 */
	restore(saved) {
		const now = this.#now();
		for (const r of Array.isArray(saved) ? saved : []) {
			if (!r || typeof r.id !== 'string' || this.#sessions.has(r.id) || !Object.hasOwn(ADAPTERS, r.agent)) continue;
			if (r.state === 'ended' && !(r.endedAt >= now - ENDED_TTL)) continue;
			const s = new AgentSession({ id: r.id, agent: r.agent, cwd: r.cwd ?? null, terminal: null, now: r.startedAt ?? now });
			s.title = typeof r.title === 'string' ? r.title : s.title;
			s.titled = r.titled === true;
			s.lastActivityAt = r.lastActivityAt ?? now;
			s.error = r.error ?? null;
			s.cleared = r.cleared === true;
			s.permissionMode = modeOf(r.permissionMode);
			s.model = typeof r.model === 'string' ? r.model : null;
			s.seq = Number.isInteger(r.seq) ? r.seq : 0;
			if (r.state === 'ended' || r.terminal) {
				s.state = 'ended';
				s.endedAt = r.state === 'ended' ? (r.endedAt ?? now) : now;
			}
			if (typeof r.transcriptPath === 'string') s.transcriptPath = r.transcriptPath;
			if (s.agent === 'claude' && s.transcriptPath) s.ready = this.#backfill(s, s.transcriptPath);
			else s.entries = Array.isArray(r.entries) ? r.entries.filter((e) => Number.isInteger(e?.seq) && e.seq <= s.seq) : [];
			this.#sessions.set(s.id, s);
		}
	}

	/**
	 * Takes one hook event. Resolves with the hook's output: for `PermissionRequest` once the
	 * request is answered (null when the computer should decide), `{}` for everything else.
	 * Aborting `signal` (the hook was killed because the computer answered) withdraws the request.
	 */
	async handle(raw, { agent = 'claude', terminal = null, signal } = {}) {
		if (!raw || typeof raw.session_id !== 'string' || !raw.session_id) {
			throw new HttpError(400, 'hook event without session_id');
		}
		if (!Object.hasOwn(ADAPTERS, agent)) throw new HttpError(400, `unknown agent ${agent}`);
		const event = ADAPTERS[agent].normalize(raw);
		const now = this.#now();
		// A resumed conversation can come back under a new id: it replaces the placeholder.
		let replaced = null;
		if (!this.#sessions.has(event.session_id)) {
			// The placeholder started in that terminal. Codex doesn't pass the terminal to its plugin
			// hooks, so its only placeholder in the same folder stands in for it.
			// After `/clear`, Claude Code goes on in the same terminal under a new id: that one too.
			// The terminal may have run other sessions before (Claude Code quit and started again):
			// the cleared one is the latest that ended by /clear or never heard it end (Claude Code
			// cuts SessionEnd hooks short on /clear, so that report can be lost).
			const cleared = event.hook_event_name === 'SessionStart' && event.source === 'clear' && terminal;
			const candidates = cleared
				? [...this.#sessions.values()]
						.filter((p) => p.terminal === terminal && p.agent === agent && (p.state !== 'ended' || p.cleared))
						.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
						.slice(0, 1)
				: [...this.#sessions.values()].filter(
						(p) => p.starting && (terminal ? p.terminal === terminal : p.agent === agent && p.cwd === event.cwd),
					);
			if (candidates.length === 1) {
				replaced = candidates[0];
				this.#sessions.delete(replaced.id);
				terminal ??= replaced.terminal;
			}
		}
		let s = this.#sessions.get(event.session_id);
		if (!s) {
			s = new AgentSession({ id: event.session_id, agent, cwd: event.cwd ?? null, terminal, now });
			this.#sessions.set(s.id, s);
			// A brand-new session has no history; anything else started before the agent heard of it.
			const fresh = event.hook_event_name === 'SessionStart' && event.source !== 'resume';
			if (typeof event.transcript_path === 'string') {
				s.transcriptPath = event.transcript_path;
				if (fresh) s.transcriptOffset = 0;
				else s.ready = this.#backfill(s, event.transcript_path);
			}
		}
		await s.ready;
		// What Claude Code shows between tool calls and its own title for the conversation reach
		// only its transcript: read what it wrote since, before the tool call or the reply.
		if (['PreToolUse', 'Stop', 'StopFailure'].includes(event.hook_event_name)) await this.#catchUp(s);
		if (s.agent === 'codex' && !s.tail && typeof event.transcript_path === 'string') {
			s.tail = this.#rolloutTail(event.transcript_path, (item) => this.#fromRollout(s, item), (error) => this.#rolloutTurnEnd(s, error));
			s.tail.poll?.().catch(() => {});
		}
		if (replaced) {
			// Prompts typed into the placeholder are confirmed under the real session.
			s.prompts.push(...replaced.prompts);
			this.emit('message', { type: 'session_removed', session: replaced.id, replacedBy: s.id });
		}
		if (terminal && !s.terminal) s.terminal = terminal;
		s.starting = false;
		s.lastActivityAt = now;
		if (s.state === 'ended' && event.hook_event_name !== 'SessionEnd') {
			// A resumed conversation comes back under the same id.
			s.state = 'idle';
			s.endedAt = null;
			s.cleared = false;
		}
		s.permissionMode = modeOf(event.permission_mode) ?? s.permissionMode;
		if (typeof event.model === 'string' && event.model) s.model = event.model;
		// Before the event's own effect, which may end the turn (resolving makes a waiting session run).
		this.#withdrawAnsweredElsewhere(s, event);

		switch (event.hook_event_name) {
			case 'SessionStart':
				// Launched from the app, it showed as running until it reported; started now, it
				// waits for a prompt unless one is already in progress.
				if (s.state === 'running' && s.turnStartedAt == null) s.state = 'idle';
				break;
			case 'UserPromptSubmit': {
				const said = typeof event.prompt === 'string' ? event.prompt : '';
				const { text, files } = this.#withFiles(said);
				if (!s.titled && text.trim() && !isNotice(text)) {
					s.title = titleOf(text);
					s.titled = true;
				}
				this.#startTurn(s, now);
				const typed = comparable(said);
				const i = s.prompts.findIndex((p) => p.text === typed || (p.text && typed.startsWith(p.text)));
				const [prompt] = i >= 0 ? s.prompts.splice(i, 1) : [];
				// Images a client attached, which Claude Code names `[Image #N]` in the text.
				this.#entry(s, {
					kind: 'prompt',
					text,
					...(prompt?.images?.length ? { images: prompt.images } : {}),
					...(files.length ? { files } : {}),
				});
				if (prompt) this.emit('message', { type: 'prompt_confirmed', session: s.id, prompt: prompt.id });
				break;
			}
			case 'PreToolUse':
				this.#startTurn(s, now);
				this.#entry(s, {
					kind: 'tool',
					toolUseId: event.tool_use_id ?? null,
					name: event.tool_name,
					input: clipInput(event.tool_input),
				});
				break;
			case 'PostToolUse':
			case 'PostToolUseFailure': {
				const failed = event.hook_event_name === 'PostToolUseFailure';
				const { text, truncated } = clip(failed ? String(event.error ?? '') : resultText(event.tool_response));
				this.#entry(s, {
					kind: 'tool_result',
					toolUseId: event.tool_use_id ?? null,
					name: event.tool_name,
					output: text,
					error: failed,
					truncated,
					duration: event.duration_ms ?? null,
				});
				break;
			}
			case 'MessageDisplay': {
				const message = s.streaming.get(event.message_id) ?? { parts: new Map(), last: null };
				s.streaming.set(event.message_id, message);
				message.parts.set(event.index ?? message.parts.size, event.delta ?? '');
				if (event.final) message.last = event.index ?? message.parts.size - 1;
				if (message.last === null || message.parts.size <= message.last) break;
				s.streaming.delete(event.message_id);
				const text = [...message.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, d]) => d).join('').trimEnd();
				// Stop may have recorded the same text already, if it got here first.
				const previous = s.entries.at(-1)?.kind === 'turn_end' ? s.entries.at(-2) : s.entries.at(-1);
				if (text.trim() && !(previous?.kind === 'assistant' && previous.text.trim() === text.trim())) {
					this.#entry(s, { kind: 'assistant', text });
				}
				break;
			}
			case 'PermissionRequest': {
				this.#emitSession(s);
				const sequential = s.capabilities.approvals === 'presence';
				// Someone at the computer answers there; holding the request would block them.
				const deferNow = sequential && (await this.present().catch(() => false));
				return this.#openRequest(s, event, signal, { deferNow, ttl: sequential ? this.#sequentialTtl : this.#requestTtl });
			}
			case 'Stop':
			case 'StopFailure': {
				// MessageDisplay may not have run (older Claude Code); the final text is here too.
				const last = typeof event.last_assistant_message === 'string' ? event.last_assistant_message.trim() : '';
				const turnEntries = s.entries.filter((e) => e.time >= (s.turnStartedAt ?? 0));
				if (last && !turnEntries.some((e) => e.kind === 'assistant' && e.text.trim() === last)) {
					this.#entry(s, { kind: 'assistant', text: last });
				}
				// Codex's rollout may have ended the turn already (see #rolloutTurnEnd).
				if (s.turnStartedAt == null && s.entries.at(-1)?.kind === 'turn_end') break;
				this.#endTurn(s, now);
				break;
			}
			case 'Interrupt':
			case 'Notification':
				// An interrupted turn (Esc) ends without Stop: Codex reports Interrupt, Claude Code says later it is idle.
				if ((event.hook_event_name === 'Interrupt' || event.notification_type === 'idle_prompt') && s.state === 'running') {
					s.state = 'idle';
					s.turnStartedAt = null;
				}
				break;
			case 'SessionEnd':
				// Its terminal goes on under a new id (see the SessionStart from `/clear` above).
				if (event.reason === 'clear') s.cleared = true;
				this.#end(s);
				break;
			default:
				break;
		}
		this.#emitSession(s);
		return {};
	}

	/**
	 * Claude Code kills a waiting PermissionRequest hook when its own dialog is answered, but not
	 * always when the answer comes from somewhere else (Claude's remote control on another device),
	 * so the request would stay open. The session going on proves it was answered: the asking tool
	 * ran (PostToolUse), or the turn moved on or ended.
	 */
	#withdrawAnsweredElsewhere(s, event) {
		if (!s.requests.size) return;
		const name = event.hook_event_name;
		let stale = [];
		if (name === 'PostToolUse' || name === 'PostToolUseFailure') {
			const oldest = [...s.requests.values()].find((p) => p.request.tool === (event.tool_name ?? null));
			if (oldest) stale = [oldest];
		} else if (
			['UserPromptSubmit', 'Stop', 'StopFailure', 'Interrupt'].includes(name) ||
			(name === 'Notification' && event.notification_type === 'idle_prompt')
		) {
			stale = [...s.requests.values()];
		}
		for (const pending of stale) this.#resolve(pending, null, 'withdrawn', 'computer');
	}

	/** The terminal a session ran in exited: whatever ran in it is over. */
	terminalExited(terminal) {
		this.#footers.delete(terminal);
		for (const s of this.#sessions.values()) {
			if (s.terminal === terminal && s.state !== 'ended') {
				if (s.starting) s.error = `${(ADAPTERS[s.agent] ?? ADAPTERS.claude).name} exited before it started. Open the terminal to see why.`;
				s.starting = false;
				this.#end(s);
				this.#emitSession(s);
			}
		}
	}

	/**
	 * Drops a session from the list, withdrawing its requests. One still running elsewhere comes
	 * back with its next hook event.
	 */
	forget(id) {
		const s = this.#sessions.get(id);
		if (!s) throw new HttpError(404, 'no such session');
		if (s.state !== 'ended') this.#end(s);
		this.#sessions.delete(id);
		this.emit('message', { type: 'session_removed', session: id, replacedBy: null });
	}

	/** Forgets sessions that ended more than a day ago. */
	sweep() {
		const cutoff = this.#now() - ENDED_TTL;
		for (const s of this.#sessions.values()) {
			if (s.state === 'ended' && s.endedAt < cutoff) {
				s.tail?.stop();
				this.#sessions.delete(s.id);
			}
		}
	}

	/**
	 * Answers an open request from a client. Throws 404 for an unknown request and 409 for one
	 * already resolved (by another device, the computer, or the timeout).
	 */
	answer({ request: id, behavior, message, suggestion, answers } = {}) {
		const pending = this.#requests.get(id);
		if (!pending) {
			throw new HttpError(this.#resolved.has(id) ? 409 : 404, this.#resolved.has(id) ? 'already answered' : 'no such request');
		}
		const { request } = pending;
		if (behavior !== 'allow' && behavior !== 'deny') throw new HttpError(400, 'behavior must be allow or deny');
		let decision;
		let outcome;
		if (behavior === 'deny') {
			decision = { behavior: 'deny', ...(typeof message === 'string' && message ? { message } : {}) };
			outcome = 'denied';
		} else if (request.kind === 'question') {
			if (!answers || typeof answers !== 'object' || Object.values(answers).some((a) => typeof a !== 'string')) {
				throw new HttpError(400, 'answers must map each question to a string');
			}
			decision = { behavior: 'allow', updatedInput: { ...pending.input, answers } };
			outcome = 'answered';
		} else {
			decision = { behavior: 'allow' };
			if (suggestion !== undefined) {
				const rule = Number.isInteger(suggestion) ? request.suggestions[suggestion] : undefined;
				if (!rule || !pending.session.capabilities.alwaysAllow) {
					throw new HttpError(400, 'suggestion must index the request’s suggestions');
				}
				decision.updatedPermissions = [rule];
			}
			outcome = 'allowed';
		}
		this.#resolve(pending, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }, outcome, 'phone');
	}

	// Ids of requests resolved recently, to tell "already answered" (409) from unknown (404).
	#resolved = new Set();

	#openRequest(s, event, signal, { deferNow = false, ttl = this.#requestTtl } = {}) {
		const isQuestion = event.tool_name === 'AskUserQuestion';
		const input = event.tool_input ?? {};
		const request = {
			id: randomUUID(),
			session: s.id,
			kind: isQuestion ? 'question' : 'permission',
			tool: event.tool_name ?? null,
			input: clipInput(input),
			suggestions: Array.isArray(event.permission_suggestions) ? event.permission_suggestions : [],
			questions: isQuestion && Array.isArray(input.questions) ? input.questions : [],
			createdAt: this.#now(),
		};
		return new Promise((resolve) => {
			const pending = { request, input, session: s, resolve, timer: null, signal, onAbort: null };
			pending.timer = setTimeout(() => this.#resolve(pending, null, 'expired', 'agent'), ttl);
			pending.timer.unref?.();
			pending.onAbort = () => this.#resolve(pending, null, 'withdrawn', 'computer');
			signal?.addEventListener('abort', pending.onAbort, { once: true });
			s.requests.set(request.id, pending);
			this.#requests.set(request.id, pending);
			s.state = 'waiting';
			this.#entry(s, { kind: 'request', request });
			this.emit('message', { type: 'request', request });
			this.#emitSession(s);
			if (signal?.aborted) pending.onAbort();
			else if (deferNow) this.#resolve(pending, null, 'deferred', 'agent');
		});
	}

	#resolve(pending, output, outcome, by) {
		const { request, session: s } = pending;
		if (!this.#requests.delete(request.id)) return;
		s.requests.delete(request.id);
		clearTimeout(pending.timer);
		pending.signal?.removeEventListener('abort', pending.onAbort);
		this.#resolved.add(request.id);
		if (this.#resolved.size > 1000) this.#resolved.delete(this.#resolved.values().next().value);
		if (s.state === 'waiting' && !s.requests.size) s.state = 'running';
		s.lastActivityAt = this.#now();
		this.#entry(s, { kind: 'request_resolved', request: request.id, outcome, by });
		this.emit('message', { type: 'request_resolved', session: s.id, request: request.id, outcome, by });
		this.#emitSession(s);
		pending.resolve(output);
	}

	async #backfill(s, file) {
		let entries = [];
		try {
			entries = await this.#transcript(file, MAX_ENTRIES);
		} catch {}
		const tools = new Map();
		for (const e of entries) {
			if (e.kind === 'tool') {
				tools.set(e.toolUseId, e.name);
				e.input = clipInput(e.input);
			} else if (e.kind === 'tool_result') {
				e.name ??= tools.get(e.toolUseId) ?? null;
				({ text: e.output, truncated: e.truncated } = clip(e.output));
			} else if (e.kind === 'title') {
				s.title = titleOf(e.text);
				s.titled = true;
				continue;
			} else if (e.kind === 'model') {
				s.model = e.model;
				continue;
			} else if (e.kind === 'prompt') {
				const { text, files } = this.#withFiles(e.text);
				e.text = text;
				if (files.length) e.files = files;
				if (!s.titled && e.text.trim() && !isNotice(e.text)) {
					s.title = titleOf(e.text);
					s.titled = true;
				}
				if (e.images) {
					const kept = await Promise.all(
						e.images.map((i) => Promise.resolve(this.keepImage?.(Buffer.from(i.data, 'base64'), i.type)).catch(() => null)),
					);
					e.images = kept.filter(Boolean);
					if (!e.images.length) delete e.images;
				}
			}
			s.entries.push({ seq: ++s.seq, ...e });
		}
		if (s.agent === 'claude' && Number.isInteger(entries.end)) s.transcriptOffset = entries.end;
		if (s.entries.length > MAX_ENTRIES) s.entries.splice(0, s.entries.length - MAX_ENTRIES);
	}

	/**
	 * Claude Code's shown thinking, its title for the conversation and the model answering, from the part of the
	 * transcript written since the last look. Text, tools and prompts come from the hooks.
	 */
	#catchUp(s) {
		// One read at a time: hooks of tools run in parallel arrive together.
		s.catchingUp = (s.catchingUp ?? Promise.resolve()).then(() => this.#readSince(s)).catch(() => {});
		return s.catchingUp;
	}

	async #readSince(s) {
		if (s.agent !== 'claude' || !s.transcriptPath || !Number.isInteger(s.transcriptOffset)) return;
		const read = await this.#transcriptSince(s.transcriptPath, s.transcriptOffset);
		if (!read) return;
		s.transcriptOffset = read.end;
		let changed = false;
		for (const e of read.entries) {
			if (e.kind === 'model') {
				if (e.model !== s.model) {
					s.model = e.model;
					changed = true;
				}
			} else if (e.kind === 'title') {
				const title = titleOf(e.text);
				if (title !== s.title) {
					s.title = title;
					changed = true;
				}
				s.titled = true;
			} else if (e.kind === 'assistant' && e.thinking) {
				this.#entry(s, { kind: 'assistant', text: e.text, thinking: true });
			}
		}
		if (changed) this.#emitSession(s);
	}

	/** Something Codex said or a tool's result, from its rollout, unless the hooks told it already. */
	#endTurn(s, now, error = null) {
		s.streaming.clear();
		const duration = s.turnStartedAt ? now - s.turnStartedAt : 0;
		s.turnStartedAt = null;
		s.state = s.requests.size ? 'waiting' : 'idle';
		this.#entry(s, { kind: 'turn_end', duration, ...(error ? { error: true, text: error } : {}) });
	}

	/**
	 * Codex's rollout says a turn ended. Stop doesn't run when it failed (an unsupported model, a
	 * lost connection), so a failed turn ends here, with its error. One that ended normally is
	 * left to Stop, which carries the last reply, unless Stop never comes (its hook failed).
	 */
	#rolloutTurnEnd(s, error) {
		if (s.turnStartedAt == null) return;
		const started = s.turnStartedAt;
		const end = () => {
			if (s.turnStartedAt !== started) return;
			this.#endTurn(s, this.#now(), error);
			s.lastActivityAt = this.#now();
			this.#emitSession(s);
		};
		if (error) end();
		else setTimeout(end, STOP_GRACE).unref?.();
	}

	#fromRollout(s, item) {
		const fields = codexItem(item);
		if (!fields) return;
		const recent = s.entries.slice(-8);
		if (fields.kind === 'assistant') {
			// Stop reports the last reply too, whichever arrives first.
			if (recent.some((e) => e.kind === 'assistant' && e.text.trim() === fields.text)) return;
			this.#entry(s, fields);
		} else {
			if (s.entries.some((e) => e.kind === 'tool_result' && e.toolUseId === fields.toolUseId)) return;
			const call = [...s.entries].reverse().find((e) => e.kind === 'tool' && e.toolUseId === fields.toolUseId);
			if (!call) return;
			const { text, truncated } = clip(fields.output);
			this.#entry(s, { kind: 'tool_result', toolUseId: fields.toolUseId, name: call.name, output: text, error: fields.error, truncated, duration: null });
		}
		s.lastActivityAt = this.#now();
		this.#emitSession(s);
	}

	#startTurn(s, now) {
		if (s.state !== 'waiting') s.state = 'running';
		s.turnStartedAt ??= now;
	}

	#end(s) {
		s.tail?.stop();
		s.tail = null;
		for (const pending of [...s.requests.values()]) this.#resolve(pending, null, 'withdrawn', 'computer');
		s.state = 'ended';
		s.endedAt = this.#now();
		s.turnStartedAt = null;
	}

	#entry(s, fields) {
		const entry = { seq: ++s.seq, time: this.#now(), ...fields };
		s.entries.push(entry);
		if (s.entries.length > MAX_ENTRIES) s.entries.shift();
		this.emit('message', { type: 'entry', session: s.id, entry });
	}

	/** A prompt's text without the paths of files a client attached, and those files. */
	#withFiles(text) {
		return attachedFiles(text, this.uploadsDir, this.fileType);
	}

	#emitSession(s) {
		this.emit('message', { type: 'session', session: s.toJSON() });
	}
}

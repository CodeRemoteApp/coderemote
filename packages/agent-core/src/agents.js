// Coding-agent sessions (Claude Code) as reported by their hooks: state, a bounded timeline,
// and the permission prompts and questions they are blocked on. See PROTOCOL.md, "Agents".
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { HttpError } from './sandbox.js';
import { RolloutTail, codexItem } from './codex-rollout.js';
import { readTranscript } from './transcript.js';

const MAX_ENTRIES = 500;
const MAX_TEXT = 16 * 1024;
const MAX_TITLE = 80;
const ENDED_TTL = 24 * 60 * 60 * 1000;
const REQUEST_TTL = 60 * 60 * 1000;
const START_TIMEOUT = 15 * 1000;
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
		capabilities: { approvals: 'parallel', alwaysAllow: true, keys: ['interrupt', 'cycle_mode', '/compact', '/clear', '/model'] },
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
	#startTimeout;
	#sequentialTtl;
	#rolloutTail;

	/**
	 * `present` says whether someone is at the computer or looking at it in a client; agents whose
	 * approvals are sequential ask there instead of holding the request for the phone.
	 */
	constructor({
		now = Date.now,
		requestTtl = REQUEST_TTL,
		sequentialTtl = SEQUENTIAL_REQUEST_TTL,
		transcript = readTranscript,
		startTimeout = START_TIMEOUT,
		present = async () => false,
		rolloutTail = (file, onItem) => new RolloutTail(file, onItem),
	} = {}) {
		super();
		this.#now = now;
		this.#requestTtl = requestTtl;
		this.#sequentialTtl = sequentialTtl;
		this.#transcript = transcript;
		this.#startTimeout = startTimeout;
		this.present = present;
		this.#rolloutTail = rolloutTail;
		// A server leaves `present` alone when the hub was given one.
		this.presenceSet = arguments[0]?.present !== undefined;
	}

	/**
	 * A prompt a client typed into a session's terminal. Once Claude Code reports a matching
	 * `UserPromptSubmit`, the socket gets `prompt_confirmed` with this id.
	 */
	prompted(sessionId, { id, text, paths = [] }) {
		const s = this.#sessions.get(sessionId);
		if (!s) return;
		s.prompts.push({ id, text: comparable(text, paths), at: this.#now() });
		// Unconfirmed prompts don't pile up: the client gives up on them after 10 seconds anyway.
		s.prompts = s.prompts.filter((p) => this.#now() - p.at < 60_000).slice(-20);
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

	timeline(id, after = 0) {
		const s = this.#sessions.get(id);
		if (!s) throw new HttpError(404, 'no such session');
		const entries = s.entries.filter((e) => e.seq > after);
		return { entries, next: s.seq, requests: [...s.requests.values()].map((r) => r.request) };
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
			const candidates = [...this.#sessions.values()].filter((p) =>
				p.starting && (terminal ? p.terminal === terminal : p.agent === agent && p.cwd === event.cwd),
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
			if (!fresh && typeof event.transcript_path === 'string') s.ready = this.#backfill(s, event.transcript_path);
		}
		await s.ready;
		if (s.agent === 'codex' && !s.tail && typeof event.transcript_path === 'string') {
			s.tail = this.#rolloutTail(event.transcript_path, (item) => this.#fromRollout(s, item));
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
		}

		switch (event.hook_event_name) {
			case 'SessionStart':
				break;
			case 'UserPromptSubmit': {
				const text = typeof event.prompt === 'string' ? event.prompt : '';
				if (!s.titled && text.trim()) {
					s.title = titleOf(text);
					s.titled = true;
				}
				this.#startTurn(s, now);
				this.#entry(s, { kind: 'prompt', text });
				const said = comparable(text);
				const i = s.prompts.findIndex((p) => p.text === said || (p.text && said.startsWith(p.text)));
				if (i >= 0) {
					const [prompt] = s.prompts.splice(i, 1);
					this.emit('message', { type: 'prompt_confirmed', session: s.id, prompt: prompt.id });
				}
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
				s.streaming.clear();
				const duration = s.turnStartedAt ? now - s.turnStartedAt : 0;
				s.turnStartedAt = null;
				s.state = s.requests.size ? 'waiting' : 'idle';
				this.#entry(s, { kind: 'turn_end', duration });
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
				this.#end(s);
				break;
			default:
				break;
		}
		this.#emitSession(s);
		return {};
	}

	/** The terminal a session ran in exited: whatever ran in it is over. */
	terminalExited(terminal) {
		for (const s of this.#sessions.values()) {
			if (s.terminal === terminal && s.state !== 'ended') {
				if (s.starting) s.error = `${(ADAPTERS[s.agent] ?? ADAPTERS.claude).name} exited before it started. Open the terminal to see why.`;
				s.starting = false;
				this.#end(s);
				this.#emitSession(s);
			}
		}
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
			} else if (e.kind === 'prompt' && !s.titled && e.text.trim()) {
				s.title = titleOf(e.text);
				s.titled = true;
			}
			s.entries.push({ seq: ++s.seq, ...e });
		}
		if (s.entries.length > MAX_ENTRIES) s.entries.splice(0, s.entries.length - MAX_ENTRIES);
	}

	/** Something Codex said or a tool's result, from its rollout, unless the hooks told it already. */
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

	#emitSession(s) {
		this.emit('message', { type: 'session', session: s.toJSON() });
	}
}

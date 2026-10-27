// `coderemote requests`: prints what the preview proxy recorded, for a person or a coding agent in
// a terminal. Secrets (auth headers, cookies, token-like fields) are masked unless asked for.

const MASK = '[redacted]';
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|api[-_]?key|session|signature|csrf|xsrf/i;
const SECRET_FIELD = /pass(word|wd)?$|secret|token|api[-_]?key|authorization|cookie|session|credential|private[-_]?key|^otp$|^code$|signature/i;

/** Masks secrets in place of a recorded request; `count()` tells how many were hidden. */
export class Redactor {
	hidden = 0;

	constructor({ show = false } = {}) {
		this.show = show;
	}

	#mask() {
		this.hidden++;
		return MASK;
	}

	/** Query parameters with secret-looking names, e.g. ?token=…. */
	path(value) {
		if (this.show) return value;
		const q = value.indexOf('?');
		if (q < 0) return value;
		const params = value
			.slice(q + 1)
			.split('&')
			.map((pair) => {
				const eq = pair.indexOf('=');
				if (eq < 0 || !SECRET_FIELD.test(decodeSafe(pair.slice(0, eq)))) return pair;
				return `${pair.slice(0, eq)}=${this.#mask()}`;
			});
		return `${value.slice(0, q)}?${params.join('&')}`;
	}

	header(name, value) {
		if (this.show || !SECRET_HEADER.test(name)) return value;
		const lower = name.toLowerCase();
		// Keep what helps debugging: the scheme, and which cookies were sent or set.
		if (lower === 'authorization' || lower === 'proxy-authorization') {
			const space = value.indexOf(' ');
			return space > 0 ? `${value.slice(0, space)} ${this.#mask()}` : this.#mask();
		}
		if (lower === 'cookie') return value.split(/;\s*/).map((c) => this.#cookie(c)).join('; ');
		if (lower === 'set-cookie') {
			const [first, ...attributes] = value.split(/;\s*/);
			return [this.#cookie(first), ...attributes].join('; ');
		}
		return this.#mask();
	}

	#cookie(pair) {
		const eq = pair.indexOf('=');
		return eq < 0 ? pair : `${pair.slice(0, eq)}=${this.#mask()}`;
	}

	/** JSON and form bodies get secret fields masked; other text is left as sent. */
	body(text, contentType = '', { pretty = true } = {}) {
		if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
			try {
				const value = JSON.parse(text);
				return JSON.stringify(this.show ? value : this.#json(value), null, pretty ? 2 : undefined);
			} catch {}
		}
		if (!this.show && /x-www-form-urlencoded/i.test(contentType)) return this.path(`?${text}`).slice(1);
		return text;
	}

	#json(value) {
		if (Array.isArray(value)) return value.map((v) => this.#json(v));
		if (!value || typeof value !== 'object') return value;
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [
				k,
				SECRET_FIELD.test(k) && v != null && typeof v !== 'object' && typeof v !== 'boolean' ? this.#mask() : this.#json(v),
			]),
		);
	}
}

function decodeSafe(s) {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Narrows summaries: `grep` matches method and path, `failed` keeps errors and 4xx/5xx. */
export function filterRequests(requests, { grep, failed } = {}) {
	const needle = grep?.toLowerCase();
	return requests.filter(
		(r) =>
			(!needle || `${r.method} ${r.path}`.toLowerCase().includes(needle)) &&
			(!failed || r.error || (r.status ?? 0) >= 400),
	);
}

function time(ms) {
	return new Date(ms).toTimeString().slice(0, 8);
}

function bytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** One line per request, oldest first: `#id  status  METHOD path  duration  size  time  [port]`. */
export function formatList(requests, redactor, { showPort = false } = {}) {
	return requests
		.map((r) => {
			const status = r.error ? 'ERR' : r.status == null ? '...' : String(r.status);
			const parts = [
				`#${r.id}`.padEnd(6),
				status.padEnd(4),
				`${r.method} ${redactor.path(r.path)}`,
				r.duration == null ? 'pending' : `${r.duration} ms`,
				bytes(r.responseSize),
				time(r.time),
			];
			if (showPort) parts.push(`port ${r.port}`);
			if (r.error) parts.push(r.error);
			return parts.join('  ');
		})
		.join('\n');
}

/** Headers and bodies of one request, as the proxy kept them. */
export function formatDetail(d, redactor) {
	const status = d.error ? `error: ${d.error}` : d.status == null ? 'no response yet' : String(d.status);
	const lines = [
		`#${d.id}  ${d.method} ${redactor.path(d.path)}  ->  ${status}`,
		`${new Date(d.time).toISOString()}${d.duration == null ? '' : `  ${d.duration} ms`}`,
	];
	for (const [title, message] of [
		['Request', d.request],
		['Response', d.response],
	]) {
		lines.push('', `${title} headers:`);
		for (const name of Object.keys(message.headers).sort()) {
			const values = [].concat(message.headers[name]);
			for (const value of values) lines.push(`  ${name}: ${redactor.header(name, String(value))}`);
		}
		lines.push('', `${title} body: ${describeBody(message.body, redactor, message.headers['content-type'])}`);
	}
	return lines.join('\n');
}

function describeBody(body, redactor, contentType) {
	if (!body.size) return '(empty)';
	if (body.truncated) return `${bytes(body.size)}, too large to keep (only bodies up to 64 KB are recorded)`;
	if (body.text == null) return `${bytes(body.size)} of binary data`;
	return `${bytes(body.size)}\n${indent(redactor.body(body.text, contentType))}`;
}

function indent(text) {
	return text.replace(/^/gm, '  ');
}

/** The JSON form of a detail, masked the same way as the text one. */
export function redactDetail(d, redactor) {
	const message = (m) => ({
		headers: Object.fromEntries(
			Object.entries(m.headers).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => redactor.header(k, String(x))) : redactor.header(k, String(v))]),
		),
		body: m.body.text == null ? m.body : { ...m.body, text: redactor.body(m.body.text, m.headers['content-type'], { pretty: false }) },
	});
	return { ...d, path: redactor.path(d.path), request: message(d.request), response: message(d.response) };
}

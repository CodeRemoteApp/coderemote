// Tells `coderemote up` users about a newer release, and installs it for `coderemote update`.
// The registry is asked at most once a day; the answer is cached in ~/.coderemote/update.json
// so a slow or offline network never holds anything up.
import fs from 'node:fs';
import path from 'node:path';

const LATEST_URL = 'https://registry.npmjs.org/coderemote/latest';
const CHECK_INTERVAL_MS = 24 * 3_600_000;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** True when `latest` is a newer release than `current` (prereleases count only against prereleases). */
export function isNewer(latest, current) {
	const a = SEMVER.exec(latest ?? '');
	const b = SEMVER.exec(current ?? '');
	if (!a || !b) return false;
	for (let i = 1; i <= 3; i++) {
		if (+a[i] !== +b[i]) return +a[i] > +b[i];
	}
	// Same x.y.z: the release is newer than its own prerelease, never the other way round.
	return !a[4] && !!b[4];
}

/** The latest version on npm, or null when the registry can't be reached in time. */
export async function fetchLatest({ fetch = globalThis.fetch, timeoutMs = 3000 } = {}) {
	try {
		const res = await fetch(LATEST_URL, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return null;
		const { version } = await res.json();
		return SEMVER.test(version) ? version : null;
	} catch {
		return null;
	}
}

/**
 * The newer version to announce, or null. Uses the cached answer when it's under a day old,
 * otherwise asks the registry (and caches what it says).
 * @param {object} opts
 * @param {string} opts.current  this CLI's version
 * @param {string} opts.dir  where update.json lives (~/.coderemote)
 */
export async function availableUpdate({ current, dir, fetch, now = Date.now() }) {
	const file = path.join(dir, 'update.json');
	let cache = {};
	try {
		cache = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {}
	let latest = cache.latest;
	if (!latest || !(now - (cache.checkedAt ?? 0) < CHECK_INTERVAL_MS)) {
		const fetched = await fetchLatest({ fetch });
		if (fetched) {
			latest = fetched;
			try {
				fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
				fs.writeFileSync(file, JSON.stringify({ latest, checkedAt: now }));
			} catch {}
		}
	}
	return isNewer(latest, current) ? latest : null;
}

/**
 * The command that installs the latest release with the package manager this copy came from,
 * judged by where it's installed (npm unless the path says otherwise).
 * @param {string} installedAt  the real path of the running CLI
 */
export function installCommand(installedAt) {
	const p = installedAt.split(path.sep).join('/');
	if (p.includes('/pnpm/') || p.includes('/.pnpm/')) return ['pnpm', ['add', '-g', 'coderemote@latest']];
	if (p.includes('/.bun/')) return ['bun', ['add', '-g', 'coderemote@latest']];
	if (p.includes('/.yarn/') || p.includes('/yarn/global/')) return ['yarn', ['global', 'add', 'coderemote@latest']];
	return ['npm', ['install', '-g', 'coderemote@latest']];
}

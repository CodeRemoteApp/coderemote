#!/usr/bin/env node
// Works out the next coderemote release from what already exists (git tags v* and the
// versions on npm) and an optional request:
//
//   node next-version.mjs              → next patch of the highest stable version (1.1.21 → 1.1.22)
//   node next-version.mjs beta         → next beta (1.2.0-beta.3 → 1.2.0-beta.4, else 1.1.22-beta.1)
//   node next-version.mjs v1.2.0       → exactly that version (also v1.2.0-beta.1, rc, …)
//
// Prints JSON: { version, tag, distTag, previous }. Exits 1 with a message when the request is
// invalid or the version already exists. `--existing a,b,c` replaces the lookup (for tests).
import { execFileSync } from 'node:child_process';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parse(v) {
	const m = SEMVER.exec(v);
	return m && { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null, raw: v };
}

function comparePre(a, b) {
	if (a === b) return 0;
	if (a === null) return 1; // a release sorts after its prereleases
	if (b === null) return -1;
	const pa = a.split('.');
	const pb = b.split('.');
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		if (pa[i] === undefined) return -1;
		if (pb[i] === undefined) return 1;
		const na = /^\d+$/.test(pa[i]);
		const nb = /^\d+$/.test(pb[i]);
		if (na && nb && +pa[i] !== +pb[i]) return +pa[i] - +pb[i];
		if (na !== nb) return na ? -1 : 1;
		if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
	}
	return 0;
}

function compare(a, b) {
	return a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePre(a.pre, b.pre);
}

function sh(cmd, args) {
	try {
		return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
	} catch {
		return '';
	}
}

function existingVersions() {
	const tags = sh('git', ['tag', '-l', 'v*']).split('\n').map((t) => t.trim().replace(/^v/, ''));
	let npm = [];
	try {
		npm = JSON.parse(sh('npm', ['view', 'coderemote', 'versions', '--json']) || '[]');
	} catch {}
	if (!Array.isArray(npm)) npm = [npm];
	// npm's "0.0.0-stage" is the placeholder it creates for staged publishing, not a release.
	return [...new Set([...tags, ...npm])].filter((v) => v && v !== '0.0.0-stage').map(parse).filter(Boolean);
}

function fail(message) {
	console.error(message);
	process.exit(1);
}

const args = process.argv.slice(2);
const existingFlag = args.indexOf('--existing');
const existing =
	existingFlag >= 0
		? args.splice(existingFlag, 2)[1].split(',').filter(Boolean).map(parse)
		: existingVersions();
const request = args[0];

const sorted = existing.sort(compare);
const highest = sorted.at(-1) ?? null;
const highestStable = sorted.filter((v) => !v.pre).at(-1) ?? parse('0.0.0');
const nextPatch = `${highestStable.major}.${highestStable.minor}.${highestStable.patch + 1}`;

let version;
if (!request) {
	version = nextPatch;
} else if (request === 'beta') {
	const beta = highest?.pre?.match(/^beta\.(\d+)$/);
	version = beta && compare(highest, highestStable) > 0
		? `${highest.major}.${highest.minor}.${highest.patch}-beta.${+beta[1] + 1}`
		: `${nextPatch}-beta.1`;
} else {
	const wanted = parse(request.replace(/^v/, ''));
	if (!wanted) fail(`"${request}" isn't a version like v1.2.0 or v1.2.0-beta.1.`);
	version = wanted.raw;
}

const target = parse(version);
if (existing.some((v) => compare(v, target) === 0)) fail(`v${version} already exists (git tag or npm).`);
if (!target.pre && compare(target, highestStable) <= 0) {
	fail(`v${version} isn't newer than the latest release v${highestStable.raw ?? '0.0.0'}.`);
}

console.log(
	JSON.stringify({
		version,
		tag: `v${version}`,
		distTag: target.pre ? 'next' : 'latest',
		previous: highest ? `v${highest.raw}` : null,
	}),
);

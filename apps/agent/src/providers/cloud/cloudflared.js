// Finds Cloudflare's tunnel connector, `cloudflared`, downloading it on first use. Order:
// $CODEREMOTE_CLOUDFLARED, `cloudflared` on PATH (Homebrew, a package), then a pinned release
// managed in ~/.coderemote/bin. The managed copy must match a SHA-256 built into this file, and on
// macOS also carry Cloudflare's Developer ID signature. A newer version comes with a coderemote
// release that bumps the table, never on its own.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { findExecutable } from '@vsremote/agent-core';
import { spawnTied } from '../../tied.js';

const run = promisify(execFile);

export const CLOUDFLARED_VERSION = '2026.11.2';
const RELEASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;
// From the release's asset digests; `.tgz` assets hold the binary at the archive's top.
export const BUILDS = {
	'darwin-arm64': { asset: 'cloudflared-darwin-arm64.tgz', sha256: 'f6d58eeec91ad1ec5fd1f7e4a587303772929b2625be5d24068033851c36ff55' },
	'darwin-x64': { asset: 'cloudflared-darwin-amd64.tgz', sha256: '6153d9ec629174882a3adbff2f7dc5a24b4f3bdd7ccc38eaa84fba26eb890311' },
	'linux-arm64': { asset: 'cloudflared-linux-arm64', sha256: '04a7b7f08bce85d56b26ffe1fdbfbb21a074495a363d16f0783c40e25b5c5281' },
	'linux-x64': { asset: 'cloudflared-linux-amd64', sha256: '56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf' },
	'win32-x64': { asset: 'cloudflared-windows-amd64.exe', sha256: '555b46c85582461d189cac30d14ad05480d612613801be9f110b8ce08c5b2113' },
	// There's no Arm build for Windows; the x64 one runs there under emulation.
	'win32-arm64': { asset: 'cloudflared-windows-amd64.exe', sha256: '555b46c85582461d189cac30d14ad05480d612613801be9f110b8ce08c5b2113' },
};
// Apple Developer ID team of Cloudflare, which signs the macOS builds.
const CLOUDFLARE_TEAM_ID = '68WVV388M8';

/**
 * @param {object} opts
 * @param {string} opts.dir  where the managed copy lives (~/.coderemote/bin)
 * @param {(text: string) => void} opts.progress  called while downloading
 * @returns {Promise<string>} the command to run
 */
export async function ensureCloudflared({
	dir,
	progress = () => {},
	env = process.env,
	platform = process.platform,
	arch = process.arch,
	builds = BUILDS,
	fetchFn = fetch,
	find = (name) => findExecutable(name, env),
	verifySignature = platform === 'darwin' ? verifyMacSignature : async () => {},
}) {
	const override = env.CODEREMOTE_CLOUDFLARED;
	if (override) {
		const found = find(override);
		if (found) return found;
		throw new Error(`CODEREMOTE_CLOUDFLARED=${override} isn't an executable file.`);
	}
	const fromPath = find('cloudflared');
	if (fromPath) return fromPath;

	const build = builds[`${platform}-${arch}`];
	if (!build) {
		throw new Error(
			`No cloudflared build for ${platform}-${arch}. Install it yourself ` +
				'(https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/), then try again.',
		);
	}
	const exe = platform === 'win32' ? '.exe' : '';
	// Versioned, so a coderemote that pins a newer release downloads it instead of using this one.
	const bin = path.join(dir, `cloudflared-${CLOUDFLARED_VERSION}${exe}`);
	if (fs.existsSync(bin)) return bin;
	await download({ url: `${RELEASE}/${build.asset}`, build, bin, dir, progress, fetchFn, verifySignature });
	// Older managed versions are no longer used.
	for (const name of fs.readdirSync(dir)) {
		if (/^cloudflared-\d/.test(name) && path.join(dir, name) !== bin) fs.rmSync(path.join(dir, name), { force: true, recursive: true });
	}
	return bin;
}

async function download({ url, build, bin, dir, progress, fetchFn, verifySignature }) {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${bin}.${process.pid}.download`;
	const unpacked = `${tmp}.d`;
	try {
		const res = await fetchFn(url, { signal: AbortSignal.timeout(180_000) });
		if (!res.ok || !res.body) throw new Error(`Downloading cloudflared failed: HTTP ${res.status} from ${url}`);
		const total = Number(res.headers.get('content-length')) || 0;
		const out = fs.createWriteStream(tmp, { mode: 0o700 });
		const sha = createHash('sha256');
		let received = 0;
		try {
			for await (const chunk of res.body) {
				sha.update(chunk);
				received += chunk.length;
				if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
				if (total) progress(`${Math.floor((received / total) * 100)}%`);
			}
			await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
		} catch (e) {
			out.destroy();
			throw e;
		}
		if (sha.digest('hex') !== build.sha256) throw new Error(`cloudflared download doesn't match the pinned SHA-256 for ${CLOUDFLARED_VERSION}; refused.`);
		let file = tmp;
		if (build.asset.endsWith('.tgz')) {
			fs.mkdirSync(unpacked, { mode: 0o700 });
			await run('tar', ['-xzf', tmp, '-C', unpacked]);
			file = path.join(unpacked, 'cloudflared');
			if (!fs.existsSync(file)) throw new Error('cloudflared archive has no cloudflared in it');
		}
		await verifySignature(file);
		fs.chmodSync(file, 0o755);
		fs.renameSync(file, bin);
	} finally {
		fs.rmSync(tmp, { force: true });
		fs.rmSync(unpacked, { force: true, recursive: true });
	}
}

/** macOS builds must carry Cloudflare's Developer ID signature. */
export async function verifyMacSignature(file) {
	try {
		await run('codesign', ['--verify', '--strict', file]);
		const { stderr } = await run('codesign', ['-dv', file]);
		if (!stderr.includes(`TeamIdentifier=${CLOUDFLARE_TEAM_ID}`)) throw new Error('not signed by Cloudflare');
	} catch (e) {
		throw new Error(`cloudflared download failed its signature check: ${e.message}`);
	}
}

const READY = /Registered tunnel connection/;
const LOG_KEEP = 8192;

/**
 * Runs the connector for a remotely managed tunnel. The token goes in through the environment
 * (`TUNNEL_TOKEN`), never the arguments, so other users listing processes don't see it. Resolves
 * the child once its first edge connection is registered; rejects with its last log lines when it
 * exits first, or after `timeoutMs` (it's then ended).
 */
export function runConnector(bin, token, { timeoutMs = 0, spawnHost = spawnTied, env = process.env } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawnHost(bin, ['tunnel', '--no-autoupdate', 'run'], { stdout: 'ignore', stderr: 'pipe', env: { ...env, TUNNEL_TOKEN: token } });
		let log = '';
		let ready = false;
		const tail = () => log.trim().split('\n').slice(-8).join('\n');
		const timer = timeoutMs
			? setTimeout(() => {
					reject(new Error(`cloudflared didn't connect within ${timeoutMs / 1000}s:\n${tail()}`));
					child.kill();
				}, timeoutMs)
			: null;
		child.stderr.on('data', (d) => {
			if (ready) return;
			log = (log + d).slice(-LOG_KEEP);
			if (READY.test(log)) {
				ready = true;
				clearTimeout(timer);
				resolve(child);
			}
		});
		child.on('error', (e) => {
			clearTimeout(timer);
			reject(new Error(`cloudflared couldn't start: ${e.message}`));
		});
		child.on('exit', (code, signal) => {
			clearTimeout(timer);
			if (!ready) reject(new Error(`cloudflared exited (${signal ?? code}):\n${tail()}`));
		});
	});
}

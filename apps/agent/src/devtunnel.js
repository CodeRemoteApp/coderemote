// Finds the Microsoft Dev Tunnels CLI, downloading it on first use so `npm install -g coderemote`
// is the only setup step. Order: $CODEREMOTE_DEVTUNNEL, `devtunnel` on PATH, then a copy managed
// in ~/.coderemote/bin (fetched from Microsoft, verified, refreshed at most once a day).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { findExecutable, isWindows } from '@vsremote/agent-core';

const run = promisify(execFile);

// The same downloads Microsoft's installer (https://aka.ms/DevTunnelCliInstall) uses.
const DOWNLOAD_BASE = 'https://tunnelsassetsprod.blob.core.windows.net/cli';
const BUILDS = {
	'darwin-arm64': 'osx-arm64-devtunnel',
	'darwin-x64': 'osx-x64-devtunnel',
	'linux-arm64': 'linux-arm64-devtunnel',
	'linux-x64': 'linux-x64-devtunnel',
	'win32-x64': 'devtunnel.exe',
	// There's no Arm build for Windows; the x64 one runs there under emulation.
	'win32-arm64': 'devtunnel.exe',
};
// Apple Developer ID team of Microsoft Corporation, which signs the macOS builds.
const MICROSOFT_TEAM_ID = 'UBF8T346G9';
// The Authenticode signer of the Windows builds.
const MICROSOFT_SIGNER = /^CN=Microsoft Corporation, O=Microsoft Corporation,/;
const REFRESH_INTERVAL_MS = 24 * 3_600_000;

/**
 * @param {object} opts
 * @param {string} opts.dir  where the managed copy lives (~/.coderemote/bin)
 * @param {(text: string) => void} opts.progress  called while downloading
 * @returns {Promise<string>} the command to run
 */
export async function ensureDevtunnel({ dir, progress }) {
	const override = process.env.CODEREMOTE_DEVTUNNEL;
	if (override) {
		const found = findExecutable(override);
		if (found) return found;
		throw new Error(`CODEREMOTE_DEVTUNNEL=${override} isn't an executable file.`);
	}
	// Checked on disk rather than by running it: devtunnel takes 1-2s just to print its version.
	const fromPath = findExecutable('devtunnel');
	if (fromPath) return fromPath;

	const build = BUILDS[`${process.platform}-${process.arch}`];
	if (!build) {
		throw new Error(
			`No devtunnel build for ${process.platform}-${process.arch}. Install it yourself: ` +
				'https://learn.microsoft.com/azure/developer/dev-tunnels/get-started',
		);
	}
	const bin = path.join(dir, isWindows ? 'devtunnel.exe' : 'devtunnel');
	const metaFile = path.join(dir, 'devtunnel.json');
	let meta = {};
	try {
		meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
	} catch {}

	const installed = findExecutable(bin) !== null;
	if (installed && Date.now() - (meta.checkedAt ?? 0) < REFRESH_INTERVAL_MS) return bin;

	const url = `${DOWNLOAD_BASE}/${build}`;
	if (installed) {
		// Daily check for a newer build; offline or slow just keeps the current one.
		try {
			const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
			const lastModified = head.headers.get('last-modified');
			if (head.ok && lastModified && lastModified === meta.lastModified) {
				fs.writeFileSync(metaFile, JSON.stringify({ ...meta, checkedAt: Date.now() }));
				return bin;
			}
		} catch {
			return bin;
		}
	}

	try {
		await download(url, bin, metaFile, progress);
	} catch (e) {
		// A refresh that fails keeps the current copy: offline, say, or Windows refusing to
		// replace a devtunnel.exe another agent is running.
		if (!installed) throw e;
	}
	return bin;
}

async function download(url, bin, metaFile, progress) {
	fs.mkdirSync(path.dirname(bin), { recursive: true, mode: 0o700 });
	const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	if (!res.ok || !res.body) throw new Error(`Downloading devtunnel failed: HTTP ${res.status} from ${url}`);
	const total = Number(res.headers.get('content-length')) || 0;
	const tmp = `${bin}.${process.pid}.download`;
	const out = fs.createWriteStream(tmp, { mode: 0o755 });
	const md5 = createHash('md5');
	let received = 0;
	try {
		for await (const chunk of res.body) {
			md5.update(chunk);
			received += chunk.length;
			if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
			if (total) progress(`${Math.floor((received / total) * 100)}%`);
		}
		await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
		if (total && received !== total) throw new Error(`devtunnel download was cut short (${received} of ${total} bytes)`);
		await verify(tmp, md5.digest('base64'), res.headers.get('content-md5'));
		fs.chmodSync(tmp, 0o755);
		fs.renameSync(tmp, bin);
	} catch (e) {
		out.destroy();
		fs.rmSync(tmp, { force: true });
		throw e;
	}
	fs.writeFileSync(metaFile, JSON.stringify({ lastModified: res.headers.get('last-modified'), checkedAt: Date.now() }));
}

/**
 * macOS builds must carry Microsoft's Developer ID signature and Windows builds its Authenticode
 * one; elsewhere the MD5 must match.
 */
export async function verify(file, md5, expectedMd5) {
	if (expectedMd5 && md5 !== expectedMd5) throw new Error('devtunnel download is corrupt (MD5 mismatch)');
	if (isWindows) return verifyAuthenticode(file);
	if (process.platform !== 'darwin') return;
	try {
		await run('codesign', ['--verify', '--strict', file]);
		const { stderr } = await run('codesign', ['-dv', file]);
		if (!stderr.includes(`TeamIdentifier=${MICROSOFT_TEAM_ID}`)) throw new Error('not signed by Microsoft');
	} catch (e) {
		throw new Error(`devtunnel download failed its signature check: ${e.message}`);
	}
}

async function verifyAuthenticode(file) {
	// The path goes in through the environment, so nothing in it is read as PowerShell.
	const script = '$s = Get-AuthenticodeSignature -LiteralPath $env:CODEREMOTE_VERIFY; "$($s.Status)|$($s.SignerCertificate.Subject)"';
	let status;
	let signer;
	try {
		const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
			env: { ...process.env, CODEREMOTE_VERIFY: file },
		});
		[status, signer] = stdout.trim().split('|');
	} catch (e) {
		throw new Error(`devtunnel download failed its signature check: ${e.message}`);
	}
	if (status !== 'Valid' || !MICROSOFT_SIGNER.test(signer ?? '')) {
		throw new Error(`devtunnel download failed its signature check: ${status}, signed by ${signer || 'nobody'}`);
	}
}

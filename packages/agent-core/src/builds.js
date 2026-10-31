// Builds an Xcode project in the shared folder for the developer's own devices (archive, then a
// development-signed export), so the phone can install it over the air. One build at a time;
// only the latest is kept. See PROTOCOL.md, "Builds".
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from './sandbox.js';

const MAX_LINES = 5000;
const MAX_LINE = 2048;
const MAX_ERRORS = 20;
const TAIL_LINES = 15;
const KILL_AFTER = 5000;

// What xcodebuild says when signing can't work, and what to do about it in Xcode.
const SIGNING_HINTS = [
	[/requires a development team/i, 'Set a team in Xcode: select the app target, then Signing & Capabilities › Team.'],
	[/No Account for Team|No accounts? (?:with|for|in)/i, 'Sign in to Xcode with an Apple Account of the project\'s team (Xcode › Settings › Accounts).'],
	[
		/No profiles for|requires a provisioning profile|doesn't include (?:the )?(?:currently selected )?device|not registered|no devices/i,
		'Run the app on this iPhone from Xcode once, so it is registered for development builds.',
	],
];

/** The Xcode workspace or project directly in `folder` (a workspace wins), or null. */
export async function findContainer(folder) {
	let names;
	try {
		names = await fs.readdir(folder);
	} catch {
		return null;
	}
	for (const [ext, kind] of [['.xcworkspace', 'workspace'], ['.xcodeproj', 'project']]) {
		const name = names.filter((n) => n.endsWith(ext)).sort()[0];
		if (name) return { container: path.join(folder, name), kind };
	}
	return null;
}

function run(command, args, { cwd, timeout = 120_000 } = {}) {
	return new Promise((resolve, reject) => {
		execFile(command, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(Object.assign(new HttpError(409, (stderr || error.message).trim().split('\n').slice(-3).join('\n')), { code: 'EXCODE' }));
			else resolve(stdout);
		});
	});
}

/** The schemes of the workspace or project in `folder`: `{ container, kind, schemes }`. */
export async function listSchemes(folder, { xcodebuild = 'xcodebuild' } = {}) {
	const found = await findContainer(folder);
	if (!found) throw new HttpError(404, 'no Xcode project or workspace in this folder');
	const out = JSON.parse(await run(xcodebuild, ['-list', '-json', `-${found.kind}`, found.container], { cwd: folder }));
	const schemes = out[found.kind]?.schemes ?? [];
	return { container: path.basename(found.container), kind: found.kind, schemes };
}

/** Why a failed build failed, from its log: compile errors, else xcodebuild's errors, else its last lines. */
export function failureOf(lines) {
	const compile = [...new Set(lines.filter((l) => /^\S.*?:\d+:(?:\d+:)? error: /.test(l)))];
	if (compile.length) return compile.slice(0, MAX_ERRORS).join('\n');
	const errors = [...new Set(lines.filter((l) => /^(?:xcodebuild: )?error: /.test(l.trim())).map((l) => l.trim()))];
	const text = (errors.length ? errors.slice(0, MAX_ERRORS) : lines.slice(-TAIL_LINES)).join('\n');
	const hint = SIGNING_HINTS.find(([re]) => re.test(text))?.[1];
	return hint ? `${hint}\n\n${text}` : text;
}

function exportOptions() {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>method</key><string>debugging</string>
	<key>signingStyle</key><string>automatic</string>
	<key>compileBitcode</key><false/>
	<key>thinning</key><string>&lt;none&gt;</string>
</dict></plist>
`;
}

/** Info.plist fields of the archived app, through plutil (macOS). */
async function readInfo(appPath) {
	const info = JSON.parse(await run('plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Info.plist')]));
	return {
		bundleId: info.CFBundleIdentifier,
		version: info.CFBundleShortVersionString ?? info.CFBundleVersion ?? '1.0',
		name: info.CFBundleDisplayName ?? info.CFBundleName ?? path.basename(appPath, '.app'),
	};
}

/**
 * Runs builds one at a time and keeps the latest. Emits `ended` with the build when one ends.
 * `xcodebuild` and `readInfo` are injectable for tests.
 */
export class BuildRunner extends EventEmitter {
	#xcodebuild;
	#readInfo;
	#dir;
	#now;
	#killAfter;
	#build = null;
	#lines = [];
	#child = null;

	constructor({ xcodebuild = 'xcodebuild', readInfo: info = readInfo, dir = path.join(os.homedir(), '.coderemote', 'builds'), now = Date.now, killAfter = KILL_AFTER } = {}) {
		super();
		this.#xcodebuild = xcodebuild;
		this.#readInfo = info;
		this.#dir = dir;
		this.#now = now;
		this.#killAfter = killAfter;
	}

	get running() {
		return this.#build?.state === 'running';
	}

	/** The latest build with its log lines after `after` (a line count), or null before any. */
	current(after = 0) {
		if (!this.#build) return null;
		const { first } = this.#build;
		const from = Math.max(after, first);
		return { ...this.#public(), log: this.#lines.slice(from - first), next: first + this.#lines.length };
	}

	/** The `.ipa` and app fields of the latest build, once it succeeded. */
	artifact() {
		return this.#build?.state === 'succeeded' ? this.#build.artifact : null;
	}

	/** Starts building `scheme` of the project in `folder`; answers the build. */
	async start({ folder, scheme, configuration = 'Debug' }) {
		if (this.running) throw new HttpError(409, 'a build is already running');
		if (typeof scheme !== 'string' || !scheme) throw new HttpError(400, 'scheme is required');
		if (!/^[\w .-]+$/.test(configuration)) throw new HttpError(400, 'invalid configuration');
		const found = await findContainer(folder);
		if (!found) throw new HttpError(404, 'no Xcode project or workspace in this folder');
		const id = randomUUID();
		const out = path.join(this.#dir, id);
		await fs.rm(this.#dir, { recursive: true, force: true });
		await fs.mkdir(out, { recursive: true });
		this.#lines = [];
		this.#build = { id, path: folder, scheme, configuration, state: 'running', step: 'archiving', startedAt: this.#now(), endedAt: null, error: null, first: 0, artifact: null };
		const build = this.#build;
		this.#run(build, found, out).catch(() => {});
		return this.#public();
	}

	/** Stops the running build. */
	cancel() {
		if (!this.running) throw new HttpError(409, 'no build is running');
		this.#build.cancelled = true;
		this.#stop();
	}

	#public() {
		const { id, path: folder, scheme, configuration, state, step, startedAt, endedAt, error, artifact } = this.#build;
		return { id, path: folder, scheme, configuration, state, step, startedAt, endedAt, error, app: artifact?.app ?? null };
	}

	#log(text) {
		for (const raw of text.split(/\r?\n/)) {
			if (!raw) continue;
			this.#lines.push(raw.length > MAX_LINE ? `${raw.slice(0, MAX_LINE)}…` : raw);
		}
		const extra = this.#lines.length - MAX_LINES;
		if (extra > 0) {
			this.#lines.splice(0, extra);
			this.#build.first += extra;
		}
	}

	async #run(build, { container, kind }, out) {
		const archive = path.join(out, 'App.xcarchive');
		const exported = path.join(out, 'export');
		try {
			await this.#xcode(build, [
				`-${kind}`, container, '-scheme', build.scheme, '-configuration', build.configuration,
				'-destination', 'generic/platform=iOS', '-archivePath', archive,
				'-allowProvisioningUpdates', '-skipPackagePluginValidation', 'archive',
			], build.path);
			build.step = 'exporting';
			const options = path.join(out, 'ExportOptions.plist');
			await fs.writeFile(options, exportOptions());
			await this.#xcode(build, [
				'-exportArchive', '-archivePath', archive, '-exportPath', exported,
				'-exportOptionsPlist', options, '-allowProvisioningUpdates',
			], build.path);
			const ipaName = (await fs.readdir(exported)).find((n) => n.endsWith('.ipa'));
			if (!ipaName) throw new Error('the export made no .ipa');
			const apps = path.join(archive, 'Products', 'Applications');
			const appName = (await fs.readdir(apps)).find((n) => n.endsWith('.app'));
			if (!appName) throw new Error('the archive holds no app');
			const ipa = path.join(exported, ipaName);
			const { size } = await fs.stat(ipa);
			build.artifact = { ipa, app: { ...(await this.#readInfo(path.join(apps, appName))), size } };
			build.state = 'succeeded';
		} catch (e) {
			if (build.cancelled) {
				build.state = 'cancelled';
			} else {
				build.state = 'failed';
				build.error = e.xcodeFailed ? failureOf(this.#lines) : e.message;
			}
		} finally {
			build.endedAt = this.#now();
			this.#child = null;
			if (build === this.#build) this.emit('ended', this.#public());
		}
	}

	#xcode(build, args, cwd) {
		return new Promise((resolve, reject) => {
			if (build.cancelled) return reject(new Error('cancelled'));
			this.#log(`$ xcodebuild ${args.join(' ')}`);
			// Its own process group, so cancelling stops the compilers it started too.
			const child = spawn(this.#xcodebuild, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
			this.#child = child;
			let partial = '';
			const take = (chunk) => {
				const text = partial + chunk.toString('utf8');
				const cut = text.lastIndexOf('\n');
				partial = cut < 0 ? text : text.slice(cut + 1);
				if (cut >= 0) this.#log(text.slice(0, cut));
			};
			child.stdout.on('data', take);
			child.stderr.on('data', take);
			child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error('xcodebuild was not found: install Xcode on the computer') : e));
			child.on('close', (code) => {
				if (partial) this.#log(partial);
				if (code === 0) resolve();
				else reject(Object.assign(new Error(`xcodebuild exited with ${code}`), { xcodeFailed: true }));
			});
		});
	}

	#stop() {
		const child = this.#child;
		if (!child?.pid) return;
		const signal = (s) => {
			try {
				process.kill(-child.pid, s);
			} catch {}
		};
		signal('SIGTERM');
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) signal('SIGKILL');
		}, this.#killAfter).unref?.();
	}
}

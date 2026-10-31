import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BuildRunner, failureOf, findContainer, listSchemes } from '../src/builds.js';
import { isWindows } from '../src/platform.js';

/**
 * A stand-in xcodebuild: `-list` prints schemes, `archive` makes an app in the archive,
 * `-exportArchive` makes an .ipa. `behavior` (JS run before that) can print, fail or wait.
 */
async function fakeXcodebuild(dir, behavior = '') {
	const file = path.join(dir, 'xcodebuild');
	await fs.writeFile(file, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
${behavior}
if (args.includes('-list')) {
	const kind = args.includes('-workspace') ? 'workspace' : 'project';
	console.log(JSON.stringify({ [kind]: { name: 'Demo', schemes: [kind === 'workspace' ? 'DemoWS' : 'Demo', 'DemoTests'] } }));
} else if (args.includes('archive')) {
	console.log('CompileSwift normal arm64 Demo.swift');
	fs.mkdirSync(path.join(at('-archivePath'), 'Products', 'Applications', 'Demo.app'), { recursive: true });
	console.log('** ARCHIVE SUCCEEDED **');
} else if (args.includes('-exportArchive')) {
	fs.mkdirSync(at('-exportPath'), { recursive: true });
	fs.writeFileSync(path.join(at('-exportPath'), 'Demo.ipa'), 'x'.repeat(1234));
	console.log('** EXPORT SUCCEEDED **');
}
`, { mode: 0o755 });
	return file;
}

async function setup(behavior) {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'builds-'));
	const project = path.join(tmp, 'app');
	await fs.mkdir(path.join(project, 'Demo.xcodeproj'), { recursive: true });
	const xcodebuild = await fakeXcodebuild(tmp, behavior);
	const runner = new BuildRunner({
		xcodebuild,
		dir: path.join(tmp, 'builds'),
		killAfter: 200,
		readInfo: async (app) => ({ bundleId: 'app.demo', version: '1.2.3', name: path.basename(app, '.app') }),
	});
	return { tmp, project, xcodebuild, runner };
}

const ended = (runner) => new Promise((resolve) => runner.once('ended', resolve));

test('finds the workspace before the project, and only directly in the folder', async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'builds-'));
	assert.equal(await findContainer(tmp), null);
	await fs.mkdir(path.join(tmp, 'sub', 'Deep.xcodeproj'), { recursive: true });
	assert.equal(await findContainer(tmp), null);
	await fs.mkdir(path.join(tmp, 'App.xcodeproj'));
	assert.deepEqual(await findContainer(tmp), { container: path.join(tmp, 'App.xcodeproj'), kind: 'project' });
	await fs.mkdir(path.join(tmp, 'App.xcworkspace'));
	assert.equal((await findContainer(tmp)).kind, 'workspace');
});

test('lists the schemes of the workspace, or of the project', { skip: isWindows }, async () => {
	const { tmp, project, xcodebuild } = await setup();
	assert.deepEqual(await listSchemes(project, { xcodebuild }), { container: 'Demo.xcodeproj', kind: 'project', schemes: ['Demo', 'DemoTests'] });
	await fs.mkdir(path.join(project, 'Demo.xcworkspace'));
	assert.deepEqual((await listSchemes(project, { xcodebuild })).schemes, ['DemoWS', 'DemoTests']);
	await assert.rejects(listSchemes(tmp, { xcodebuild }), { status: 404 });
});

test('a build archives, exports, and keeps its log', { skip: isWindows }, async () => {
	const { project, runner } = await setup();
	const done = ended(runner);
	const started = await runner.start({ folder: project, scheme: 'Demo' });
	assert.equal(started.state, 'running');
	assert.equal(started.step, 'archiving');
	const build = await done;
	assert.equal(build.state, 'succeeded');
	assert.deepEqual(build.app, { bundleId: 'app.demo', version: '1.2.3', name: 'Demo', size: 1234 });
	assert.ok(runner.artifact().ipa.endsWith('Demo.ipa'));
	const all = runner.current(0);
	assert.ok(all.log.some((l) => l.includes('ARCHIVE SUCCEEDED')) && all.log.some((l) => l.includes('EXPORT SUCCEEDED')));
	assert.deepEqual(runner.current(all.next).log, []);
	assert.equal(runner.current(all.next - 1).log.length, 1);
});

test('a compile error fails the build with its lines', { skip: isWindows }, async () => {
	const { project, runner } = await setup(`if (args.includes('archive')) {
		console.log('/p/Composer.swift:12:9: error: cannot find \\'foo\\' in scope');
		console.log('/p/Composer.swift:12:9: error: cannot find \\'foo\\' in scope');
		console.log('** ARCHIVE FAILED **');
		process.exit(65);
	}`);
	const done = ended(runner);
	await runner.start({ folder: project, scheme: 'Demo' });
	const build = await done;
	assert.equal(build.state, 'failed');
	assert.equal(build.error, "/p/Composer.swift:12:9: error: cannot find 'foo' in scope");
	assert.equal(runner.artifact(), null);
});

test('signing failures say what to do in Xcode', () => {
	const team = failureOf(['note: Using new build system', 'error: Signing for "Demo" requires a development team. Select a development team in the Signing & Capabilities editor. (in target \'Demo\' from project \'Demo\')']);
	assert.match(team, /^Set a team in Xcode/);
	assert.match(failureOf(['error: No profiles for \'app.demo\' were found']), /Run the app on this iPhone from Xcode once/);
	assert.equal(failureOf(['a', 'b', 'c']), 'a\nb\nc');
});

test('one build at a time; cancel stops it', { skip: isWindows }, async () => {
	// Archiving never ends on its own; SIGTERM ends it.
	const { project, runner } = await setup(`if (args.includes('archive')) {
		console.log('working');
		process.on('SIGTERM', () => process.exit(143));
		setInterval(() => {}, 1000);
		return;
	}`);
	const done = ended(runner);
	await runner.start({ folder: project, scheme: 'Demo' });
	await assert.rejects(runner.start({ folder: project, scheme: 'Demo' }), { status: 409 });
	await new Promise((r) => setTimeout(r, 300));
	runner.cancel();
	const build = await done;
	assert.equal(build.state, 'cancelled');
	assert.equal(build.error, null);
	assert.throws(() => runner.cancel(), { status: 409 });
});

test('a build needs a scheme and a project', async () => {
	const { tmp, project, runner } = await setup();
	await assert.rejects(runner.start({ folder: project }), { status: 400 });
	await assert.rejects(runner.start({ folder: tmp, scheme: 'Demo' }), { status: 404 });
	assert.equal(runner.current(), null);
});

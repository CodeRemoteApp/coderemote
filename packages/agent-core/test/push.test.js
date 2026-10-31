import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { AgentHub } from '../src/agents.js';
import { PushSender } from '../src/push.js';

const key = randomBytes(32);
const device = (fields = {}) => ({
	relay: 'https://relay.example',
	token: 'ab'.repeat(32),
	environment: 'development',
	ticket: 'ticket-1',
	key: key.toString('base64'),
	keyId: 'mac-1',
	...fields,
});

function open(e, k = key) {
	const raw = Buffer.from(e, 'base64');
	const decipher = createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12));
	decipher.setAuthTag(raw.subarray(raw.length - 16));
	return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString());
}

function setup({ status = 200, reason, quiet = false, foreground = false, saved = [] } = {}) {
	let now = 0;
	const hub = new AgentHub({ now: () => now, transcript: async () => [] });
	const sent = [];
	const stored = { devices: saved };
	const push = new PushSender({
		hub,
		store: { load: () => stored.devices, save: (d) => (stored.devices = d) },
		foreground: () => foreground,
		userActive: async () => quiet,
		fetch: async (url, init) => {
			sent.push({ url, body: JSON.parse(init.body), raw: init.body });
			return new Response(JSON.stringify(reason ? { reason } : {}), { status });
		},
	});
	const settle = () => new Promise((r) => setTimeout(r, 20));
	return { hub, push, sent, stored, settle, tick: (ms) => (now += ms) };
}

const ev = (hook_event_name, fields = {}) => ({ session_id: 's1', cwd: '/p/app', transcript_path: '/x', hook_event_name, ...fields });
const permission = ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });

test('registrations are validated, stored, and kept without secrets in listings', () => {
	const { push, stored } = setup();
	push.register(device({ kinds: { finished: false } }));
	assert.equal(stored.devices.length, 1);
	assert.deepEqual(stored.devices[0].kinds, { requests: true, finished: false });
	assert.equal(push.devices()[0].key, undefined);
	push.register(device({ keyId: 'mac-2' }));
	assert.equal(stored.devices.length, 1, 're-registering a token replaces it');
	for (const bad of [{ relay: 'http://evil.example' }, { token: 'xyz' }, { environment: 'prod' }, { key: 'c2hvcnQ=' }, { keyId: '' }, { ticket: '' }]) {
		assert.throws(() => push.register(device(bad)), { status: 400 });
	}
	push.unregister('AB'.repeat(32));
	assert.equal(stored.devices.length, 0);
	// Registrations come back after a restart.
	assert.equal(setup({ saved: [device()] }).push.devices().length, 1);
});

test('a permission request is pushed encrypted, with nothing readable for the relay', async () => {
	const { hub, push, sent, settle } = setup();
	push.register(device());
	await hub.handle(ev('UserPromptSubmit', { prompt: 'Clean up the build' }));
	hub.handle(permission);
	await settle();
	assert.equal(sent.length, 1);
	const [{ url, body, raw }] = sent;
	assert.equal(url, 'https://relay.example/v1/send');
	assert.deepEqual([body.token, body.environment, body.ticket], ['ab'.repeat(32), 'development', 'ticket-1']);
	assert.ok(!raw.includes('rm -rf') && !raw.includes('Clean up'), 'no plaintext command or title');
	assert.equal(body.payload.aps.category, 'PERMISSION');
	assert.equal(body.payload.aps['mutable-content'], 1);
	assert.equal(body.payload.k, 'mac-1');
	const request = hub.requests()[0];
	assert.equal(body.collapseId, request.id);
	assert.deepEqual(open(body.payload.e), {
		kind: 'request',
		title: 'Clean up the build',
		body: 'Bash: rm -rf build',
		session: 's1',
		request: request.id,
	});
});

test('questions carry their options', async () => {
	const { hub, push, sent, settle } = setup();
	push.register(device());
	const questions = [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Green' }], multiSelect: false }];
	hub.handle(ev('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions } }));
	await settle();
	assert.equal(sent[0].body.payload.aps.category, 'QUESTION');
	const note = open(sent[0].body.payload.e);
	assert.deepEqual([note.body, note.question, note.options], ['Which color?', 'Which color?', ['Red', 'Green']]);

	// Several questions, or several picks, need the app.
	hub.handle(ev('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ ...questions[0], multiSelect: true }] } }));
	await settle();
	assert.equal(open(sent[1].body.payload.e).options, undefined);
});

test('answering on the computer replaces the notification; answering on the phone does not', async () => {
	const { hub, push, sent, settle } = setup();
	push.register(device());
	const abort = new AbortController();
	hub.handle(permission, { signal: abort.signal });
	await settle();
	abort.abort();
	await settle();
	assert.equal(sent.length, 2);
	const replaced = sent[1].body;
	assert.equal(replaced.collapseId, sent[0].body.collapseId);
	assert.equal(replaced.payload.aps.category, undefined);
	assert.equal(replaced.payload.aps.sound, undefined);
	assert.equal(open(replaced.payload.e).body, 'Answered on your computer');

	hub.handle(permission);
	await settle();
	hub.answer({ request: hub.requests()[0].id, behavior: 'allow' });
	await settle();
	assert.equal(sent.length, 3);
});

test('long turns notify when they finish, short ones do not', async () => {
	const { hub, push, sent, settle, tick } = setup();
	push.register(device());
	await hub.handle(ev('UserPromptSubmit', { prompt: 'quick' }));
	tick(10_000);
	await hub.handle(ev('Stop'));
	await settle();
	assert.equal(sent.length, 0);
	await hub.handle(ev('UserPromptSubmit', { prompt: 'long' }));
	tick(4 * 60_000);
	await hub.handle(ev('Stop'));
	await settle();
	assert.equal(sent.length, 1);
	assert.equal(sent[0].body.payload.aps.category, 'DONE');
	assert.deepEqual(open(sent[0].body.payload.e).body, 'Finished after 4 min');
});

test('kinds turned off are not sent', async () => {
	const { hub, push, sent, settle, tick } = setup();
	push.register(device({ kinds: { requests: false, finished: false } }));
	hub.handle(permission);
	await hub.handle(ev('UserPromptSubmit', { prompt: 'long' }));
	tick(5 * 60_000);
	await hub.handle(ev('Stop'));
	await settle();
	assert.equal(sent.length, 0);
});

test('nothing is pushed while someone uses the computer or the app shows it', async () => {
	for (const opts of [{ quiet: true }, { foreground: true }]) {
		const { hub, push, sent, settle } = setup(opts);
		push.register(device());
		hub.handle(permission);
		await settle();
		assert.equal(sent.length, 0);
	}
});

test('a token APNs no longer knows is dropped', async () => {
	for (const [status, reason] of [[410, 'Unregistered'], [400, 'BadDeviceToken']]) {
		const { hub, push, stored, settle } = setup({ status, reason });
		push.register(device());
		hub.handle(permission);
		await settle();
		assert.equal(stored.devices.length, 0);
	}
});

test('test pushes report what happened', async () => {
	const ok = setup();
	ok.push.register(device());
	await ok.push.test('ab'.repeat(32));
	assert.equal(open(ok.sent[0].body.payload.e).kind, 'test');
	await assert.rejects(ok.push.test('cd'.repeat(32)), { status: 404 });

	const refused = setup({ status: 403 });
	refused.push.register(device());
	await assert.rejects(refused.push.test('ab'.repeat(32)), { status: 502 });
});

test('a build that ends is a finished notification, unless cancelled or someone is around', async () => {
	const { push, sent } = setup();
	push.register(device());
	await push.buildEnded({ id: 'b1', scheme: 'Demo', state: 'succeeded', app: { name: 'Demo', version: '1.2' }, error: null });
	assert.equal(sent.length, 1);
	assert.equal(sent[0].body.collapseId, 'build-b1');
	assert.equal(sent[0].body.payload.aps.category, 'BUILD');
	assert.deepEqual(open(sent[0].body.payload.e), { kind: 'build', title: 'Build ready to install', body: 'Demo 1.2', build: 'b1' });
	assert.ok(!sent[0].raw.includes('Demo 1.2'), 'the content is encrypted');

	await push.buildEnded({ id: 'b2', scheme: 'Demo', state: 'failed', error: '\n/p/A.swift:3:1: error: expected expression\nmore' });
	assert.equal(open(sent[1].body.payload.e).body, 'Demo: /p/A.swift:3:1: error: expected expression');
	await push.buildEnded({ id: 'b3', scheme: 'Demo', state: 'cancelled', error: null });
	assert.equal(sent.length, 2);

	push.register(device({ kinds: { finished: false } }));
	await push.buildEnded({ id: 'b4', scheme: 'Demo', state: 'succeeded', app: { name: 'Demo', version: '1' } });
	assert.equal(sent.length, 2, 'finished pushes turned off');
	const quiet = setup({ foreground: true });
	quiet.push.register(device());
	await quiet.push.buildEnded({ id: 'b5', scheme: 'Demo', state: 'succeeded', app: { name: 'Demo', version: '1' } });
	assert.equal(quiet.sent.length, 0, 'the app is in front');
});

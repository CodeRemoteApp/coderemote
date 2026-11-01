import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createAgentServer } from '../src/index.js';
import { findExecutable } from '../src/platform.js';
import { listFiles, pathFilter, preview, queryRegex, search } from '../src/search.js';

let root;

async function write(rel, content) {
	const p = path.join(root, ...rel.split('/'));
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, content);
}

before(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vsremote-search-')));
	execFileSync('git', ['init', '-q'], { cwd: root });
	await write('.gitignore', 'build/\n*.log\n');
	await write('src/server.js', 'import http from "node:http";\n\tconst server = http.createServer();\nserver.listen(0);\n');
	await write('src/client.ts', 'export const Server = 1;\nconst serverless = true;\n');
	await write('docs/Server notes.md', '# Notes\nnothing here\n');
	await write('build/out.js', 'const server = "ignored";\n');
	await write('debug.log', 'server crashed\n');
	await write('node_modules/x/index.js', 'server\n');
	await write('image.bin', Buffer.from([0, 1, 2, 115, 101, 114, 118, 101, 114]));
	await write('long.txt', `${'a'.repeat(1000)} server ${'b'.repeat(1000)}\n`);
	execFileSync('git', ['add', 'src/server.js'], { cwd: root });
	// A repository inside the shared one, untracked: its own ignore rules apply.
	await write('inner/.gitignore', 'secret.txt\n');
	await write('inner/a.txt', 'server inside\n');
	await write('inner/secret.txt', 'server secret\n');
	execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'inner') });
});

after(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

test('pathFilter: plain text matches anywhere in the path, globs anywhere unless anchored', () => {
	assert.ok(pathFilter('src/')('src/a.js'));
	assert.ok(pathFilter('server')('src/Server.js'));
	assert.ok(!pathFilter('server')('src/client.js'));
	assert.ok(pathFilter('*.js')('a/b/c.js'));
	assert.ok(!pathFilter('*.js')('a/b/c.ts'));
	assert.ok(pathFilter('*.{js,ts}')('a/c.ts'));
	assert.ok(pathFilter('src/**/*.ts')('pkg/src/x/y.ts'));
	assert.ok(!pathFilter('/src/**/*.ts')('pkg/src/x/y.ts'));
	assert.ok(pathFilter('/src')('src/x/y.ts'), 'a folder pattern covers what is inside');
	assert.ok(pathFilter('*.js, *.md')('README.md'));
	assert.ok(!pathFilter('', 'test/')('test/a.js'));
	assert.ok(!pathFilter('*.js', '*.test.js')('a.test.js'));
	assert.ok(pathFilter('', '')('anything'));
});

test('preview: drops indentation, clips long lines around the match, ranges in UTF-16', () => {
	const re = queryRegex('foo', {}, true);
	assert.deepEqual(preview('\t\tlet foo = Foo;', re), { text: 'let foo = Foo;', ranges: [[4, 7], [10, 13]], clipped: false });
	const long = preview(`${'x'.repeat(500)}foo${'y'.repeat(500)}`, re);
	assert.equal(long.clipped, true);
	assert.equal(long.text.length, 240);
	assert.equal(long.text.slice(long.ranges[0][0], long.ranges[0][1]), 'foo');
	const emoji = preview('😀 foo', re);
	assert.deepEqual(emoji.ranges, [[3, 6]]);
});

test('queryRegex: literal by default, whole words, case, and invalid regexes refused', () => {
	assert.ok(queryRegex('a.b').test('a.b'));
	assert.ok(!queryRegex('a.b').test('axb'));
	assert.ok(queryRegex('a.b', { regex: true }).test('axb'));
	assert.ok(!queryRegex('serv', { wholeWord: true }).test('server'));
	assert.ok(!queryRegex('Server', { caseSensitive: true }).test('server'));
	assert.throws(() => queryRegex('(', { regex: true }), /invalid regular expression/);
});

test('listFiles: honours .gitignore, nested repositories and the always-skipped folders', async () => {
	const files = (await listFiles(root)).sort();
	assert.deepEqual(files, [
		'.gitignore',
		'docs/Server notes.md',
		'image.bin',
		'inner/.gitignore',
		'inner/a.txt',
		'long.txt',
		'src/client.ts',
		'src/server.js',
	]);
});

const engines = ['node', ...(findExecutable('rg') ? ['rg'] : [])];

for (const engine of engines) {
	test(`search (${engine}): content and names, ignored and binary files skipped`, async () => {
		const r = await search({ root, query: 'server', engine });
		assert.deepEqual(
			r.files.map((f) => f.path),
			['inner/a.txt', 'long.txt', 'src/client.ts', 'src/server.js'],
		);
		const server = r.files.find((f) => f.path === 'src/server.js');
		assert.deepEqual(
			server.matches.map((m) => [m.line, m.text]),
			[
				[2, 'const server = http.createServer();'],
				[3, 'server.listen(0);'],
			],
		);
		assert.deepEqual(server.matches[1].ranges, [[0, 6]]);
		assert.deepEqual(
			r.names.map((n) => n.path),
			['docs/Server notes.md', 'src/server.js'],
		);
		assert.equal(r.truncated, false);
	});

	test(`search (${engine}): options and file filters`, async () => {
		const exact = await search({ root, query: 'Server', caseSensitive: true, wholeWord: true, engine });
		assert.deepEqual(
			exact.files.map((f) => f.path),
			['src/client.ts'],
		);
		const words = await search({ root, query: 'server', wholeWord: true, include: 'src/', engine });
		assert.deepEqual(
			words.files.map((f) => [f.path, f.matches.length]),
			[['src/client.ts', 1], ['src/server.js', 2]],
		);
		const regex = await search({ root, query: 'server\\.\\w+\\(', regex: true, engine });
		assert.deepEqual(
			regex.files.map((f) => f.path),
			['src/server.js'],
		);
		const excluded = await search({ root, query: 'server', exclude: '*.ts,inner', engine });
		assert.deepEqual(
			excluded.files.map((f) => f.path),
			['long.txt', 'src/server.js'],
		);
		const listing = await search({ root, include: '*.ts', engine });
		assert.deepEqual(listing.names, [{ path: 'src/client.ts' }]);
		assert.deepEqual(listing.files, []);
	});

	test(`search (${engine}): stops at the limit`, async () => {
		const r = await search({ root, query: 'server', limit: 2, engine });
		assert.equal(
			r.files.reduce((n, f) => n + f.matches.length, 0),
			2,
		);
		assert.equal(r.truncated, true);
	});
}

test('search: a query or an include filter is needed', async () => {
	await assert.rejects(search({ root, engine: 'node' }), { status: 400 });
});

test('GET /api/fs/search answers over HTTP', async () => {
	const server = createAgentServer({ token: 't', root });
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	try {
		const base = `http://127.0.0.1:${server.address().port}`;
		const get = (qs) => fetch(`${base}/api/fs/search?${qs}`, { headers: { authorization: 'Bearer t' } });
		const res = await get('q=listen&include=*.js');
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.root, root);
		assert.deepEqual(
			body.files.map((f) => [f.path, f.matches[0].line]),
			[['src/server.js', 3]],
		);
		assert.equal((await get('q=(&regex=1')).status, 400);
		assert.equal((await get('q=')).status, 400);
	} finally {
		server.close();
	}
});

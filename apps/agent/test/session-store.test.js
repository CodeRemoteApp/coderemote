import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sessionStore } from '../src/session-store.js';

test('sessions are kept per agent port, and a missing or broken file reads as none', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-sessions-'));
	const a = sessionStore(dir, 31580);
	assert.deepEqual(a.load(), []);
	a.save([{ id: 's1' }]);
	assert.deepEqual(a.load(), [{ id: 's1' }]);
	assert.deepEqual(sessionStore(dir, 31581).load(), []);
	fs.writeFileSync(path.join(dir, '31580.json'), '{oops');
	assert.deepEqual(a.load(), []);
	assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
	fs.rmSync(dir, { recursive: true, force: true });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyOf, render, step } from '../src/picker.js';

const start = (count) => ({ cursor: 0, selected: new Set(), count });
const press = (state, ...keys) => keys.reduce(step, state);
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('reads arrows, vim keys, space, enter and the ways out', () => {
	assert.equal(keyOf('\x1b[A'), 'up');
	assert.equal(keyOf('\x1bOB'), 'down');
	assert.equal(keyOf('j'), 'down');
	assert.equal(keyOf(' '), 'toggle');
	assert.equal(keyOf('\r'), 'enter');
	for (const out of ['\x1b', 'q', '\x03']) assert.equal(keyOf(out), 'cancel');
	assert.equal(keyOf('x'), null);
});

test('moves round the list and ticks what the cursor is on', () => {
	let s = press(start(3), 'up');
	assert.equal(s.cursor, 2);
	s = press(s, 'down', 'down', 'toggle', 'down', 'toggle');
	assert.deepEqual([...s.selected].sort(), [1, 2]);
	s = press(s, 'toggle');
	assert.deepEqual([...s.selected], [1]);
	assert.equal(press(s, 'all').selected.size, 3);
	assert.equal(press(s, 'all', 'all').selected.size, 0);
});

test('enter confirms only a choice; esc always backs out', () => {
	const empty = press(start(2), 'enter');
	assert.equal(empty.done, undefined);
	assert.match(empty.hint, /space/);
	assert.equal(press(start(2), 'toggle', 'enter').done, 'confirm');
	assert.equal(press(start(2), 'toggle', 'cancel').done, 'cancel');
	// The hint goes with the next key.
	assert.equal(press(empty, 'down').hint, null);
});

test('draws ticks, the cursor and the count, cut to the terminal', () => {
	const items = [{ label: 'tunnel-a', note: 'idle' }, { label: 'tunnel-b', note: 'online '.repeat(20), warn: true }];
	const lines = render({ title: 'Pick', items, state: press(start(2), 'down', 'toggle'), columns: 40 }).map(plain);
	assert.equal(lines[0], 'Pick');
	assert.equal(lines[1], '  ◯ tunnel-a  idle');
	assert.ok(lines[2].startsWith('❯ ◉ tunnel-b'));
	assert.ok(lines[2].length <= 40 && lines[2].endsWith('…'));
	assert.match(lines[3], /enter delete \(1\)/);
});

// Advertisements that agents from before tied processes left behind are swept at start.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strayAdvertisers, sweepStrayAdvertisers } from '../src/bonjour.js';

const PS = `
  101     1 dns-sd -R Thanhs-MacBook-Air :31582 _coderemote._tcp local 32582 fp=d5a87f0b354d1be5 proto=4
  102   555 dns-sd -R Thanhs-MacBook-Air :31581 _coderemote._tcp local 32581 fp=d5a87f0b354d1be5 proto=4
  103     1 /usr/bin/dns-sd -R other _http._tcp local 80
  104     1 dns-sd -B _coderemote._tcp
  105     1 /usr/bin/dns-sd -R Mac _coderemote._tcp local 32580
  106     1 node coderemote.js dns-sd -R _coderemote._tcp
`;

test('only advertisements of this service whose agent is gone are strays', () => {
	assert.deepEqual(strayAdvertisers(PS, '_coderemote._tcp'), [101, 105]);
});

test('the sweep ends the strays, on macOS only, and never throws', async () => {
	const killed = [];
	const run = async () => ({ stdout: PS });
	assert.equal(await sweepStrayAdvertisers('_coderemote._tcp', { run, kill: (pid) => killed.push(pid), platform: 'darwin' }), 2);
	assert.deepEqual(killed, [101, 105]);
	assert.equal(await sweepStrayAdvertisers('_coderemote._tcp', { run, kill: () => assert.fail(), platform: 'linux' }), 0);
	assert.equal(await sweepStrayAdvertisers('_coderemote._tcp', { run: async () => { throw new Error('no ps'); }, platform: 'darwin' }), 0);
});

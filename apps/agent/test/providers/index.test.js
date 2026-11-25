// Which tunnel provider `up` uses for a folder, and when it asks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
test('up asks only for a folder that never chose, and not when --tunnel says', async () => {
	const { needsProviderChoice, PROVIDER_CHOICES } = await import('../../src/providers/index.js');
	assert.equal(needsProviderChoice({}, 31580), true);
	assert.equal(needsProviderChoice({}, 31580, { flag: 'cloud' }), false);
	assert.equal(needsProviderChoice({ tunnelProviders: { 31580: 'cloud' } }, 31580), false);
	assert.equal(needsProviderChoice({ tunnelProviders: { 31581: 'cloud' } }, 31580), true, 'per port');
	assert.equal(needsProviderChoice({ tunnels: { 31580: 'abc.asse' } }, 31580), false, 'a Dev Tunnels folder from before the choice');
	assert.equal(needsProviderChoice({ tunnelProviders: { 31580: 'gone' } }, 31580), true);
	assert.deepEqual(PROVIDER_CHOICES.map((c) => c.name).sort(), ['cloud', 'devtunnels']);
});

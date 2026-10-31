import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { InstallLinks, manifest } from '../src/install-links.js';

function stubPreview() {
	const calls = [];
	return {
		calls,
		forward: async (port) => (calls.push(['forward', port]), { port, url: 'https://tunnel-1.example.devtunnels.ms/' }),
		share: async (port, hours) => calls.push(['share', port, hours]),
		unshare: async (port) => calls.push(['unshare', port]),
		unforward: async (port) => calls.push(['unforward', port]),
	};
}

async function setup() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'install-'));
	const ipa = path.join(dir, 'Demo.ipa');
	await fs.writeFile(ipa, 'ipa-bytes');
	const preview = stubPreview();
	const timers = [];
	const links = new InstallLinks({ preview, now: () => 1_000, setTimer: (fn, ms) => timers.push({ fn, ms }) });
	const app = { bundleId: 'app.demo', version: '1.2 <beta>', name: 'Demo & Co' };
	return { ipa, preview, timers, links, app };
}

/** The local URL of a public path the link names. */
function local(links, url) {
	const manifestUrl = decodeURIComponent(new URL(url).searchParams.get('url'));
	return `http://127.0.0.1:${links.port}${new URL(manifestUrl).pathname}`;
}

test('a link serves its manifest and app once, then 404', async () => {
	const { ipa, preview, links, app } = await setup();
	const { url, expiresAt } = await links.create({ ipa, app });
	assert.match(url, /^itms-services:\/\/\?action=download-manifest&url=https%3A%2F%2Ftunnel-1\.example\.devtunnels\.ms%2F[0-9a-f]{48}%2Fmanifest\.plist$/);
	assert.equal(expiresAt, 1_000 + 10 * 60 * 1000);
	assert.deepEqual(preview.calls, [['forward', links.port], ['share', links.port, 1]]);

	const manifestUrl = local(links, url);
	const plist = await (await fetch(manifestUrl)).text();
	assert.match(plist, /<string>https:\/\/tunnel-1\.example\.devtunnels\.ms\/[0-9a-f]{48}\/app\.ipa<\/string>/);
	assert.match(plist, /<string>1\.2 &lt;beta&gt;<\/string>/);
	assert.match(plist, /<string>Demo &amp; Co<\/string>/);

	const appUrl = manifestUrl.replace('manifest.plist', 'app.ipa');
	assert.equal(await (await fetch(appUrl)).text(), 'ipa-bytes');
	// Ended with its download, and with it the public share.
	await new Promise((r) => setTimeout(r, 50));
	assert.equal((await fetch(manifestUrl)).status, 404);
	assert.equal((await fetch(appUrl)).status, 404);
	assert.deepEqual(preview.calls.slice(2), [['unshare', links.port], ['unforward', links.port]]);
	links.close();
});

test('links expire, and the share ends with the last one', async () => {
	const { ipa, preview, timers, links, app } = await setup();
	const first = await links.create({ ipa, app });
	const second = await links.create({ ipa, app });
	// Shared once for both.
	assert.equal(preview.calls.filter((c) => c[0] === 'share').length, 1);
	assert.equal(links.size, 2);
	timers[0].fn();
	assert.equal((await fetch(local(links, first.url))).status, 404);
	assert.equal((await fetch(local(links, second.url))).status, 200);
	assert.ok(!preview.calls.some((c) => c[0] === 'unshare'));
	timers[1].fn();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(links.size, 0);
	assert.deepEqual(preview.calls.slice(-2), [['unshare', links.port], ['unforward', links.port]]);
	// A new link shares again.
	await links.create({ ipa, app });
	assert.equal(preview.calls.filter((c) => c[0] === 'share').length, 2);
	links.close();
});

test('anything but a live token is 404', async () => {
	const { ipa, links, app } = await setup();
	await links.create({ ipa, app });
	for (const p of ['/', '/manifest.plist', `/${'0'.repeat(48)}/manifest.plist`, '/../etc/passwd']) {
		assert.equal((await fetch(`http://127.0.0.1:${links.port}${p}`)).status, 404, p);
	}
	links.close();
});

test('the manifest escapes what it carries', () => {
	assert.match(manifest({ ipaUrl: 'https://x/a?b=1&c=2', bundleId: 'a', version: '1', title: '"T"' }), /a\?b=1&amp;c=2.*&quot;T&quot;/s);
});

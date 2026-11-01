// What `up` says about Windows Defender Firewall, from what PowerShell reports.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firewallAdvice, firewallReport, lanAdapters } from '../src/windows-firewall.js';

const v4 = (address) => ({ address, family: 'IPv4', internal: false });
const opts = { lanPort: 32580, adapters: ['Wi-Fi'] };
const report = (profiles, blockRules = []) => ({ profiles, blockRules });
const nodeBlock = (profile, name = '{b1}') => ({ name, displayName: 'Node.js JavaScript Runtime', profile });

test('the adapters phones reach are the ones LAN addresses come from', () => {
	const got = lanAdapters({
		'Wi-Fi': [v4('192.168.1.20')],
		'vEthernet (WSL)': [v4('172.28.160.1')],
		Ethernet: [{ address: '169.254.3.3', family: 'IPv4', internal: false }],
	});
	assert.deepEqual(got, ['Wi-Fi']);
});

test('nothing to add on a Private network without Block rules, or when nothing is known', () => {
	assert.deepEqual(firewallAdvice(report([{ alias: 'Wi-Fi', category: 'Private' }]), opts), []);
	assert.deepEqual(firewallAdvice(null, opts), []);
});

test('a Public network gets a warning, the command to make it Private, and the port rule', () => {
	const lines = firewallAdvice(report([{ alias: 'Wi-Fi', category: 'Public' }, { alias: 'vEthernet (WSL)', category: 'Public' }]), opts);
	const text = lines.join('\n');
	assert.match(text, /"Wi-Fi" as a Public network/);
	assert.doesNotMatch(text, /WSL/);
	assert.match(text, /Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private/);
	assert.match(text, /netsh advfirewall firewall add rule name="Code Remote LAN 32580" dir=in action=allow protocol=TCP localport=32580 remoteip=localsubnet/);
});

test('on a Public network with node blocked for Public, only making it Private helps', () => {
	// What Windows leaves when someone chose Allow with only "Private networks" ticked.
	const text = firewallAdvice(report([{ alias: 'Wi-Fi', category: 'Public' }], [nodeBlock('Public')]), opts).join('\n');
	assert.match(text, /Set-NetConnectionProfile/);
	assert.doesNotMatch(text, /netsh/);
	assert.doesNotMatch(text, /Remove-NetFirewallRule/);
});

test('a Block rule on node for the network in use says how to remove it', () => {
	const rules = [nodeBlock('Private, Public', '{b1}'), nodeBlock('Any', '{b2}')];
	const text = firewallAdvice(report([{ alias: 'Wi-Fi', category: 'Private' }], rules), opts).join('\n');
	assert.match(text, /The firewall blocks node \("Node.js JavaScript Runtime"/);
	assert.match(text, /Remove-NetFirewallRule -Name "\{b1\}","\{b2\}"/);
	assert.doesNotMatch(text, /Public network/);
});

test('a domain network counts as Domain for the rules', () => {
	const text = firewallAdvice(report([{ alias: 'Wi-Fi', category: 'DomainAuthenticated' }], [nodeBlock('Domain')]), opts).join('\n');
	assert.match(text, /Remove-NetFirewallRule/);
});

test('the report reads PowerShell JSON, single values included, and is null on any failure', async () => {
	const run = (stdout, err = null) => (_file, _args, _opts, cb) => cb(err, stdout);
	const one = await firewallReport({
		platform: 'win32',
		run: run(JSON.stringify({ profiles: { alias: 'Wi-Fi', category: 'Public' }, blockRules: [] })),
	});
	assert.deepEqual(one, { profiles: [{ alias: 'Wi-Fi', category: 'Public' }], blockRules: [], firewall: [] });
	assert.equal(await firewallReport({ platform: 'win32', run: run('', new Error('timeout')) }), null);
	assert.equal(await firewallReport({ platform: 'win32', run: run('not json') }), null);
	assert.equal(await firewallReport({ platform: 'darwin', run: run('{}') }), null);
});

test('the PowerShell script is passed encoded, with the node path quoted', async () => {
	let args;
	await firewallReport({
		platform: 'win32',
		execPath: "C:\\Users\\O'Neil\\node.exe",
		run: (_f, a, _o, cb) => {
			args = a;
			cb(null, '{"profiles":[],"blockRules":[]}');
		},
	});
	assert.equal(args[2], '-EncodedCommand');
	assert.match(Buffer.from(args[3], 'base64').toString('utf16le'), /\$exe = 'C:\\Users\\O''Neil\\node\.exe'/);
});

test('a firewall managed by the organization: no commands, which it would ignore, only why', () => {
	const r = {
		...report([{ alias: 'Wi-Fi', category: 'Public' }], [nodeBlock('Any')]),
		firewall: [{ name: 'Public', enabled: 'True', allowLocalRules: 'False' }],
	};
	const text = firewallAdvice(r, opts).join('\n');
	assert.match(text, /organization manages this computer's firewall/);
	assert.match(text, /port 32580/);
	assert.doesNotMatch(text, /Set-NetConnectionProfile|netsh|Remove-NetFirewallRule/);
});

test('local rules allowed or not configured: the usual advice', () => {
	for (const allowLocalRules of ['True', 'NotConfigured']) {
		const r = { ...report([{ alias: 'Wi-Fi', category: 'Public' }]), firewall: [{ name: 'Public', enabled: 'True', allowLocalRules }] };
		assert.match(firewallAdvice(r, opts).join('\n'), /Set-NetConnectionProfile/);
	}
});

test('a network whose firewall profile is off needs nothing', () => {
	const r = {
		...report([{ alias: 'Wi-Fi', category: 'Public' }], [nodeBlock('Any')]),
		firewall: [{ name: 'Public', enabled: 'False', allowLocalRules: 'False' }],
	};
	assert.deepEqual(firewallAdvice(r, opts), []);
});

test('the managed check only looks at the profile of the network phones use', () => {
	const r = {
		...report([{ alias: 'Wi-Fi', category: 'Private' }]),
		firewall: [
			{ name: 'Domain', enabled: 'True', allowLocalRules: 'False' },
			{ name: 'Private', enabled: 'True', allowLocalRules: 'True' },
		],
	};
	assert.deepEqual(firewallAdvice(r, opts), []);
});

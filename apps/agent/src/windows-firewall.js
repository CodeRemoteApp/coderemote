// Windows Defender Firewall keeps phones away from the LAN listener on networks Windows classes
// Public (a new Wi-Fi often is), and for good after someone chose Cancel on its prompt, which
// leaves a Block rule for node.exe. The agent can't change either without elevation, so it looks
// (reading only) and says what to run.
import { execFile } from 'node:child_process';
import { lanAddresses } from '@vsremote/agent-core';

/** PowerShell's single-quoted string. */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Enum values in English whatever the display language, unlike netsh's output.
function script(execPath) {
	return `
$ErrorActionPreference = 'SilentlyContinue'
$exe = ${psQuote(execPath)}
$profiles = @(Get-NetConnectionProfile | ForEach-Object {
	@{ alias = $_.InterfaceAlias; category = [string]$_.NetworkCategory }
})
$blocks = @(Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True | ForEach-Object {
	$rule = $_
	$program = ($rule | Get-NetFirewallApplicationFilter).Program
	if ($program -and [Environment]::ExpandEnvironmentVariables($program) -ieq $exe) {
		@{ name = $rule.Name; displayName = $rule.DisplayName; profile = [string]$rule.Profile }
	}
})
ConvertTo-Json -Compress -Depth 4 @{ profiles = $profiles; blockRules = $blocks }
`;
}

/**
 * What the firewall makes of this agent: `{ profiles: [{ alias, category }], blockRules: [{ name,
 * displayName, profile }] }` for the connected networks and the inbound Block rules on `execPath`.
 * Null off Windows, and when PowerShell is missing, fails or takes longer than `timeoutMs`.
 */
export function firewallReport({ execPath = process.execPath, timeoutMs = 10_000, run = execFile, platform = process.platform } = {}) {
	if (platform !== 'win32') return Promise.resolve(null);
	return new Promise((resolve) => {
		try {
			run(
				'powershell.exe',
				['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script(execPath), 'utf16le').toString('base64')],
				{ timeout: timeoutMs, windowsHide: true },
				(err, stdout) => {
					if (err) return resolve(null);
					try {
						const got = JSON.parse(stdout);
						resolve({ profiles: [got.profiles ?? []].flat(), blockRules: [got.blockRules ?? []].flat() });
					} catch {
						resolve(null);
					}
				},
			);
		} catch {
			resolve(null);
		}
	});
}

/** The adapters phones reach this computer through: the ones the LAN addresses come from. */
export function lanAdapters(interfaces) {
	return Object.entries(interfaces)
		.filter(([name, addrs]) => lanAddresses({ [name]: addrs }).length > 0)
		.map(([name]) => name);
}

// A connection profile's category against a rule's profiles ("Any", "Private, Public", ...).
const PROFILE_OF = { Public: 'Public', Private: 'Private', DomainAuthenticated: 'Domain' };
const covers = (ruleProfile, category) => ruleProfile === 'Any' || ruleProfile.split(/,\s*/).includes(PROFILE_OF[category]);

/**
 * The lines to print about `report` (from `firewallReport`) for the LAN listener on `lanPort`,
 * reached through `adapters`; none when nothing is in the way, or nothing is known.
 */
export function firewallAdvice(report, { lanPort, adapters }) {
	if (!report) return [];
	const lines = [];
	const lan = report.profiles.filter((p) => adapters.includes(p.alias));
	const publicOnes = lan.filter((p) => p.category === 'Public');
	// A Block rule beats every Allow rule; on a Public network, making it Private gets past one for Public.
	const blocking = report.blockRules.filter((r) => lan.some((p) => p.category !== 'Public' && covers(r.profile, p.category)));
	const blockingPublic = report.blockRules.some((r) => covers(r.profile, 'Public'));
	if (publicOnes.length) {
		const names = publicOnes.map((p) => `"${p.alias}"`).join(', ');
		lines.push(`Windows treats ${names} as a Public network, and its firewall keeps phones on it out.`);
		lines.push('On a network you trust, make it Private (in PowerShell run as administrator):');
		for (const p of publicOnes) lines.push(`  Set-NetConnectionProfile -InterfaceAlias "${p.alias}" -NetworkCategory Private`);
		if (!blockingPublic) {
			lines.push('Or let in only this port, from the local network (Command Prompt or PowerShell as administrator):');
			lines.push(
				`  netsh advfirewall firewall add rule name="Code Remote LAN ${lanPort}" dir=in action=allow protocol=TCP localport=${lanPort} remoteip=localsubnet`,
			);
		}
	}
	if (blocking.length) {
		lines.push(`The firewall blocks node ("${blocking[0].displayName}", left by choosing Cancel when Windows asked), so phones can't connect.`);
		lines.push('Remove it (in PowerShell run as administrator), then start coderemote again and choose Allow:');
		lines.push(`  Remove-NetFirewallRule -Name ${blocking.map((r) => `"${r.name}"`).join(',')}`);
	}
	return lines;
}

// The Bonjour advertisement of the LAN listener (macOS: `dns-sd`, which ships with it). The agent
// starts it tied to itself (tied.js); this sweeps the ones agents from before that left behind.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * The pids of `dns-sd` advertisements of `serviceType` that their agent left behind: adopted by
 * launchd (parent 1). A live agent's advertiser has that agent, or its watchdog, as parent.
 * `psOutput` is `ps -axo pid=,ppid=,command=`.
 */
export function strayAdvertisers(psOutput, serviceType) {
	const pids = [];
	for (const line of psOutput.split('\n')) {
		const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (!m || m[2] !== '1') continue;
		const words = m[3].trim().split(/\s+/);
		if (!/(^|\/)dns-sd$/.test(words[0]) || words[1] !== '-R' || !words.includes(serviceType)) continue;
		pids.push(Number(m[1]));
	}
	return pids;
}

/** Ends the advertisements earlier agents left behind (macOS); returns how many. Never throws. */
export async function sweepStrayAdvertisers(serviceType, { run = promisify(execFile), kill = process.kill.bind(process), platform = process.platform } = {}) {
	if (platform !== 'darwin') return 0;
	try {
		const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,command=']);
		let ended = 0;
		for (const pid of strayAdvertisers(stdout, serviceType)) {
			try {
				kill(pid, 'SIGTERM');
				ended++;
			} catch {}
		}
		return ended;
	} catch {
		return 0;
	}
}

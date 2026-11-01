// Direct connections on the local network: the agent's self-signed certificate, which clients
// pin by fingerprint (from the QR or learned over the tunnel), and the addresses it can be reached at.
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selfSignedCertificate } from './x509.js';

/** Lowercase hex SHA-256 of a PEM certificate's DER encoding, without separators. */
export function certFingerprint(pem) {
	return new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
}

/**
 * The LAN certificate in `dir` (`key.pem`, `cert.pem`), generated on first use and reused after,
 * so paired phones keep trusting it (one an older version made with openssl too). Resolves
 * `{ key, cert, fingerprint }`, or `{ error }` when none could be made or saved: the agent then
 * runs without its LAN listener.
 */
export async function lanCertificate(dir) {
	const keyFile = path.join(dir, 'key.pem');
	const certFile = path.join(dir, 'cert.pem');
	const load = () => {
		const key = fs.readFileSync(keyFile, 'utf8');
		const cert = fs.readFileSync(certFile, 'utf8');
		return { key, cert, fingerprint: certFingerprint(cert) };
	};
	try {
		return load();
	} catch {}
	try {
		const { key, cert } = selfSignedCertificate();
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(keyFile, key, { mode: 0o600 });
		// An existing file keeps its mode through writeFileSync.
		fs.chmodSync(keyFile, 0o600);
		fs.writeFileSync(certFile, cert);
		return load();
	} catch (e) {
		for (const f of [keyFile, certFile]) {
			try {
				fs.rmSync(f, { force: true });
			} catch {}
		}
		return { error: `could not create a certificate: ${e.message}` };
	}
}

// VPNs, bridges, VM/container networks and hotspots: a phone on the Wi-Fi never reaches the
// computer there. Windows names its adapters in words: "VirtualBox Host-Only Network",
// "vEthernet (WSL)", "Local Area Connection* 10" (Wi-Fi Direct, Mobile hotspot; without the star
// it's the Ethernet port of older Windows).
const VIRTUAL =
	/^(utun|ipsec|ppp|bridge|docker|br-|veth|vboxnet|vmnet|vEthernet|awdl|llw|anpi|ap\d|gif|stf|tailscale|zt|wg|VirtualBox|VMware|ZeroTier|Hyper-V|Bluetooth|Local Area Connection\*)/i;

/** 10/8, 172.16/12, 192.168/16: what home and office networks hand out. */
function privateV4(address) {
	const [a, b] = address.split('.').map(Number);
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The addresses a device on the same network can reach this computer at: no loopback,
 * link-local or virtual interfaces. Private IPv4 first, then other IPv4 (100.64/10 is mostly a
 * VPN), then IPv6, as phones on home Wi-Fi mostly reach them in that order; the QR takes the first.
 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
	const v4 = [];
	const v6 = [];
	for (const [name, addrs] of Object.entries(interfaces)) {
		if (VIRTUAL.test(name)) continue;
		for (const a of addrs ?? []) {
			if (a.internal) continue;
			const family = a.family === 4 ? 'IPv4' : a.family === 6 ? 'IPv6' : a.family;
			if (family === 'IPv4' && !a.address.startsWith('169.254.')) v4.push(a.address);
			if (family === 'IPv6' && !/^fe[89ab]/i.test(a.address)) v6.push(a.address);
		}
	}
	return [...new Set([...v4.filter(privateV4), ...v4.filter((a) => !privateV4(a)), ...v6])];
}

/**
 * The addresses the QR carries: the first 3 of `addresses`, in their order, with at most one
 * IPv6 address. macOS keeps several temporary IPv6 addresses that would only make the code
 * denser; /api/info has them all.
 */
export function qrAddresses(addresses) {
	const firstV6 = addresses.find((a) => a.includes(':'));
	return addresses.filter((a) => !a.includes(':') || a === firstV6).slice(0, 3);
}

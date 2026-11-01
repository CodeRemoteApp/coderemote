// Direct connections on the local network: the agent's self-signed certificate, which clients
// pin by fingerprint (learned over the tunnel), and the addresses it can be reached at.
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable, isWindows } from './platform.js';

/** Git for Windows bundles openssl, which most Windows developers have even without it on PATH. */
const WINDOWS_OPENSSL = ['C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe'];

/** The openssl to generate the certificate with, or null. */
export function findOpenssl(env = process.env) {
	return findExecutable('openssl', env) ?? (isWindows ? WINDOWS_OPENSSL.find((f) => fs.existsSync(f)) ?? null : null);
}

/** Lowercase hex SHA-256 of a PEM certificate's DER encoding, without separators. */
export function certFingerprint(pem) {
	return new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
}

function generate(openssl, keyFile, certFile) {
	return new Promise((resolve, reject) => {
		execFile(
			openssl,
			[
				'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
				'-days', '3650', '-subj', '/CN=coderemote', '-keyout', keyFile, '-out', certFile,
			],
			{ timeout: 30_000 },
			(err, _stdout, stderr) => (err ? reject(new Error(stderr?.trim() || err.message)) : resolve()),
		);
	});
}

/**
 * The LAN certificate in `dir` (`key.pem`, `cert.pem`), generated on first use and reused after,
 * so paired phones keep trusting it. Resolves `{ key, cert, fingerprint }`, or `{ error }` when
 * none could be made (no openssl, or it failed): the agent then runs without its LAN listener.
 */
export async function lanCertificate(dir, { env = process.env } = {}) {
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
	const openssl = findOpenssl(env);
	if (!openssl) return { error: 'openssl was not found' };
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		// openssl writes the key with the umask's mode; it's created first so it starts private.
		fs.writeFileSync(keyFile, '', { mode: 0o600 });
		fs.chmodSync(keyFile, 0o600);
		await generate(openssl, keyFile, certFile);
		fs.chmodSync(keyFile, 0o600);
		return load();
	} catch (e) {
		fs.rmSync(keyFile, { force: true });
		fs.rmSync(certFile, { force: true });
		return { error: `could not create a certificate: ${e.message}` };
	}
}

// VPNs, bridges and VM/container networks: a phone on the Wi-Fi never reaches the computer there.
const VIRTUAL = /^(utun|ipsec|ppp|bridge|docker|br-|veth|vboxnet|vmnet|vEthernet|awdl|llw|anpi|ap\d|gif|stf|tailscale|zt|wg)/i;

/**
 * The addresses a device on the same network can reach this computer at: no loopback,
 * link-local or virtual interfaces; IPv4 first, as phones on home Wi-Fi mostly reach those.
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
	return [...new Set([...v4, ...v6])];
}

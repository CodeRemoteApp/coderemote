// A self-signed certificate made with Node alone, so the LAN listener needs no openssl (which
// Windows doesn't have). Clients pin it by fingerprint, so only a well-formed P-256 certificate
// matters: names, chain and expiry are never checked against anything.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// DER: tag, length, contents.
function tlv(tag, ...parts) {
	const body = Buffer.concat(parts);
	const n = body.length;
	let len;
	if (n < 0x80) len = Buffer.from([n]);
	else {
		const bytes = [];
		for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
		len = Buffer.from([0x80 | bytes.length, ...bytes]);
	}
	return Buffer.concat([Buffer.from([tag]), len, body]);
}

const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);

function oid(dotted) {
	const [a, b, ...rest] = dotted.split('.').map(Number);
	const out = [40 * a + b];
	for (const n of rest) {
		const chunk = [n & 0x7f];
		for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
		out.push(...chunk);
	}
	return tlv(0x06, Buffer.from(out));
}

/** UTCTime (YYMMDDHHMMSSZ): enough until 2049. */
function utcTime(date) {
	const s = date.toISOString();
	return tlv(0x17, Buffer.from(`${s.slice(2, 4)}${s.slice(5, 7)}${s.slice(8, 10)}${s.slice(11, 13)}${s.slice(14, 16)}${s.slice(17, 19)}Z`));
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function extension(id, critical, value) {
	return seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
}

const pem = (label, der) =>
	`-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

/**
 * A new P-256 key and a v3 certificate for it, signed by itself with ECDSA-SHA256, valid from a
 * day ago (for clocks a little behind) for `days`. Resolves PEMs: `key` PKCS#8, `cert` X.509.
 */
export function selfSignedCertificate({ commonName = 'coderemote', days = 3650, now = new Date() } = {}) {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	// Positive and minimally encoded: the first byte is neither 0 nor above 0x7f.
	const serial = randomBytes(16);
	serial[0] = (serial[0] & 0x7f) | 0x40;
	const name = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
	const day = 24 * 60 * 60 * 1000;
	const tbs = seq(
		tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
		tlv(0x02, serial),
		ECDSA_SHA256,
		name,
		seq(utcTime(new Date(now.getTime() - day)), utcTime(new Date(now.getTime() + days * day))),
		name,
		publicKey.export({ type: 'spki', format: 'der' }),
		tlv(
			0xa3,
			seq(
				extension('2.5.29.19', true, seq()), // basicConstraints: not a CA
				extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))), // keyUsage: digitalSignature
				extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
			),
		),
	);
	// Node signs EC keys as a DER ECDSA-Sig-Value, which is what the certificate carries.
	const signature = sign('sha256', tbs, privateKey);
	const cert = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), signature));
	return {
		key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
		cert: pem('CERTIFICATE', cert),
	};
}

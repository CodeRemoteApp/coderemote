import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Redactor, filterRequests, formatDetail, formatList, redactDetail } from '../src/requests.js';

const detail = {
	id: 7,
	time: 0,
	method: 'POST',
	path: '/api/login?next=/home&access_token=abc',
	status: 200,
	duration: 12,
	error: null,
	request: {
		headers: {
			authorization: 'Bearer sk-live-123',
			cookie: 'sid=s3cr3t; theme=dark',
			'content-type': 'application/json',
			'x-api-key': 'key-1',
		},
		body: { size: 40, truncated: false, text: '{"user":"me","password":"hunter2","remember":true}' },
	},
	response: {
		headers: { 'content-type': 'application/json', 'set-cookie': ['sid=new; Path=/; HttpOnly'] },
		body: { size: 60, truncated: false, text: '{"token":"jwt.abc","profile":{"name":"Me","apiKey":"k"}}' },
	},
};

test('masks auth headers, cookies, token fields and query params, keeping their shape', () => {
	const redactor = new Redactor();
	const text = formatDetail(detail, redactor);
	for (const secret of ['sk-live-123', 's3cr3t', 'key-1', 'hunter2', 'jwt.abc', '"k"', 'access_token=abc', 'sid=new']) {
		assert.ok(!text.includes(secret), `${secret} leaked`);
	}
	assert.match(text, /authorization: Bearer \[redacted\]/);
	assert.match(text, /cookie: sid=\[redacted\]; theme=\[redacted\]/);
	assert.match(text, /set-cookie: sid=\[redacted\]; Path=\/; HttpOnly/);
	assert.match(text, /next=\/home&access_token=\[redacted\]/);
	assert.match(text, /"user": "me"/);
	assert.match(text, /"remember": true/);
	assert.match(text, /"name": "Me"/);
	assert.ok(redactor.hidden >= 8);
});

test('--show-secrets prints everything as recorded', () => {
	const redactor = new Redactor({ show: true });
	const text = formatDetail(detail, redactor);
	for (const secret of ['Bearer sk-live-123', 'sid=s3cr3t', 'key-1', 'hunter2', 'jwt.abc', 'access_token=abc']) {
		assert.ok(text.includes(secret), `${secret} missing`);
	}
	assert.equal(redactor.hidden, 0);
});

test('the JSON form is masked too', () => {
	const out = redactDetail(detail, new Redactor());
	assert.equal(out.request.headers.authorization, 'Bearer [redacted]');
	assert.deepEqual(out.response.headers['set-cookie'], ['sid=[redacted]; Path=/; HttpOnly']);
	assert.equal(JSON.parse(out.response.body.text).token, '[redacted]');
	assert.equal(JSON.parse(out.request.body.text).user, 'me');
});

test('form bodies are masked by field name', () => {
	assert.equal(new Redactor().body('user=me&password=x', 'application/x-www-form-urlencoded'), 'user=me&password=[redacted]');
	assert.equal(new Redactor().body('plain text token=1', 'text/plain'), 'plain text token=1');
});

test('filters and lists requests', () => {
	const requests = [
		{ id: 1, time: 0, method: 'GET', path: '/app.css', status: 200, duration: 3, error: null, responseSize: 10 },
		{ id: 2, time: 0, method: 'POST', path: '/api/login', status: 401, duration: 9, error: null, responseSize: 20 },
		{ id: 3, time: 0, method: 'GET', path: '/api/me', status: null, duration: null, error: 'ECONNREFUSED', responseSize: 0 },
	];
	assert.deepEqual(filterRequests(requests, { grep: 'API' }).map((r) => r.id), [2, 3]);
	assert.deepEqual(filterRequests(requests, { failed: true }).map((r) => r.id), [2, 3]);
	const lines = formatList(requests, new Redactor()).split('\n');
	assert.equal(lines.length, 3);
	assert.match(lines[1], /^#2 +401 +POST \/api\/login +9 ms +20 B/);
	assert.match(lines[2], /ERR +GET \/api\/me +pending .*ECONNREFUSED$/);
});

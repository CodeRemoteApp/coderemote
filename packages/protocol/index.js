// Wire contract between the agent and its clients. Keep in sync with PROTOCOL.md; clients
// mirror it (the iOS app in its own Protocol.swift).

// v2: file access is confined to the folder the agent was started in (`root`).
// v3: git routes; terminal attach announces the scrollback replay.
// v4: sign-in handoff and tunnel token renewal for private tunnels.
export const PROTOCOL_VERSION = 4;

// The oldest client protocol this agent still serves, reported in `GET /api/info`. A client older
// than this asks its user to update instead of failing on routes it doesn't know. Raise it only
// when a change leaves older clients unable to work, and only once a client release that speaks
// the new protocol is out (see PROTOCOL.md, Compatibility).
export const MIN_CLIENT_PROTOCOL = 4;

export const PAIRING_SCHEME = 'vsremote';

export const Routes = Object.freeze({
	info: 'GET /api/info',
	fsList: 'GET /api/fs/list',
	fsStat: 'GET /api/fs/stat',
	fsRead: 'GET /api/fs/read',
	fsWrite: 'PUT /api/fs/write',
	fsMkdir: 'POST /api/fs/mkdir',
	fsRename: 'POST /api/fs/rename',
	fsDelete: 'DELETE /api/fs',
	// Added within v4: older agents answer 404.
	fsSearch: 'GET /api/fs/search',
	termList: 'GET /api/term',
	termKill: 'DELETE /api/term',
	gitRepos: 'GET /api/git/repos',
	gitStatus: 'GET /api/git/status',
	gitDiff: 'GET /api/git/diff',
	gitStage: 'POST /api/git/stage',
	gitUnstage: 'POST /api/git/unstage',
	gitDiscard: 'POST /api/git/discard',
	gitCommit: 'POST /api/git/commit',
	// Added within v4: older agents answer 404.
	gitCommitMessage: 'POST /api/git/commit-message',
	gitLog: 'GET /api/git/log',
	gitShow: 'GET /api/git/show',
	gitPull: 'POST /api/git/pull',
	gitPush: 'POST /api/git/push',
	// Added within v4 after the commit-message route: older agents answer 404.
	gitFetch: 'POST /api/git/fetch',
	gitBranches: 'GET /api/git/branches',
	gitCheckout: 'POST /api/git/checkout',
	gitStashes: 'GET /api/git/stashes',
	gitStash: 'POST /api/git/stash',
	gitStashApply: 'POST /api/git/stash/apply',
	gitStashDrop: 'POST /api/git/stash/drop',
	portsList: 'GET /api/ports',
	portsKill: 'POST /api/ports/kill',
	previewList: 'GET /api/preview',
	previewOpen: 'POST /api/preview',
	previewClose: 'DELETE /api/preview',
	previewShare: 'POST /api/preview/share',
	previewUnshare: 'DELETE /api/preview/share',
	previewRequests: 'GET /api/preview/requests',
	previewRequest: 'GET /api/preview/request',
	previewRequestsClear: 'DELETE /api/preview/requests',
	tunnelToken: 'POST /api/tunnel/token',
	tunnelStatus: 'GET /api/tunnel',
	// Added within v4: older agents answer 404.
	tunnelDelete: 'DELETE /api/tunnel',
	agentsHook: 'POST /api/agents/hook',
	agentsSessions: 'GET /api/agents/sessions',
	agentsTimeline: 'GET /api/agents/timeline',
	agentsAnswer: 'POST /api/agents/answer',
	agentsLaunch: 'POST /api/agents/sessions',
	agentsSetup: 'GET /api/agents/setup',
	agentsCommands: 'GET /api/agents/commands',
	agentsHistory: 'GET /api/agents/history',
	buildsSchemes: 'GET /api/builds/schemes',
	buildsStart: 'POST /api/builds',
	buildsCurrent: 'GET /api/builds/current',
	buildsCancel: 'POST /api/builds/cancel',
	buildsInstall: 'POST /api/builds/install',
	agentsPrompt: 'POST /api/agents/prompt',
	agentsKeys: 'POST /api/agents/keys',
	agentsStop: 'POST /api/agents/stop',
	agentsForget: 'POST /api/agents/forget',
	agentsUpload: 'POST /api/agents/uploads',
	// Added within v4: older agents answer 404.
	agentsUploadFile: 'GET /api/agents/uploads',
	pushDeviceSet: 'PUT /api/push/device',
	pushDeviceDelete: 'DELETE /api/push/device',
	pushTest: 'POST /api/push/test',
	// Added within v4: sealed in the end-to-end envelope, mints a ticket for the transfers outside it.
	e2eTicket: 'POST /api/e2e/ticket',
});

// Opened in the system browser (no bearer token); answers with a redirect to
// `vsremote://tunnel-auth?token=&expires=&state=`. See PROTOCOL.md, "Tunnel sign-in".
export const TUNNEL_HANDOFF_PATH = '/vsremote/handoff';
export const TUNNEL_AUTH_CALLBACK_HOST = 'tunnel-auth';

// End-to-end encryption (PROTOCOL.md, "End-to-end encryption"): the handshake and the sealed-request
// endpoint. Both are POST, answered before any bearer-token check.
export const E2E_HANDSHAKE_PATH = '/api/e2e/handshake';
export const E2E_REQUEST_PATH = '/api/e2e';
export const E2E_SESSION_HEADER = 'X-E2E-Session';
export const E2E_VERSION = 1;

export const TERMINAL_WS_PATH = '/api/term/ws';

// Bonjour service the agent's LAN listener is advertised as. See PROTOCOL.md, "Local network".
export const LAN_SERVICE_TYPE = '_coderemote._tcp';

// Server -> client text frames on the terminal socket. Binary frames carry PTY output.
export const TerminalServerMessage = Object.freeze({ session: 'session', exit: 'exit' });

// Client -> server text frames. Binary frames carry raw keyboard input.
export const TerminalClientMessage = Object.freeze({ input: 'input', resize: 'resize' });

// Coding-agent sessions (Claude Code) reported by `coderemote hook`. See PROTOCOL.md, "Agents".
export const AGENTS_WS_PATH = '/api/agents/ws';

// Hook deliveries carry this header with the machine-local hook secret instead of a bearer token.
export const HOOK_SECRET_HEADER = 'x-coderemote-hook';

// Server -> client frames on the agents socket.
export const AgentsServerMessage = Object.freeze({
	snapshot: 'snapshot',
	session: 'session',
	entry: 'entry',
	request: 'request',
	requestResolved: 'request_resolved',
	sessionRemoved: 'session_removed',
	promptConfirmed: 'prompt_confirmed',
});

// Client -> server frames on the agents socket.
export const AgentsClientMessage = Object.freeze({ presence: 'presence' });

/** Browser link: the agent's landing page turns the fragment into a pairing link. */
export function webUrl({ url, token }) {
	return `${url}/#token=${encodeURIComponent(token)}`;
}

/**
 * The link the pairing QR encodes. `url` is the tunnel's address (absent while an agent that
 * never had a tunnel runs offline). `agentId`, the agent's identity, goes in whenever it has a
 * LAN listener. `lan`, `{ port, addresses, fingerprint }`, lets a client pin the agent's
 * certificate and reach it on the local network straight from the QR: the agent passes it only
 * while its tunnel isn't up, as a client otherwise learns all that from /api/info, and the QR
 * stays small. `publicKey`, the agent's end-to-end identity key, goes in whenever it has one.
 * See PROTOCOL.md, "Pairing".
 */
export function pairingUrl({ url = null, token, agentId = null, lan = null, publicKey = null }) {
	if (!url && !lan) throw new Error('a pairing link needs a tunnel URL or the LAN listener');
	if (lan && !agentId) throw new Error('a pairing link with the LAN listener needs the agent id');
	const q = new URLSearchParams();
	if (url) q.set('url', url);
	q.set('token', token);
	if (agentId) q.set('id', agentId);
	if (lan) {
		q.set('lan', String(lan.port));
		q.set('addr', lan.addresses.join(','));
		q.set('fp', lan.fingerprint);
	}
	// The agent's end-to-end identity key (32 bytes, unpadded base64url): the client pins it.
	if (publicKey && publicKey.length !== 32) throw new Error('the end-to-end identity key is 32 bytes');
	if (publicKey) q.set('pk', Buffer.from(publicKey).toString('base64url'));
	// encodeURIComponent's escaping, as links from older agents have it (URLSearchParams writes "+").
	return `${PAIRING_SCHEME}://pair?${q.toString().replace(/\+/g, '%20')}`;
}

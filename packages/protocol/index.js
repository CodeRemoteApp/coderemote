// Wire contract between the agent and its clients. Keep in sync with PROTOCOL.md; clients
// mirror it (the iOS app in its own Protocol.swift).

// v2: file access is confined to the folder the agent was started in (`root`).
// v3: git routes; terminal attach announces the scrollback replay.
// v4: sign-in handoff and tunnel token renewal for private tunnels.
export const PROTOCOL_VERSION = 4;

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
	termList: 'GET /api/term',
	termKill: 'DELETE /api/term',
	gitRepos: 'GET /api/git/repos',
	gitStatus: 'GET /api/git/status',
	gitDiff: 'GET /api/git/diff',
	gitStage: 'POST /api/git/stage',
	gitUnstage: 'POST /api/git/unstage',
	gitDiscard: 'POST /api/git/discard',
	gitCommit: 'POST /api/git/commit',
	gitLog: 'GET /api/git/log',
	gitShow: 'GET /api/git/show',
	gitPull: 'POST /api/git/pull',
	gitPush: 'POST /api/git/push',
	tunnelToken: 'POST /api/tunnel/token',
});

// Opened in the system browser (no bearer token); answers with a redirect to
// `vsremote://tunnel-auth?token=&expires=&state=`. See PROTOCOL.md, "Tunnel sign-in".
export const TUNNEL_HANDOFF_PATH = '/vsremote/handoff';
export const TUNNEL_AUTH_CALLBACK_HOST = 'tunnel-auth';

export const TERMINAL_WS_PATH = '/api/term/ws';

// Server -> client text frames on the terminal socket. Binary frames carry PTY output.
export const TerminalServerMessage = Object.freeze({ session: 'session', exit: 'exit' });

// Client -> server text frames. Binary frames carry raw keyboard input.
export const TerminalClientMessage = Object.freeze({ input: 'input', resize: 'resize' });

/** Browser link: the agent's landing page turns the fragment into a pairing link. */
export function webUrl({ url, token }) {
	return `${url}/#token=${encodeURIComponent(token)}`;
}

export function pairingUrl({ url, token }) {
	return `${PAIRING_SCHEME}://pair?url=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`;
}

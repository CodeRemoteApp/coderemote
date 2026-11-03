// Which routes need a presence grant (a recent Face ID), by class. The terminal class is whatever
// runs commands on the computer; the writes class is whatever changes or publishes work. Every
// route has an explicit class here, and a test fails for one that doesn't.
import { Routes } from '@vsremote/protocol';

const FREE = 'free';
const TERMINAL = 'terminal';
const WRITES = 'writes';

const CLASSES = {
	[Routes.info]: FREE,
	[Routes.fsList]: FREE,
	[Routes.fsStat]: FREE,
	[Routes.fsRead]: FREE,
	[Routes.fsWrite]: WRITES,
	[Routes.fsMkdir]: WRITES,
	[Routes.fsRename]: WRITES,
	[Routes.fsDelete]: WRITES,
	[Routes.fsSearch]: FREE,
	[Routes.termList]: FREE,
	// Ends a terminal session: stopping a process.
	[Routes.termKill]: WRITES,
	[Routes.gitRepos]: FREE,
	[Routes.gitStatus]: FREE,
	[Routes.gitDiff]: FREE,
	// Staging only moves changes between the index and the tree.
	[Routes.gitStage]: FREE,
	[Routes.gitUnstage]: FREE,
	[Routes.gitDiscard]: WRITES,
	[Routes.gitCommit]: WRITES,
	[Routes.gitCommitMessage]: FREE,
	[Routes.gitLog]: FREE,
	[Routes.gitShow]: FREE,
	[Routes.gitPull]: WRITES,
	[Routes.gitPush]: WRITES,
	[Routes.gitFetch]: FREE,
	[Routes.gitBranches]: FREE,
	[Routes.gitCheckout]: WRITES,
	[Routes.gitStashes]: FREE,
	[Routes.gitStash]: WRITES,
	[Routes.gitStashApply]: WRITES,
	[Routes.gitStashDrop]: WRITES,
	[Routes.portsList]: FREE,
	[Routes.portsKill]: WRITES,
	[Routes.previewList]: FREE,
	[Routes.previewOpen]: FREE,
	[Routes.previewClose]: FREE,
	[Routes.previewShare]: WRITES,
	[Routes.previewUnshare]: FREE,
	[Routes.previewRequests]: FREE,
	[Routes.previewRequest]: FREE,
	[Routes.previewRequestsClear]: FREE,
	[Routes.tunnelToken]: FREE,
	[Routes.tunnelStatus]: FREE,
	[Routes.tunnelDelete]: FREE,
	// Authenticated by the hook secret, not by a device.
	[Routes.agentsHook]: FREE,
	[Routes.agentsSessions]: FREE,
	[Routes.agentsTimeline]: FREE,
	// Approving a tool call authorizes a command the coding agent will run.
	[Routes.agentsAnswer]: WRITES,
	// Starting a coding-agent session, and typing into one, run commands as a terminal does.
	[Routes.agentsLaunch]: TERMINAL,
	[Routes.agentsSetup]: FREE,
	[Routes.agentsCommands]: FREE,
	[Routes.agentsHistory]: FREE,
	[Routes.buildsSchemes]: FREE,
	[Routes.buildsStart]: TERMINAL,
	[Routes.buildsCurrent]: FREE,
	[Routes.buildsCancel]: FREE,
	[Routes.buildsInstall]: WRITES,
	[Routes.agentsPrompt]: TERMINAL,
	[Routes.agentsKeys]: TERMINAL,
	[Routes.agentsStop]: WRITES,
	[Routes.agentsForget]: FREE,
	[Routes.agentsUpload]: FREE,
	[Routes.agentsUploadFile]: FREE,
	[Routes.pushDeviceSet]: FREE,
	[Routes.pushDeviceDelete]: FREE,
	[Routes.pushTest]: FREE,
	[Routes.e2eTicket]: FREE,
	[Routes.deviceEnroll]: FREE,
	[Routes.deviceList]: FREE,
	[Routes.deviceRevoke]: FREE,
	[Routes.deviceChallenge]: FREE,
	[Routes.deviceSession]: FREE,
	[Routes.presenceChallenge]: FREE,
	[Routes.presenceGrant]: FREE,
	// Relaxing the policy checks for a grant itself.
	[Routes.devicePolicy]: FREE,
};

export const ROUTE_CLASSES = Object.freeze(CLASSES);

/** The class of `METHOD /path`, or null for a route nobody classified. */
export function routeClass(routeKey) {
	return CLASSES[routeKey] ?? null;
}

/** Whether a route of `cls` needs a grant at presence `level`. */
export function requiresGrant(level, cls) {
	return (cls === TERMINAL && level !== 'none') || (cls === WRITES && level === 'terminal+writes');
}

/** Whether opening a terminal socket needs a grant at `level`. */
export function terminalNeedsGrant(level) {
	return requiresGrant(level, TERMINAL);
}

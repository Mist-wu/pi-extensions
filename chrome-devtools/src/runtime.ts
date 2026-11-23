import type { ChildProcess } from "node:child_process";
import {
	DEFAULT_BROWSER_HOST,
	DEFAULT_BROWSER_PORT,
	type EffectiveBrowserSettings,
	parseConfiguredPort,
} from "./settings.js";

export const DEFAULT_HOST = DEFAULT_BROWSER_HOST;
export const DEFAULT_PORT = DEFAULT_BROWSER_PORT;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 1_000;
export const DEFAULT_ENDPOINT_WAIT_MS = 5_000;
export const DEFAULT_ENDPOINT_RETRY_MS = 250;
export const MANAGED_BROWSER_PROFILE_PREFIX = "pi-chrome-devtools-profile-";
export const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";
export const BROWSER_SHUTDOWN_WAIT_MS = 1_500;

export interface DevToolsPage {
	id: string;
	type: string;
	title: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

export interface ChromeDevToolsState {
	host: string;
	port: number;
	configuredPort: number;
	hostConfigured: boolean;
	portConfigured: boolean;
	autoLaunchEnabled: boolean;
	endpointSource: EffectiveBrowserSettings["endpointSource"];
	autoLaunchSource: EffectiveBrowserSettings["autoLaunchSource"];
	browserExecutable?: string;
	browserUserDataDir?: string;
	keepAliveEnabled: boolean;
	extensionPaths: string[];
	browserExecutableSource: EffectiveBrowserSettings["executablePathSource"];
	browserUserDataDirSource: EffectiveBrowserSettings["userDataDirSource"];
	keepAliveSource: EffectiveBrowserSettings["keepAliveSource"];
	extensionPathsSource: EffectiveBrowserSettings["extensionPathsSource"];
	settingsFilePath?: string;
	projectSettingsFilePath?: string;
	projectSettingsTrusted: boolean;
	activePageId?: string;
	managedBrowser?: ManagedBrowser;
	launchPromise?: Promise<void>;
	lastLaunchAttempt?: BrowserLaunchAttempt;
	shuttingDown: boolean;
	sessionGeneration: number;
	sessionController: AbortController;
	settingsNotice?: string;
}

export interface ManagedBrowser {
	process: ChildProcess;
	userDataDir: string;
	/** A user-configured profile is reused across sessions, so shutdown must not delete it. */
	persistentProfile: boolean;
	/** Session shutdown detaches from this browser instead of stopping it. */
	keepAlive: boolean;
	port?: number;
	exited: boolean;
	ready: boolean;
	ownerGeneration: number;
	sessionOwner?: object;
	cleanupPromise?: Promise<void>;
}

export interface BrowserLaunchAttempt {
	candidateLabels: string[];
	mode: "dynamic-port" | "explicit-port";
	selectedCandidate?: string;
	userDataDir?: string;
	lastError?: string;
}

export interface BrowserCandidateDefinition {
	label: string;
	executable: string;
	source: "env" | "path" | "wellKnownPath";
}

export interface BrowserCandidate extends BrowserCandidateDefinition {
	resolvedExecutable: string;
}

export { parseConfiguredPort };

export const state: ChromeDevToolsState = {
	host: DEFAULT_HOST,
	port: DEFAULT_PORT,
	configuredPort: DEFAULT_PORT,
	hostConfigured: false,
	portConfigured: false,
	autoLaunchEnabled: true,
	endpointSource: "default",
	autoLaunchSource: "default",
	keepAliveEnabled: false,
	extensionPaths: [],
	browserExecutableSource: "default",
	browserUserDataDirSource: "default",
	keepAliveSource: "default",
	extensionPathsSource: "default",
	projectSettingsTrusted: false,
	shuttingDown: false,
	sessionGeneration: 0,
	sessionController: new AbortController(),
};

interface WebMcpSessionRuntime {
	controller: AbortController;
	enabled: boolean;
	controllers: Set<AbortController>;
	generation: number;
	sessionGeneration: number;
}

const webMcpRuntimeByOwner = new WeakMap<object, WebMcpSessionRuntime>();

export function setWebMcpSessionOwner(owner: object) {
	const runtime = webMcpRuntime(owner);
	runtime.enabled = false;
	runtime.sessionGeneration += 1;
}

export function beginWebMcpOperation(owner: object, toolSignal?: AbortSignal) {
	const runtime = webMcpRuntime(owner);
	const controller = new AbortController();
	runtime.controllers.add(controller);
	const signals = [controller.signal, runtime.controller.signal];
	if (toolSignal) signals.push(toolSignal);
	const signal = AbortSignal.any(signals);
	return {
		signal,
		owner,
		sessionGeneration: runtime.sessionGeneration,
		webMcpGeneration: runtime.generation,
		dispose() {
			runtime.controllers.delete(controller);
		},
	};
}

export function invalidateWebMcpOperations(owner: object, reason: string) {
	const runtime = webMcpRuntime(owner);
	runtime.generation += 1;
	const controllers = [...runtime.controllers];
	runtime.controllers.clear();
	const error = new DOMException(reason, "AbortError");
	runtime.controller.abort(error);
	runtime.controller = new AbortController();
	for (const controller of controllers) controller.abort(error);
}

export function currentWebMcpGeneration(owner: object) {
	return webMcpRuntime(owner).generation;
}

export function webMcpSessionSignal(owner: object) {
	return webMcpRuntime(owner).controller.signal;
}

export function applyRuntimeWebMcpSetting(enabled: boolean, owner: object) {
	const runtime = webMcpRuntime(owner);
	if (runtime.enabled !== enabled) {
		invalidateWebMcpOperations(owner, `WebMCP ${enabled ? "enabled" : "disabled"}`);
	}
	runtime.enabled = enabled;
}

export function webMcpEnabled(owner: object) {
	return webMcpRuntime(owner).enabled;
}

export function webMcpOperationIsCurrent(operation: {
	owner: object;
	sessionGeneration: number;
	webMcpGeneration: number;
}) {
	const runtime = webMcpRuntime(operation.owner);
	return (
		operation.sessionGeneration === runtime.sessionGeneration &&
		operation.webMcpGeneration === runtime.generation
	);
}

function webMcpRuntime(owner: object) {
	const existing = webMcpRuntimeByOwner.get(owner);
	if (existing) return existing;
	const created: WebMcpSessionRuntime = {
		controller: new AbortController(),
		controllers: new Set(),
		enabled: false,
		generation: 0,
		sessionGeneration: 0,
	};
	webMcpRuntimeByOwner.set(owner, created);
	return created;
}

interface ExtensionSession {
	controller: AbortController;
	generation: number;
}

const extensionSessions = new WeakMap<object, ExtensionSession>();

function extensionSession(extension: object): ExtensionSession {
	const existing = extensionSessions.get(extension);
	if (existing) return existing;
	const created: ExtensionSession = { controller: new AbortController(), generation: 0 };
	extensionSessions.set(extension, created);
	return created;
}

/** Bump only this extension instance so a sibling instance sharing the module keeps running. */
export function replaceExtensionSession(extension: object, reason: string): number {
	const current = extensionSession(extension);
	current.controller.abort(new DOMException(reason, "AbortError"));
	current.controller = new AbortController();
	current.generation += 1;
	return current.generation;
}

export function extensionSessionGeneration(extension: object): number {
	return extensionSession(extension).generation;
}

export function extensionSessionSignal(extension: object): AbortSignal {
	return extensionSession(extension).controller.signal;
}

export interface PageOperation {
	generation: number;
	owner?: object;
	signal: AbortSignal;
}

interface OwnerOperationLifecycle {
	controller: AbortController;
	generation: number;
}

const ownerOperations = new WeakMap<object, OwnerOperationLifecycle>();

function ownerOperationLifecycle(owner: object): OwnerOperationLifecycle {
	const existing = ownerOperations.get(owner);
	if (existing) return existing;
	const created: OwnerOperationLifecycle = { controller: new AbortController(), generation: 0 };
	ownerOperations.set(owner, created);
	return created;
}

/** Capture the owner's lifecycle before discovery so a later shutdown can still invalidate it. */
export function beginPageOperation(
	owner: object | undefined,
	toolSignal?: AbortSignal,
): PageOperation {
	if (!owner) {
		const signal = toolSignal
			? AbortSignal.any([state.sessionController.signal, toolSignal])
			: state.sessionController.signal;
		return { generation: state.sessionGeneration, signal };
	}
	const lifecycle = ownerOperationLifecycle(owner);
	const signals = [lifecycle.controller.signal];
	if (toolSignal) signals.push(toolSignal);
	return {
		generation: lifecycle.generation,
		owner,
		signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
	};
}

export function pageOperationCurrent(operation?: PageOperation): boolean {
	if (!operation) return true;
	if (operation.signal.aborted) return false;
	if (!operation.owner) return operation.generation === state.sessionGeneration;
	const lifecycle = ownerOperationLifecycle(operation.owner);
	return lifecycle.generation === operation.generation;
}

export function assertPageOperationCurrent(operation?: PageOperation): void {
	if (!operation || pageOperationCurrent(operation)) return;
	const reason = operation.signal.reason;
	if (reason !== undefined) throw reason;
	throw new DOMException("Chrome DevTools operation cancelled", "AbortError");
}

export function invalidatePageOperations(owner: object | undefined, reason: string): void {
	if (!owner) return;
	const lifecycle = ownerOperationLifecycle(owner);
	lifecycle.generation += 1;
	lifecycle.controller.abort(new DOMException(reason, "AbortError"));
	lifecycle.controller = new AbortController();
}

export function applyRuntimeBrowserSettings(
	browser: EffectiveBrowserSettings,
	paths: { user: string; project?: string },
	projectTrusted: boolean,
) {
	state.host = browser.host;
	state.port = browser.port;
	state.configuredPort = browser.port;
	state.hostConfigured = browser.hostConfigured;
	state.portConfigured = browser.portConfigured;
	state.autoLaunchEnabled = browser.autoLaunchEnabled;
	state.endpointSource = browser.endpointSource;
	state.autoLaunchSource = browser.autoLaunchSource;
	state.browserExecutable = browser.executablePath;
	state.browserUserDataDir = browser.userDataDir;
	state.keepAliveEnabled = browser.keepAliveEnabled;
	state.extensionPaths = [...browser.extensionPaths];
	state.browserExecutableSource = browser.executablePathSource;
	state.browserUserDataDirSource = browser.userDataDirSource;
	state.keepAliveSource = browser.keepAliveSource;
	state.extensionPathsSource = browser.extensionPathsSource;
	state.settingsFilePath = paths.user;
	state.projectSettingsFilePath = paths.project;
	state.projectSettingsTrusted = projectTrusted;
}

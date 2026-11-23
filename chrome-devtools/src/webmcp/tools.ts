import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { browserCustody } from "../browser-manager.js";
import { getPage, resolvePage, textResult } from "../cdp-client.js";
import { beginWebMcpOperation, webMcpEnabled } from "../runtime.js";
import {
	assertOperationCurrent,
	discoverWebMcpTools,
	invokeDiscoveredWebMcpTool,
} from "./discovery.js";
import {
	boundedWebMcpDiscovery,
	boundedWebMcpJson,
	normalizeWebMcpInput,
	requireMatchingWebMcpTool,
	sanitizeWebMcpDisplay,
	validateWebMcpInput,
	type WebMcpToolIdentity,
	webMcpConfirmationMessage,
	webMcpErrorMessage,
	webMcpIdentity,
} from "./policy.js";

interface ListInput {
	pageId?: string;
}

interface CallInput extends Omit<WebMcpToolIdentity, "name"> {
	input: Record<string, unknown>;
	toolName: string;
}

export async function executeWebMcpListTool(
	params: ListInput,
	toolSignal: AbortSignal | undefined,
	ctx: ExtensionContext,
) {
	try {
		requireWebMcpEnabled(ctx.sessionManager);
		const operation = beginWebMcpOperation(ctx.sessionManager, toolSignal);
		const page = await resolvePage(params.pageId, {
			sessionOwner: ctx.sessionManager,
			signal: operation.signal,
		});
		assertOperationCurrent(operation);
		const tools = await discoverWebMcpTools(page, operation);
		assertOperationCurrent(operation);
		const published = boundedWebMcpDiscovery(
			{ id: page.id, title: page.title, url: page.url },
			tools,
		);
		return textResult(published.text, {
			page: { id: page.id, url: page.url },
			toolCount: tools.length,
			publishedToolCount: published.included.length,
			truncated: published.truncated,
			identities: published.included.map(webMcpIdentity),
		});
	} catch (error) {
		throw safeToolError(error);
	}
}

export async function executeWebMcpCallTool(
	params: CallInput,
	toolSignal: AbortSignal | undefined,
	ctx: ExtensionContext,
) {
	try {
		requireWebMcpEnabled(ctx.sessionManager);
		if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
			throw new Error(
				"chrome_devtools_webmcp_call_tool requires observable confirmation in TUI or RPC mode and is unavailable in print or JSON mode.",
			);
		}
		const input = normalizeWebMcpInput(params.input);
		const expected = expectedIdentity(params);
		const operation = beginWebMcpOperation(ctx.sessionManager, toolSignal);
		const page = await getPage(params.pageId, {
			sessionOwner: ctx.sessionManager,
			signal: operation.signal,
		});
		assertOperationCurrent(operation);
		const discovered = await discoverWebMcpTools(page, operation);
		const current = requireMatchingWebMcpTool(discovered, expected);
		const validatedInput = validateWebMcpInput(current.inputSchema, input);
		assertOperationCurrent(operation);
		const confirmed = await ctx.ui.confirm(
			`Allow WebMCP tool: ${sanitizeWebMcpDisplay(current.name, 256)}`,
			webMcpConfirmationMessage(current, validatedInput, browserCustody(ctx.sessionManager)),
			{ signal: operation.signal },
		);
		assertOperationCurrent(operation);
		if (!confirmed) {
			throw new DOMException("WebMCP tool call cancelled by the user.", "AbortError");
		}
		const invocation = await invokeDiscoveredWebMcpTool(page, expected, validatedInput, operation);
		assertOperationCurrent(operation);
		const published = boundedWebMcpJson({
			status: "completed",
			tool: webMcpIdentity(invocation.tool),
			output: invocation.output,
		});
		return textResult(published.text, {
			invocationId: invocation.invocationId,
			tool: webMcpIdentity(invocation.tool),
			truncated: published.truncated,
			output: published.text,
		});
	} catch (error) {
		throw safeToolError(error);
	}
}

function requireWebMcpEnabled(owner: object) {
	if (!webMcpEnabled(owner)) {
		throw new Error(
			"WebMCP is disabled. Enable the experimental user setting in /chrome-devtools settings, then make the WebMCP gateway tools available.",
		);
	}
}

function expectedIdentity(params: CallInput): WebMcpToolIdentity {
	return {
		sessionGeneration: params.sessionGeneration,
		pageId: params.pageId,
		documentId: params.documentId,
		frameId: params.frameId,
		frameOrigin: params.frameOrigin,
		name: params.toolName,
		schemaDigest: params.schemaDigest,
	};
}

function safeToolError(error: unknown) {
	const message = webMcpErrorMessage(error);
	if (error instanceof DOMException && error.name === "AbortError") {
		return new DOMException(message, "AbortError");
	}
	return new Error(message);
}

export const CORE_CHROME_DEVTOOLS_TOOL_NAMES = [
	"chrome_devtools_list_pages",
	"chrome_devtools_select_page",
	"chrome_devtools_navigate",
	"chrome_devtools_evaluate",
	"chrome_devtools_screenshot",
	"chrome_devtools_snapshot",
	"chrome_devtools_click",
	"chrome_devtools_fill",
	"chrome_devtools_press",
	"chrome_devtools_wait_for",
	"chrome_devtools_console",
	"chrome_devtools_network",
	"chrome_devtools_emulate",
	"chrome_devtools_cdp_send",
] as const;

export const WEBMCP_TOOL_NAMES = [
	"chrome_devtools_webmcp_list_tools",
	"chrome_devtools_webmcp_call_tool",
] as const;

export const CHROME_DEVTOOLS_TOOL_NAMES = [
	...CORE_CHROME_DEVTOOLS_TOOL_NAMES,
	...WEBMCP_TOOL_NAMES,
] as const;

export type ChromeDevToolsToolName = (typeof CHROME_DEVTOOLS_TOOL_NAMES)[number];
export type WebMcpToolName = (typeof WEBMCP_TOOL_NAMES)[number];

export function isWebMcpToolName(value: string): value is WebMcpToolName {
	return WEBMCP_TOOL_NAMES.includes(value as WebMcpToolName);
}

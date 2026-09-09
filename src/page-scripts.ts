/**
 * Scripts evaluated inside the inspected page.
 *
 * Snapshots register their elements in a page-local registry so later tool calls can address an
 * element by a short ref instead of re-sending a selector. Refs are validated on use: an element
 * that left the document resolves to an explicit error rather than a silent mis-click.
 */

const REGISTRY = "window.__piCdpRefs";

const REGISTRY_BOOTSTRAP = `
	const registry = ${REGISTRY} || (${REGISTRY} = { seq: 0, map: new Map() });
`;

export interface SnapshotNode {
	ref: string;
	role: string;
	name: string;
	value?: string;
	state?: string;
	href?: string;
	selector: string;
}

export interface SnapshotResult {
	url: string;
	title: string;
	nodes: SnapshotNode[];
	truncated: boolean;
	total: number;
}

export interface ResolvedElement {
	x: number;
	y: number;
	width: number;
	height: number;
	tag: string;
	selector: string;
	name: string;
}

/** Build a compact, ref-addressable outline of the interactive and structural page content. */
export function snapshotScript(limit: number, includeText: boolean) {
	return `(() => {
	${REGISTRY_BOOTSTRAP}
	registry.seq = 0;
	registry.map = new Map();

	const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role], [onclick], [contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
	const STRUCTURAL = 'h1, h2, h3, h4, h5, h6';
	const selector = ${includeText ? "INTERACTIVE + ', ' + STRUCTURAL" : "INTERACTIVE"};

	const visible = (el) => {
		const rect = el.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return false;
		const style = getComputedStyle(el);
		return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
	};

	const trim = (value, max) => {
		const text = (value || '').replace(/\\s+/g, ' ').trim();
		return text.length > max ? text.slice(0, max) + '…' : text;
	};

	const accessibleName = (el) => {
		const aria = el.getAttribute('aria-label');
		if (aria) return trim(aria, 120);
		const labelledBy = el.getAttribute('aria-labelledby');
		if (labelledBy) {
			const parts = labelledBy.split(/\\s+/)
				.map((id) => document.getElementById(id))
				.filter(Boolean)
				.map((node) => node.textContent);
			if (parts.length) return trim(parts.join(' '), 120);
		}
		if (el.id) {
			const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
			if (label && label.textContent.trim()) return trim(label.textContent, 120);
		}
		const closestLabel = el.closest('label');
		if (closestLabel && closestLabel.textContent.trim()) return trim(closestLabel.textContent, 120);
		if (el.getAttribute('placeholder')) return trim(el.getAttribute('placeholder'), 120);
		if (el.getAttribute('title')) return trim(el.getAttribute('title'), 120);
		if (el.getAttribute('alt')) return trim(el.getAttribute('alt'), 120);
		if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) {
			return trim(el.value, 120);
		}
		return trim(el.innerText || el.textContent, 120);
	};

	const roleOf = (el) => {
		const explicit = el.getAttribute('role');
		if (explicit) return explicit;
		const tag = el.tagName.toLowerCase();
		if (tag === 'a') return 'link';
		if (tag === 'button') return 'button';
		if (tag === 'select') return 'combobox';
		if (tag === 'textarea') return 'textbox';
		if (tag === 'input') {
			const type = (el.getAttribute('type') || 'text').toLowerCase();
			if (type === 'checkbox') return 'checkbox';
			if (type === 'radio') return 'radio';
			if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
			return type === 'text' ? 'textbox' : type;
		}
		if (/^h[1-6]$/.test(tag)) return 'heading';
		return tag;
	};

	const shortSelector = (el) => {
		if (el.id) return '#' + CSS.escape(el.id);
		const name = el.getAttribute('name');
		if (name) return el.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\\\"') + '"]';
		const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
		if (testId) return '[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]';
		const parent = el.parentElement;
		if (!parent) return el.tagName.toLowerCase();
		const siblings = [...parent.children].filter((node) => node.tagName === el.tagName);
		const index = siblings.indexOf(el) + 1;
		const base = el.tagName.toLowerCase();
		return siblings.length > 1 ? base + ':nth-of-type(' + index + ')' : base;
	};

	const stateOf = (el) => {
		const parts = [];
		if (el.disabled) parts.push('disabled');
		if (el.checked) parts.push('checked');
		if (el.getAttribute('aria-expanded')) parts.push('expanded=' + el.getAttribute('aria-expanded'));
		if (el.required) parts.push('required');
		return parts.length ? parts.join(',') : undefined;
	};

	const all = [...document.querySelectorAll(selector)].filter(visible);
	const nodes = [];
	for (const el of all.slice(0, ${limit})) {
		const ref = 'e' + (++registry.seq);
		registry.map.set(ref, el);
		const node = {
			ref,
			role: roleOf(el),
			name: accessibleName(el),
			selector: shortSelector(el),
		};
		const state = stateOf(el);
		if (state) node.state = state;
		if (el.value !== undefined && el.type !== 'password' && typeof el.value === 'string' && el.value) {
			node.value = trim(el.value, 80);
		}
		if (el.tagName === 'A' && el.getAttribute('href')) node.href = trim(el.getAttribute('href'), 200);
		nodes.push(node);
	}

	return {
		url: location.href,
		title: document.title,
		nodes,
		total: all.length,
		truncated: all.length > ${limit},
	};
})()`;
}

/** Resolve a ref or selector to viewport coordinates, scrolling it into view first. */
export function resolveElementScript(target: { ref?: string; selector?: string }) {
	const lookup = target.ref
		? `registry.map.get(${JSON.stringify(target.ref)})`
		: `document.querySelector(${JSON.stringify(target.selector ?? "")})`;
	const label = target.ref
		? `ref ${JSON.stringify(target.ref)}`
		: `selector ${JSON.stringify(target.selector ?? "")}`;
	return `(() => {
	${REGISTRY_BOOTSTRAP}
	const el = ${lookup};
	if (!el) throw new Error('No element for ${label}. Take a fresh chrome_devtools_snapshot.');
	if (!el.isConnected) throw new Error('Element for ${label} left the document. Take a fresh chrome_devtools_snapshot.');
	el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
	const rect = el.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) throw new Error('Element for ${label} has no layout box.');
	return {
		x: rect.left + rect.width / 2,
		y: rect.top + rect.height / 2,
		width: rect.width,
		height: rect.height,
		tag: el.tagName.toLowerCase(),
		selector: el.id ? '#' + el.id : el.tagName.toLowerCase(),
		name: (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
	};
})()`;
}

/** Focus an element and clear it, so a following Input.insertText replaces rather than appends. */
export function focusAndClearScript(target: { ref?: string; selector?: string }, clear: boolean) {
	const lookup = target.ref
		? `registry.map.get(${JSON.stringify(target.ref)})`
		: `document.querySelector(${JSON.stringify(target.selector ?? "")})`;
	const label = target.ref
		? `ref ${JSON.stringify(target.ref)}`
		: `selector ${JSON.stringify(target.selector ?? "")}`;
	return `(() => {
	${REGISTRY_BOOTSTRAP}
	const el = ${lookup};
	if (!el) throw new Error('No element for ${label}. Take a fresh chrome_devtools_snapshot.');
	if (!el.isConnected) throw new Error('Element for ${label} left the document. Take a fresh chrome_devtools_snapshot.');
	el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
	el.focus();
	if (${clear ? "true" : "false"}) {
		if (el.value !== undefined) {
			const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
			if (setter) setter.call(el, '');
			else el.value = '';
			el.dispatchEvent(new Event('input', { bubbles: true }));
		} else if (el.isContentEditable) {
			el.textContent = '';
		}
	}
	return { tag: el.tagName.toLowerCase(), focused: document.activeElement === el };
})()`;
}

/** Predicate used by chrome_devtools_wait_for, evaluated repeatedly until it returns true. */
export function waitConditionScript(condition: {
	selector?: string;
	text?: string;
	gone?: boolean;
	expression?: string;
}) {
	if (condition.expression) return `(() => Boolean(${condition.expression}))()`;
	if (condition.selector) {
		const present = `Boolean(document.querySelector(${JSON.stringify(condition.selector)}))`;
		return `(() => ${condition.gone ? `!${present}` : present})()`;
	}
	if (condition.text) {
		const present = `(document.body?.innerText || '').includes(${JSON.stringify(condition.text)})`;
		return `(() => ${condition.gone ? `!${present}` : present})()`;
	}
	return "(() => true)()";
}

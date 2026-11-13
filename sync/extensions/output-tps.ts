/**
 * Output TPS status line.
 *
 * Measures the output throughput of the last assistant message: tokens reported in
 * `usage.output` divided by the time between the first and last streamed delta, so
 * time-to-first-token is excluded. The result is shown in the footer as `out: 42.3 t/s`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "output-tps";

function formatTps(tps: number): string {
	return `${tps.toFixed(1)} t/s`;
}

export default function (pi: ExtensionAPI) {
	let startedAt = 0;
	let firstDeltaAt = 0;
	let lastDeltaAt = 0;

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		startedAt = Date.now();
		firstDeltaAt = 0;
		lastDeltaAt = 0;
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const type = event.assistantMessageEvent.type;
		if (type !== "text_delta" && type !== "thinking_delta" && type !== "toolcall_delta") return;
		const now = Date.now();
		if (!firstDeltaAt) firstDeltaAt = now;
		lastDeltaAt = now;
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const output = event.message.usage?.output ?? 0;
		if (output <= 0) return;

		// Prefer the delta window (pure generation speed). Fall back to the whole
		// message when the provider sent everything in one chunk, since a window of a
		// few milliseconds would report a meaningless rate.
		const begin = firstDeltaAt || startedAt;
		if (!begin) return;
		const deltaWindow = firstDeltaAt ? lastDeltaAt - firstDeltaAt : 0;
		const elapsedMs = deltaWindow > 100 ? deltaWindow : Date.now() - begin;
		if (elapsedMs <= 0) return;

		const tps = output / (elapsedMs / 1000);
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `out: ${formatTps(tps)}`));
	});
}

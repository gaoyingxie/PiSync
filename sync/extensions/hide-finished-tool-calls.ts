/**
 * Hide finished tool calls, and the labels of hidden thinking runs.
 *
 * Tool cards stay visible while Pi works. When a run finishes (the `agent_end` / `agent_settled`
 * event, or its final answer, which is the one assistant message without tool calls), every card of
 * that run (and of earlier runs) is redrawn as zero lines, so the transcript keeps the prompts and
 * the answers. Ctrl+H shows the hidden cards again.
 *
 * How it works:
 * - `registerToolRenderer` wraps every tool's renderers and switches the row to `renderShell: "self"`.
 *   That is the only shell that can draw nothing: `ToolExecutionComponent.render` returns `[]` for an
 *   empty self shell, while the default shell always draws its spacer and box.
 * - Tools that use the default shell are wrapped in the same box it used, so their visible rendering
 *   is byte-identical to before.
 * - Each row's renderer context hands out `invalidate()`, kept per tool call, so hidden rows repaint
 *   at once instead of waiting for their next update.
 * - A hidden thinking run draws the one-line label `hiddenThinkingLabel`; `session_start` sets it to
 *   an empty string, and `AssistantMessageComponent` then skips those runs completely.
 * - Hidden ids outlive a reload (only the repaint handles are dropped), so `/reload` does not bring
 *   the finished cards of the conversation back.
 *   an empty string, and `AssistantMessageComponent` then skips those runs completely.
 */
import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, type Component, type Theme } from "@earendil-works/pi-tui";

const ANSI = /\u001b\[[0-9;]*m/g;

interface RowState {
	/** The component the wrapped renderer returned last time, for its `lastComponent`. */
	call?: Component;
	result?: Component;
	/** The box a default-shell tool draws its call and result into, as the default shell does. */
	box?: Box;
	/** The row of a tool that has no renderers of its own. */
	row?: Text;
	rowArgs?: unknown;
}

type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

/** Text of a tool result, as `getTextOutput` produces it, minus image placeholders. */
function plainText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((item) => item && typeof item === "object" && item.type === "text")
		.map((item) => String(item.text ?? "").replace(ANSI, "").replace(/\r/g, ""))
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	/** Tool calls whose row is currently hidden. */
	const hidden = new Set<string>();
	/** Repaints one row, captured from its renderer context. */
	const invalidators = new Map<string, () => void>();

	const repaint = (ids: Iterable<string>) => {
		for (const id of ids) invalidators.get(id)?.();
	};

	const bgFor = (ctx: RenderContext) =>
		ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg";

	/** The box the default shell would draw, so a wrapped tool looks unchanged while visible. */
	const frame = (state: RowState, ctx: RenderContext, theme: Theme): Box => {
		const box = (state.box ??= new Box(1, 1));
		box.setBgFn((text) => theme.bg(bgFor(ctx), text));
		box.setPaddingX(ctx.outputPad);
		return box;
	};

	/**
	 * Renderers for a tool without renderers of its own: the same title, arguments, and output the
	 * default shell would draw, on one row that can also be hidden.
	 */
	const fallbackRenderers = (toolName: string): ToolRenderers => {
		const text = (state: RowState, args: unknown, result: unknown, theme: Theme): string => {
			let output = theme.fg("toolTitle", theme.bold(toolName));
			const argsText = args === undefined ? "" : JSON.stringify(args, null, 2);
			if (argsText) output += `\n\n${argsText}`;
			const resultText = plainText((result as { content?: unknown } | undefined)?.content);
			if (resultText) output += `\n${resultText}`;
			return output;
		};
		return {
			renderShell: "self",
			renderCall(args, theme, ctx) {
				invalidators.set(ctx.toolCallId, ctx.invalidate);
				if (hidden.has(ctx.toolCallId)) return new Container();
				const state = ctx.state as RowState;
				state.rowArgs = args;
				const row = (state.row ??= new Text("", 0, 1));
				row.setPaddingX(ctx.outputPad);
				row.setCustomBgFn((value) => theme.bg(bgFor(ctx), value));
				row.setText(text(state, args, undefined, theme));
				return row;
			},
			renderResult(result, _options, theme, ctx) {
				invalidators.set(ctx.toolCallId, ctx.invalidate);
				if (hidden.has(ctx.toolCallId)) return new Container();
				const state = ctx.state as RowState;
				state.row?.setText(text(state, state.rowArgs, result, theme));
				// The call slot already returned the row; a second copy would draw it twice.
				return new Container();
			},
		};
	};

	const wrap = (toolName: string, built: ToolRenderers | undefined): ToolRenderers => {
		if (!built?.renderCall) return fallbackRenderers(toolName);
		const selfShell = built.renderShell === "self";
		const call = built.renderCall;
		const result = built.renderResult;

		return {
			renderShell: "self",
			renderCall(args, theme, ctx) {
				invalidators.set(ctx.toolCallId, ctx.invalidate);
				if (hidden.has(ctx.toolCallId)) return new Container();
				const state = ctx.state as RowState;
				// The wrapped renderer must see its own component as `lastComponent`, not our box.
				const component = call(args, theme, { ...ctx, lastComponent: state.call });
				state.call = component;
				if (selfShell) return component;
				const box = frame(state, ctx, theme);
				box.clear();
				box.addChild(component);
				return box;
			},
			renderResult(result_, options, theme, ctx) {
				invalidators.set(ctx.toolCallId, ctx.invalidate);
				if (hidden.has(ctx.toolCallId)) return new Container();
				const state = ctx.state as RowState;
				const inner = result?.(result_, options, theme, { ...ctx, lastComponent: state.result });
				if (selfShell) return inner ?? new Container();
				const box = frame(state, ctx, theme);
				if (inner) {
					state.result = inner;
					box.addChild(inner);
				}
				// The call slot already returned the box; a second copy would draw the row twice.
				return new Container();
			},
		};
	};

	pi.registerToolRenderer((toolName, next) => wrap(toolName, next()));

	/** A finished run is history: only its prompts and answers stay on screen. */
	const hideFinished = () => {
		const ids = [...invalidators.keys()].filter((id) => !hidden.has(id));
		if (ids.length === 0) return;
		for (const id of ids) hidden.add(id);
		repaint(ids);
	};

	// Hide on every signal that a run is over: `agent_end` (an LLM run ended), `agent_settled` (nothing
	// queued, retried or compacting any more) and its final answer (the one assistant message that asks
	// for no tools). Hiding twice is free; not hiding is visible.
	pi.on("agent_end", () => {
		hideFinished();
		// `agent_end` is emitted before the UI applies the run's last row update, so hide once more.
		setTimeout(hideFinished, 0);
	});
	pi.on("agent_settled", hideFinished);
	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; content?: unknown };
		if (message.role !== "assistant") return;
		const asksForTools =
			Array.isArray(message.content) &&
			message.content.some((block) => (block as { type?: string })?.type === "toolCall");
		if (!asksForTools) hideFinished();
	});

	pi.on("session_start", (_event, ctx) => {
		// Only the repaint handles die with a reload: keeping the hidden ids keeps the finished cards
		// of the restored conversation hidden instead of showing them again.
		invalidators.clear();
		// Hidden thinking runs still draw a one-line label ("Thinking..."); an empty label makes
		// `AssistantMessageComponent` skip them entirely, spacing included. Visible thinking (Ctrl+T)
		// is unaffected, and so is a session that does not hide thinking blocks.
		ctx.ui.setHiddenThinkingLabel("");
	});

	pi.registerShortcut("ctrl+h", {
		description: "Show or hide finished tool calls",
		handler: async (ctx) => {
			const show = hidden.size > 0;
			const ids = show ? [...hidden] : [...invalidators.keys()];
			if (ids.length === 0) {
				ctx.ui.notify("No tool calls to show or hide yet.", "info");
				return;
			}
			for (const id of ids) {
				if (show) hidden.delete(id);
				else hidden.add(id);
			}
			repaint(ids);
			ctx.ui.notify(`Tool calls: ${show ? "shown" : "hidden"}`, "info");
		},
	});
}

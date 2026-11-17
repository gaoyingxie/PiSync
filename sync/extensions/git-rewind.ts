/**
 * Git Rewind Extension
 *
 * Saves a git checkpoint of the working tree before each agent run, so /tree navigation
 * (double Esc) and /fork can also restore the code state that belonged to a past message -
 * the code half of Claude Code's rewind.
 *
 * Checkpoints are tree refs under refs/pi/rewind/<entryId>, keyed by session entry id, so
 * they survive restarts, /resume and /fork. They never touch HEAD, the real index or the
 * stash list, and they are only pushed when a refspec asks for refs/pi/rewind/*.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REF_PREFIX = "refs/pi/rewind/";
const GIT_TIMEOUT_MS = 60_000;

/**
 * Pi's own scratch directory. It is untracked in most projects and keeps changing while the
 * agent runs, so checkpointing it would bloat snapshots and rewinding would delete live files.
 */
const SCRATCH_PATHSPEC = ":(exclude).pi";

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run git without a shell, with an optional temporary index file. */
function git(cwd: string, args: string[], indexFile?: string): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{
				cwd,
				env: indexFile ? { ...process.env, GIT_INDEX_FILE: indexFile } : process.env,
				timeout: GIT_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				const code =
					error === null
						? 0
						: typeof (error as { code?: unknown }).code === "number"
							? ((error as { code: unknown }).code as number)
							: 1;
				resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
			},
		);
	});
}

/** A temporary index path that does not exist yet; git rejects an empty existing file. */
async function newIndexFile(): Promise<string> {
	const dir = join(tmpdir(), "pi-rewind");
	await mkdir(dir, { recursive: true });
	return join(dir, `${randomUUID()}.index`);
}

export async function findRepoRoot(cwd: string): Promise<string | undefined> {
	const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
	if (result.code !== 0) return undefined;
	const root = result.stdout.trim();
	return root.length > 0 ? root : undefined;
}

/**
 * Stage the current working tree into a temporary index and hand its tree id to `use`.
 * Tracked and untracked files are included; ignored files and pi's scratch dir are not.
 */
async function withCurrentTree<T>(
	root: string,
	use: (tree: string, indexFile: string) => Promise<T>,
): Promise<T | undefined> {
	const indexFile = await newIndexFile();
	try {
		const add = await git(root, ["add", "-A", "--", ".", SCRATCH_PATHSPEC], indexFile);
		if (add.code !== 0) return undefined;
		const write = await git(root, ["write-tree"], indexFile);
		if (write.code !== 0) return undefined;
		const tree = write.stdout.trim();
		if (tree.length === 0) return undefined;
		return await use(tree, indexFile);
	} finally {
		await rm(indexFile, { force: true });
	}
}

export function snapshotTree(root: string): Promise<string | undefined> {
	return withCurrentTree(root, async (tree) => tree);
}

/**
 * Restore the working tree to a snapshot tree. Files whose content differs are rewritten,
 * files deleted since the snapshot come back, and files created since then are removed.
 * Ignored files and pi's scratch dir are left untouched.
 */
export function restoreTree(root: string, tree: string): Promise<string | undefined> {
	return withCurrentTree(root, async (_current, indexFile) => {
		const read = await git(root, ["read-tree", "-u", "-m", tree], indexFile);
		return read.code === 0 ? undefined : read.stderr.trim() || "git read-tree failed";
	});
}

/** Map of session entry id -> snapshot tree for every checkpoint in this repository. */
export async function listCheckpoints(root: string): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	const result = await git(root, ["for-each-ref", "--format=%(refname) %(objectname)", REF_PREFIX]);
	if (result.code !== 0) return map;
	for (const line of result.stdout.split("\n")) {
		const [refname, tree] = line.trim().split(" ");
		if (!refname || !tree) continue;
		map.set(refname.slice(REF_PREFIX.length), tree);
	}
	return map;
}

export async function saveCheckpoint(root: string, entryId: string, tree: string): Promise<boolean> {
	const result = await git(root, ["update-ref", `${REF_PREFIX}${entryId}`, tree]);
	return result.code === 0;
}

export default function (pi: ExtensionAPI) {
	const roots = new Map<string, string | null>();
	const checkpoints = new Map<string, Map<string, string>>();

	async function rootOf(cwd: string): Promise<string | undefined> {
		const cached = roots.get(cwd);
		if (cached !== undefined) return cached ?? undefined;
		const root = await findRepoRoot(cwd);
		roots.set(cwd, root ?? null);
		return root;
	}

	async function checkpointsOf(root: string): Promise<Map<string, string>> {
		const cached = checkpoints.get(root);
		if (cached) return cached;
		const map = await listCheckpoints(root);
		checkpoints.set(root, map);
		return map;
	}

	/** Nearest checkpoint at or above an entry in the session tree. */
	async function findCheckpoint(
		ctx: ExtensionContext,
		startId: string,
	): Promise<{ root: string; tree: string } | undefined> {
		const root = await rootOf(ctx.cwd);
		if (!root) return undefined;
		const map = await checkpointsOf(root);
		if (map.size === 0) return undefined;
		let id: string | null | undefined = startId;
		for (let hops = 0; id && hops < 2000; hops++) {
			const tree = map.get(id);
			if (tree) return { root, tree };
			id = ctx.sessionManager.getEntry(id)?.parentId;
		}
		return undefined;
	}

	// A run's checkpoint has to be taken before the model touches the tree but keyed by the
	// user message entry, which does not exist yet when the message ends (pi persists it right
	// after). So snapshot on message_end and bind it to the entry that shows up as the leaf when
	// the assistant reply starts.
	let pending: { root: string; tree: string } | undefined;

	pi.on("session_start", async () => {
		pending = undefined;
	});

	pi.on("message_end", async (event, ctx) => {
		pending = undefined;
		if (event.message.role !== "user") return;
		const root = await rootOf(ctx.cwd);
		if (!root) return;
		const tree = await snapshotTree(root);
		if (tree) pending = { root, tree };
	});

	pi.on("message_start", async (event, ctx) => {
		if (!pending || event.message.role !== "assistant") return;
		const leaf = ctx.sessionManager.getLeafEntry();
		const { root, tree } = pending;
		pending = undefined;
		if (!leaf || leaf.type !== "message" || leaf.message.role !== "user") return;
		const map = await checkpointsOf(root);
		if (map.has(leaf.id)) return;
		if (await saveCheckpoint(root, leaf.id, tree)) map.set(leaf.id, tree);
	});

	// Same three actions as Claude Code's Esc Esc rewind menu. Returning { cancel: true } is how
	// "code only" keeps the conversation where it is.
	async function offerRestore(
		ctx: ExtensionContext,
		entryId: string,
		action: string,
	): Promise<{ cancel?: boolean } | undefined> {
		const checkpoint = await findCheckpoint(ctx, entryId);
		if (!checkpoint || !ctx.hasUI) return;

		// Nothing on disk differs from that point, so there is no code decision to make.
		const current = await snapshotTree(checkpoint.root);
		if (!current || current === checkpoint.tree) return;

		const both = "对话和代码一起回退";
		const codeOnly = "只回退代码，保留对话";
		const choice = await ctx.ui.select(
			`回退到该时间点？（${action}）之后新建的文件会被删除；.gitignore 与 .pi 内的文件保持不变。`,
			[both, "只回退对话，保留当前代码", codeOnly],
		);
		if (!choice || choice === "只回退对话，保留当前代码") return;

		const error = await restoreTree(checkpoint.root, checkpoint.tree);
		if (error) {
			ctx.ui.notify(`代码回退失败：${error.split(/\r?\n/)[0]}`, "error");
			return;
		}
		ctx.ui.notify("代码已恢复到该时间点", "info");
		return choice === codeOnly ? { cancel: true } : undefined;
	}

	pi.on("session_before_tree", async (event, ctx) =>
		offerRestore(ctx, event.preparation.targetId, "回退到这条消息"),
	);

	pi.on("session_before_fork", async (event, ctx) =>
		offerRestore(ctx, event.entryId, "从这条消息分叉"),
	);
}

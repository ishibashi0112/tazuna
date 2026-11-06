/**
 * tazuna commit — まだコミットしていない適用で tazuna が書いたファイルだけを、changes.md の概要を
 * メッセージにしてコミットする。config の git.commitEachApply では次の適用の前に自動で行う分を、バッチの最後に
 * 締めるときに使う。設定なしで当て続けたときは、前回のコミットの後に当てた分をまとめて 1 コミットにする (v0.25.0)。
 * -m で件名だけを替えられる。push はしない。フックは動かさない (infra/git.ts の commitPaths)
 */
import { parseArgs } from "node:util";
import { TOOL_NAME } from "../brand.ts";
import { loadConfig } from "../infra/config.ts";
import { findProjectRoot } from "../infra/root.ts";
import { err, out } from "../infra/term.ts";
import { withSubject } from "../core/commit-message.ts";
import { commitPending, lookupPendingCommit, shortSha } from "./commit-apply.ts";

export async function commitCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      message: { type: "string", short: "m" },
    },
    allowPositionals: false,
  });
  const root = findProjectRoot(process.cwd(), values.root);
  loadConfig(root); // 設定エラーの早期検出のみ

  const lookup = lookupPendingCommit(root, { requireSameHead: false });
  if (lookup.kind === "none") {
    out("コミットしていない適用はありません (直近の適用はコミット済みか、巻き戻し済みです)");
    return 0;
  }
  if (lookup.kind === "skip") {
    err(`${TOOL_NAME}: ${lookup.reason}`);
    return 1;
  }
  let pending = lookup.pending;
  if (values.message !== undefined) {
    const replaced = withSubject(pending, values.message);
    if (replaced === null) {
      err(`${TOOL_NAME}: -m の件名が空です`);
      return 1;
    }
    pending = { ...pending, ...replaced };
  }
  if (values["dry-run"]) {
    out(`dry-run: ${pending.label}の ${pending.paths.length} ファイルを、次のメッセージでコミットします (コミットはしていません)`);
    if (pending.ids.length > 1) {
      for (const [i, id] of pending.ids.entries()) out(`  ${id}  ${pending.subjects[i] ?? ""}`);
    }
    out("");
    for (const line of pending.message.trimEnd().split("\n")) out(`  ${line}`);
    out("");
    for (const p of pending.paths) out(`  ${p}`);
    return 0;
  }
  const result = commitPending(root, pending, new Date());
  switch (result.kind) {
    case "committed":
      out(`コミットしました: ${shortSha(result.sha)} ${pending.subject} (${pending.label}・${result.files.length} ファイル)`);
      for (const p of result.files) out(`  ${p}`);
      out("push はしていません。共有するときはご自身で push してください");
      return 0;
    case "nothing":
      out(`${pending.label}のファイルには、コミットする変更がありません (コミット済みか、元に戻されています)`);
      return 0;
    case "not-repo":
      err(`${TOOL_NAME}: コミットできません: ${result.message}`);
      return 1;
    case "failed":
      err(`${TOOL_NAME}: コミットできませんでした:`);
      for (const line of result.message.split("\n")) err(`  ${line}`);
      return 1;
  }
}

/**
 * 1 回の適用 = 1 コミット (config の git.commitEachApply と tazuna commit)。
 *
 * 適用の直後にはコミットせず、次の changes.md を当てる直前に前回の分をコミットする。git diff には常に
 * 「最後に当てた分と、その後の手修正」だけが出るので、git diff で確かめてからビルドする流れが変わらない。
 * バッチの最後の 1 回は tazuna commit で締める。
 *
 * コミットするのは前回の適用で tazuna が書いたファイルだけ (手で変えたほかのファイル・ステージ済みの変更は
 * 入れない)。メッセージは changes.md の概要から作る (core/commit-message.ts)。push はしない。
 * 設定なしで当て続けたときの tazuna commit は、前回のコミットの後に当てた分をまとめて 1 コミットにする (v0.25.0)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invalidPathReason } from "../core/applier.ts";
import { buildBatchCommitMessage, buildCommitMessage, type CommitEntry } from "../core/commit-message.ts";
import { parseChangesRecovering } from "../core/parser.ts";
import { changedPathKeys, commitPaths, gitHeadCommit, type GitCommitResult } from "../infra/git.ts";
import { findUncommittedApplies, historyRoot, markCommitted } from "../infra/history.ts";

export interface PendingCommit {
  /** まとめてコミットする適用の履歴 ID (古い順) */
  ids: string[];
  /** 表示用 (「履歴 X」または「履歴 X〜Y の N 回分」) */
  label: string;
  /** コミットするファイル (各回で書いたもの。ルート相対・重複なし) */
  paths: string[];
  subject: string;
  message: string;
  /** 各回の件名 (古い順。dry-run の表示用) */
  subjects: string[];
  /** 含めなかった回 (書いたファイルがどれも HEAD と同じ = git で元に戻した。古い順) */
  dropped: string[];
}

export type PendingLookup =
  | { kind: "none" }
  | { kind: "pending"; pending: PendingCommit }
  /** 前回の適用はあるが、コミットしない (理由つき) */
  | { kind: "skip"; id: string; reason: string };

/** 保存済みの changes.md の概要 (読めなければ空。件名は既定の文になる) */
function savedSummary(root: string, id: string): string {
  try {
    const text = readFileSync(join(historyRoot(root), id, "changes.md"), "utf8").replace(/^\uFEFF/, "");
    return parseChangesRecovering(text).changeSet.header;
  } catch {
    return "";
  }
}

const labelOf = (ids: readonly string[]): string =>
  ids.length === 1 ? `履歴 ${ids[0]}` : `履歴 ${ids[0]}〜${ids[ids.length - 1]} の ${ids.length} 回分`;

/**
 * コミットしていない適用 (前回のコミットの後に、同じコミットの上で当てたもの。infra/history.ts の findUncommittedApplies)。
 * 2 回以上あれば 1 つのコミットにまとめる (設定なしで当て続けて、区切りで tazuna commit したとき)。
 * そのうち、書いたファイルがどれも HEAD と同じ回 (git で元に戻した) は含めない (件名・本文・トレーラーにも)。
 * @param requireSameHead 次の適用の前の自動コミットでは true: 直近の適用のときから HEAD が動いていれば、
 *   利用者が自分でコミットした (または ブランチを切り替えた) とみなしてコミットしない。tazuna commit は false
 */
export function lookupPendingCommit(root: string, options: { requireSameHead: boolean }): PendingLookup {
  const found = findUncommittedApplies(root);
  const newest = found[found.length - 1];
  if (newest === undefined) return { kind: "none" };
  const applies: Array<{ id: string; paths: string[] }> = [];
  for (const { id, manifest } of found) {
    const paths: string[] = [];
    for (const f of manifest.files) {
      if (f?.applied !== true) continue;
      // manifest は非信頼入力。apply と同じパスの検証を通らないものがあればコミットしない
      if (typeof f.path !== "string" || invalidPathReason(f.path) !== null) {
        return { kind: "skip", id, reason: `履歴 ${id} の manifest に不正なパスがあるため、コミットしません` };
      }
      paths.push(f.path);
    }
    applies.push({ id, paths });
  }
  if (options.requireSameHead) {
    if (newest.manifest.gitHead === undefined) {
      return {
        kind: "skip",
        id: newest.id,
        reason: `履歴 ${newest.id} は適用したときの HEAD の記録がないため、自動ではコミットしません`,
      };
    }
    const head = gitHeadCommit(root);
    if (head !== undefined && head !== newest.manifest.gitHead) {
      return {
        kind: "skip",
        id: newest.id,
        reason: `履歴 ${newest.id} を当てた後にコミットが増えている (またはブランチが変わった) ため、前回の分はご自身でコミットしたものとみなします`,
      };
    }
  }
  // 書いたファイルがどれも HEAD と同じ回 (VS Code の「変更を破棄」や git checkout で元に戻した) は含めない。
  // 含めると、取り消した回の件名がコミットの件名になる。どの回も同じなら、そのまま (コミットするものはない)
  let used = applies;
  let dropped: string[] = [];
  if (applies.length > 1) {
    const changed = changedPathKeys(root, [...new Set(applies.flatMap((a) => a.paths))]);
    if (changed !== null) {
      const contributing = applies.filter((a) => a.paths.some((p) => changed.has(p.toLowerCase())));
      if (contributing.length > 0 && contributing.length < applies.length) {
        used = contributing;
        dropped = applies.filter((a) => !contributing.includes(a)).map((a) => a.id);
      }
    }
  }
  const ids = used.map((a) => a.id);
  const paths = [...new Set(used.flatMap((a) => a.paths))];
  const entries: CommitEntry[] = used.map((a) => ({
    header: savedSummary(root, a.id),
    historyId: a.id,
    fileCount: a.paths.length,
  }));
  const { subject, message } = buildBatchCommitMessage(entries);
  const subjects = entries.map((e) => buildCommitMessage(e.header, e.historyId, e.fileCount).subject);
  return { kind: "pending", pending: { ids, label: labelOf(ids), paths, subject, message, subjects, dropped } };
}

/** コミットし、できたら manifest に記録する */
export function commitPending(root: string, pending: PendingCommit, now: Date): GitCommitResult {
  const result = commitPaths(root, pending.paths, pending.message);
  if (result.kind === "committed") {
    for (const id of pending.ids) {
      try {
        markCommitted(root, id, result.sha, now);
      } catch {
        // 記録できなくても、次の自動コミットは HEAD が動いたことで見送られる (二重にコミットしない)
      }
    }
  }
  return result;
}

export const shortSha = (sha: string): string => (/^[0-9a-f]{7,64}$/.test(sha) ? sha.slice(0, 7) : "");

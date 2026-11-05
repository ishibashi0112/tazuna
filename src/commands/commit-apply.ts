/**
 * 1 回の適用 = 1 コミット (config の git.commitEachApply と tazuna commit)。
 *
 * 適用の直後にはコミットせず、次の changes.md を当てる直前に前回の分をコミットする。git diff には常に
 * 「最後に当てた分と、その後の手修正」だけが出るので、git diff で確かめてからビルドする流れが変わらない。
 * バッチの最後の 1 回は tazuna commit で締める。
 *
 * コミットするのは前回の適用で tazuna が書いたファイルだけ (手で変えたほかのファイル・ステージ済みの変更は
 * 入れない)。メッセージは changes.md の概要から作る (core/commit-message.ts)。push はしない。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invalidPathReason } from "../core/applier.ts";
import { buildCommitMessage } from "../core/commit-message.ts";
import { parseChangesRecovering } from "../core/parser.ts";
import { commitPaths, gitHeadCommit, type GitCommitResult } from "../infra/git.ts";
import { findUncommittedApply, historyRoot, markCommitted, type Manifest } from "../infra/history.ts";

export interface PendingCommit {
  id: string;
  /** コミットするファイル (前回の適用で書いたもの。ルート相対) */
  paths: string[];
  subject: string;
  message: string;
  manifest: Manifest;
}

export type PendingLookup =
  | { kind: "none" }
  | { kind: "pending"; pending: PendingCommit }
  /** 前回の適用はあるが、コミットしない (理由つき) */
  | { kind: "skip"; id: string; reason: string };

/** 保存済みの changes.md の概要 (読めなければ空。件名は既定の文になる) */
function savedSummary(root: string, id: string): string {
  try {
    const text = readFileSync(join(historyRoot(root), id, "changes.md"), "utf8").replace(/^﻿/, "");
    return parseChangesRecovering(text).changeSet.header;
  } catch {
    return "";
  }
}

/**
 * コミットしていない直近の適用。
 * @param requireSameHead 次の適用の前の自動コミットでは true: 適用したときから HEAD が動いていれば、
 *   利用者が自分でコミットした (または ブランチを切り替えた) とみなしてコミットしない。tazuna commit は false
 */
export function lookupPendingCommit(root: string, options: { requireSameHead: boolean }): PendingLookup {
  const found = findUncommittedApply(root);
  if (found === null) return { kind: "none" };
  const { id, manifest } = found;
  const paths: string[] = [];
  for (const f of manifest.files) {
    if (f?.applied !== true) continue;
    // manifest は非信頼入力。apply と同じパスの検証を通らないものがあればコミットしない
    if (typeof f.path !== "string" || invalidPathReason(f.path) !== null) {
      return { kind: "skip", id, reason: `履歴 ${id} の manifest に不正なパスがあるため、コミットしません` };
    }
    paths.push(f.path);
  }
  if (options.requireSameHead) {
    if (manifest.gitHead === undefined) {
      return { kind: "skip", id, reason: `履歴 ${id} は適用したときの HEAD の記録がないため、自動ではコミットしません` };
    }
    const head = gitHeadCommit(root);
    if (head !== undefined && head !== manifest.gitHead) {
      return {
        kind: "skip",
        id,
        reason: `履歴 ${id} を当てた後にコミットが増えている (またはブランチが変わった) ため、前回の分はご自身でコミットしたものとみなします`,
      };
    }
  }
  const { subject, message } = buildCommitMessage(savedSummary(root, id), id, paths.length);
  return { kind: "pending", pending: { id, paths, subject, message, manifest } };
}

/** コミットし、できたら manifest に記録する */
export function commitPending(root: string, pending: PendingCommit, now: Date): GitCommitResult {
  const result = commitPaths(root, pending.paths, pending.message);
  if (result.kind === "committed") {
    try {
      markCommitted(root, pending.id, result.sha, now);
    } catch {
      // 記録できなくても、次の自動コミットは HEAD が動いたことで見送られる (二重にコミットしない)
    }
  }
  return result;
}

export const shortSha = (sha: string): string => (/^[0-9a-f]{7,64}$/.test(sha) ? sha.slice(0, 7) : "");

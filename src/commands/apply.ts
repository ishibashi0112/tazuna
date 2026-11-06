/**
 * tazuna [path] — 適用コマンド (§4.1)。
 * 手順: パース → 全件ドライラン検証 → (失敗があれば何も書かずレポート) →
 * before 保存 → 書き換え → after 保存 → サマリ表示。
 */
import { INIT_COMMAND, TOOL_NAME } from "../brand.ts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  invalidPathReason,
  planChangeSet,
  type FileOutcome,
  type FileState,
  type NewFileResolver,
  type Plan,
} from "../core/applier.ts";
import { buildCommitMessage } from "../core/commit-message.ts";
import { countLineChanges } from "../core/diff.ts";
import { decodeFile } from "../core/encoding.ts";
import { changeSetFingerprint } from "../core/fingerprint.ts";
import { fileNameKey, looksLikeOtherRepository } from "../core/other-repo.ts";
import { PRESENCE_STAGE_LABEL } from "../core/matcher.ts";
import { fixedNewFile, resolveNewFileStyle } from "../core/new-file-style.ts";
import { parseChangesRecovering } from "../core/parser.ts";
import {
  buildBlankInsensitiveNote,
  buildMaskRestoreNote,
  buildSjisFoldNote,
  buildFailureReport,
  buildParseErrorReport,
} from "../core/report.ts";
import { readClipboard, writeClipboard } from "../infra/clipboard.ts";
import { loadConfig } from "../infra/config.ts";
import {
  findRecentChangesFiles,
  resolveDownloadsDir,
  type CandidateFile,
} from "../infra/downloads.ts";
import { deleteFile, isInsideRoot, readFileState, sha256, writeBytes } from "../infra/files.ts";
import { stateDir } from "../infra/history.ts";
import { gitDirtyFiles, gitHeadCommit, listGitFiles } from "../infra/git.ts";
import { collectStyleSampleGroups } from "../infra/new-file-style.ts";
import { err, out, outEmphasis } from "../infra/term.ts";
import {
  beginHistory,
  createHistoryId,
  findAppliedHistory,
  finishHistory,
  pruneHistory,
  type Manifest,
  type ManifestFileEntry,
} from "../infra/history.ts";
import { confirm } from "../infra/prompt.ts";
import { findProjectRoot } from "../infra/root.ts";
import { commitPending, lookupPendingCommit, shortSha, type PendingLookup } from "./commit-apply.ts";
import { formatVbprojPlan, planVbprojRegistrations, type VbprojPlan } from "./vbproj-register.ts";

/** このファイルは書き込み対象か (適用済みのみのファイルは書き込み不要なので含めない) */
function isApplicable(o: FileOutcome): boolean {
  if (o.alreadyApplied || o.withheld === true) return false;
  if (o.change.op === "replace") return o.appliedBlocks.length > 0;
  return o.failures.length === 0;
}

function opLabel(o: FileOutcome): string {
  const c = o.change;
  if (c.op === "replace") {
    const already = o.alreadyAppliedBlocks.length;
    const detail =
      already > 0
        ? `適用 ${o.appliedBlocks.length} / 済み ${already} / 全 ${o.totalBlocks} ブロック`
        : `${o.appliedBlocks.length}/${o.totalBlocks} ブロック`;
    return `replace ${c.path} — ${detail}`;
  }
  const label = `${c.op.padEnd(7)} ${c.path}`;
  return o.alreadyApplied ? `${label} — 適用済み (スキップ)` : label;
}

/** バイト列の行 (書き込まない・無いファイルは空)。読めなければ null */
function textLines(bytes: Uint8Array | null | undefined): string[] | null {
  if (bytes === null || bytes === undefined) return [];
  try {
    return decodeFile(bytes).lines.map((l) => l.text);
  } catch {
    return null;
  }
}

/** 結果の一覧に添える増減の行数 (「 (+12 -3 行)」)。どちらかを読めない・差が大きすぎて数えられなければ付けない */
export function lineChangeLabel(before: Uint8Array | null | undefined, after: Uint8Array | null | undefined): string {
  const a = textLines(before);
  const b = textLines(after);
  if (a === null || b === null) return "";
  const counts = countLineChanges(a, b);
  return counts === null ? "" : ` (+${counts.added} -${counts.removed} 行)`;
}

function printPreview(outcomes: FileOutcome[]): void {
  for (const o of outcomes) {
    out(`  ${opLabel(o)}`);
    for (const b of o.appliedBlocks) {
      out(`    @@ ${o.change.path}:${b.start + 1} (${b.stage})`);
      for (const l of b.removed) out(`    - ${l}`);
      for (const l of b.inserted) out(`    + ${l}`);
    }
  }
}

/** 適用済みとしてスキップした内容の一覧 (冪等性)。該当がなければ何も出さない */
function printAlreadyApplied(outcomes: FileOutcome[]): void {
  const files = outcomes.filter((o) => o.alreadyApplied || o.alreadyAppliedBlocks.length > 0);
  if (files.length === 0) return;
  out("適用済みのためスキップ:");
  for (const o of files) {
    if (o.change.op !== "replace") {
      const why = o.change.op === "delete" ? "既に存在しません" : "現在の内容と一致";
      out(`  ${o.change.op.padEnd(7)} ${o.change.path} — ${why}`);
      continue;
    }
    for (const b of o.alreadyAppliedBlocks) {
      const what = b.insertion === true ? "追記する行が SEARCH の前後に既に存在" : "REPLACE が既に存在";
      out(
        `  replace ${o.change.path} — ブロック ${b.block.index}: ${what} (${PRESENCE_STAGE_LABEL[b.stage]})`,
      );
    }
  }
}

/** tazuna watch が検出したファイル (自動検出と同じ扱いで、成功後に履歴へ移動する・§4.7) */
export interface DetectedChanges {
  path: string;
  origin: "downloads" | "project-root";
}

/**
 * 適用 1 回の結果の種類 (tazuna watch が結果の通知と changes.md の片付けに使う・§4.7)
 * - applied: 書き込んだ / already-applied: すべて適用済みで書き込みなし / failed: 構文エラー・検証の失敗で何も書かない /
 *   duplicate: 適用済みの changes.md で、なお書き込みが起きるため止めた / other-repo: 別のリポジトリ向けらしく当てなかった
 *   (watch のみ) / commit-failed: 当てる前の前回の分のコミット (git.commitEachApply) に失敗したため当てなかった /
 *   dry-run / aborted: 確認で中止 / unreadable: 入力を読めない・見つからない
 */
export type ApplyOutcomeKind =
  | "applied"
  | "already-applied"
  | "failed"
  | "duplicate"
  | "other-repo"
  | "commit-failed"
  | "dry-run"
  | "aborted"
  | "unreadable";

export interface ApplyResult {
  /** 終了コード */
  code: number;
  kind: ApplyOutcomeKind;
  /** applied のとき書き込んだファイル数 (.vbproj への登録を除く) */
  files: number;
  /** 失敗レポートをクリップボードへコピーしたか */
  reportCopied: boolean;
}

export async function applyCommand(argv: string[], detected?: DetectedChanges): Promise<number> {
  return (await runApply(argv, detected)).code;
}

/** 適用の本体。applyCommand と tazuna watch が使う */
export async function runApply(argv: string[], detected?: DetectedChanges): Promise<ApplyResult> {
  let reportCopied = false;
  const done = (kind: ApplyOutcomeKind, code: number, files = 0): ApplyResult => ({
    code,
    kind,
    files,
    reportCopied,
  });
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
      partial: { type: "boolean", default: false },
      root: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      clip: { type: "boolean", default: false },
      "clip-report": { type: "boolean", default: false },
      // create した .vb / .cs の .vbproj / .csproj 自動登録を今回だけ無効化 (config vbproj.register の一時上書き)
      "no-vbproj": { type: "boolean", default: false },
      // 履歴で適用済みの changes.md でも再適用する (二重適用防止の解除・§6.1)
      force: { type: "boolean", default: false },
      // 元の値に戻せない [MASKED] をその文字のまま書く (伏せ字を扱うコードそのものを書く場合)
      "literal-masked": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const root = findProjectRoot(process.cwd(), values.root);
  const config = loadConfig(root);
  if (!existsSync(stateDir(root))) {
    out(`ヒント: 初回は \`${INIT_COMMAND}\` を実行すると設定の雛形と .gitignore などが整います`);
  }

  // レポートを標準出力へ出し、クリップボードにもコピーする (§7)。
  // 既定 (clipReportOnFailure: true) で自動コピーし、config で無効化できる。--clip-report は常に有効
  const emitReport = async (report: string): Promise<void> => {
    out(report);
    if (values["clip-report"] || config.clipReportOnFailure) {
      try {
        await writeClipboard(report);
        reportCopied = true;
        // 貼り返しを忘れないよう、コピー済みであることを最後に強調表示する
        const rule = "━".repeat(56);
        outEmphasis(rule);
        outEmphasis(" 失敗レポートをクリップボードにコピーしました ", true);
        outEmphasis("   → そのまま AI チャットに貼り付けて再依頼できます (Ctrl+V)");
        outEmphasis(rule);
      } catch (e) {
        err(`${TOOL_NAME}: クリップボードへのコピーに失敗: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  const stripBom = (s: string): string => s.replace(/^\uFEFF/, "");

  // 入力ソースの優先順位 (§4.1): 引数 > --clip > Downloads 自動検出
  let changesText: string;
  let source: Manifest["source"];
  const inputPath = positionals[0];
  if (detected !== undefined) {
    try {
      changesText = stripBom(readFileSync(detected.path, "utf8"));
    } catch {
      err(`${TOOL_NAME}: ファイルを読めません: ${detected.path}`);
      return done("unreadable", 1);
    }
    source = { type: detected.origin, path: detected.path };
  } else if (inputPath !== undefined) {
    const abs = resolve(process.cwd(), inputPath);
    try {
      changesText = stripBom(readFileSync(abs, "utf8"));
    } catch {
      err(`${TOOL_NAME}: ファイルを読めません: ${abs}`);
      return done("unreadable", 1);
    }
    source = { type: "file", path: abs };
  } else if (values.clip) {
    try {
      changesText = stripBom(await readClipboard());
    } catch (e) {
      err(`${TOOL_NAME}: クリップボードを読めません: ${e instanceof Error ? e.message : String(e)}`);
      return done("unreadable", 1);
    }
    if (changesText.trim() === "") {
      err(`${TOOL_NAME}: クリップボードが空です`);
      return done("unreadable", 1);
    }
    source = { type: "clipboard" };
  } else {
    // Downloads とプロジェクトルート直下の両方から候補を集め、最新を採用する
    const downloadsDir = await resolveDownloadsDir(config.downloadsDir);
    const now = new Date();
    const tagged: (CandidateFile & { origin: "downloads" | "project-root" })[] = [
      ...findRecentChangesFiles(downloadsDir, now).map((c) => ({ ...c, origin: "downloads" as const })),
      ...findRecentChangesFiles(root, now).map((c) => ({ ...c, origin: "project-root" as const })),
    ];
    const seen = new Set<string>();
    const candidates = tagged
      .filter((c) => !seen.has(c.path) && (seen.add(c.path), true))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    if (candidates.length === 0) {
      err(`${TOOL_NAME}: ${downloadsDir} にもプロジェクト直下にも直近 30 分以内の changes*.md が見つかりません`);
      err("  ファイルパスを指定するか、--clip でクリップボードから読み込んでください");
      return done("unreadable", 1);
    }
    const newest = candidates[0] as (typeof candidates)[number];
    out(`${newest.origin === "downloads" ? "Downloads" : "プロジェクト直下"}から検出: ${newest.path}`);
    if (candidates.length > 1) {
      out(`  (他 ${candidates.length - 1} 件の候補があります。最新を使用します)`);
      for (const c of candidates.slice(1)) out(`    - ${c.path}`);
      if (!values.yes && !(await confirm("このファイルを適用しますか?"))) {
        out("中止しました。");
        return done("aborted", 1);
      }
    }
    try {
      changesText = stripBom(readFileSync(newest.path, "utf8"));
    } catch {
      err(`${TOOL_NAME}: ファイルを読めません: ${newest.path}`);
      return done("unreadable", 1);
    }
    source = { type: newest.origin, path: newest.path };
  }

  // 1. パース (構文エラーは即時失敗・§4.1)。strict で失敗したら寛容パースを試す (§3.5)
  const { changeSet, issues, repairs } = parseChangesRecovering(changesText);
  if (issues.length > 0) {
    err(`${TOOL_NAME}: changes.md の構文エラーです。何も書き込んでいません。\n`);
    await emitReport(buildParseErrorReport(issues));
    return done("failed", 1);
  }
  if (repairs.length > 0) {
    out(`規約からの軽微な逸脱 ${repairs.length} 件を自動補正して解釈しました:`);
    for (const r of repairs) out(`  ${r.line} 行目: ${r.message}`);
    out("");
  }

  // 同じ changes.md を以前に適用していないか (取り違え・二重実行の検出・§6.1)。
  // 旧形式の履歴は保存済みの changes.md 原本をパースして指紋を算出する
  const fingerprint = changeSetFingerprint(changeSet);
  const previousId = findAppliedHistory(root, fingerprint, (text) => {
    const r = parseChangesRecovering(stripBom(text));
    return r.issues.length > 0 ? null : changeSetFingerprint(r.changeSet);
  });
  const previousNote =
    previousId !== null ? `この changes.md は適用済みです (履歴 ID: ${previousId})` : null;

  // 2. 全ブロックのドライラン検証
  const states = new Map<string, FileState>();
  for (const f of changeSet.files) {
    if (invalidPathReason(f.path) !== null) {
      states.set(f.path, { exists: false, symlink: false, bytes: null });
      continue;
    }
    const abs = join(root, f.path);
    // symlink ディレクトリ経由でルート外に出るパスは検証段階で失敗させる (§9)
    if (!isInsideRoot(root, abs)) {
      states.set(f.path, { exists: false, symlink: false, bytes: null, escapesRoot: true });
      continue;
    }
    states.set(f.path, readFileState(abs));
  }
  // 新規ファイルの形式: encoding "auto" なら作成先の既存ファイルから推定する (設計書 §11.2)
  const newFileBasis = new Map<string, string>();
  const resolveNewFile: NewFileResolver = (change) => {
    if (config.newFile.encoding !== "auto" || change.op !== "create") {
      return fixedNewFile(config.newFile);
    }
    // 不正パス・symlink 経由でルート外を指すパスは手本を探さない (検証段階で失敗する)
    if (invalidPathReason(change.path) !== null || states.get(change.path)?.escapesRoot === true) {
      return fixedNewFile(config.newFile);
    }
    const r = resolveNewFileStyle(
      change.path,
      config.newFile,
      collectStyleSampleGroups(root, change.path),
    );
    if (r.basis !== null) newFileBasis.set(change.path, r.basis);
    return r.config;
  };
  const plan: Plan = planChangeSet(changeSet, states, resolveNewFile, {
    literalMasked: values["literal-masked"],
  });
  // --literal-masked の案内は端末にだけ出す (AI に貼るレポートには書かない。実際の値を伏せた行にまで
  // 指定を勧めさせないため)
  const literalHint = (): void => {
    const masked = plan.failures.filter((f) => f.kind === "masked-value");
    if (masked.some((f) => f.literalRefused === true)) {
      err(
        "注: 実際の値を伏せた [MASKED] の行を変える・移す変更のため、--literal-masked は使いませんでした " +
          "(実際の値を [MASKED] の文字で置き換えないため)\n",
      );
    }
    // 指定すれば本当に書けるときだけ案内する (指定しても使われない変更に勧めない)
    const literalWorks = (): boolean =>
      !planChangeSet(changeSet, states, resolveNewFile, { literalMasked: true }).failures.some(
        (f) => f.kind === "masked-value",
      );
    // tazuna watch は --literal-masked を受け付けないため案内しない
    const canSpecify = detected === undefined && values["literal-masked"] !== true;
    if (canSpecify && masked.some((f) => f.literalAllowed === true) && literalWorks()) {
      err(
        "注: [MASKED] という文字そのものを書く変更 (伏せ字を扱うコード) なら、--literal-masked を付けると" +
          "そのまま書き込めます。実際の値を伏せた行には使わないでください\n",
      );
    }
  };

  // 対象のファイルがどれもこのリポジトリに無い = 別のリポジトリ向けらしい (§4.7)。watch では当てずに残し
  // (失敗レポートでクリップボードを上書きしない。正しいリポジトリの watch が当てる)、手で実行したときは注記する
  // 失敗が「対象のファイルが無い」だけのときに限る (パスの誤り・symlink などはレポートが要る)
  const otherRepository =
    !plan.ok &&
    plan.failures.length > 0 &&
    plan.failures.every((f) => f.kind === "target-missing") &&
    looksLikeOtherRepository(
      changeSet.files,
      (path) => states.get(path)?.exists === true,
      () => repositoryFileNames(root),
    );
  if (otherRepository && detected !== undefined) {
    out(`changes.md の対象 (どれもこのリポジトリ ${root} にありません):`);
    for (const f of changeSet.files) out(`  ${f.op.padEnd(7)} ${f.path}`);
    return done("other-repo", 1);
  }

  // 3. 失敗があれば何も書き込まずレポート (§4.1, §7)
  if (!plan.ok && !values.partial) {
    err(`${TOOL_NAME}: 検証に失敗しました (${plan.failures.length} 件)。何も書き込んでいません。\n`);
    if (otherRepository) {
      err(`注: 対象のファイルがどれもこのリポジトリ (${root}) にありません。別のリポジトリ向けの changes.md ではないか確認してください\n`);
    }
    if (previousNote !== null) err(`注: ${previousNote}。取り違えていないか確認してください\n`);
    literalHint();
    await emitReport(
      buildFailureReport(plan.failures, { outcomes: plan.outcomes, nothingWritten: true }),
    );
    return done("failed", 1);
  }
  const applicable = plan.outcomes.filter(isApplicable);
  // create した .vb / .cs の旧スタイル .vbproj / .csproj への登録計画 (設計書 §11.1)。失敗しても create は成功扱い
  const vbprojEnabled = config.vbproj.register && !values["no-vbproj"];
  const vbprojPlan: VbprojPlan = vbprojEnabled
    ? planVbprojRegistrations(root, applicable)
    : { writes: new Map(), registrations: [], notes: [] };
  const printExtras = (): void => {
    for (const o of applicable) {
      const basis = newFileBasis.get(o.change.path);
      if (basis !== undefined) out(`  新規ファイルの形式: ${o.change.path} → ${basis}`);
    }
    for (const line of formatVbprojPlan(vbprojPlan)) out(line);
  };
  if (applicable.length === 0) {
    // 冪等性: 全変更が適用済みなら成功として終了 (書き込み・履歴なし)
    if (plan.ok && plan.outcomes.some((o) => o.alreadyApplied)) {
      out("すべての変更は適用済みです。書き込みは行いませんでした。");
      if (previousNote !== null) out(`  (${previousNote})`);
      for (const o of plan.outcomes) out(`  ${opLabel(o)}`);
      return done("already-applied", 0);
    }
    err(`${TOOL_NAME}: 適用できる変更がありません。\n`);
    literalHint();
    await emitReport(
      buildFailureReport(plan.failures, { outcomes: plan.outcomes, nothingWritten: true }),
    );
    return done("failed", 1);
  }
  // 適用済みの changes.md で、なお書き込みが発生する = 二重適用のおそれ。--force なしでは止める
  if (previousNote !== null) {
    if (values.force) {
      out(`--force: ${previousNote}。再適用します`);
    } else if (values["dry-run"]) {
      out(`警告: ${previousNote}。実際の適用は --force を付けない限り止まります`);
    } else {
      err(`${TOOL_NAME}: ${previousNote}。何も書き込んでいません。`);
      err("  このまま適用すると次のファイルに書き込みが発生します (二重適用のおそれ):");
      for (const o of applicable) err(`    ${opLabel(o)}`);
      // tazuna watch は当て直すコマンドを結果の行で示す (移した先のパスで)
      if (detected === undefined) {
        err("  取り違えでなければ --force を付けて再実行してください");
        err(`  (${TOOL_NAME} undo で巻き戻した履歴は対象外です。git 等で手動で戻した場合は --force が必要です)`);
      }
      return done("duplicate", 1);
    }
  }
  // 1 回の適用 = 1 コミット (config git.commitEachApply): 当てる直前に前回の適用の分をコミットする
  const commitLookup: PendingLookup | null = config.git.commitEachApply
    ? lookupPendingCommit(root, { requireSameHead: true })
    : null;
  const printCommitPlan = (): void => {
    if (commitLookup === null || commitLookup.kind === "none") return;
    if (commitLookup.kind === "skip") {
      out(`コミット: ${commitLookup.reason}`);
      return;
    }
    const p = commitLookup.pending;
    out(`コミット: 当てる前に、前回の適用 (${p.label}・${p.paths.length} ファイル) を「${p.subject}」でコミットします`);
  };

  if (values["dry-run"]) {
    out(`dry-run: 適用予定 ${applicable.length} ファイル (書き込みなし)`);
    printPreview(applicable);
    printExtras();
    printCommitPlan();
    printAlreadyApplied(plan.outcomes);
    const dryRunNote = buildBlankInsensitiveNote(plan.outcomes);
    if (dryRunNote !== null) out(dryRunNote);
    const dryRunMaskNote = buildMaskRestoreNote(plan.outcomes, false);
    if (dryRunMaskNote !== null) out(dryRunMaskNote);
    const dryRunSjisNote = buildSjisFoldNote(plan.outcomes, false);
    if (dryRunSjisNote !== null) out(dryRunSjisNote);
    if (plan.failures.length > 0) {
      out("");
      await emitReport(
        buildFailureReport(plan.failures, { outcomes: plan.outcomes, nothingWritten: true }),
      );
    }
    return done("dry-run", 0);
  }

  // 確認 (§4.1, §9)
  out(`プロジェクトルート: ${root}`);
  out(`適用予定 ${applicable.length} ファイル:`);
  for (const o of applicable) out(`  ${opLabel(o)}`);
  printExtras();
  printAlreadyApplied(plan.outcomes);
  if (plan.failures.length > 0) {
    out(`  (検証失敗 ${plan.failures.length} 件は --partial によりスキップ)`);
  }
  printCommitPlan();
  const dirty = await gitDirtyFiles(root);
  if (dirty !== null && dirty.length > 0) {
    out(`警告: Git 作業ツリーに未コミットの変更が ${dirty.length} 件あります`);
  }
  if (!values.yes) {
    if (!(await confirm("適用しますか?"))) {
      out("中止しました。");
      return done("aborted", 1);
    }
  }

  if (commitLookup?.kind === "pending") {
    const p = commitLookup.pending;
    const r = commitPending(root, p, new Date());
    if (r.kind === "committed") {
      out(`前回の適用 (${p.label}) をコミットしました: ${shortSha(r.sha)} ${p.subject}`);
    } else if (r.kind === "nothing") {
      out(`前回の適用 (${p.label}) のファイルには変更が無いため、コミットしませんでした`);
    } else if (r.kind === "not-repo") {
      err(`${TOOL_NAME}: 前回の適用をコミットできません (${r.message})。コミットせずに当てます`);
    } else {
      // 1 回 1 コミットを崩さないよう、前回の分をコミットできないうちは次を当てない
      err(`${TOOL_NAME}: 前回の適用 (${p.label}) をコミットできなかったため、この changes.md は当てていません:`);
      for (const line of r.message.split("\n")) err(`  ${line}`);
      err(`  git の問題を直してから、もう一度当ててください (前回の分だけを先にコミットするなら ${TOOL_NAME} commit)`);
      return done("commit-failed", 1);
    }
  }

  // 4. before 保存 → 書き換え → after 保存 (§4.1 手順 4, §5)
  const id = createHistoryId(root, new Date());
  const before = new Map<string, Uint8Array | null>();
  for (const o of applicable) {
    before.set(o.change.path, states.get(o.change.path)?.bytes ?? null);
  }
  // .vbproj 登録も履歴・undo の対象。changes.md の変更対象でもある .vbproj は元の before を保つ
  for (const [path, w] of vbprojPlan.writes) {
    if (!before.has(path)) before.set(path, w.before);
  }
  beginHistory(root, id, changesText, before);

  const after = new Map<string, Uint8Array | null>();
  for (const o of applicable) {
    const abs = join(root, o.change.path);
    if (o.change.op === "delete") {
      deleteFile(abs);
      after.set(o.change.path, null);
    } else {
      // 同じ .vbproj への登録があれば登録後の内容 (変更後に登録を重ねたもの) を書く
      const bytes = vbprojPlan.writes.get(o.change.path)?.after ?? (o.afterBytes as Uint8Array);
      writeBytes(abs, bytes);
      after.set(o.change.path, bytes);
    }
  }
  for (const [path, w] of vbprojPlan.writes) {
    if (after.has(path)) continue;
    writeBytes(join(root, path), w.after);
    after.set(path, w.after);
  }

  const entries: ManifestFileEntry[] = plan.outcomes.map((o) => {
    const applied = isApplicable(o);
    const beforeBytes = states.get(o.change.path)?.bytes ?? null;
    const afterBytes = applied ? (after.get(o.change.path) ?? null) : null;
    const skipped = o.failures
      .filter((f) => f.block !== undefined)
      .map((f) => ({ index: (f.block as { index: number }).index, reason: f.message }));
    const entry: ManifestFileEntry = {
      path: o.change.path,
      op: o.change.op,
      applied,
      blocks: o.totalBlocks,
      appliedBlocks: o.appliedBlocks.length,
      beforeSha256: beforeBytes !== null ? sha256(beforeBytes) : null,
      afterSha256: afterBytes !== null ? sha256(afterBytes) : null,
    };
    if (skipped.length > 0) entry.skippedBlocks = skipped;
    if (o.alreadyAppliedBlocks.length > 0) {
      entry.alreadyAppliedBlocks = o.alreadyAppliedBlocks.map((b) => b.block.index);
    }
    if (o.alreadyApplied) entry.alreadyApplied = true;
    const registered = vbprojPlan.writes.get(o.change.path)?.registered;
    if (registered !== undefined) entry.registered = registered;
    return entry;
  });
  for (const [path, w] of vbprojPlan.writes) {
    if (entries.some((e) => e.path === path)) continue;
    entries.push({
      path,
      op: "vbproj",
      applied: true,
      blocks: 0,
      appliedBlocks: 0,
      registered: w.registered,
      beforeSha256: w.before !== null ? sha256(w.before) : null,
      afterSha256: sha256(w.after),
    });
  }
  // 適用したときの HEAD (次の適用の前の自動コミットで、その間に利用者がコミットしたかを見分ける)
  const gitHead = gitHeadCommit(root);
  const manifest: Manifest = {
    id,
    appliedAt: new Date().toISOString(),
    success: plan.ok,
    partial: values.partial,
    source,
    changesFingerprint: fingerprint,
    ...(gitHead !== undefined ? { gitHead } : {}),
    files: entries,
  };
  finishHistory(root, id, manifest, after);
  const pruned = pruneHistory(root, config.historyLimit);
  if (pruned.length > 0) {
    out(`古い履歴 ${pruned.length} 件を削除しました (historyLimit: ${config.historyLimit})`);
  }

  // 5. サマリ (§4.1 手順 5)
  out("");
  out(`適用しました (履歴 ID: ${id})`);
  for (const o of applicable) {
    const path = o.change.path;
    out(`  ${opLabel(o)}${lineChangeLabel(states.get(path)?.bytes, after.get(path))}`);
  }
  printExtras();
  printAlreadyApplied(plan.outcomes);
  const appliedNote = buildBlankInsensitiveNote(plan.outcomes);
  if (appliedNote !== null) out(appliedNote);
  const maskNote = buildMaskRestoreNote(plan.outcomes, true);
  if (maskNote !== null) out(maskNote);
  const sjisNote = buildSjisFoldNote(plan.outcomes, true);
  if (sjisNote !== null) out(sjisNote);
  if (plan.failures.length > 0) {
    out(`スキップした失敗 ${plan.failures.length} 件のレポート:`);
    out("");
    literalHint();
    // --partial で成功分は書き込み済みのため nothingWritten は付けない
    await emitReport(buildFailureReport(plan.failures, { outcomes: plan.outcomes }));
  }

  // 6. 自動検出 (Downloads / プロジェクト直下) 由来なら changes.md を履歴へ移動
  //    (原本は history に保存済み・§4.1)。全件適用済みで履歴を作らなかった場合は削除しない
  if ((source.type === "downloads" || source.type === "project-root") && source.path !== undefined) {
    try {
      deleteFile(source.path);
      out(`${source.path} を履歴へ移動しました`);
    } catch {
      err(`${TOOL_NAME}: ${source.path} を削除できませんでした (履歴には保存済み)`);
    }
  }

  out("");
  out(
    `差分を確認してからビルドしてください (VS Code のソース管理、または \`${TOOL_NAME} show\`)。` +
      `巻き戻しは \`${TOOL_NAME} undo\` です。`,
  );
  if (config.git.commitEachApply) {
    const next = buildCommitMessage(changeSet.header, id, applicable.length);
    out(
      `コミット: 次の changes.md を当てる前に「${next.subject}」でコミットします ` +
        `(区切りで締めるときは ${TOOL_NAME} commit。メッセージを変えたいときは、その前にご自身でコミットしてください)`,
    );
  }
  return done("applied", 0, applicable.length);
}

/** リポジトリのファイル名 (小文字) の集合。git のリポジトリでなければ null (別のリポジトリ向けの判定をしない) */
function repositoryFileNames(root: string): Set<string> | null {
  const listed = listGitFiles(root);
  if (!listed.ok) return null;
  return new Set(listed.files.map(fileNameKey));
}

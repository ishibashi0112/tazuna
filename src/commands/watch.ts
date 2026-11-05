/**
 * tazuna watch — Downloads とプロジェクト直下を監視し、届いた changes*.md を自動で適用する (§4.7)。
 * 新着 1 件ごとに runApply へ確認なしで渡す。検証・失敗レポートの自動コピー・
 * 二重適用の防止・成功後の履歴への移動は `tazuna` (引数なし) と同じ。Ctrl+C で終了する。
 * 結果はターミナルのタイトルでも知らせ (--bell でベルも。既定は鳴らさない)、
 * 当てなかった Downloads の changes.md は少し待ってから状態ディレクトリの unapplied/ へ移す。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { TOOL_NAME } from "../brand.ts";
import { hasChangesHeading } from "../core/parser.ts";
import { initialWatchState, observeWatch, type WatchedFile } from "../core/watch.ts";
import { loadConfig } from "../infra/config.ts";
import { listChangesFiles, resolveDownloadsDir } from "../infra/downloads.ts";
import { findProjectRoot } from "../infra/root.ts";
import { err, out, outEmphasis, restoreTerminalTitle, ringBell, setTerminalTitle } from "../infra/term.ts";
import { moveToUnapplied, unappliedDir } from "../infra/unapplied.ts";
import { runApply, type ApplyOutcomeKind, type ApplyResult, type DetectedChanges } from "./apply.ts";

export interface WatchOptions {
  /** 監視を止める合図 (テスト用。指定がなくても Ctrl+C で止まる) */
  signal?: AbortSignal;
  /** 観測の間隔 (ミリ秒)。テスト用 */
  intervalMs?: number;
  /** 当てなかった changes.md を unapplied/ へ移すまでの猶予 (ミリ秒)。テスト用 */
  tidyDelayMs?: number;
}

const DEFAULT_INTERVAL_MS = 1000;
/**
 * 当てなかった changes.md を移すまでの猶予。Downloads は複数のリポジトリで共通なので、別のリポジトリの
 * watch もほぼ同時に同じファイルを見つけて当てに行く (このリポジトリにも同じ名前のファイルがあって
 * 別のリポジトリ向けと見分けられなかったとき、すぐ移すとそちらの watch が当てられなくなる)。
 * どの watch も 1 秒間隔の 2 回の観測で渡すので、15 秒あれば向こうの適用が先に終わる
 */
const DEFAULT_TIDY_DELAY_MS = 15_000;

const pad2 = (n: number): string => String(n).padStart(2, "0");
const clock = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/** 引数に渡すパスを引用符で囲む (Downloads のファイル名は "changes (1).md" のように空白を含む) */
const quoted = (path: string): string => `"${path}"`;

/** watch での 1 件の結果。runApply の結果に、runApply が例外で止まったとき ("error") を足したもの */
export type WatchOutcomeKind = ApplyOutcomeKind | "error";

/** 1 件の結果をどう知らせるか (タイトル・結果の行)。純粋関数 */
export interface WatchReport {
  /** ターミナルのタイトル (リポジトリ名と時刻は呼び出し側が足す) */
  title: string;
  /** 結果の行 (強調表示する) */
  headline: string;
  /** 補足の行 */
  details: string[];
}

/** 案内するコマンドに付ける --root (watch を --root 付きで始めたときだけ。別のフォルダからでも同じルートになるように) */
const rootSuffix = (rootOption: string | null): string => (rootOption === null ? "" : ` --root ${quoted(rootOption)}`);

export function describeWatchResult(
  result: { kind: WatchOutcomeKind; files: number; reportCopied: boolean },
  file: {
    path: string;
    /** 後で unapplied/ へ移すとき、その先 (ルートからの相対) と猶予の秒数 */
    tidy: { dir: string; afterSec: number } | null;
    rootOption: string | null;
  },
): WatchReport {
  const later: string[] =
    file.tidy === null
      ? []
      : [`changes.md は${file.tidy.afterSec > 0 ? ` ${file.tidy.afterSec} 秒後に` : ""} ${file.tidy.dir} へ移します`];
  switch (result.kind) {
    case "applied":
      return {
        title: `✓ 適用 ${result.files} ファイル`,
        headline: `✓ 適用しました (${result.files} ファイル)`,
        details: ["git diff で確認してからビルドしてください"],
      };
    case "already-applied":
      return {
        title: "– 適用済み (書き込みなし)",
        headline: "– すべて適用済みでした。何も書き込んでいません",
        details: later,
      };
    case "failed":
      return {
        title: "✗ 失敗 (レポートを貼る)",
        headline: result.reportCopied
          ? "✗ 適用できませんでした。失敗レポートをクリップボードにコピー済みです → AI チャットに貼ってください"
          : "✗ 適用できませんでした。上の失敗レポートを AI チャットに貼ってください",
        details: [...later, "修正版の changes.md が届けば、そのまま当てます"],
      };
    case "duplicate":
      return {
        title: "! 止めました (適用済みの changes.md)",
        headline: "! この changes.md は適用済みのため、当てずに止めました (二重適用の防止)",
        details: [
          "以前にダウンロードしたものを取り違えていないか確認してください (最新の回答の changes.md をダウンロードすれば当てます)",
          ...(file.tidy === null
            ? [forceLine(file.path, file.rootOption)]
            : [...later, "git などで戻したため当て直したいときのコマンドは、移したときに示します"]),
        ],
      };
    case "other-repo":
      return {
        title: "! 当てていません (別のリポジトリ向け?)",
        headline: "! 対象のファイルがこのリポジトリに無いため、当てていません (別のリポジトリ向けの changes.md のようです)",
        details: [
          `ファイルは ${file.path} に残しています (そのリポジトリで動いている watch や ${TOOL_NAME} が当てられます)`,
          `このリポジトリ向けなら ${TOOL_NAME} ${quoted(file.path)}${rootSuffix(file.rootOption)} で失敗の理由を確かめられます`,
        ],
      };
    case "commit-failed":
      return {
        title: "✗ コミットできず止めました",
        headline: "✗ 前回の適用をコミットできなかったため、この changes.md は当てていません (理由は上)",
        details: [
          `git の問題を直してから ${TOOL_NAME} ${quoted(file.path)}${rootSuffix(file.rootOption)} で当ててください`,
          `changes.md は ${file.path} に残しています`,
        ],
      };
    case "dry-run":
      return {
        title: "dry-run: 検証しました",
        headline: "dry-run: 検証と差分の表示だけ行いました (書き込みなし)",
        details: [],
      };
    case "aborted":
    case "unreadable":
      return {
        title: "✗ 読めませんでした",
        headline: `✗ changes.md を読めませんでした: ${file.path}`,
        details: [],
      };
    case "error":
      return {
        title: "✗ エラー (git diff を確認)",
        headline: "✗ 処理の途中でエラーになりました (上のメッセージ)",
        details: [
          "書きかけのファイルがないか git diff で確認してください",
          `changes.md は ${file.path} に残しています`,
        ],
      };
  }
}

function forceLine(path: string, rootOption: string | null): string {
  return `git などで戻したため当て直したいときだけ: ${TOOL_NAME} ${quoted(path)} --force${rootSuffix(rootOption)}`;
}

/** 猶予の後に unapplied/ へ移したとき (移せなかったとき) の行。純粋関数 */
export function describeTidy(
  kind: WatchOutcomeKind,
  file: { path: string; movedTo: string | null; moveError: string | null; rootOption: string | null },
): string[] {
  const lines: string[] = [];
  if (file.movedTo !== null) lines.push(`changes.md を ${file.movedTo} へ移しました`);
  if (file.moveError !== null) lines.push(`changes.md を移せませんでした (${file.moveError})。${file.path} に残っています`);
  if (kind === "duplicate") lines.push(forceLine(file.movedTo ?? file.path, file.rootOption));
  return lines;
}

export async function watchCommand(argv: string[], options: WatchOptions = {}): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "no-vbproj": { type: "boolean", default: false },
      // 結果ごとにベルも鳴らす (既定は鳴らさない。職場で毎回音が鳴るのを避けるため)
      bell: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const root = findProjectRoot(process.cwd(), values.root);
  const config = loadConfig(root);
  const downloadsDir = await resolveDownloadsDir(config.downloadsDir);

  // Downloads を先に並べ、同じパスはその由来で扱う (apply の自動検出と同じ)
  type Found = WatchedFile & { origin: DetectedChanges["origin"] };
  const list = (): Found[] => {
    const seen = new Set<string>();
    return [
      ...listChangesFiles(downloadsDir).map((f) => ({ ...f, origin: "downloads" as const })),
      ...listChangesFiles(root).map((f) => ({ ...f, origin: "project-root" as const })),
    ].filter((f) => !seen.has(f.path) && (seen.add(f.path), true));
  };

  const stop = new AbortController();
  const onSigint = (): void => stop.abort();
  process.once("SIGINT", onSigint);
  const onAbort = (): void => stop.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted === true) stop.abort();

  const applyArgs = ["--root", root, "--yes"];
  if (values["dry-run"]) applyArgs.push("--dry-run");
  if (values["no-vbproj"]) applyArgs.push("--no-vbproj");

  // タイトルにはリポジトリの名前を入れる (複数の watch を開いても見分けられるように)
  const repoName = basename(root);
  const title = (text: string): void => setTerminalTitle(`${TOOL_NAME} watch: ${text} — ${repoName}`);
  const rootOption = values.root === undefined ? null : root;
  const tidyRel = relative(root, unappliedDir(root));
  const tidyDelay = options.tidyDelayMs ?? DEFAULT_TIDY_DELAY_MS;

  // 猶予の後に unapplied/ へ移すもの。渡したときと同じ時刻・サイズのまま残っているときだけ移す
  // (無くなっていれば別のリポジトリの watch が当てたか利用者が動かした。変わっていれば新着として渡し直される)
  interface PendingTidy {
    path: string;
    stamp: string;
    due: number;
    kind: WatchOutcomeKind;
  }
  const pendingTidy: PendingTidy[] = [];
  const stampOf = (path: string): string | null => {
    try {
      const st = statSync(path);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  };
  const tidyDue = (): void => {
    const now = Date.now();
    for (let i = 0; i < pendingTidy.length; ) {
      const p = pendingTidy[i] as PendingTidy;
      if (p.due > now) {
        i++;
        continue;
      }
      pendingTidy.splice(i, 1);
      const current = stampOf(p.path);
      if (current === null) {
        out(`(${clock(new Date())}) ${p.path} は移す前に無くなっていました (別のリポジトリの watch が当てたか、手で動かしたようです)`);
        continue;
      }
      if (current !== p.stamp) continue;
      let movedTo: string | null = null;
      let moveError: string | null = null;
      try {
        movedTo = moveToUnapplied(root, p.path, new Date());
      } catch (e) {
        moveError = e instanceof Error ? e.message : String(e);
      }
      const lines = describeTidy(p.kind, { path: p.path, movedTo, moveError, rootOption });
      out(`(${clock(new Date())}) ${lines[0] ?? ""}`);
      for (const line of lines.slice(1)) out(`  ${line}`);
    }
  };

  try {
    // 開始時に既にあるファイルは対象外 (古い changes.md を黙って当てない)
    const state = initialWatchState(list());
    out("changes*.md の到着を待っています。届いたら確認なしで適用します (Ctrl+C で終了)");
    out(`  Downloads:        ${downloadsDir}`);
    out(`  プロジェクト直下: ${root}`);
    if (values["dry-run"]) out("  --dry-run: 検証と差分プレビューだけで、書き込みはしません");
    if (state.settled.size > 0) {
      out(`  (既にある ${state.settled.size} 件は対象外です。それを当てるときは ${TOOL_NAME} を実行してください)`);
    }
    out(
      `  結果はこのターミナルのタイトル${values.bell ? "とベル" : ""}でも知らせます。` +
        `当てなかった Downloads の changes.md は少し待ってから ${tidyRel} へ移します`,
    );
    title("待機中");

    const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    while (!stop.signal.aborted) {
      try {
        await delay(interval, undefined, { signal: stop.signal });
      } catch {
        break; // 中断
      }
      tidyDue();
      for (const f of observeWatch(state, list())) {
        if (stop.signal.aborted) break;
        // 別のリポジトリの watch が先に当てて履歴へ移したものは、黙って見送る
        if (!existsSync(f.path)) continue;
        // 移すのを待っていたものが書き換わって渡し直されたら、前の結果では移さない
        for (let i = pendingTidy.length - 1; i >= 0; i--) if (pendingTidy[i]?.path === f.path) pendingTidy.splice(i, 1);
        out("");
        out(`━━ ${clock(new Date())} 新しい changes.md: ${f.path}`);
        let text: string;
        try {
          text = readFileSync(f.path, "utf8");
        } catch {
          err(`${TOOL_NAME}: ファイルを読めません: ${f.path}`);
          continue;
        }
        // 変更履歴の CHANGES.md 等を当てに行かない (失敗レポートでクリップボードを上書きしないため)
        if (!hasChangesHeading(text.replace(/^\uFEFF/, ""))) {
          out("  ## CHANGES の見出しがないため、changes.md ではないと判断して適用しません");
          out(`  (AI の返答なら \`${TOOL_NAME} <パス>\` で実行すると失敗の理由を確認できます)`);
          continue;
        }
        title("適用中");
        let result: Pick<ApplyResult, "files" | "reportCopied"> & { kind: WatchOutcomeKind };
        try {
          result = await runApply(applyArgs, { path: f.path, origin: f.origin });
        } catch (e) {
          // 1 件の失敗で監視ごと止めない (書き込みの途中かもしれないので、読めなかったとは書かない)
          err(`${TOOL_NAME}: ${e instanceof Error ? e.message : String(e)}`);
          result = { kind: "error", files: 0, reportCopied: false };
        }
        // 当てなかった Downloads の changes.md は片付ける。プロジェクト直下のものは利用者が置いて
        // 手で直しながら当て直すことがあるので動かさない。別のリポジトリ向けらしいものは、そちらの
        // watch が当てられるよう残す。dry-run は何も動かさない
        const tidy =
          f.origin === "downloads" &&
          !values["dry-run"] &&
          (result.kind === "failed" || result.kind === "already-applied" || result.kind === "duplicate");
        if (tidy) {
          pendingTidy.push({ path: f.path, stamp: `${f.mtimeMs}:${f.size}`, due: Date.now() + tidyDelay, kind: result.kind });
        }
        const report = describeWatchResult(result, {
          path: f.path,
          tidy: tidy ? { dir: tidyRel, afterSec: Math.ceil(tidyDelay / 1000) } : null,
          rootOption,
        });
        out("");
        outEmphasis(report.headline);
        for (const line of report.details) out(`  ${line}`);
        title(`${report.title} (${clock(new Date()).slice(0, 5)})`);
        if (values.bell) ringBell();
        tidyDue();
        out("");
        out("引き続き待っています (Ctrl+C で終了)");
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    options.signal?.removeEventListener("abort", onAbort);
    restoreTerminalTitle();
  }
  for (const p of pendingTidy) out(`移す前に終了したため、そのまま残しています: ${p.path}`);
  out("監視を終了しました。");
  return 0;
}

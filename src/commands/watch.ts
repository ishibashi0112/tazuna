/**
 * tazuna watch — Downloads とプロジェクト直下を監視し、届いた changes*.md を自動で適用する (§4.7)。
 * 新着 1 件ごとに runApply へ確認なしで渡す。検証・失敗レポートの自動コピー・
 * 二重適用の防止・成功後の履歴への移動は `tazuna` (引数なし) と同じ。Ctrl+C で終了する。
 * 結果はターミナルのタイトルでも知らせ (--bell でベルも。既定は鳴らさない)、
 * 当てなかった Downloads の changes.md は状態ディレクトリの unapplied/ へ移す。
 */
import { existsSync, readFileSync } from "node:fs";
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
import { runApply, type ApplyResult, type DetectedChanges } from "./apply.ts";

export interface WatchOptions {
  /** 監視を止める合図 (テスト用。指定がなくても Ctrl+C で止まる) */
  signal?: AbortSignal;
  /** 観測の間隔 (ミリ秒)。テスト用 */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 1000;

const pad2 = (n: number): string => String(n).padStart(2, "0");
const clock = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/** 引数に渡すパスを引用符で囲む (Downloads のファイル名は "changes (1).md" のように空白を含む) */
const quoted = (path: string): string => `"${path}"`;

/** 1 件の結果をどう知らせるか (タイトル・結果の行)。純粋関数 */
export interface WatchReport {
  /** ターミナルのタイトル (リポジトリ名と時刻は呼び出し側が足す) */
  title: string;
  /** 結果の行 (強調表示する) */
  headline: string;
  /** 補足の行 */
  details: string[];
}

export function describeWatchResult(
  result: Pick<ApplyResult, "kind" | "files" | "reportCopied">,
  file: { path: string; movedTo: string | null; moveError: string | null },
): WatchReport {
  const kept = file.movedTo ?? file.path;
  const moved: string[] = [];
  if (file.movedTo !== null) moved.push(`changes.md は ${file.movedTo} へ移しました`);
  if (file.moveError !== null) moved.push(`changes.md を移せませんでした (${file.moveError})。${file.path} に残っています`);
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
        details: moved,
      };
    case "failed":
      return {
        title: "✗ 失敗 (レポートを貼る)",
        headline: result.reportCopied
          ? "✗ 適用できませんでした。失敗レポートをクリップボードにコピー済みです → AI チャットに貼ってください"
          : "✗ 適用できませんでした。上の失敗レポートを AI チャットに貼ってください",
        details: [...moved, "修正版の changes.md が届けば、そのまま当てます"],
      };
    case "duplicate":
      return {
        title: "! 止めました (適用済みの changes.md)",
        headline: "! この changes.md は適用済みのため、当てずに止めました (二重適用の防止)",
        details: [
          ...moved,
          "以前にダウンロードしたものを取り違えていないか確認してください (最新の回答の changes.md をダウンロードすれば当てます)",
          `git などで戻したため当て直したいときだけ: ${TOOL_NAME} ${quoted(kept)} --force`,
        ],
      };
    case "other-repo":
      return {
        title: "! 当てていません (別のリポジトリ向け?)",
        headline: "! 対象のファイルがこのリポジトリに無いため、当てていません (別のリポジトリ向けの changes.md のようです)",
        details: [
          `ファイルは ${file.path} に残しています (そのリポジトリで動いている watch や ${TOOL_NAME} が当てられます)`,
          `このリポジトリ向けなら ${TOOL_NAME} ${quoted(file.path)} で失敗の理由を確かめられます`,
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
  }
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
        `当てなかった Downloads の changes.md は ${relative(root, unappliedDir(root))} へ移します`,
    );
    title("待機中");

    const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    while (!stop.signal.aborted) {
      try {
        await delay(interval, undefined, { signal: stop.signal });
      } catch {
        break; // 中断
      }
      for (const f of observeWatch(state, list())) {
        if (stop.signal.aborted) break;
        // 別のリポジトリの watch が先に当てて履歴へ移したものは、黙って見送る
        if (!existsSync(f.path)) continue;
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
        let result: ApplyResult;
        try {
          result = await runApply(applyArgs, { path: f.path, origin: f.origin });
        } catch (e) {
          // 1 件の失敗で監視ごと止めない
          err(`${TOOL_NAME}: ${e instanceof Error ? e.message : String(e)}`);
          result = { code: 1, kind: "unreadable", files: 0, reportCopied: false };
        }
        // 当てなかった Downloads の changes.md は片付ける。プロジェクト直下のものは利用者が置いて
        // 手で直しながら当て直すことがあるので動かさない。別のリポジトリ向けらしいものは、そちらの
        // watch が当てられるよう残す。dry-run は何も動かさない
        let movedTo: string | null = null;
        let moveError: string | null = null;
        const tidy =
          f.origin === "downloads" &&
          !values["dry-run"] &&
          (result.kind === "failed" || result.kind === "already-applied" || result.kind === "duplicate");
        if (tidy && existsSync(f.path)) {
          try {
            movedTo = moveToUnapplied(root, f.path, new Date());
          } catch (e) {
            moveError = e instanceof Error ? e.message : String(e);
          }
        }
        const report = describeWatchResult(result, { path: f.path, movedTo, moveError });
        out("");
        outEmphasis(report.headline);
        for (const line of report.details) out(`  ${line}`);
        title(`${report.title} (${clock(new Date()).slice(0, 5)})`);
        if (values.bell) ringBell();
        out("");
        out("引き続き待っています (Ctrl+C で終了)");
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    options.signal?.removeEventListener("abort", onAbort);
    restoreTerminalTitle();
  }
  out("監視を終了しました。");
  return 0;
}

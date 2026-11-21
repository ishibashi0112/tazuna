/**
 * tazuna watch — Downloads とプロジェクト直下を監視し、届いた changes*.md を自動で適用する (§4.7)。
 * 新着 1 件ごとに runApply へ確認なしで渡す。検証・失敗レポートの自動コピー・
 * 二重適用の防止・成功後の履歴への移動は `tazuna` (引数なし) と同じ。Ctrl+C で終了する。
 * 結果はターミナルのタイトルでも知らせ (--bell でベルも。既定は鳴らさない)、
 * 当てなかった Downloads の changes.md は少し待ってから状態ディレクトリの unapplied/ へ移す。
 * 同じダウンロードフォルダを見る watch は 1 つだけ (後から始めた watch に切り替わり、前の watch は自分で終了する。
 * 1 つの changes.md が 2 か所に当たらないように。infra/watch-lock.ts)。
 * 画面で p (パック)・c (前回のパックで貼るものをもう一度コピー)・b (ビルド)・h (一覧) を打って Enter で操作できる
 * (0.27.0。パック・ビルド用の端末を別に開かなくて済むように。core/watch-keys.ts・commands/watch-pack.ts)。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { BUILD_COMMAND, PACK_COMMAND, TOOL_NAME } from "../brand.ts";
import { hasChangesHeading } from "../core/parser.ts";
import { initialWatchState, observeWatch, type WatchedFile } from "../core/watch.ts";
import type { WatchCommand, WatchInput } from "../core/watch-keys.ts";
import { writeClipboardSync, type ClipboardResult } from "../infra/clipboard.ts";
import { loadConfig } from "../infra/config.ts";
import { listChangesFiles, resolveDownloadsDir } from "../infra/downloads.ts";
import { findProjectRoot } from "../infra/root.ts";
import { err, out, outEmphasis, restoreTerminalTitle, ringBell, setTerminalTitle } from "../infra/term.ts";
import { moveToUnapplied, unappliedDir } from "../infra/unapplied.ts";
import { listenWatchInput, type WatchInputListener } from "../infra/watch-keys.ts";
import {
  acquireWatchLock,
  checkWatchLock,
  releaseWatchLock,
  watchLockPath,
  type PreviousWatch,
  type WatchLock,
  type WatchLockInfo,
} from "../infra/watch-lock.ts";
import { PASTE_LIMIT_CHARS, planHandoff } from "../pack/handoff.ts";
import { runApply, type ApplyOutcomeKind, type ApplyResult, type DetectedChanges } from "./apply.ts";
import { describeCopy, readLastPack } from "./watch-pack.ts";

export interface WatchOptions {
  /** 監視を止める合図 (テスト用。指定がなくても Ctrl+C で止まる) */
  signal?: AbortSignal;
  /** 観測の間隔 (ミリ秒)。テスト用 */
  intervalMs?: number;
  /** 当てなかった changes.md を unapplied/ へ移すまでの猶予 (ミリ秒)。テスト用 */
  tidyDelayMs?: number;
  /** watch の印を置くフォルダ (既定は一時フォルダ)。テスト用 */
  lockDir?: string;
  /**
   * 画面で打つコマンド (p / c / b / h + Enter) を読むストリーム。cli から process.stdin を渡す。
   * 指定がなければコマンドを受け付けない (テストで実行機の標準入力を読まないように)
   */
  input?: NodeJS.ReadableStream;
  /** p で作るパック (既定は tazuna pack と同じ packCommand)。テスト用 */
  pack?: (argv: string[]) => number | Promise<number>;
  /** b で行うビルド (既定は tazuna build と同じ buildCommand)。テスト用 */
  build?: (argv: string[]) => number | Promise<number>;
  /**
   * b を案内するか (.sln / .vbproj / .csproj が見つかるか)。既定は tazuna build と同じ探し方で決める。テスト用。
   * 案内しないときも b は打てる (tazuna build と同じ理由の行を出す)
   */
  buildAvailable?: boolean;
  /** c でクリップボードに書く (既定は writeClipboardSync)。テスト用 (実行機のクリップボードを汚さないように) */
  writeClipboard?: (text: string) => ClipboardResult;
}

const DEFAULT_INTERVAL_MS = 1000;
/**
 * 当てなかった changes.md を移すまでの猶予。Downloads は複数のリポジトリで共通なので、別のリポジトリで
 * 同じファイルを当てに行くものがあり得る (0.26.0 より前の版の watch や、手で実行した tazuna。このリポジトリにも
 * 同じ名前のファイルがあって別のリポジトリ向けと見分けられなかったとき、すぐ移すとそちらが当てられなくなる)。
 * 0.26.0 からの watch どうしは同じ Downloads に 1 つだけ (後から始めた方に切り替わる) なので、ここでは競わない。
 * watch は 1 秒間隔の 2 回の観測で渡すので、15 秒あれば向こうの適用が先に終わる
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
    /** 画面で b (ビルド) を打てるとき true (次にすることの案内に添える) */
    buildKey?: boolean;
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
        details: [
          file.buildKey === true
            ? `差分を VS Code のソース管理か ${TOOL_NAME} show で確認してから、b を打って Enter でビルドしてください`
            : `差分を VS Code のソース管理か ${TOOL_NAME} show で確認してからビルドしてください`,
        ],
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

/** 開始時刻の表示 (同じ日なら時刻だけ) */
function startedLabel(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const hm = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  return at.toDateString() === now.toDateString() ? hm : `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
}

/** 同じルートか (Windows・macOS は大文字小文字を区別しないのが普通) */
function sameRoot(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * 始めたときに、前に動いていた watch から切り替えたことを知らせる行。前の watch が動いていなければ (ウィンドウを
 * 閉じて印だけが残っていた) 何も出さない。純粋関数
 */
export function describeHandover(
  previous: PreviousWatch | null,
  root: string,
  now: Date,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (previous === null || !previous.alive) return [];
  const where = sameRoot(previous.root, root, platform) ? "このリポジトリで" : `${previous.root} で`;
  return [
    `${where}動いていた ${TOOL_NAME} watch (PID ${previous.pid}、${startedLabel(previous.startedAt, now)} から) から、ここに切り替えます`,
    "同じダウンロードフォルダを見る watch は 1 つだけです (1 つの changes.md が 2 か所に当たらないように、あちらは自動で終了します)",
  ];
}

/** 後から始めた watch に切り替わったとき (この watch が終了するとき) の行。純粋関数 */
export function describeTakeover(
  by: Omit<WatchLockInfo, "token">,
  root: string,
  platform: NodeJS.Platform = process.platform,
): { headline: string; details: string[] } {
  return {
    headline: sameRoot(by.root, root, platform)
      ? `このリポジトリで別の ${TOOL_NAME} watch が始まりました (PID ${by.pid})`
      : `別の場所で ${TOOL_NAME} watch が始まりました: ${by.root}`,
    details: [
      "同じダウンロードフォルダを見る watch は 1 つだけにするため、ここでの監視を終了します (1 つの changes.md が 2 か所に当たらないように)",
      `ここで続けるときは、もう一度 ${TOOL_NAME} watch を実行してください (あちらの watch が終了します)`,
    ],
  };
}

/** 画面で打てるコマンドの一覧 (開始時と h のとき)。build: b (ビルド) を案内するか。純粋関数 */
export function describeWatchKeys(options: { build: boolean }): string[] {
  return [
    "画面で 1 文字打って Enter:",
    `  p  パックを作る (この端末で ${PACK_COMMAND} と打つのと同じ。貼るものをクリップボードへ)`,
    "  c  前回のパックで貼るものを、もう一度クリップボードへ (別のものをコピーした後や、新しいチャットに貼り直すとき)",
    ...(options.build
      ? [`  b  ビルドする (${BUILD_COMMAND} と同じ。失敗したらエラーと周辺のコードをクリップボードへ)`]
      : []),
    "  h  この一覧を出す",
  ];
}

/** 結果の後の 1 行の案内 (待っていることと、打てるコマンド)。keys: コマンドを受け付けるか。純粋関数 */
export function describeWatchGuide(options: { keys: boolean; build: boolean }): string {
  if (!options.keys) return "引き続き待っています (Ctrl+C で終了)";
  return (
    "引き続き待っています ― 打って Enter: p パックを作る / c 貼るものをもう一度コピー / " +
    (options.build ? "b ビルド / " : "") +
    "h 一覧 (Ctrl+C で終了)"
  );
}

/** 打ったものがコマンドでなかったとき・貼り付けとみなしたときの行 (それ以外は null)。純粋関数 */
export function describeWatchInput(input: WatchInput): string | null {
  if (input.kind === "pasted") {
    return `${input.lines} 行がまとめて入力されたため、貼り付けとみなして何もしていません (コマンドは 1 文字を打って Enter)`;
  }
  if (input.kind === "unknown") {
    return `「${input.text.length > 20 ? `${input.text.slice(0, 20)}…` : input.text}」はコマンドではありません`;
  }
  return null;
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
  // 観測の間の待ちを、打ったコマンドで早めに切り上げる (stop で止めたときも切り上げる)
  let tick = new AbortController();
  stop.signal.addEventListener("abort", () => tick.abort(), { once: true });
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
  // (無くなっていれば別のリポジトリで当てたか利用者が動かした。変わっていれば新着として渡し直される)
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
        out(`(${clock(new Date())}) ${p.path} は移す前に無くなっていました (別のリポジトリで当てたか、手で動かしたようです)`);
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

  // 画面で打ったコマンド (p / c / b / h + Enter)。観測の間に行い、適用の最中に打ったものはその後に順に行う
  // (同じコマンドが待っていれば 1 回にまとめる)。コマンドでない入力は、行を 1 つ出すだけ
  type QueuedCommand = { kind: "command"; command: WatchCommand } | { kind: "note"; line: string; withKeys: boolean };
  const commands: QueuedCommand[] = [];
  let listener: WatchInputListener | null = null;
  const onInput = (input: WatchInput): void => {
    if (input.kind === "empty") return;
    if (input.kind === "command") {
      if (commands.some((c) => c.kind === "command" && c.command === input.command)) return;
      commands.push({ kind: "command", command: input.command });
    } else {
      commands.push({ kind: "note", line: describeWatchInput(input) ?? "", withKeys: input.kind === "unknown" });
    }
    tick.abort();
  };
  const keysEnabled = options.input !== undefined;
  // b を案内するのは、tazuna build と同じ探し方で .sln / .vbproj / .csproj が見つかるときだけ
  // (kind: "generic" の構成ではビルドのコマンドはプロジェクトのもの)
  const findBuildTarget = async (): Promise<boolean> => {
    try {
      const { findTargetQuietly } = await import("./pack-io.ts");
      return findTargetQuietly(values.root === undefined ? undefined : root) !== undefined;
    } catch {
      return false;
    }
  };
  const buildAvailable = options.buildAvailable ?? (keysEnabled && (await findBuildTarget()));
  const waitingLine = describeWatchGuide({ keys: keysEnabled, build: buildAvailable });
  const hhmm = (): string => clock(new Date()).slice(0, 5);

  // p / b: この端末で tazuna pack / tazuna build と打つのと同じ (--root 付きで始めた watch は、そのルートのもの)
  const targetArgs = rootOption === null ? [] : [root, "--root", root];
  const commandLabel = (command: string): string =>
    rootOption === null ? command : `${command} ${quoted(root)} --root ${quoted(root)}`;
  /** パック・ビルドを行う。例外でも監視ごと止めない */
  const runTool = async (run: (args: string[]) => number | Promise<number>): Promise<number> => {
    try {
      return await run([...targetArgs]);
    } catch (e) {
      err(`${TOOL_NAME}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  };
  const runPack = options.pack ?? (async (args: string[]) => (await import("./pack.ts")).packCommand(args));
  const packNow = async (): Promise<void> => {
    out("");
    out(`━━ ${clock(new Date())} パックを作ります (${commandLabel(PACK_COMMAND)})`);
    title("パック作成中");
    const code = await runTool(runPack);
    out("");
    if (code === 0) {
      outEmphasis("✓ パックを作りました (Copilot Chat への渡し方は上に出ています)");
      title(`✓ パック作成 (${hhmm()})`);
    } else {
      outEmphasis("✗ パックを作れませんでした (理由は上)");
      title(`✗ パック失敗 (${hhmm()})`);
    }
  };

  // b: ビルド。打ったときだけ行う (適用の後に自動でビルドはしない。差分を確かめてから動かすため)
  const runBuild = options.build ?? (async (args: string[]) => (await import("./build.ts")).buildCommand(args));
  const buildNow = async (): Promise<void> => {
    out("");
    out(`━━ ${clock(new Date())} ビルドします (${commandLabel(BUILD_COMMAND)})`);
    title("ビルド中");
    const code = await runTool(runBuild);
    out("");
    if (code === 0) {
      outEmphasis("✓ ビルドに成功しました");
      title(`✓ ビルド成功 (${hhmm()})`);
    } else {
      outEmphasis("✗ ビルドできませんでした (理由は上。エラーをクリップボードにコピーしたときは、そのまま AI チャットに貼ってください)");
      title(`✗ ビルド失敗 (${hhmm()})`);
    }
    if (values.bell) ringBell();
  };

  // c: 前回のパックで貼るもの (tazuna pack がクリップボードに入れるものと同じ) を、もう一度クリップボードへ
  const writeClipboard = options.writeClipboard ?? writeClipboardSync;
  const copyNow = (): void => {
    out("");
    out(`━━ ${clock(new Date())} 前回のパックで貼るものをコピーします`);
    const last = readLastPack(root);
    const plan = last === null ? null : planHandoff(last.pack, last.prompt, PASTE_LIMIT_CHARS);
    let copied: ClipboardResult | null = null;
    if (plan !== null && plan.kind !== "none") {
      try {
        copied = writeClipboard(plan.text);
      } catch (e) {
        copied = { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    }
    const report = describeCopy(last, plan, copied, new Date());
    outEmphasis(report.headline);
    for (const line of report.details) out(`  ${line}`);
    title(`${report.title} (${hhmm()})`);
  };

  const runCommand = async (queued: QueuedCommand): Promise<void> => {
    if (queued.kind === "note") {
      out(`(${clock(new Date())}) ${queued.line}`);
      if (queued.withKeys) for (const line of describeWatchKeys({ build: buildAvailable })) out(`  ${line}`);
      return;
    }
    switch (queued.command) {
      case "help":
        out("");
        for (const line of describeWatchKeys({ build: buildAvailable })) out(line);
        out("  Ctrl+C  終了");
        return;
      case "pack":
        await packNow();
        break;
      case "copy":
        copyNow();
        break;
      case "build":
        await buildNow();
        break;
    }
    out("");
    out(waitingLine);
  };

  // 同じダウンロードフォルダを見る watch は 1 つだけにする。印を置き換え、前の watch には自分で終了してもらう
  // (印は開始時の一覧より先に書く。前の watch はこの後に届いたものを当てる前に切り替わりに気づき、この watch は
  // それより前からあるものを当てないので、同じ changes.md を 2 つの watch が当てることはない)
  const me: Omit<WatchLockInfo, "token"> = { pid: process.pid, root, startedAt: new Date().toISOString() };
  let lock: WatchLock | null = null;
  let previous: PreviousWatch | null = null;
  let lockError: string | null = null;
  let takenBy: Omit<WatchLockInfo, "token"> | null = null;
  /** 後から始めた watch に切り替わっていれば true */
  const handedOver = (): boolean => {
    if (takenBy === null && lock !== null) {
      const check = checkWatchLock(lock, me);
      if (check.state === "taken") takenBy = check.by;
    }
    return takenBy !== null;
  };

  try {
    try {
      ({ lock, previous } = acquireWatchLock(watchLockPath(downloadsDir, options.lockDir), me));
    } catch (e) {
      lockError = e instanceof Error ? e.message : String(e);
    }
    // 開始時に既にあるファイルは対象外 (古い changes.md を黙って当てない)
    const state = initialWatchState(list());
    for (const line of describeHandover(previous, root, new Date())) out(line);
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
    if (lockError !== null) {
      out(
        `  (ほかの watch と重ならないようにする印を書けませんでした: ${lockError}。` +
          "同じダウンロードフォルダを見る watch をほかに起動しないでください)",
      );
    }
    if (options.input !== undefined) {
      out("");
      for (const line of describeWatchKeys({ build: buildAvailable })) out(line);
      listener = listenWatchInput(options.input, onInput);
    }
    title("待機中");

    const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    while (!stop.signal.aborted && takenBy === null) {
      try {
        await delay(interval, undefined, { signal: tick.signal });
      } catch {
        if (stop.signal.aborted) break; // 中断
        tick = new AbortController(); // 打ったコマンドで起こされた
      }
      if (handedOver()) break;
      tidyDue();
      // 打ったコマンドは、届いた changes.md より先に行う (適用の最中に打ったものはその後に)
      while (commands.length > 0 && !stop.signal.aborted && !handedOver()) {
        await runCommand(commands.shift() as QueuedCommand);
        tidyDue();
      }
      if (stop.signal.aborted || handedOver()) break;
      for (const f of observeWatch(state, list())) {
        // 後から始めた watch に切り替わっていたら当てない (そちらが当てる)
        if (stop.signal.aborted || handedOver()) break;
        // 別のリポジトリで先に当てて履歴へ移したもの (手で実行した tazuna や前の版の watch) は、黙って見送る
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
          buildKey: keysEnabled && buildAvailable,
        });
        out("");
        outEmphasis(report.headline);
        for (const line of report.details) out(`  ${line}`);
        title(`${report.title} (${clock(new Date()).slice(0, 5)})`);
        if (values.bell) ringBell();
        tidyDue();
        out("");
        out(waitingLine);
      }
    }
    if (takenBy !== null) {
      const report = describeTakeover(takenBy, root);
      out("");
      outEmphasis(`━━ ${clock(new Date())} ${report.headline}`);
      for (const line of report.details) out(`  ${line}`);
    }
  } finally {
    listener?.close();
    process.removeListener("SIGINT", onSigint);
    options.signal?.removeEventListener("abort", onAbort);
    if (lock !== null) releaseWatchLock(lock);
    restoreTerminalTitle();
  }
  for (const p of pendingTidy) out(`移す前に終了したため、そのまま残しています: ${p.path}`);
  out("監視を終了しました。");
  return 0;
}

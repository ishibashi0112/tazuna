/**
 * 端末出力のサニタイズ (セキュリティレビュー指摘 4)。
 * changes.md 由来の文字列 (SEARCH 引用・プレビュー・パス表示) には
 * ANSI エスケープ等を仕込めるため、\n \t 以外の C0/C1 制御文字を除去してから出力する。
 * クリップボードへコピーするレポート本文は原文のまま (これは端末を通らない)。
 */
// C0/C1 制御文字 (\n \t 以外) に加え、表示順序を偽装できる双方向制御文字
// (Trojan Source 対策: LRM/RLM/ALM・LRE〜PDF・LRI〜PDI) も除去する
const CONTROL_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]",
  "g",
);

export function sanitizeForTerminal(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}

export const out = (s: string): void => void process.stdout.write(sanitizeForTerminal(s) + "\n");
export const err = (s: string): void => void process.stderr.write(sanitizeForTerminal(s) + "\n");

const RESET = "\u001B[0m";
const BOLD_YELLOW = "\u001B[1;33m";
const BOLD_REVERSE_YELLOW = "\u001B[1;7;33m";

/**
 * 目立たせたい行の出力。装飾コードはこのファイルのリテラル定数のみで、
 * 本文はサニタイズ後に着色するため ANSI 注入対策 (上記) は保たれる。
 * 非 TTY (パイプ・リダイレクト) と NO_COLOR 指定時は装飾なしで出力する。
 */
export const outEmphasis = (s: string, reverse = false): void => {
  const clean = sanitizeForTerminal(s);
  const decorate =
    process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
  const colored = decorate ? `${reverse ? BOLD_REVERSE_YELLOW : BOLD_YELLOW}${clean}${RESET}` : clean;
  process.stdout.write(colored + "\n");
};

// ターミナルのタイトルの保存と復元 (xterm の XTWINOPS 22 / 23。対応しない端末は無視する)
const TITLE_PUSH = "\u001B[22;0t";
const TITLE_POP = "\u001B[23;0t";
const OSC_TITLE_START = "\u001B]0;";
const BEL = "\u0007";
const TITLE_MAX_CHARS = 120;

let savedTitle: { platform: "win32"; title: string } | { platform: "other" } | null = null;

/**
 * ターミナルのタイトルを変える (tazuna watch の結果をタブ・タスクバーで見せる)。非 TTY では何もしない。
 * Windows は process.title (コンソールのタイトル。Windows Terminal にも反映される)、ほかは OSC 0。
 * 制御シーケンスはこのファイルのリテラル定数だけで、本文はサニタイズしてから入れる (ANSI 注入対策)
 */
export function setTerminalTitle(text: string, platform: NodeJS.Platform = process.platform): void {
  if (process.stdout.isTTY !== true) return;
  const clean = sanitizeForTerminal(text).replace(/\n|\t/g, " ").slice(0, TITLE_MAX_CHARS);
  if (platform === "win32") {
    if (savedTitle === null) savedTitle = { platform: "win32", title: process.title };
    process.title = clean;
    return;
  }
  if (savedTitle === null) {
    savedTitle = { platform: "other" };
    process.stdout.write(TITLE_PUSH);
  }
  process.stdout.write(`${OSC_TITLE_START}${clean}${BEL}`);
}

/** setTerminalTitle で変えたタイトルを元に戻す (変えていなければ何もしない) */
export function restoreTerminalTitle(): void {
  if (savedTitle === null) return;
  const saved = savedTitle;
  savedTitle = null;
  if (process.stdout.isTTY !== true) return;
  if (saved.platform === "win32") {
    process.title = saved.title;
    return;
  }
  // タイトルの復元に対応しない端末では、空にしておく (シェルが次のプロンプトで付け直すことが多い)
  process.stdout.write(`${OSC_TITLE_START}${BEL}${TITLE_POP}`);
}

/** 端末のベル (音・タスクバーの点滅など、端末の設定による)。非 TTY では何もしない */
export function ringBell(): void {
  if (process.stdout.isTTY === true) process.stdout.write(BEL);
}

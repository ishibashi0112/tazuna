/**
 * tazuna watch の画面で打つコマンド (1 文字 + Enter) の解釈。純粋関数。
 * 入力の読み取りは infra/watch-keys.ts、実行は commands/watch.ts。
 *
 * キーを押した瞬間に反応させる方式 (raw モード) にしないのは、Ctrl+C が SIGINT ではなくキー入力になって
 * パックやクリップボードの処理の途中で止められなくなるのと、Git Bash (mintty) では端末として読めないのと、
 * 誤って画面に貼り付けた長い文章の中の 1 文字に反応してしまうため (Vite の開発サーバーと同じ「打って Enter」)。
 */

export type WatchCommand = "pack" | "copy" | "build" | "help";

/** 1 回の入力 (ひとかたまりで届いた行) の解釈 */
export type WatchInput =
  | { kind: "command"; command: WatchCommand }
  /** p / c / b / h 以外の 1 行 (キーの一覧を出す) */
  | { kind: "unknown"; text: string }
  /** 複数行がまとめて届いた (画面への貼り付け。何もしない) */
  | { kind: "pasted"; lines: number }
  /** 空行だけ (Enter を押しただけ。何もしない) */
  | { kind: "empty" };

const COMMANDS: Readonly<Record<string, WatchCommand>> = {
  p: "pack",
  c: "copy",
  b: "build",
  h: "help",
  "?": "help",
};

/**
 * ひとかたまりで届いた行 (呼び出し側が短い間隔で届いたものをまとめる) を解釈する。
 * 全角の英字 (IME がオンのときの ｐ) と大文字は同じものとして扱う (NFKC で半角・小文字にそろえる)。
 * 内容のある行が 2 行以上なら貼り付けとみなし、どのコマンドも実行しない
 */
export function interpretWatchInput(lines: readonly string[]): WatchInput {
  const filled = lines.map((line) => line.normalize("NFKC").trim()).filter((line) => line !== "");
  if (filled.length === 0) return { kind: "empty" };
  if (filled.length > 1) return { kind: "pasted", lines: filled.length };
  const text = filled[0] as string;
  const command = COMMANDS[text.toLowerCase()];
  return command === undefined ? { kind: "unknown", text } : { kind: "command", command };
}

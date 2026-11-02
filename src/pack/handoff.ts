/**
 * Copilot Chat への受け渡し(v0.19.0、設計書 §21)。`npx slnmix` の後にクリップボードへ
 * 何を入れるかを決める(純粋関数。クリップボードの書き込みは clipboard.ts)。
 *
 * - パック全体が貼付上限の目安以内 → パック全体(先頭のリマインダと末尾の
 *   <task> / <procedure> / <instruction> を含む)を入れる。本文に 1 回貼るだけで
 *   添付は要らず、全文がコンテキストに入り、手順文・規約文も効く
 * - 超える → 本文用テキスト(.prompt.md と同じ内容)を入れる。パックは添付で渡す
 * - 本文用テキストも無い(--no-procedure かつ規約文・タスクなし)→ 入れない
 */

/**
 * M365 Copilot Chat の入力欄に貼れる上限の目安(文字)。超えると送信ボタンが
 * 非活性になる(2026-09-12 実測: 約 120K 文字。設計書 §15.1)
 */
export const PASTE_LIMIT_CHARS = 120_000;

/**
 * パックのうちファイルの中身以外(手順文・規約文・ディレクトリ構成など)のおおよその大きさ(文字)。
 * init の大きさの目安に使う(2026-11-02 の実測で、小さいプロジェクトのパックが約 21K 文字)
 */
export const PACK_OVERHEAD_CHARS = 20_000;

export type HandoffPlan =
  | { kind: "paste-pack"; text: string }
  | { kind: "paste-prompt"; text: string }
  | { kind: "none" };

/**
 * @param packContent パック全体(ファイルに書く内容。BOM なし)
 * @param promptText 本文用テキスト(無ければ undefined)
 * @param pasteLimit 貼付上限の目安(文字)
 */
export function planHandoff(
  packContent: string,
  promptText: string | undefined,
  pasteLimit: number,
): HandoffPlan {
  if (packContent.length <= pasteLimit) {
    return { kind: "paste-pack", text: packContent };
  }
  if (promptText !== undefined) {
    return { kind: "paste-prompt", text: promptText };
  }
  return { kind: "none" };
}

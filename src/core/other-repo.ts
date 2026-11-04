/**
 * changes.md が別のリポジトリ向けらしいかの判定 (純粋ロジック。§4.7)。
 *
 * tazuna watch は起動したリポジトリだけを見張るが、Downloads は複数のリポジトリで共通のため、
 * 別のリポジトリのチャットの changes.md も届く。当てに行くと、対象のファイルが無いという失敗レポートで
 * クリップボードを上書きしてしまう (別の watch が正しいリポジトリに当てるはずのものでも)。
 *
 * 次のすべてを満たすときだけ「別のリポジトリ向けらしい」とする。迷う形は false (従来どおり失敗レポート):
 * - 既存のファイルを変える操作 (replace / rewrite) が 1 つ以上ある
 * - changes.md が挙げるファイル (どの操作でも) が、ルートに 1 つも無い
 * - replace / rewrite の対象と同じ名前のファイルが、リポジトリのどこにも無い
 *   (同じ名前があれば、AI がフォルダを書き違えた可能性が高い。そのときは失敗レポートが役に立つ)
 * リポジトリのファイル名の一覧が得られないとき (git のリポジトリでない・git が無い) は判定しない
 *
 * create だけの changes.md は見分けられない (どのリポジトリにも作れるため)
 */
import type { FileChange } from "../types.ts";

/** パスの最後の名前 (区切りは / と \ の両方。大文字小文字は区別しない) */
export function fileNameKey(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).toLowerCase();
}

export function looksLikeOtherRepository(
  changes: readonly FileChange[],
  existsInRoot: (path: string) => boolean,
  repositoryFileNames: ReadonlySet<string> | null,
): boolean {
  if (repositoryFileNames === null) return false;
  const modifying = changes.filter((c) => c.op === "replace" || c.op === "rewrite");
  if (modifying.length === 0) return false;
  if (changes.some((c) => existsInRoot(c.path))) return false;
  return modifying.every((c) => !repositoryFileNames.has(fileNameKey(c.path)));
}

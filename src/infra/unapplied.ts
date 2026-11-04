/**
 * tazuna watch が当てなかった changes.md の置き場 (.tazuna/unapplied/。旧版の .petari/ だけがあればそちら。§4.7)。
 * 失敗した・適用済みだった・二重適用で止めた changes.md を Downloads から移し、Downloads に溜めない
 * (次の返答が "changes (3).md" のような連番にならず、引数なしの tazuna が古いものを拾わない)。
 */
import { constants, copyFileSync, lstatSync, mkdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { isInsideRoot } from "./files.ts";
import { stateDir } from "./history.ts";

export function unappliedDir(root: string): string {
  return join(stateDir(root), "unapplied");
}

/** 移した先のファイル名: YYYY-MM-DD_HHmmss_<元の名前>。同じ秒の衝突は _2, _3 … */
export function unappliedFileName(original: string, now: Date, n = 1): string {
  const pad = (v: number): string => String(v).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return n === 1 ? `${stamp}_${original}` : `${stamp}_${n}_${original}`;
}

/** そのパスに何かある (壊れた symlink も含む) */
function taken(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * ファイルを置き場へ移し、移した先の絶対パスを返す。置き場 (unapplied/ 自身や状態ディレクトリ) が
 * symlink でルートの外を指すときは移さずに例外。
 * Downloads と別のドライブなら写してから元を消す。元を消せなければ写しを消して例外 (元はそのまま)
 */
export function moveToUnapplied(root: string, path: string, now: Date): string {
  const dir = unappliedDir(root);
  // isInsideRoot は親ディレクトリの実体を見るので、置き場の中の名前で確かめる (置き場自身の symlink も解決される)
  if (!isInsideRoot(root, join(dir, "x"))) {
    throw new Error(`${dir} がプロジェクトの外を指しています`);
  }
  mkdirSync(dir, { recursive: true });
  const original = basename(path);
  let dest = join(dir, unappliedFileName(original, now));
  for (let n = 2; taken(dest); n++) dest = join(dir, unappliedFileName(original, now, n));
  try {
    renameSync(path, dest);
    return dest;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
  }
  // 写し先に後から置かれた symlink を辿らない (EXCL は既にあれば失敗する)
  copyFileSync(path, dest, constants.COPYFILE_EXCL);
  try {
    unlinkSync(path);
  } catch (e) {
    rmSync(dest, { force: true });
    throw e;
  }
  return dest;
}

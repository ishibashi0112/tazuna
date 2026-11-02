/**
 * 最寄りのプロジェクトファイル (.vbproj / .csproj) の探索 (設計書 §11.1)。ファイル I/O のみ。
 * 判定・挿入は core/vbproj.ts。
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type VbprojLookup =
  /** path はルート相対 (/ 区切り) */
  | { kind: "found"; path: string }
  | { kind: "none" }
  /** 同じディレクトリに複数あり、人が決める必要がある */
  | { kind: "multiple"; dir: string; names: string[] }
  /** 最寄りのプロジェクトファイルが別の言語のもの (.vb の最寄りが .csproj など)。path はその 1 つ */
  | { kind: "other-language"; path: string };

const PROJECT_FILE = /\.(vbproj|csproj)$/i;

function listProjectFiles(absDir: string): string[] | null {
  try {
    return readdirSync(absDir, { withFileTypes: true })
      // 書き込み対象になるため symlink は除外する (Dirent 判定・§9)
      .filter((e) => e.isFile() && PROJECT_FILE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return null; // 未作成ディレクトリ (create 先) は手本なしとして上へ辿る
  }
}

/**
 * ルート相対ディレクトリ relDir から上へ辿り、プロジェクトルートまでの間で最寄りのプロジェクトファイル
 * (.vbproj / .csproj) のあるディレクトリを探し、その中から拡張子 extension (".vbproj" / ".csproj") のものを返す。
 * 最寄りのディレクトリに別の言語のプロジェクトファイルしかなければ other-language (それより上は探さない。
 * そのプロジェクトの配下のファイルを、上にある別のプロジェクトに登録しないため)。ルートの外には出ない。
 */
export function findNearestVbproj(root: string, relDir: string, extension = ".vbproj"): VbprojLookup {
  let dir = relDir === "." ? "" : relDir;
  for (;;) {
    const all = listProjectFiles(dir === "" ? root : join(root, dir));
    if (all !== null && all.length > 0) {
      const names = all.filter((name) => name.toLowerCase().endsWith(extension.toLowerCase()));
      const at = (name: string): string => (dir === "" ? name : `${dir}/${name}`);
      if (names.length === 1) return { kind: "found", path: at(names[0] as string) };
      if (names.length > 1) return { kind: "multiple", dir: dir === "" ? "." : dir, names };
      return { kind: "other-language", path: at(all[0] as string) };
    }
    if (dir === "") return { kind: "none" };
    const parent = dirname(dir);
    dir = parent === "." ? "" : parent;
  }
}

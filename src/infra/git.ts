import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * 未コミット変更のあるファイル一覧 (§9)。
 * Git が使えない / リポジトリでない場合は null (Git は必須ではない)。
 */
export async function gitDirtyFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileP("git", ["status", "--porcelain"], { cwd: root });
    return stdout.split("\n").filter((l) => l.trim() !== "");
  } catch {
    return null;
  }
}

/**
 * git が管理しているファイル(追跡中 + .gitignore に一致しない未追跡)のルート相対パス(`/` 区切り)。
 * `git ls-files` はカレント配下だけを、カレントからの相対で返すので、ルートで実行する。
 * 子プロセスは配列引数(シェル非経由)。
 */
export function listGitFiles(rootDir: string): { ok: true; files: string[] } | { ok: false; message: string } {
  const result = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: rootDir,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return { ok: false, message: code === "ENOENT" ? "git が見つかりません" : result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.toString("utf8").trim().split(/\r?\n/)[0] ?? "";
    return { ok: false, message: detail === "" ? `git ls-files が終了コード ${result.status ?? "不明"} で終了しました` : detail };
  }
  // 競合中のファイルは段ごとに並ぶので重ねない
  const files = [...new Set(result.stdout.toString("utf8").split("\0").filter((p) => p !== ""))];
  return { ok: true, files };
}

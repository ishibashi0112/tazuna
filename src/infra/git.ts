import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { TOOL_NAME } from "../brand.ts";

const execFileP = promisify(execFile);

/**
 * git を読み取りだけで呼ぶための共通の指定。
 * - `core.fsmonitor=false`: リポジトリの設定 (.git/config) に書かれたコマンドを git status / ls-files の
 *   ついでに実行させない (設定が書き換えられていた場合の備え。changes.md からは .git に書けない)
 * - `GIT_OPTIONAL_LOCKS=0`: git status が索引 (.git/index) を書き直さない。VS Code のソース管理などが
 *   同時に動いていても index.lock でぶつからない。古い git は知らない環境変数を無視する
 *   (`--no-optional-locks` は git 2.15 未満で使えない)
 */
const GIT_READ_ONLY_ARGS = ["-c", "core.fsmonitor=false"] as const;

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
}

/**
 * 未コミット変更のあるファイル一覧 (§9)。
 * Git が使えない / リポジトリでない場合は null (Git は必須ではない)。
 */
export async function gitDirtyFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileP("git", [...GIT_READ_ONLY_ARGS, "status", "--porcelain"], {
      cwd: root,
      env: gitEnv(),
      windowsHide: true,
    });
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
  const result = spawnSync(
    "git",
    [...GIT_READ_ONLY_ARGS, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: rootDir,
      env: gitEnv(),
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
      timeout: 60_000,
    },
  );
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

export type GitCommitResult =
  | { kind: "committed"; sha: string; files: string[] }
  /** 対象のファイルに HEAD との差が無い (利用者がコミット済み・元に戻した) */
  | { kind: "nothing" }
  /** git が無い・git のリポジトリでない */
  | { kind: "not-repo"; message: string }
  | { kind: "failed"; message: string };

/** git を同期で実行する (読み取りと同じ指定に加えて、パスを文字どおりに扱い、フックを動かさない) */
function runGit(
  cwd: string,
  args: readonly string[],
  noHooksDir: string,
  input?: string,
): { status: number | null; stdout: Buffer; stderr: string; error?: NodeJS.ErrnoException } {
  const result = spawnSync("git", [...GIT_READ_ONLY_ARGS, "-c", `core.hooksPath=${noHooksDir}`, ...args], {
    cwd,
    // パスの * や :(glob) をパターンとして読ませない (ファイル名どおりのものだけを対象にする)
    env: { ...gitEnv(), GIT_LITERAL_PATHSPECS: "1" },
    input,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
    ...(result.error !== undefined ? { error: result.error as NodeJS.ErrnoException } : {}),
  };
}

const nulList = (out: Buffer): string[] => out.toString("utf8").split("\0").filter((p) => p !== "");

/** 存在しないディレクトリ (乱数入り)。フックの置き場に指定して、どのフックも見つからないようにする */
const noHooksDirectory = (): string => join(tmpdir(), `${TOOL_NAME}-no-hooks-${randomBytes(8).toString("hex")}`);

/** パスの照合用 (Windows・macOS の大文字小文字を区別しないファイルシステムで、git が実際の綴りで返すため) */
const pathKey = (path: string): string => path.toLowerCase();

/**
 * git が返した一覧のうち、指定したファイルそのものだけ。manifest は非信頼入力で、`.` やディレクトリの名前を
 * 書けば git はその下のファイルすべてに当てはめる (未追跡のものまで git add してしまう) ため、名前の一致で絞る
 */
function onlyNamed(listed: readonly string[], paths: readonly string[]): string[] {
  const wanted = new Set(paths.map(pathKey));
  return listed.filter((p) => wanted.has(pathKey(p)));
}

/** git の出力の先頭の数行 (失敗の理由として見せる) */
const firstLines = (text: string, n = 8): string =>
  text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l !== "")
    .slice(0, n)
    .join("\n");

/**
 * 指定したファイル (ルート相対・`/` 区切り) だけをコミットする (1 回の適用 = 1 コミット)。
 * - 未追跡のものは `git add` してから (.gitignore に一致するものは入れない)
 * - `git commit --only` なので、ほかのファイルの手元の変更・ステージ済みの変更はコミットに入らない
 * - メッセージは標準入力から渡す (AI の書いた概要を引数にしない。長さの制限も受けない)
 * - フックは動かさない (core.hooksPath を存在しない場所に向ける)。フックの置き場が作業ツリーにある
 *   リポジトリ (husky など) では、確かめる前の changes.md が書き換えたフックを動かしてしまうため
 */
export function commitPaths(rootDir: string, paths: readonly string[], message: string): GitCommitResult {
  if (paths.length === 0) return { kind: "nothing" };
  const noHooksDir = noHooksDirectory();
  const git = (args: readonly string[], input?: string) => runGit(rootDir, args, noHooksDir, input);

  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.error !== undefined) {
    return {
      kind: "not-repo",
      message: inside.error.code === "ENOENT" ? "git が見つかりません" : inside.error.message,
    };
  }
  if (inside.status !== 0 || inside.stdout.toString("utf8").trim() !== "true") {
    return { kind: "not-repo", message: firstLines(inside.stderr, 1) || "git のリポジトリではありません" };
  }

  const tracked = git(["ls-files", "-z", "--cached", "--", ...paths]);
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard", "--", ...paths]);
  if (tracked.status !== 0 || untracked.status !== 0) {
    return { kind: "failed", message: firstLines(tracked.stderr || untracked.stderr) || "git ls-files に失敗しました" };
  }
  const added = onlyNamed(nulList(untracked.stdout), paths);
  const targets = [...new Set([...onlyNamed(nulList(tracked.stdout), paths), ...added])];
  if (targets.length === 0) return { kind: "nothing" };
  if (added.length > 0) {
    const add = git(["add", "--", ...added]);
    if (add.status !== 0) return { kind: "failed", message: firstLines(add.stderr) || "git add に失敗しました" };
  }
  const status = git(["status", "--porcelain", "-z", "--", ...targets]);
  if (status.status !== 0) return { kind: "failed", message: firstLines(status.stderr) || "git status に失敗しました" };
  if (nulList(status.stdout).length === 0) return { kind: "nothing" };

  const commit = git(["commit", "--only", "--no-verify", "--cleanup=whitespace", "-F", "-", "--", ...targets], message);
  if (commit.error !== undefined) return { kind: "failed", message: commit.error.message };
  if (commit.status !== 0) {
    return {
      kind: "failed",
      message: firstLines(commit.stderr) || firstLines(commit.stdout.toString("utf8")) || "git commit に失敗しました",
    };
  }
  const head = git(["rev-parse", "HEAD"]);
  return { kind: "committed", sha: head.stdout.toString("utf8").trim(), files: targets };
}

/**
 * 指定したファイルのうち、HEAD と内容の違うもの (未追跡で .gitignore に一致しないものを含む) の照合用の名前
 * (小文字)。まとめてコミットするときに、git で元に戻した回を見分ける。git が無い・リポジトリでなければ null
 */
export function changedPathKeys(rootDir: string, paths: readonly string[]): Set<string> | null {
  if (paths.length === 0) return new Set();
  const status = runGit(rootDir, ["status", "--porcelain", "-z", "--", ...paths], noHooksDirectory());
  if (status.error !== undefined || status.status !== 0) return null;
  const changed = new Set<string>();
  const entries = nulList(status.stdout);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as string;
    changed.add(pathKey(entry.slice(3)));
    // 名前の変更 (R) と写し (C) は、次の項目が元の名前
    if (entry[0] === "R" || entry[0] === "C") {
      const from = entries[i + 1];
      if (from !== undefined) changed.add(pathKey(from));
      i++;
    }
  }
  return changed;
}

/**
 * 今の HEAD のコミット。コミットがまだ無いリポジトリでは null、git が無い・リポジトリでなければ undefined。
 * 適用のときに manifest に残し、次の適用の前のコミットで「その間に利用者がコミットしたか」を見分ける
 */
export function gitHeadCommit(rootDir: string): string | null | undefined {
  const run = (args: readonly string[]) =>
    spawnSync("git", [...GIT_READ_ONLY_ARGS, ...args], { cwd: rootDir, env: gitEnv(), windowsHide: true, timeout: 60_000 });
  const inside = run(["rev-parse", "--is-inside-work-tree"]);
  if (inside.error !== undefined || inside.status !== 0 || inside.stdout.toString("utf8").trim() !== "true") return undefined;
  const head = run(["rev-parse", "--verify", "-q", "HEAD"]);
  if (head.error !== undefined) return undefined;
  return head.status === 0 ? head.stdout.toString("utf8").trim() : null;
}

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCommand } from "../src/commands/apply.ts";
import { commitCommand } from "../src/commands/commit.ts";
import { describeWatchResult } from "../src/commands/watch.ts";
import { undoCommand } from "../src/commands/undo.ts";
import { buildCommitMessage, SUBJECT_MAX_CHARS } from "../src/core/commit-message.ts";
import { listHistoryIds, readManifest } from "../src/infra/history.ts";

const doc = (...lines: string[]): string => lines.join("\n");

describe("buildCommitMessage (changes.md の概要 → コミットメッセージ)", () => {
  it("最初の行の最初の「。」までを件名にし、その行から本文に入れる。影響ファイルとコードブロックは除く", () => {
    const header = doc(
      "受注画面の初期値を 2 にする。業務からの依頼のため。",
      "",
      "影響ファイル:",
      "- src/Orders/OrderForm.vb",
      "- src/Orders/OrderForm.Designer.vb",
      "",
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "",
      "検証は手動で行う。",
    );
    const m = buildCommitMessage(header, "2026-11-05_0900", 2);
    expect(m.subject).toBe("受注画面の初期値を 2 にする");
    expect(m.message).toBe(
      doc(
        "受注画面の初期値を 2 にする",
        "",
        "受注画面の初期値を 2 にする。業務からの依頼のため。",
        "",
        "検証は手動で行う。",
        "",
        "Tazuna-History: 2026-11-05_0900",
        "",
      ),
    );
  });

  it("1 文だけの行はその行を件名にし、本文は次の行から (見出し・強調の記号は外す)", () => {
    const m = buildCommitMessage(doc("## **CSV 出力を追加した。**", "", "理由: 月次の集計に使う"), "id", 1);
    expect(m.subject).toBe("CSV 出力を追加した");
    expect(m.message).toBe(doc("CSV 出力を追加した", "", "理由: 月次の集計に使う", "", "Tazuna-History: id", ""));
  });

  it("長い件名は切り詰め、全文を本文に残す", () => {
    const long = "あ".repeat(SUBJECT_MAX_CHARS + 10);
    const m = buildCommitMessage(long, "id", 1);
    expect([...m.subject]).toHaveLength(SUBJECT_MAX_CHARS);
    expect(m.subject.endsWith("…")).toBe(true);
    expect(m.message).toContain(`\n\n${long}\n`);
  });

  it("概要が空なら既定の件名。制御文字と双方向制御文字は除く", () => {
    expect(buildCommitMessage("", "id", 3).subject).toBe("tazuna で changes.md を適用 (3 ファイル)");
    const m = buildCommitMessage("修正\u001B[31m‮した\r\n次の行", "id", 1);
    expect(m.subject).toBe("修正[31mした");
    expect(m.message).not.toMatch(/[\u001B‮\r]/);
  });
});

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe.skipIf(!hasGit)("1 回の適用 = 1 コミット (git.commitEachApply / tazuna commit)", () => {
  let output: string[];
  beforeEach(() => {
    output = [];
    const capture = (chunk: string | Uint8Array): boolean => {
      output.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
  });
  afterEach(() => vi.restoreAllMocks());

  function git(root: string, ...args: string[]): string {
    const r = spawnSync("git", args, { cwd: root });
    expect(r.status, `git ${args.join(" ")}: ${r.stderr.toString()}`).toBe(0);
    return r.stdout.toString("utf8");
  }

  /** git のリポジトリ (初期コミットあり) と、changes.md を置くルートの外のディレクトリ */
  function setup(options: { commitEachApply?: boolean; initialCommit?: boolean } = {}): { root: string; drop: string } {
    const root = mkdtempSync(join(tmpdir(), "tazuna-commit-"));
    const drop = mkdtempSync(join(tmpdir(), "tazuna-commit-drop-"));
    git(root, "init", "-q", ".");
    git(root, "config", "user.name", "tester");
    git(root, "config", "user.email", "tester@example.com");
    git(root, "config", "commit.gpgsign", "false");
    mkdirSync(join(root, ".tazuna"));
    writeFileSync(
      join(root, ".tazuna", "config.json"),
      JSON.stringify({ clipReportOnFailure: false, git: { commitEachApply: options.commitEachApply ?? true } }),
    );
    writeFileSync(join(root, ".gitignore"), ".tazuna/\nignored/\n");
    writeFileSync(join(root, "a.txt"), "one\n");
    writeFileSync(join(root, "old.txt"), "obsolete\n");
    writeFileSync(join(root, "other.txt"), "other\n");
    if (options.initialCommit ?? true) {
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "init");
    }
    return { root, drop };
  }

  const changes = (summary: string, ...sections: string[]): string => doc("## CHANGES", "", summary, "", ...sections, "");
  const replace = (path: string, from: string, to: string): string =>
    doc(`### FILE: ${path} (replace)`, "<<<<<<< SEARCH", from, "=======", to, ">>>>>>> REPLACE", "");

  async function apply(root: string, drop: string, name: string, text: string): Promise<number> {
    const p = join(drop, name);
    writeFileSync(p, text, "utf8");
    return applyCommand([p, "--root", root, "--yes"]);
  }

  const log = (root: string): string[] => git(root, "log", "--format=%s").trim().split("\n");
  const filesOf = (root: string, rev: string): string[] =>
    git(root, "show", "--name-only", "--format=", rev).trim().split("\n").filter((l) => l !== "").sort();
  const status = (root: string): string[] =>
    git(root, "status", "--porcelain").split("\n").filter((l) => l !== "").sort();

  it("次の changes.md を当てる直前に、前回の分 (手修正を含む・tazuna が書いたファイルだけ) をコミットする", async () => {
    const { root, drop } = setup();
    const first = changes(
      "a を two にする。確認のため。",
      replace("a.txt", "one", "two"),
      doc("### FILE: b.txt (create)", "<<<<<<< CONTENT", "bee", ">>>>>>> END", ""),
      "### FILE: old.txt (delete)",
      "",
    );
    expect(await apply(root, drop, "c1.md", first)).toBe(0);
    // 当てた直後はコミットしない (git diff で確かめられる)
    expect(log(root)).toEqual(["init"]);
    expect(output.join("")).toContain("次の changes.md を当てる前に「a を two にする」でコミットします");

    // 確かめる間の手修正 (b.txt) と、関係のないファイルの変更 (other.txt)・ステージ済みの変更
    writeFileSync(join(root, "b.txt"), "bee (hand)\n");
    writeFileSync(join(root, "other.txt"), "other changed\n");
    writeFileSync(join(root, "staged.txt"), "staged\n");
    git(root, "add", "staged.txt");

    expect(await apply(root, drop, "c2.md", changes("a を three にする", replace("a.txt", "two", "three")))).toBe(0);
    expect(log(root)).toEqual(["a を two にする", "init"]);
    expect(filesOf(root, "HEAD")).toEqual(["a.txt", "b.txt", "old.txt"]);
    expect(git(root, "show", "HEAD:b.txt")).toBe("bee (hand)\n");
    expect(git(root, "show", "HEAD:a.txt")).toBe("two\n");
    const body = git(root, "log", "-1", "--format=%B");
    const ids = listHistoryIds(root);
    expect(body).toContain(`Tazuna-History: ${ids[0]}`);
    // git diff には 2 回目の分だけが出る。ほかの手元の変更・ステージ済みの変更はそのまま
    expect(status(root)).toEqual(["A  staged.txt", " M a.txt", " M other.txt"].sort());
    expect(readManifest(root, ids[0] as string)?.committed?.sha).toBe(git(root, "rev-parse", "HEAD~0").trim());

    // バッチの最後は tazuna commit で締める
    expect(await commitCommand(["--root", root])).toBe(0);
    expect(log(root)).toEqual(["a を three にする", "a を two にする", "init"]);
    expect(filesOf(root, "HEAD")).toEqual(["a.txt"]);
    expect(status(root)).toEqual(["A  staged.txt", " M other.txt"].sort());
    // もうコミットするものはない
    output = [];
    expect(await commitCommand(["--root", root])).toBe(0);
    expect(output.join("")).toContain("コミットしていない適用はありません");
  });

  it("設定が無効なら自動ではコミットしないが、tazuna commit は使える", async () => {
    const { root, drop } = setup({ commitEachApply: false });
    expect(await apply(root, drop, "c1.md", changes("一つ目", replace("a.txt", "one", "two")))).toBe(0);
    expect(await apply(root, drop, "c2.md", changes("二つ目", replace("a.txt", "two", "three")))).toBe(0);
    expect(log(root)).toEqual(["init"]);
    expect(output.join("")).not.toContain("コミットします");
    expect(await commitCommand(["--root", root])).toBe(0);
    expect(log(root)).toEqual(["二つ目", "init"]);
  });

  it("前回の適用の後に利用者がコミットしていれば、自動ではコミットしない (手修正を前回のメッセージで入れない)", async () => {
    const { root, drop } = setup();
    expect(await apply(root, drop, "c1.md", changes("一つ目", replace("a.txt", "one", "two")))).toBe(0);
    git(root, "commit", "-q", "-am", "自分でコミット");
    writeFileSync(join(root, "a.txt"), "two (hand)\n");
    output = [];
    expect(await apply(root, drop, "c2.md", changes("二つ目", replace("other.txt", "other", "other2")))).toBe(0);
    expect(log(root)).toEqual(["自分でコミット", "init"]);
    expect(output.join("")).toContain("ご自身でコミットしたものとみなします");
    expect(status(root)).toEqual([" M a.txt", " M other.txt"]);
  });

  it("コミットできなければ、次の changes.md は当てない (index.lock がある)", async () => {
    const { root, drop } = setup();
    expect(await apply(root, drop, "c1.md", changes("一つ目", replace("a.txt", "one", "two")))).toBe(0);
    writeFileSync(join(root, ".git", "index.lock"), "");
    output = [];
    expect(await apply(root, drop, "c2.md", changes("二つ目", replace("other.txt", "other", "other2")))).toBe(1);
    expect(output.join("")).toContain("コミットできなかったため、この changes.md は当てていません");
    expect(readFileSync(join(root, "other.txt"), "utf8")).toBe("other\n");
    expect(listHistoryIds(root)).toHaveLength(1);
  });

  it("フックは動かさない (フックの置き場が作業ツリーにあっても)", async () => {
    const { root, drop } = setup();
    mkdirSync(join(root, "hooks"));
    for (const hook of ["pre-commit", "commit-msg", "post-commit", "prepare-commit-msg"]) {
      writeFileSync(join(root, "hooks", hook), `#!/bin/sh\ntouch hook-${hook}-ran\nexit 1\n`, { mode: 0o755 });
    }
    git(root, "config", "core.hooksPath", "hooks");
    expect(await apply(root, drop, "c1.md", changes("一つ目", replace("a.txt", "one", "two")))).toBe(0);
    expect(await commitCommand(["--root", root])).toBe(0);
    expect(log(root)).toEqual(["一つ目", "init"]);
    for (const hook of ["pre-commit", "commit-msg", "post-commit", "prepare-commit-msg"]) {
      expect(existsSync(join(root, `hook-${hook}-ran`)), hook).toBe(false);
    }
  });

  it(".gitignore に一致する新しいファイルはコミットに入れず、ファイル名の [ ] はパターンとして読まない", async () => {
    const { root, drop } = setup();
    writeFileSync(join(root, "x1.txt"), "x1\n");
    writeFileSync(join(root, "x2.txt"), "x2\n");
    git(root, "add", "x1.txt", "x2.txt");
    git(root, "commit", "-q", "-m", "x");
    writeFileSync(join(root, "x1.txt"), "x1 changed\n");
    const text = changes(
      "二つ作る",
      doc("### FILE: ignored/a.txt (create)", "<<<<<<< CONTENT", "secret", ">>>>>>> END", ""),
      doc("### FILE: x[12].txt (create)", "<<<<<<< CONTENT", "star", ">>>>>>> END", ""),
    );
    expect(await apply(root, drop, "c1.md", text)).toBe(0);
    expect(await commitCommand(["--root", root])).toBe(0);
    expect(filesOf(root, "HEAD")).toEqual(["x[12].txt"]);
    // パターンとして読めば x1.txt の手元の変更まで入ってしまう (Windows ではファイル名に * を使えないため [ ] で確かめる)
    expect(status(root)).toEqual([" M x1.txt"]);
  });

  it("コミットがまだ無いリポジトリでも、最初のコミットとして作れる", async () => {
    const { root, drop } = setup({ initialCommit: false });
    expect(await apply(root, drop, "c1.md", changes("最初", replace("a.txt", "one", "two")))).toBe(0);
    expect(await commitCommand(["--root", root])).toBe(0);
    expect(log(root)).toEqual(["最初"]);
    expect(filesOf(root, "HEAD")).toEqual(["a.txt"]);
  });

  it("コミット済みの適用は undo せず、git revert を案内する。コミットしていない最後の 1 回は undo できる", async () => {
    const { root, drop } = setup();
    expect(await apply(root, drop, "c1.md", changes("一つ目", replace("a.txt", "one", "two")))).toBe(0);
    expect(await apply(root, drop, "c2.md", changes("二つ目", replace("a.txt", "two", "three")))).toBe(0);
    expect(await undoCommand(["--root", root, "--yes"])).toBe(0);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("two\n");
    output = [];
    expect(await undoCommand(["--root", root, "--yes"])).toBe(1);
    const sha = git(root, "rev-parse", "--short=7", "HEAD").trim();
    expect(output.join("")).toContain(`git revert ${sha}`);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("two\n");
  });

  it("git のリポジトリでなければ、コミットせずに当てる", async () => {
    const root = mkdtempSync(join(tmpdir(), "tazuna-commit-norepo-"));
    const drop = mkdtempSync(join(tmpdir(), "tazuna-commit-drop-"));
    mkdirSync(join(root, ".tazuna"));
    writeFileSync(join(root, ".tazuna", "config.json"), JSON.stringify({ clipReportOnFailure: false, git: { commitEachApply: true } }));
    writeFileSync(join(root, "a.txt"), "one\n");
    expect(await apply(root, drop, "c1.md", changes("一つ目", replace("a.txt", "one", "two")))).toBe(0);
    expect(await apply(root, drop, "c2.md", changes("二つ目", replace("a.txt", "two", "three")))).toBe(0);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("three\n");
  });
});

describe("watch の結果の知らせ (commit-failed)", () => {
  it("コミットできずに止めたときは、当て直すコマンドを示し、changes.md は残す", () => {
    const r = describeWatchResult(
      { kind: "commit-failed", files: 0, reportCopied: false },
      { path: "/dl/changes.md", tidy: null, rootOption: null },
    );
    expect(r.headline).toContain("コミットできなかったため");
    expect(r.details.join("\n")).toContain('tazuna "/dl/changes.md"');
  });
});

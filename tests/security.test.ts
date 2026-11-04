import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCommand } from "../src/commands/apply.ts";
import { invalidVscodeCommandReason, showCommand } from "../src/commands/show.ts";
import { undoCommand } from "../src/commands/undo.ts";
import { invalidPathReason } from "../src/core/applier.ts";
import { isInsideRoot } from "../src/infra/files.ts";
import { gitDirtyFiles, listGitFiles } from "../src/infra/git.ts";
import { listHistoryIds, readManifest, type Manifest } from "../src/infra/history.ts";
import { restoreTerminalTitle, ringBell, sanitizeForTerminal, setTerminalTitle } from "../src/infra/term.ts";

const doc = (...lines: string[]): string => lines.join("\n");

const simpleChanges = (path: string): string =>
  doc(
    "## CHANGES",
    "概要",
    `### FILE: ${path} (replace)`,
    "<<<<<<< SEARCH",
    "hello",
    "=======",
    "goodbye",
    ">>>>>>> REPLACE",
  );

describe("invalidPathReason: Windows 特殊パス (指摘 6)", () => {
  it("代替データストリーム (:) を拒否する", () => {
    expect(invalidPathReason("src/a.txt:stream")).not.toBeNull();
  });
  it("予約デバイス名を拒否する (拡張子付き・大文字小文字問わず)", () => {
    expect(invalidPathReason("CON")).not.toBeNull();
    expect(invalidPathReason("src/nul.txt")).not.toBeNull();
    expect(invalidPathReason("src/COM1")).not.toBeNull();
    expect(invalidPathReason("lpt9.vb")).not.toBeNull();
  });
  it("紛らわしいが正当な名前は許可する", () => {
    expect(invalidPathReason("src/console.ts")).toBeNull();
    expect(invalidPathReason("src/nullable.vb")).toBeNull();
    expect(invalidPathReason("com10/x.ts")).toBeNull();
  });
  it("末尾ドット/空白での予約名バイパスを拒否する (Windows は末尾を無視して解釈)", () => {
    expect(invalidPathReason("src/con.")).not.toBeNull();
    expect(invalidPathReason("src/aux.txt ")).not.toBeNull();
    expect(invalidPathReason("nul...")).not.toBeNull();
  });
});

describe("invalidPathReason: .git と状態ディレクトリ (2026-11-04)", () => {
  it(".git の中・.git 自体を拒否する (どの階層でも、大文字小文字・末尾のドットと空白・短い名前も)", () => {
    for (const p of [
      ".git/config",
      ".git/hooks/pre-commit",
      ".git",
      "sub/.git/config",
      ".GIT/config",
      ".Git/HEAD",
      ".git./config",
      ".git /config",
      "GIT~1/config",
      "git~2/hooks/post-checkout",
      ".g‌it/config",
      "﻿.git/config",
      // manifest のパスはパーサーを通らないため `\` 区切りのこともある (Windows では区切りになる)
      ".git\\config",
      "sub\\.git\\hooks\\pre-commit",
    ]) {
      expect(invalidPathReason(p), p).toContain("'.git' の中は変更できません");
    }
  });
  it("状態ディレクトリ (.tazuna / .petari) の中を拒否する", () => {
    for (const p of [".tazuna/config.json", ".petari/history/x/manifest.json", "menu/.TAZUNA/config.json", "TAZUNA~1/config.json"]) {
      expect(invalidPathReason(p), p).toContain("状態ディレクトリ");
    }
  });
  it("`\\` 区切りの `..` も拒否する (manifest のパス)", () => {
    expect(invalidPathReason("..\\evil.txt")).not.toBeNull();
    expect(invalidPathReason("src\\..\\..\\evil.txt")).not.toBeNull();
  });
  it("git の関連ファイルなど、紛らわしいが正当な名前は許可する", () => {
    for (const p of [
      ".gitignore",
      ".gitattributes",
      ".gitmodules",
      ".github/workflows/ci.yml",
      "docs/.gitkeep",
      "src/git/status.ts",
      "src/.git-blame-ignore-revs",
      "git~/x.ts",
      ".tazuna.config.json",
      "tazuna.config.json",
      "src/petari/a.ts",
    ]) {
      expect(invalidPathReason(p), p).toBeNull();
    }
  });

  it("apply は .git に書く changes.md を検証段階で失敗させ、何も書かない", async () => {
    const root = mkdtempSync(join(tmpdir(), "tazuna-sec-git-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "[core]\n\tbare = false\n");
    writeFileSync(join(root, "a.txt"), "hello\n");
    mkdirSync(join(root, ".tazuna"), { recursive: true });
    writeFileSync(join(root, ".tazuna", "config.json"), JSON.stringify({ clipReportOnFailure: false }), "utf8");
    const changesPath = join(root, "changes.md");
    writeFileSync(
      changesPath,
      doc(
        "## CHANGES",
        "概要",
        "### FILE: a.txt (replace)",
        "<<<<<<< SEARCH",
        "hello",
        "=======",
        "goodbye",
        ">>>>>>> REPLACE",
        "### FILE: .git/config (replace)",
        "<<<<<<< SEARCH",
        "[core]",
        "=======",
        "[core]",
        '\tfsmonitor = "touch pwned"',
        ">>>>>>> REPLACE",
        "### FILE: .git/hooks/pre-commit (create)",
        "<<<<<<< CONTENT",
        "#!/bin/sh",
        ">>>>>>> END",
      ),
      "utf8",
    );
    // --partial でも .git の分は書かない (検証の失敗としてスキップされる)
    expect(await applyCommand([changesPath, "--root", root, "--yes", "--partial"])).toBe(0);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("goodbye\n");
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe("[core]\n\tbare = false\n");
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("undo は .git を指す manifest で巻き戻さない", async () => {
    const root = mkdtempSync(join(tmpdir(), "tazuna-sec-git-undo-"));
    writeFileSync(join(root, "a.txt"), "hello\n");
    const changesPath = join(root, "changes.md");
    writeFileSync(changesPath, simpleChanges("a.txt"), "utf8");
    expect(await applyCommand([changesPath, "--root", root, "--yes"])).toBe(0);
    const id = listHistoryIds(root)[0] as string;
    const manifestPath = join(root, ".tazuna", "history", id, "manifest.json");
    const manifest = readManifest(root, id) as Manifest;
    (manifest.files[0] as { path: string }).path = ".git/config";
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    // 巻き戻す材料 (before) もそろえておく (パスの検証が無ければ .git/config を書いてしまう状態)
    mkdirSync(join(root, ".tazuna", "history", id, "before", ".git"), { recursive: true });
    writeFileSync(join(root, ".tazuna", "history", id, "before", ".git", "config"), "[core]\n\tfsmonitor = x\n");
    expect(await undoCommand(["--root", root, "--yes"])).toBe(1);
    expect(existsSync(join(root, ".git", "config"))).toBe(false);
  });
});

describe("git を読み取りだけで呼ぶ (2026-11-04)", () => {
  const hasGit = spawnSync("git", ["--version"]).status === 0;
  it.skipIf(!hasGit)("リポジトリの設定の core.fsmonitor のコマンドを git status / ls-files のついでに実行しない", async () => {
    const root = mkdtempSync(join(tmpdir(), "tazuna-sec-fsmonitor-"));
    const git = (...args: string[]): void => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root });
      expect(r.status, args.join(" ")).toBe(0);
    };
    git("init", "-q", ".");
    writeFileSync(join(root, "a.txt"), "hello\n");
    git("add", "a.txt");
    git("commit", "-q", "--no-verify", "-m", "init");
    // 設定が書き換えられていた場合 (tazuna の外で) を想定。印のファイルはルートからの相対で作る
    git("config", "core.fsmonitor", "touch fsmonitor-ran; false");
    writeFileSync(join(root, "a.txt"), "changed\n");

    expect(await gitDirtyFiles(root)).toEqual([" M a.txt"]);
    const listed = listGitFiles(root);
    expect(listed.ok && listed.files).toEqual(["a.txt"]);
    expect(existsSync(join(root, "fsmonitor-ran"))).toBe(false);
  });
});

describe("symlink ディレクトリ経由のルート外書き込み防止 (指摘 2)", () => {
  it("isInsideRoot は symlink 経由の外部パスを検出する", () => {
    const root = mkdtempSync(join(tmpdir(), "tazuna-sec-root-"));
    const outside = mkdtempSync(join(tmpdir(), "tazuna-sec-out-"));
    symlinkSync(outside, join(root, "linkdir"));
    mkdirSync(join(root, "realdir"));

    expect(isInsideRoot(root, join(root, "realdir", "a.txt"))).toBe(true);
    expect(isInsideRoot(root, join(root, "a.txt"))).toBe(true);
    expect(isInsideRoot(root, join(root, "new", "deep", "a.txt"))).toBe(true); // 未作成の深い階層
    expect(isInsideRoot(root, join(root, "linkdir", "a.txt"))).toBe(false);
  });

  it("apply は symlink 経由の変更を検証段階で失敗させ、外部ファイルを守る", async () => {
    const root = mkdtempSync(join(tmpdir(), "tazuna-sec-a-"));
    const outside = mkdtempSync(join(tmpdir(), "tazuna-sec-b-"));
    writeFileSync(join(outside, "target.txt"), "hello\n");
    symlinkSync(outside, join(root, "linkdir"));
    // 失敗レポートの自動コピーがテスト実行機のクリップボードを書き換えないよう無効化
    mkdirSync(join(root, ".tazuna"), { recursive: true });
    writeFileSync(
      join(root, ".tazuna", "config.json"),
      JSON.stringify({ clipReportOnFailure: false }),
      "utf8",
    );
    const changesPath = join(root, "changes.md");
    writeFileSync(changesPath, simpleChanges("linkdir/target.txt"), "utf8");

    const code = await applyCommand([changesPath, "--root", root, "--yes"]);
    expect(code).toBe(1);
    expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("hello\n");
    expect(listHistoryIds(root)).toHaveLength(0);
  });
});

describe("undo は改ざんされた manifest を拒否する (指摘 1)", () => {
  async function setupApplied(): Promise<{ root: string; manifestPath: string; manifest: Manifest }> {
    const root = mkdtempSync(join(tmpdir(), "tazuna-sec-undo-"));
    writeFileSync(join(root, "a.txt"), "hello\n");
    const changesPath = join(root, "changes.md");
    writeFileSync(changesPath, simpleChanges("a.txt"), "utf8");
    expect(await applyCommand([changesPath, "--root", root, "--yes"])).toBe(0);
    const id = listHistoryIds(root)[0] as string;
    const manifestPath = join(root, ".tazuna", "history", id, "manifest.json");
    const manifest = readManifest(root, id) as Manifest;
    return { root, manifestPath, manifest };
  }

  it("パストラバーサル (../) を含む manifest で undo しない", async () => {
    const { root, manifestPath, manifest } = await setupApplied();
    (manifest.files[0] as { path: string }).path = "../evil.txt";
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    expect(await undoCommand(["--root", root, "--yes"])).toBe(1);
    expect(existsSync(join(root, "..", "evil.txt"))).toBe(false);
  });

  it("絶対パスを含む manifest で undo しない", async () => {
    const { root, manifestPath, manifest } = await setupApplied();
    (manifest.files[0] as { path: string }).path = "/tmp/evil.txt";
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    expect(await undoCommand(["--root", root, "--yes"])).toBe(1);
  });
});

describe("vscodeCommand の形式制限 (指摘 3)", () => {
  it("相対パス・UNC を拒否し、コマンド名と絶対パスを許可する", () => {
    expect(invalidVscodeCommandReason("./evil.sh")).not.toBeNull();
    expect(invalidVscodeCommandReason("scripts\\evil.cmd")).not.toBeNull();
    expect(invalidVscodeCommandReason("\\\\server\\share\\evil.exe")).not.toBeNull();
    expect(invalidVscodeCommandReason("//server/share/evil")).not.toBeNull();
    expect(invalidVscodeCommandReason("")).not.toBeNull();
    expect(invalidVscodeCommandReason("code")).toBeNull();
    expect(invalidVscodeCommandReason("code-insiders")).toBeNull();
    expect(invalidVscodeCommandReason("/usr/local/bin/code")).toBeNull();
  });

  it("show は不正な vscodeCommand を実行前に拒否する", async () => {
    const root = mkdtempSync(join(tmpdir(), "tazuna-sec-show-"));
    writeFileSync(join(root, "a.txt"), "hello\n");
    const changesPath = join(root, "changes.md");
    writeFileSync(changesPath, simpleChanges("a.txt"), "utf8");
    expect(await applyCommand([changesPath, "--root", root, "--yes"])).toBe(0);
    writeFileSync(
      join(root, ".tazuna", "config.json"),
      JSON.stringify({ vscodeCommand: "./evil.sh" }),
      "utf8",
    );
    expect(await showCommand(["--root", root])).toBe(1);
  });
});

describe("sanitizeForTerminal (指摘 4)", () => {
  it("ANSI エスケープと C0/C1 制御文字を除去し、改行とタブは保持する", () => {
    expect(sanitizeForTerminal("\u001b[31m赤\u001b[0m")).toBe("[31m赤[0m");
    expect(sanitizeForTerminal("a\u0007b\u0000c\u009bd")).toBe("abcd");
    expect(sanitizeForTerminal("line1\nline2\tend")).toBe("line1\nline2\tend");
  });

  it("双方向制御文字 (Trojan Source) を除去する", () => {
    expect(sanitizeForTerminal("a\u202egnp.exe")).toBe("agnp.exe");
    expect(sanitizeForTerminal("x\u2066y\u2069z\u200f")).toBe("xyz");
  });
});

describe("config の実行時検証 (指摘 5 追補)", () => {
  it("不正な newFile.encoding / historyLimit は明確なエラーになる", async () => {
    const { loadConfig } = await import("../src/infra/config.ts");
    const root = mkdtempSync(join(tmpdir(), "tazuna-sec-cfg-"));
    mkdirSync(join(root, ".tazuna"));
    writeFileSync(
      join(root, ".tazuna", "config.json"),
      JSON.stringify({ newFile: { encoding: "utf16" } }),
      "utf8",
    );
    expect(() => loadConfig(root)).toThrow(/newFile\.encoding/);

    writeFileSync(
      join(root, ".tazuna", "config.json"),
      JSON.stringify({ historyLimit: -5 }),
      "utf8",
    );
    expect(() => loadConfig(root)).toThrow(/historyLimit/);

    writeFileSync(
      join(root, ".tazuna", "config.json"),
      JSON.stringify({ vbproj: { register: "yes" } }),
      "utf8",
    );
    expect(() => loadConfig(root)).toThrow(/vbproj/);
  });

  it('newFile.encoding "auto" は eol / bom を省略でき、既定の lf を混ぜない (設計書 §11.2)', async () => {
    const { loadConfig } = await import("../src/infra/config.ts");
    const root = mkdtempSync(join(tmpdir(), "tazuna-sec-cfg2-"));
    mkdirSync(join(root, ".tazuna"));
    writeFileSync(
      join(root, ".tazuna", "config.json"),
      JSON.stringify({ newFile: { encoding: "auto" } }),
      "utf8",
    );
    expect(loadConfig(root).newFile).toEqual({ encoding: "auto" });
    expect(loadConfig(root).vbproj).toEqual({ register: true });
    // 従来形式 (eol のみ指定) は既定とマージされる
    writeFileSync(
      join(root, ".tazuna", "config.json"),
      JSON.stringify({ newFile: { eol: "crlf" } }),
      "utf8",
    );
    expect(loadConfig(root).newFile).toEqual({ encoding: "utf8", eol: "crlf" });
  });
});

describe("ターミナルのタイトルとベル (tazuna watch の結果の知らせ)", () => {
  const writes: string[] = [];
  const tty = process.stdout.isTTY;
  const title = process.title;
  beforeEach(() => {
    writes.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
    process.title = title;
  });

  it("タイトルの本文の制御文字は取り除き、シーケンスはリテラルだけ。復元は退避した状態へ戻す", () => {
    setTerminalTitle("a\u001b]0;evil\u0007b\nc", "linux");
    restoreTerminalTitle();
    expect(writes).toEqual(["\u001b[22;0t", "\u001b]0;a]0;evilb c\u0007", "\u001b]0;\u0007\u001b[23;0t"]);
  });

  it("Windows はコンソールのタイトル (process.title) を変え、終わったら元に戻す", () => {
    const before = process.title;
    setTerminalTitle("tazuna watch: 待機中", "win32");
    expect(process.title).toBe("tazuna watch: 待機中");
    restoreTerminalTitle();
    expect(process.title).toBe(before);
    expect(writes).toEqual([]);
  });

  it("非 TTY (パイプ・リダイレクト) では何も書かない", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    setTerminalTitle("x", "linux");
    ringBell();
    restoreTerminalTitle();
    expect(writes).toEqual([]);
  });

  it("ベルは BEL 1 文字", () => {
    ringBell();
    expect(writes).toEqual(["\u0007"]);
  });
});

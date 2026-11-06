import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCommand, lineChangeLabel } from "../src/commands/apply.ts";
import { describeWatchResult } from "../src/commands/watch.ts";
import { findWindowsVscode, isVscodeExecutable, resolveVscodeCommand } from "../src/commands/show.ts";
import { buildCommitMessage } from "../src/core/commit-message.ts";
import { countLineChanges } from "../src/core/diff.ts";

const doc = (...lines: string[]): string => lines.join("\n");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("コミットの件名: 概要の見出しは外す (規約文 v6)", () => {
  it("見出しだけの行 (**変更概要** / ## 概要) は飛ばして、次の行を件名にする", () => {
    for (const label of ["**変更概要**", "## 概要", "変更の概要:", "Summary"]) {
      const m = buildCommitMessage(doc(label, "受注一覧に得意先コードの絞り込みを追加", "", "検索条件を増やす。"), "id", 1);
      expect(m.subject, label).toBe("受注一覧に得意先コードの絞り込みを追加");
      expect(m.message, label).toBe(
        doc("受注一覧に得意先コードの絞り込みを追加", "", "検索条件を増やす。", "", "Tazuna-History: id", ""),
      );
    }
  });

  it("同じ行の「変更概要: 」は外す。見出しでない語 (概要を更新・要約処理) は残す", () => {
    expect(buildCommitMessage("変更概要: CSV 出力を追加", "id", 1).subject).toBe("CSV 出力を追加");
    expect(buildCommitMessage("**概要**：CSV 出力を追加", "id", 1).subject).toBe("CSV 出力を追加");
    expect(buildCommitMessage("概要を更新する画面を追加", "id", 1).subject).toBe("概要を更新する画面を追加");
    expect(buildCommitMessage("要約処理を修正", "id", 1).subject).toBe("要約処理を修正");
  });
});

describe("適用の結果に添える増減の行数", () => {
  it("足した行と消した行を数える", () => {
    expect(countLineChanges(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual({ added: 2, removed: 1 });
    expect(countLineChanges([], ["a", "b"])).toEqual({ added: 2, removed: 0 });
    expect(countLineChanges(["a"], [])).toEqual({ added: 0, removed: 1 });
  });

  it("差が大きく差分の計算を打ち切っても、全行の入れ替えとは数えない", () => {
    const a = Array.from({ length: 30_000 }, (_, i) => `line ${i}`);
    const b = a.map((l, i) => (i % 15 === 0 ? `${l} changed` : l));
    expect(countLineChanges(a, b)).toEqual({ added: 2000, removed: 2000 });
  });

  it("作成・削除・変更のどれでも表示し、読めないファイル (UTF-16) では付けない", () => {
    expect(lineChangeLabel(null, bytes("a\nb\n"))).toBe(" (+2 -0 行)");
    expect(lineChangeLabel(bytes("a\nb\n"), null)).toBe(" (+0 -2 行)");
    expect(lineChangeLabel(bytes("a\r\nb\r\n"), bytes("a\r\nc\r\nd\r\n"))).toBe(" (+2 -1 行)");
    expect(lineChangeLabel(Uint8Array.of(0xff, 0xfe, 0x61, 0x00), bytes("a\n"))).toBe("");
  });

  describe("tazuna の出力", () => {
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

    it("ファイルごとに増減の行数を出し、差分の見方を案内する", async () => {
      const root = mkdtempSync(join(tmpdir(), "tazuna-guide-"));
      const drop = mkdtempSync(join(tmpdir(), "tazuna-guide-drop-"));
      writeFileSync(join(root, "tazuna.config.json"), "{}");
      writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
      const changes = join(drop, "changes.md");
      writeFileSync(
        changes,
        doc(
          "## CHANGES",
          "",
          "a.txt を直して b.txt を追加",
          "",
          "### FILE: a.txt (replace)",
          "<<<<<<< SEARCH",
          "two",
          "=======",
          "2",
          "2.5",
          ">>>>>>> REPLACE",
          "",
          "### FILE: b.txt (create)",
          "<<<<<<< CONTENT",
          "x",
          "y",
          "z",
          ">>>>>>> END",
          "",
        ),
      );
      expect(await applyCommand([changes, "--root", root, "--yes"])).toBe(0);
      const text = output.join("");
      expect(text).toContain("replace a.txt — 1/1 ブロック (+2 -1 行)");
      expect(text).toContain("create  b.txt (+3 -0 行)");
      expect(text).toContain("VS Code のソース管理、または `tazuna show`");
    });
  });

  it("watch の結果の行も差分の見方を案内する", () => {
    const r = describeWatchResult(
      { kind: "applied", files: 2, reportCopied: false },
      { path: "changes.md", tidy: null, rootOption: null },
    );
    expect(r.details).toEqual(["差分を VS Code のソース管理か tazuna show で確認してからビルドしてください"]);
  });
});

describe("Windows で VS Code (Code.exe) を見つける", () => {
  const user = "C:\\Users\\taro\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";
  const system = "C:\\Program Files\\Microsoft VS Code\\Code.exe";
  const env = { LOCALAPPDATA: "C:\\Users\\taro\\AppData\\Local", ProgramFiles: "C:\\Program Files" };

  it("ユーザーごとのインストール先を先に、無ければシステム全体のインストール先を探す", () => {
    expect(findWindowsVscode(env, (p) => p === user || p === system)).toBe(user);
    expect(findWindowsVscode(env, (p) => p === system)).toBe(system);
    expect(findWindowsVscode(env, () => false)).toBeNull();
  });

  it("環境変数が UNC・相対パスなら使わない", () => {
    const seen: string[] = [];
    const exists = (p: string): boolean => {
      seen.push(p);
      return true;
    };
    expect(findWindowsVscode({ LOCALAPPDATA: "\\\\server\\share", ProgramFiles: "relative\\dir" }, exists)).toBeNull();
    expect(seen).toEqual([]);
  });

  it("既定の \"code\" のときだけ探す (Windows 以外・設定で指定したものはそのまま)", () => {
    const found = (p: string): boolean => p === user;
    expect(resolveVscodeCommand("code", "win32", env, found)).toBe(user);
    expect(resolveVscodeCommand("code", "win32", env, () => false)).toBe("code");
    expect(resolveVscodeCommand("code", "darwin", env, found)).toBe("code");
    expect(resolveVscodeCommand("D:\\tools\\VSCode\\Code.exe", "win32", env, found)).toBe("D:\\tools\\VSCode\\Code.exe");
  });

  it("Code.exe は終わりを待たずに起動する (code / code.cmd は従来どおり)", () => {
    expect(isVscodeExecutable(user)).toBe(true);
    expect(isVscodeExecutable("D:/tools/VSCode/code.exe")).toBe(true);
    expect(isVscodeExecutable("C:\\Users\\taro\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe")).toBe(true);
    expect(isVscodeExecutable("code")).toBe(false);
    expect(isVscodeExecutable("/usr/local/bin/code")).toBe(false);
    expect(isVscodeExecutable("C:\\tools\\vscode.exe")).toBe(false);
  });
});

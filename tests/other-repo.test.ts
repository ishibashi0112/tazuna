import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCommand } from "../src/commands/apply.ts";
import { fileNameKey, looksLikeOtherRepository } from "../src/core/other-repo.ts";
import type { FileChange } from "../src/types.ts";

const replace = (path: string): FileChange => ({ path, op: "replace", blocks: [] }) as unknown as FileChange;
const create = (path: string): FileChange => ({ path, op: "create", content: ["x"] }) as unknown as FileChange;
const remove = (path: string): FileChange => ({ path, op: "delete" }) as unknown as FileChange;

describe("looksLikeOtherRepository (§4.7)", () => {
  const none = (): boolean => false;
  const names = (): ReadonlySet<string> => new Set(["main.vb", "readme.md"]);

  it("replace の対象が無く、同じ名前のファイルもリポジトリに無ければ true", () => {
    expect(looksLikeOtherRepository([replace("src/Orders/OrderForm.vb"), create("src/Orders/New.vb")], none, names)).toBe(true);
  });

  it("同じ名前のファイルがリポジトリにあれば (フォルダの書き違い) false。名前は大文字小文字を区別しない", () => {
    expect(looksLikeOtherRepository([replace("app/Main.VB")], none, names)).toBe(false);
  });

  it("挙げたファイルのどれかがルートにあれば false (delete・create の対象も含む)", () => {
    const exists = (p: string): boolean => p === "docs/a.md";
    expect(looksLikeOtherRepository([replace("x/OrderForm.vb"), remove("docs/a.md")], exists, names)).toBe(false);
  });

  it("create / delete だけなら判定しない (どのリポジトリにも当てられる)", () => {
    expect(looksLikeOtherRepository([create("a/b.vb"), remove("c.vb")], none, names)).toBe(false);
  });

  it("リポジトリのファイル名の一覧が無ければ (git でない) 判定しない", () => {
    expect(looksLikeOtherRepository([replace("x/OrderForm.vb")], none, () => null)).toBe(false);
  });

  it("挙げたファイルがルートにあるとき・create / delete だけのときは、一覧を求めない (git ls-files を走らせない)", () => {
    const listing = vi.fn(names);
    expect(looksLikeOtherRepository([replace("Main.vb")], () => true, listing)).toBe(false);
    expect(looksLikeOtherRepository([create("a/b.vb")], none, listing)).toBe(false);
    expect(listing).not.toHaveBeenCalled();
    expect(looksLikeOtherRepository([replace("x/OrderForm.vb")], none, listing)).toBe(true);
    expect(listing).toHaveBeenCalledTimes(1);
  });

  it("fileNameKey は / と \\ のどちらの区切りでも最後の名前を小文字で返す", () => {
    expect(fileNameKey("a/b/C.vb")).toBe("c.vb");
    expect(fileNameKey("a\\B.VB")).toBe("b.vb");
  });
});

describe("手で実行した tazuna は、別のリポジトリ向けらしければ注記して従来どおりレポートする", () => {
  let output: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    output = [];
  });

  it.skipIf(spawnSync("git", ["--version"]).status !== 0)("注記とレポート", async () => {
    const capture = (chunk: unknown): boolean => {
      output.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
    const dir = mkdtempSync(join(tmpdir(), "tazuna-other-"));
    spawnSync("git", ["init", "-q", "."], { cwd: dir });
    mkdirSync(join(dir, ".tazuna"), { recursive: true });
    writeFileSync(join(dir, ".tazuna", "config.json"), JSON.stringify({ clipReportOnFailure: false }), "utf8");
    writeFileSync(join(dir, "Main.vb"), "Module M\nEnd Module\n", "utf8");
    const changesPath = join(mkdtempSync(join(tmpdir(), "tazuna-other-in-")), "changes.md");
    writeFileSync(
      changesPath,
      ["## CHANGES", "", "変更。", "", "### FILE: src/OrderForm.vb (replace)", "<<<<<<< SEARCH", "a", "=======", "b", ">>>>>>> REPLACE", ""].join("\n"),
      "utf8",
    );
    expect(await applyCommand([changesPath, "--root", dir, "--yes"])).toBe(1);
    const text = output.join("");
    expect(text).toContain("別のリポジトリ向けの changes.md ではないか確認してください");
    expect(text).toContain("検証に失敗しました");
  });
});

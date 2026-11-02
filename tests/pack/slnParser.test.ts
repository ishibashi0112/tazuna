/**
 * slnParser の単体テスト。
 * fixture の Sample.sln と、インライン文字列による頑健性ケースで検証する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSln } from "../../src/pack/slnParser.ts";
import type { SlnParseResult } from "../../src/pack/types.ts";

const FIXTURES_ROOT = path.resolve(import.meta.dirname, "..", "fixtures", "pack");

const realFs = { fileExists: (p: string): boolean => fs.existsSync(p) };

function parseSampleSln(): SlnParseResult {
  const solutionPath = path.join(FIXTURES_ROOT, "solution", "Sample.sln");
  return parseSln(fs.readFileSync(solutionPath, "utf8"), solutionPath, realFs);
}

suite("slnParser: Sample.sln fixture", () => {
  const result = parseSampleSln();

  test(".vbproj / .csproj のプロジェクトのみ抽出する", () => {
    assert.deepStrictEqual(
      result.projects.map((p) => p.name),
      ["Basic", "LinkedApp", "Gone"],
    );
  });

  test("名前・GUID・相対パスを取得する", () => {
    const basic = result.projects[0]!;
    assert.strictEqual(basic.name, "Basic");
    assert.strictEqual(basic.relativePath, "..\\basic\\Basic.vbproj");
    assert.strictEqual(basic.projectGuid, "A1111111-1111-1111-1111-111111111111");
    assert.strictEqual(
      basic.projectTypeGuid,
      "F184B08F-C81C-45F6-A57F-5ABD9991F28F",
    );
  });

  test("相対パスを .sln 基準の絶対パスへ解決し、存在確認する", () => {
    const basic = result.projects[0]!;
    assert.strictEqual(
      basic.absolutePath,
      path.join(FIXTURES_ROOT, "basic", "Basic.vbproj"),
    );
    assert.strictEqual(basic.exists, true);
    const gone = result.projects[2]!;
    assert.strictEqual(gone.exists, false);
  });

  test("Solution Folder と他言語プロジェクトはスキップし診断に残す", () => {
    assert.ok(
      result.diagnostics.some(
        (d) => d.severity === "info" && d.message.includes("Solution Folder"),
      ),
    );
    assert.ok(
      result.diagnostics.some(
        (d) => d.severity === "info" && d.message.includes("FSharpLib.fsproj"),
      ),
    );
  });
});

suite("slnParser: 入力の頑健性", () => {
  test("BOM 付きでも解析できる", () => {
    const content =
      "\uFEFF" +
      "Microsoft Visual Studio Solution File, Format Version 12.00\n" +
      'Project("{F184B08F-C81C-45F6-A57F-5ABD9991F28F}") = "App", "App\\App.vbproj", "{B1111111-1111-1111-1111-111111111111}"\n' +
      "EndProject\n";
    const result = parseSln(content, "/tmp/sol/Test.sln", {
      fileExists: () => true,
    });
    assert.strictEqual(result.projects.length, 1);
    assert.strictEqual(result.projects[0]?.name, "App");
  });

  test("VB / C# のプロジェクトが 1 件もない場合は警告を残す", () => {
    const content = "Microsoft Visual Studio Solution File, Format Version 12.00\n";
    const result = parseSln(content, "/tmp/sol/Empty.sln", realFs);
    assert.strictEqual(result.projects.length, 0);
    assert.ok(
      result.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("見つかりません"),
      ),
    );
  });

  test(".sln らしくない内容にはヘッダー警告を出す", () => {
    const result = parseSln("<xml />", "/tmp/sol/NotSln.sln", realFs);
    assert.ok(
      result.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("ヘッダー"),
      ),
    );
  });
});

suite("slnParser: C# の .csproj", () => {
  const CONTENT =
    "Microsoft Visual Studio Solution File, Format Version 12.00\n" +
    'Project("{F184B08F-C81C-45F6-A57F-5ABD9991F28F}") = "Vb", "Vb\\Vb.vbproj", "{B1111111-1111-1111-1111-111111111111}"\n' +
    "EndProject\n" +
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Cs", "Cs\\Cs.csproj", "{B2222222-2222-2222-2222-222222222222}"\n' +
    "EndProject\n" +
    'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Sdk", "Sdk\\Sdk.CSPROJ", "{B3333333-3333-3333-3333-333333333333}"\n' +
    "EndProject\n";

  test(".vbproj と .csproj(大文字の拡張子も)を出現順に取り、言語を付ける", () => {
    const result = parseSln(CONTENT, "/tmp/sol/Mixed.sln", { fileExists: () => true });
    assert.deepStrictEqual(
      result.projects.map((p) => [p.name, p.language]),
      [
        ["Vb", "vb"],
        ["Cs", "cs"],
        ["Sdk", "cs"],
      ],
    );
  });

  test("同じフォルダの .sln から参照されていない .csproj にも警告を出す", () => {
    const result = parseSln(CONTENT, "/tmp/sol/Mixed.sln", {
      fileExists: () => true,
      listFileNames: () => ["Old.csproj", "Old.fsproj"],
    });
    const warnings = result.diagnostics.filter((d) => d.message.includes("参照されていない"));
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0]?.message.includes("Old.csproj"));
  });

  test("mixed fixture: F# のプロジェクトはスキップし、診断に残す", () => {
    const solutionPath = path.join(FIXTURES_ROOT, "mixed", "Mixed.sln");
    const result = parseSln(fs.readFileSync(solutionPath, "utf8"), solutionPath, realFs);
    assert.deepStrictEqual(
      result.projects.map((p) => [p.name, p.language, p.exists]),
      [
        ["Basic", "vb", true],
        ["LegacyApp", "cs", true],
        ["SdkApp", "cs", true],
      ],
    );
    assert.ok(result.diagnostics.some((d) => d.message.includes("FSharpLib.fsproj")));
  });
});

suite("slnParser: 同フォルダの未参照 .vbproj 警告", () => {
  const CONTENT =
    "Microsoft Visual Studio Solution File, Format Version 12.00\n" +
    'Project("{F184B08F-C81C-45F6-A57F-5ABD9991F28F}") = "App", "App.vbproj", "{B1111111-1111-1111-1111-111111111111}"\n' +
    "EndProject\n";

  function fakeDeps(names: string[]) {
    return {
      fileExists: (): boolean => true,
      listFileNames: (): string[] => names,
    };
  }

  test(".sln から参照されていない同フォルダの .vbproj に警告を出す", () => {
    const result = parseSln(
      CONTENT,
      "/tmp/sol/Test.sln",
      fakeDeps(["App.vbproj", "Old.vbproj", "readme.txt"]),
    );
    const warnings = result.diagnostics.filter(
      (d) => d.severity === "warning" && d.message.includes("参照されていない"),
    );
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0]?.message.includes("Old.vbproj"));
  });

  test("参照済み .vbproj は大文字小文字が違っても警告しない", () => {
    const result = parseSln(
      CONTENT,
      "/tmp/sol/Test.sln",
      fakeDeps(["APP.VBPROJ"]),
    );
    assert.ok(
      !result.diagnostics.some((d) => d.message.includes("参照されていない")),
    );
  });

  test("listFileNames が渡されない場合はこのチェックをスキップする", () => {
    const result = parseSln(CONTENT, "/tmp/sol/Test.sln", {
      fileExists: () => true,
    });
    assert.ok(
      !result.diagnostics.some((d) => d.message.includes("参照されていない")),
    );
  });

  test("ディレクトリを読めない場合(undefined)もスキップする", () => {
    const result = parseSln(CONTENT, "/tmp/sol/Test.sln", {
      fileExists: () => true,
      listFileNames: () => undefined,
    });
    assert.ok(
      !result.diagnostics.some((d) => d.message.includes("参照されていない")),
    );
  });
});

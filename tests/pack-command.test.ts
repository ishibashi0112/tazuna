import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_TEXT } from "../src/assets/protocol.ts";
import { packCommand } from "../src/commands/pack.ts";

const BASIC = resolve(import.meta.dirname, "fixtures", "pack", "basic");

/** packCommand を実行して stdout / stderr を捕まえる */
function run(argv: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  const before = process.cwd();
  try {
    process.chdir(cwd);
    return { code: packCommand(argv), stdout, stderr };
  } finally {
    process.chdir(before);
    vi.restoreAllMocks();
  }
}

/**
 * .git のあるリポジトリの dotnet/ に basic フィクスチャを置く。一時フォルダはリンクを解いた実際のパスで返す
 * (macOS の /var は /private/var へのリンクで、process.cwd() は解いた側を返すため)
 */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tazuna-pack-")));
  mkdirSync(join(dir, ".git"));
  cpSync(BASIC, join(dir, "dotnet"), { recursive: true });
  return dir;
}

describe("tazuna pack (設計書 §25)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("設定ファイルが無ければ .git の場所がルート (<file path> が適用のルートと揃う)", () => {
    const dir = repo();
    const result = run(["Basic.vbproj", "--stdout", "--no-clip"], join(dir, "dotnet"));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('<file path="dotnet/Module1.vb"');
    expect(result.stderr).toContain(`ルート: ${dir}(リポジトリの直下(.git の場所))`);
  });

  it("規約文は内蔵 (protocol.md が無くても <instruction> が入る)。--no-instruction で外せる", () => {
    const dir = repo();
    const result = run(["dotnet/Basic.vbproj", "--stdout", "--no-clip"], dir);
    expect(result.stdout).toContain(`<instruction>\n${PROTOCOL_TEXT}`);
    expect(result.stderr).toMatch(/規約文: 内蔵 v\d+\n/);
    const without = run(["dotnet/Basic.vbproj", "--stdout", "--no-clip", "--no-instruction"], dir);
    expect(without.stdout).not.toContain("\n<instruction>\n");
  });

  it("手を加えた protocol.md は上書きとして使う", () => {
    const dir = repo();
    writeFileSync(join(dir, "protocol.md"), "# 社内の規約\n");
    const result = run(["dotnet/Basic.vbproj", "--stdout", "--no-clip"], dir);
    expect(result.stdout).toContain("<instruction>\n# 社内の規約\n</instruction>");
  });

  it("設定ファイルが新旧の名前で両方あれば止める", () => {
    const dir = repo();
    writeFileSync(join(dir, "tazuna.config.json"), "{}");
    writeFileSync(join(dir, "slnmix.config.json"), "{}");
    const result = run(["dotnet/Basic.vbproj", "--stdout", "--no-clip"], dir);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("両方あります");
  });

  it("旧名の slnmix.config.json の target を使う", () => {
    const dir = repo();
    writeFileSync(join(dir, "slnmix.config.json"), JSON.stringify({ target: "dotnet/Basic.vbproj" }));
    const result = run(["--stdout", "--no-clip"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('<file path="dotnet/Module1.vb"');
  });
});

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe("tazuna pack: generic 構成で extraRoots が無ければ git が管理しているファイル (設計書 §25.7)", () => {
  afterEach(() => vi.restoreAllMocks());

  /** git init したリポジトリに Python / TS のファイルを置く */
  function gitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "tazuna-pack-git-"));
    const git = (...args: string[]): void => {
      const r = spawnSync("git", args, { cwd: dir });
      if (r.status !== 0) throw new Error(r.stderr.toString());
    };
    git("init", "-q", ".");
    writeFileSync(join(dir, "tazuna.config.json"), '{ "kind": "generic" }\n');
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n*.log\n");
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "main.py"), 'import os\npassword = "hunter2xyz"\n');
    writeFileSync(join(dir, "app", "web.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "poetry.lock"), "# lock\n");
    writeFileSync(join(dir, "app", "data.bin"), Buffer.from([0x50, 0x00, 0x01, 0x02]));
    mkdirSync(join(dir, "node_modules", "m"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "m", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(dir, "debug.log"), "secret log\n");
    git("add", "tazuna.config.json", ".gitignore", "app/main.py", "poetry.lock", "app/data.bin");
    // app/web.ts は未追跡(.gitignore に一致しないので対象)
    return dir;
  }

  it.skipIf(!hasGit)("追跡中と未追跡(.gitignore 以外)のファイルを入れ、ロックファイル・バイナリ・ignore を除く", () => {
    const dir = gitRepo();
    const result = run(["--stdout", "--no-clip"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("git が管理しているファイル(git ls-files)に基づき");
    expect(result.stdout).toContain('<file path="app/main.py">');
    expect(result.stdout).toContain('<file path="app/web.ts">');
    expect(result.stdout).toContain('<file path=".gitignore">');
    expect(result.stdout).not.toContain('<file path="poetry.lock"');
    expect(result.stdout).not.toContain('<file path="app/data.bin"');
    expect(result.stdout).not.toContain("node_modules/m");
    expect(result.stdout).not.toContain("debug.log");
    expect(result.stdout).not.toContain("hunter2xyz");
    expect(result.stdout).toMatch(/<directory_structure>\n\.\/\n {2}app\/\n/);
    expect(result.stderr).toContain("設定: tazuna.config.json(git が管理しているファイル)");
  });

  it.skipIf(!hasGit)("<docs> / <db_schema> に入るファイルは <file> に重ねない", () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "tazuna.config.json"), '{ "kind": "generic", "docs": true }\n');
    mkdirSync(join(dir, "docs", "design"), { recursive: true });
    mkdirSync(join(dir, "docs", "db"), { recursive: true });
    writeFileSync(join(dir, "docs", "design", "x.md"), "<!-- slnmix design: status=ready blocking=0 deferred=0 -->\n# x\n");
    writeFileSync(join(dir, "docs", "db", "schema.md"), "# schema\n");
    writeFileSync(join(dir, "docs", "notes.md"), "# notes\n");
    const result = run(["--stdout", "--no-clip"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('<file path="docs/design/x.md"');
    expect(result.stdout).not.toContain('<file path="docs/db/schema.md"');
    expect(result.stdout).toContain('<doc path="docs/design/x.md"');
    expect(result.stdout).toContain("- docs/design/x.md: <docs> に入れたため <file> には入れない");
    expect(result.stdout).toContain('<file path="docs/notes.md">');
  });

  it.skipIf(!hasGit)("前回のパック (.gitignore に書いていない repomix-output.*) を入れない", () => {
    const dir = gitRepo();
    const first = run(["--no-clip"], dir);
    expect(first.code).toBe(0);
    expect(existsSync(join(dir, "repomix-output.xml"))).toBe(true);
    const second = run(["--stdout", "--no-clip"], dir);
    expect(second.code).toBe(0);
    expect(second.stdout).not.toContain('<file path="repomix-output.xml"');
    expect(second.stdout).not.toContain('<file path="repomix-output.prompt.md"');
    expect(second.stdout).toContain('<file path="app/main.py">');
  });

  it.skipIf(!hasGit)("適用の履歴 (.gitignore に書いていない .tazuna/・旧版の .petari/) を入れない", () => {
    const dir = gitRepo();
    for (const state of [".tazuna", ".petari"]) {
      mkdirSync(join(dir, state, "history", "2026-11-01_0900", "after", "app"), { recursive: true });
      writeFileSync(join(dir, state, "history", "2026-11-01_0900", "after", "app", "main.py"), "print(1)\n");
      writeFileSync(join(dir, state, "config.json"), "{}\n");
    }
    const result = run(["--stdout", "--no-clip"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('<file path=".tazuna/');
    expect(result.stdout).not.toContain('<file path=".petari/');
    expect(result.stdout).toContain('<file path="app/main.py">');
  });

  it("git のリポジトリでなければ、extraRoots を書くよう案内して止める", () => {
    const dir = mkdtempSync(join(tmpdir(), "tazuna-pack-nogit-"));
    writeFileSync(join(dir, "tazuna.config.json"), '{ "kind": "generic" }\n');
    const result = run(["--stdout", "--no-clip"], dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("git が管理しているファイルを一覧できません");
    expect(result.stderr).toContain("extraRoots");
  });
});

describe("tazuna pack --init-config: 拡張子を見て include / exclude を書く (0.18.0)", () => {
  afterEach(() => vi.restoreAllMocks());

  /** git init したリポジトリに Python・vendor・データ・鍵・生成コードを置く (設定ファイルなし) */
  function pythonRepo(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tazuna-init-config-")));
    const git = (...args: string[]): void => {
      const r = spawnSync("git", args, { cwd: dir });
      if (r.status !== 0) throw new Error(r.stderr.toString());
    };
    git("init", "-q", ".");
    const write = (rel: string, content: string | Buffer): void => {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    };
    write("shop/models.py", "class Order:\n    pass\n");
    write("shop/settings.py", 'SECRET_KEY = "django-insecure-8f3k2j4h5g6f7d8s9a0qwe1rty2uio3p"\n');
    write("shop/pb/order_pb2.py", "# Generated by the protocol buffer compiler.  DO NOT EDIT!\nx = 1\n");
    write("static/app.js", "document.title = 'shop';\n");
    write("static/vendor/chart.js", "var chart = 1;\n");
    write("static/app.min.js", "var a=1;\n");
    write("data/customers.csv", "id,email\n1,taro@example.co.jp\n");
    write("certs/dev.pem", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n");
    write("pyproject.toml", '[project]\nname = "shop"\n');
    write("bin/run", "#!/usr/bin/env python3\nprint(1)\n");
    git("add", "-A");
    return dir;
  }

  it.skipIf(!hasGit)("git のリポジトリ: 言語・include・exclude・入れないものを示して書き、パックはそのとおりに絞る", () => {
    const dir = pythonRepo();
    const init = run(["--init-config"], dir);
    expect(init.code).toBe(0);
    const config = JSON.parse(readFileSync(join(dir, "tazuna.config.json"), "utf8")) as Record<string, unknown>;
    expect(config).toEqual({
      kind: "generic",
      include: ["**/*.py", "**/*.js", "**/*.md", "**/*.toml", "**/.gitignore", "bin/run", "tazuna.config.json"],
      exclude: ["static/vendor/**", "**/*.min.js", "**/*_pb2.py"],
    });
    expect(init.stderr).toContain("言語: Python 3 件 / JavaScript 1 件");
    expect(init.stderr).toContain("入れないもの: .csv 1 件(データ。例: data/customers.csv) / .pem 1 件(鍵・証明書・認証情報のファイル");
    expect(init.stderr).toContain("exclude: static/vendor/**(他から取り込んだコード 1 件) / **/*.min.js(圧縮済み 1 件) / **/*_pb2.py(生成コード 1 件)");

    const pack = run(["--stdout", "--no-clip"], dir);
    expect(pack.code).toBe(0);
    for (const included of ["shop/models.py", "shop/settings.py", "static/app.js", "pyproject.toml", "bin/run", "tazuna.config.json"]) {
      expect(pack.stdout).toContain(`<file path="${included}">`);
    }
    for (const omitted of ["data/customers.csv", "certs/dev.pem", "static/vendor/chart.js", "static/app.min.js", "shop/pb/order_pb2.py"]) {
      expect(pack.stdout).not.toContain(`<file path="${omitted}"`);
    }
    expect(pack.stdout).not.toContain("taro@example.co.jp");
    expect(pack.stdout).not.toContain("django-insecure-8f3k");
    expect(pack.stdout).toContain("tazuna.config.json の include に一致し exclude に一致しないもの");
    expect(pack.stdout).toContain("- 設定で入れていないファイル: include に一致しない 2 件(.csv 1 件 / .pem 1 件)、exclude(static/vendor/** / **/*.min.js / **/*_pb2.py)に一致する 3 件");
    expect(pack.stderr).toContain("設定: tazuna.config.json(git が管理しているファイル / include 7 件 / exclude 3 件)");
    expect(pack.stderr).toContain("設定で入れていないファイル: include に一致しない 2 件(.csv 1 件 / .pem 1 件)、exclude に一致 3 件");
  });

  it("git の外: 直下のディレクトリのうち言語の分かるソースを含むものを extraRoots にし、include を書く (Python が src/ に無くても)", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tazuna-init-config-nogit-")));
    mkdirSync(join(dir, "mypkg"));
    writeFileSync(join(dir, "mypkg", "core.py"), "def total(q, p):\n    return q * p\n");
    mkdirSync(join(dir, ".venv", "lib"), { recursive: true });
    writeFileSync(join(dir, ".venv", "pyvenv.cfg"), "home = /usr\n");
    mkdirSync(join(dir, "env", "lib"), { recursive: true });
    writeFileSync(join(dir, "env", "pyvenv.cfg"), "home = /usr\n");
    writeFileSync(join(dir, "env", "lib", "site.py"), "x = 1\n");
    const init = run(["--init-config"], dir);
    expect(init.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "tazuna.config.json"), "utf8"))).toEqual({
      kind: "generic",
      extraRoots: [{ path: "mypkg", kind: "src", include: ["**/*.py"] }],
    });
    const pack = run(["--stdout", "--no-clip"], dir);
    expect(pack.code).toBe(0);
    expect(pack.stdout).toContain('<file path="mypkg/core.py" root="src">');
  });
});

describe("tazuna pack: C# の .csproj (0.17.0)", () => {
  afterEach(() => vi.restoreAllMocks());

  /** .git のあるリポジトリに mixed (VB 1 + C# 2 + F# 1) と参照先のフィクスチャを置く */
  function mixedRepo(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tazuna-pack-cs-")));
    mkdirSync(join(dir, ".git"));
    for (const name of ["mixed", "basic", "csharp-legacy", "csharp-sdk"]) {
      cpSync(resolve(import.meta.dirname, "fixtures", "pack", name), join(dir, name), { recursive: true });
    }
    return dir;
  }

  it("VB と C# のプロジェクトを論理構成に入れ、Designer.cs は要約、bin / obj は入れない", () => {
    const dir = mixedRepo();
    const result = run(["mixed/Mixed.sln", "--stdout", "--no-clip"], dir);
    expect(result.code).toBe(0);
    const out = result.stdout;
    expect(out).toContain("論理構成(.sln / .vbproj / .csproj)");
    expect(out).toContain('<file path="basic/Module1.vb"');
    expect(out).toContain('<file path="csharp-legacy/Forms/OrderForm.cs" project="LegacyApp"');
    expect(out).toContain('<file path="csharp-sdk/Services/PriceService.cs" project="SdkApp"');
    expect(out).not.toContain('<file path="csharp-legacy/Forms/OrderForm.Designer.cs"');
    expect(out).not.toContain("csharp-sdk/bin/");
    expect(out).not.toContain("csharp-sdk/obj/");
    expect(out).toContain('<ui_summary path="csharp-legacy/Forms/OrderForm.Designer.cs" form="OrderForm">');
    expect(out).toContain('- btnSave: Button — Text "保存(&S)" — イベント Click → btnSave_Click');
    expect(out).toContain("フォームのイベント: Load → OrderForm_Load");
    expect(out).toContain("既定の Compile グロブ(**/*.cs)を展開した");
    // C# のソースも伏せる
    expect(out).toContain("Password=[MASKED]");
    expect(out).not.toContain("Tz9qLm2Xv7Rk");
    // ビルド環境と手順文
    expect(out).toContain(".vbproj / .csproj から読み取ったビルド環境");
    expect(out).toContain("  - C#: 5 まで(");
    expect(out).toContain("  - C#: 12 まで(");
    expect(out).toContain("(mode: full, language: VB / C#)");
  });

  it("C# だけのプロジェクトは手順文が C# の語句になる。--print-procedure も同じ", () => {
    const dir = mixedRepo();
    const result = run(["--stdout", "--no-clip"], join(dir, "csharp-sdk"));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("(mode: full, language: C#)");
    expect(result.stdout).toContain("<ui_summary> は Designer.cs からの要約です");
    expect(result.stdout).not.toContain("Designer.vb");
    const printed = run(["--print-procedure"], join(dir, "csharp-legacy"));
    expect(printed.stdout).toMatch(/^<!-- tazuna procedure v\d+ \(mode: full, language: C#\) -->/);
    // 入力が見つからないところでは従来どおり Visual Basic の文面
    const none = run(["--print-procedure"], dir);
    expect(none.stdout).toMatch(/^<!-- tazuna procedure v\d+ \(mode: full\) -->/);
  });
});

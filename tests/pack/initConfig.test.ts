/**
 * initConfig(--init-config)の単体テスト。ファイルシステムは fake を注入する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as path from "node:path";
import { EXAMPLE_CONFIG, initConfig, type InitConfigDeps } from "../../src/pack/initConfig.ts";

const ROOT = path.resolve("/work/tsproj");

interface FakeFs {
  deps: InitConfigDeps;
  files: Map<string, string>;
}

/** dirs: ルート相対のディレクトリ名。files: ルート直下のファイル名(内容は空) */
function fakeFs(dirs: string[], files: string[] = []): FakeFs {
  const fileMap = new Map(files.map((name) => [path.join(ROOT, name), ""]));
  const dirSet = new Set([ROOT, ...dirs.map((d) => path.join(ROOT, d))]);
  return {
    files: fileMap,
    deps: {
      isDirectory: (p) => dirSet.has(path.resolve(p)),
      isFile: (p) => fileMap.has(path.resolve(p)),
      listFileNames: (p) =>
        path.resolve(p) === ROOT
          ? [...fileMap.keys()].map((k) => path.basename(k))
          : undefined,
      writeTextFile: (p, content) => {
        fileMap.set(path.resolve(p), content);
      },
    },
  };
}

suite("initConfig", () => {
  test("src と tests があれば両方を extraRoots に書く(kind は src / test)", () => {
    const fs = fakeFs(["src", "tests", "node_modules", "dist"], ["package.json"]);
    const result = initConfig(ROOT, fs.deps);
    assert.strictEqual(result.kind, "created");
    if (result.kind !== "created") return;
    assert.strictEqual(result.path, path.join(ROOT, "tazuna.config.json"));
    assert.deepStrictEqual(result.roots, [
      { path: "src", kind: "src" },
      { path: "tests", kind: "test" },
    ]);
    assert.deepStrictEqual(JSON.parse(result.content), {
      kind: "generic",
      extraRoots: [
        { path: "src", kind: "src" },
        { path: "tests", kind: "test" },
      ],
    });
    assert.strictEqual(fs.files.get(path.join(ROOT, "tazuna.config.json")), result.content);
    assert.ok(result.content.endsWith("}\n"), "末尾は改行で終える");
  });

  test("候補は実在するものだけ(src のみなら test は書かない)", () => {
    const result = initConfig(ROOT, fakeFs(["src"]).deps);
    assert.ok(result.kind === "created");
    assert.deepStrictEqual(result.roots, [{ path: "src", kind: "src" }]);
  });

  test("複数の候補(app と e2e)も拾う。順序は候補名の順", () => {
    const result = initConfig(ROOT, fakeFs(["e2e", "app", "lib"]).deps);
    assert.ok(result.kind === "created");
    assert.deepStrictEqual(result.roots, [
      { path: "app", kind: "src" },
      { path: "lib", kind: "src" },
      { path: "e2e", kind: "test" },
    ]);
  });

  test("既に旧名の slnmix.config.json があれば変えない(冪等。新しい名前の設定も作らない)", () => {
    const fs = fakeFs(["src"], ["slnmix.config.json"]);
    fs.files.set(path.join(ROOT, "slnmix.config.json"), '{ "kind": "solution" }');
    const result = initConfig(ROOT, fs.deps);
    assert.deepStrictEqual(result, { kind: "kept", path: path.join(ROOT, "slnmix.config.json") });
    assert.strictEqual(fs.files.get(path.join(ROOT, "slnmix.config.json")), '{ "kind": "solution" }');
  });

  test(".sln / .vbproj がある場所では作らない(solution 構成で動くため)", () => {
    const fs = fakeFs(["src"], ["App.sln", "readme.txt"]);
    const result = initConfig(ROOT, fs.deps);
    assert.ok(result.kind === "error" && result.message.includes("App.sln"));
    assert.ok(!fs.files.has(path.join(ROOT, "slnmix.config.json")));
  });

  test("ソースの候補ディレクトリが無ければ推測で書かずエラー + 設定例", () => {
    const fs = fakeFs(["docs", "tests"]);
    const result = initConfig(ROOT, fs.deps);
    assert.ok(result.kind === "error");
    assert.ok(result.message.includes("見つかりません"));
    assert.ok(result.message.includes(EXAMPLE_CONFIG));
    assert.ok(!fs.files.has(path.join(ROOT, "slnmix.config.json")));
  });
});

suite("initConfig: 実際にあるファイルの拡張子から include / exclude を書く(v0.18.0)", () => {
  /** ルート相対のパス → 内容 */
  const contents: Record<string, string> = {
    "app/main.py": "print(1)\n",
    "app/util.py": "x = 1\n",
    "app/vendor/lib.py": "y = 2\n",
    "data/users.csv": "id,email\n",
    "pyproject.toml": "[project]\n",
    ".npmrc": "//r/:_authToken=x\n",
  };
  const files = Object.entries(contents).map(([relativePath, content]) => ({ relativePath, size: content.length }));
  const readHead = (abs: string): string | undefined =>
    contents[path.relative(ROOT, abs).split(path.sep).join("/")];

  test("git のリポジトリ: git の一覧から include / exclude を決めて書く(Markdown・.gitignore・設定ファイル自身は常に)", () => {
    const fs = fakeFs([]);
    const result = initConfig(
      ROOT,
      { ...fs.deps, listPackableGitFiles: () => files, readHead },
      { gitRepository: true },
    );
    assert.ok(result.kind === "created");
    assert.deepStrictEqual(JSON.parse(result.content), {
      kind: "generic",
      include: ["**/*.py", "**/*.md", "**/*.toml", "**/.gitignore", "tazuna.config.json"],
      exclude: ["app/vendor/**"],
    });
    assert.strictEqual(fs.files.get(path.join(ROOT, "tazuna.config.json")), result.content);
    assert.deepStrictEqual(result.plan?.languages, [{ name: "Python", count: 2 }]);
    assert.deepStrictEqual(
      result.plan?.omitted.map((entry) => entry.label),
      [".csv", ".npmrc"],
    );
  });

  test("git のリポジトリでファイルがまだ無い・一覧できないときは include を書かない(すべてが対象。v0.17.0 と同じ)", () => {
    for (const listed of [[], undefined]) {
      const result = initConfig(ROOT, { ...fakeFs([]).deps, listPackableGitFiles: () => listed }, { gitRepository: true });
      assert.ok(result.kind === "created");
      assert.strictEqual(result.content, '{\n  "kind": "generic"\n}\n');
      assert.strictEqual(result.plan, undefined);
    }
  });

  test("git の外: 候補のディレクトリごとに中のファイルから include を、入らなかったディレクトリ(仮想環境など)を exclude に書く", () => {
    const fs = fakeFs(["src", "tests"]);
    const listDirectoryFiles = (abs: string) => {
      const name = path.relative(ROOT, abs);
      if (name === "src") {
        return {
          files: [
            { relativePath: "pkg/core.py", size: 10 },
            { relativePath: "pkg/data.csv", size: 10 },
          ],
          skippedDirs: [{ relativePath: ".venv", reason: "Python の仮想環境" }],
        };
      }
      return { files: [{ relativePath: "test_core.py", size: 10 }], skippedDirs: [] };
    };
    const result = initConfig(ROOT, {
      ...fs.deps,
      listDirectoryFiles,
      listDirectoryNames: () => ["src", "tests"],
      readHead: () => "x = 1\n",
    });
    assert.ok(result.kind === "created");
    assert.deepStrictEqual(JSON.parse(result.content), {
      kind: "generic",
      extraRoots: [
        { path: "src", kind: "src", include: ["**/*.py"], exclude: [".venv/**"] },
        { path: "tests", kind: "test", include: ["**/*.py"] },
      ],
    });
  });

  test("git の外で候補名のディレクトリが無ければ、直下のディレクトリのうち言語の分かるソースを含むもの(仮想環境・docs/ は見ない)", () => {
    const fs = fakeFs(["mypkg", "venv", "docs", "assets", "tests"]);
    fs.files.set(path.join(ROOT, "venv", "pyvenv.cfg"), "home = /usr\n");
    const listed: Record<string, string[]> = {
      mypkg: ["__init__.py", "core.py"],
      venv: ["lib/site.py"],
      docs: ["a.md"],
      assets: ["logo.csv"],
      tests: ["test_core.py"],
    };
    const result = initConfig(ROOT, {
      ...fs.deps,
      listDirectoryNames: () => ["assets", "docs", "mypkg", "tests", "venv", ".git"],
      listDirectoryFiles: (abs) => ({
        files: (listed[path.basename(abs)] ?? []).map((relativePath) => ({ relativePath, size: 5 })),
        skippedDirs: [],
      }),
      readHead: () => "x\n",
    });
    assert.ok(result.kind === "created");
    assert.deepStrictEqual(
      result.roots.map((root) => [root.path, root.kind, root.plan?.include]),
      [
        ["mypkg", "src", ["**/*.py"]],
        ["tests", "test", ["**/*.py"]],
      ],
    );
  });

  test("git の外で言語の分かるソースを含むディレクトリも無ければ、推測で書かずエラー", () => {
    const fs = fakeFs(["assets"]);
    const result = initConfig(ROOT, {
      ...fs.deps,
      listDirectoryNames: () => ["assets"],
      listDirectoryFiles: () => ({ files: [{ relativePath: "a.csv", size: 3 }], skippedDirs: [] }),
      readHead: () => "a\n",
    });
    assert.ok(result.kind === "error" && result.message.includes("言語の分かるソースを含むディレクトリ"));
    assert.ok(!fs.files.has(path.join(ROOT, "tazuna.config.json")));
  });
});

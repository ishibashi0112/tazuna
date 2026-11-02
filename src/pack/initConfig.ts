/**
 * tazuna pack --init-config: .sln の無いプロジェクト(TypeScript・Python・Go など)で使う
 * ための設定ファイル(tazuna.config.json、kind: "generic")を作る(旧 slnmix v0.17.0、設計書 §19)。
 * tazuna init も .sln などが無いときはこれを使う。
 *
 * - 既に設定ファイルがあれば(旧名の slnmix.config.json でも)何もしない(冪等。中身は変えない)
 * - その場所に .sln / .vbproj / .csproj があれば作らない(従来の solution 構成で動くため)
 * - git のリポジトリの中なら extraRoots を書かない(git が管理しているファイルが対象。設計書 §25.7)。
 *   v0.18.0 から、実際にあるファイルの拡張子を見て include / exclude を書く(includePlanner.ts)。
 *   ファイルがまだ無ければ書かない(すべてが対象)
 * - git の外では、ソースのディレクトリは「候補名のうち実在するもの」だけを採用する(src / app /
 *   lib / apps / packages → kind: "src"、tests / test / e2e / __tests__ →
 *   kind: "test")。候補が無ければ、直下のディレクトリのうち言語の分かるソースを含むものを使う
 *   (v0.18.0)。それぞれの include / exclude も中のファイルの拡張子から書く。1 つも無ければ推測で
 *   書かずエラーにし、例を示す
 *
 * ファイルシステムは deps 注入(単体テスト可能)。
 */

import * as path from "node:path";
import { PACK_COMMAND } from "../brand.ts";
import { planInclude, type IncludePlan, type PlannerFile } from "./includePlanner.ts";
import { CONFIG_FILE_NAME, configFileNameIn, hasConfigFile } from "./slnmixConfig.ts";

export interface InitConfigDeps {
  isDirectory(absolutePath: string): boolean;
  isFile(absolutePath: string): boolean;
  /** ディレクトリ直下のファイル名一覧(取得できなければ undefined) */
  listFileNames(absolutePath: string): string[] | undefined;
  writeTextFile(absolutePath: string, content: string): void;
  /**
   * git が管理しているファイル(ルート相対。パックと同じ既定の除外を済ませたもの)。無い・一覧できなければ
   * undefined(include を書かない)
   */
  listPackableGitFiles?: ((rootDir: string) => PlannerFile[] | undefined) | undefined;
  /**
   * ディレクトリの中のファイル(再帰。ドットで始まるディレクトリ・仮想環境・ビルドの出力には入らず、
   * skippedDirs に)。無ければ extraRoots に include を書かない(v0.17.0 までと同じ)
   */
  listDirectoryFiles?:
    | ((absoluteDir: string) => { files: PlannerFile[]; skippedDirs: Array<{ relativePath: string; reason: string }> } | undefined)
    | undefined;
  /** 直下のディレクトリ名(git の外で候補のディレクトリが無いときに見る) */
  listDirectoryNames?: ((absolutePath: string) => string[] | undefined) | undefined;
  /** ファイルの先頭(生成コードの印・shebang・バイナリの見分け)。読めなければ undefined */
  readHead?: ((absolutePath: string) => string | undefined) | undefined;
}

export type InitConfigResult =
  /**
   * roots が空なら git が管理しているファイルを対象にする設定(extraRoots なし)。plan はそのとき
   * 拡張子から決めた include / exclude(ファイルがまだ無いなど、決めなかったときは undefined)
   */
  | { kind: "created"; path: string; content: string; roots: InitConfigRoot[]; plan?: IncludePlan | undefined }
  | { kind: "kept"; path: string }
  | { kind: "error"; message: string };

export interface InitConfigRoot {
  path: string;
  kind: "src" | "test";
  /** 中のファイルの拡張子から決めた include / exclude(決めなかったときは undefined) */
  plan?: IncludePlan | undefined;
  /** 中に入らなかったディレクトリ(仮想環境・ビルドの出力など)。exclude に書いた */
  skippedDirs?: Array<{ relativePath: string; reason: string }> | undefined;
}

/**
 * git の一覧から決める include に、ファイルが無くても入れるもの(init が続けて作る docs/ の Markdown・
 * .gitignore・設定ファイル自身。設定ファイルは AI がパックの範囲を知る手がかりになる)
 */
export const ALWAYS_INCLUDE: readonly string[] = ["**/*.md", "**/.gitignore", CONFIG_FILE_NAME];

/** git の外で候補のディレクトリが無いとき、直下のディレクトリのうち見ないもの(docs/ は <docs> に入る) */
const SKIPPED_TOP_DIRECTORIES = new Set(["node_modules", "dist", "build", "bin", "obj", "target", "docs", "__pycache__"]);

/** ソースの候補ディレクトリ(この順で並ぶ) */
export const SOURCE_DIR_CANDIDATES: readonly string[] = ["src", "app", "lib", "apps", "packages"];
/** 自動テストの候補ディレクトリ */
export const TEST_DIR_CANDIDATES: readonly string[] = ["tests", "test", "e2e", "__tests__"];

/** 候補が 1 つも無いときに案内する設定例 */
export const EXAMPLE_CONFIG = `{
  "kind": "generic",
  "extraRoots": [
    { "path": "src", "kind": "src" },
    { "path": "tests", "kind": "test" }
  ]
}`;

function renderConfig(roots: readonly InitConfigRoot[]): string {
  return `${JSON.stringify(
    {
      kind: "generic",
      extraRoots: roots.map((root) => {
        const exclude = [
          ...(root.plan?.exclude ?? []),
          ...(root.skippedDirs ?? []).map((dir) => `${dir.relativePath}/**`),
        ];
        return {
          path: root.path,
          kind: root.kind,
          ...(root.plan !== undefined && root.plan.include.length > 0 ? { include: root.plan.include } : {}),
          ...(exclude.length > 0 ? { exclude } : {}),
        };
      }),
    },
    null,
    2,
  )}\n`;
}

/** git が管理しているファイルを対象にし、拡張子から決めた include / exclude を書く generic 構成 */
export function renderGitGenericConfig(plan: IncludePlan): string {
  return `${JSON.stringify(
    {
      kind: "generic",
      include: plan.include,
      ...(plan.exclude.length > 0 ? { exclude: plan.exclude } : {}),
    },
    null,
    2,
  )}\n`;
}

/** git が管理しているファイルを対象にする generic 構成(extraRoots なし。設計書 §25.7) */
export const GIT_GENERIC_CONFIG = `{
  "kind": "generic"
}
`;

/**
 * @param rootDir 設定を置くディレクトリ(プロジェクトルート)の絶対パス
 * @param options.gitRepository git のリポジトリの中か。そうなら extraRoots を書かず、git が管理している
 *   ファイルを対象にする(候補のディレクトリを探さない)
 */
export function initConfig(
  rootDir: string,
  deps: InitConfigDeps,
  options: { gitRepository?: boolean | undefined } = {},
): InitConfigResult {
  // 旧名(slnmix.config.json)の設定があればそれを使う(名前は変えない)
  if (hasConfigFile(rootDir, deps.isFile)) {
    return { kind: "kept", path: path.join(rootDir, configFileNameIn(rootDir, deps.isFile)) };
  }
  const configPath = path.join(rootDir, CONFIG_FILE_NAME);
  const names = deps.listFileNames(rootDir) ?? [];
  const solutionFiles = names.filter((name) => /\.(sln|vbproj|csproj)$/i.test(name)).sort();
  if (solutionFiles.length > 0) {
    return {
      kind: "error",
      message: [
        `${rootDir} には ${solutionFiles.join(", ")} があります。VB.NET / C# のプロジェクトは設定なしで npx ${PACK_COMMAND} を実行できます(kind: "generic" は .sln / .vbproj / .csproj の無いプロジェクト向け)。`,
      ].join("\n"),
    };
  }
  if (options.gitRepository === true) {
    const files = deps.listPackableGitFiles?.(rootDir);
    if (files === undefined || files.length === 0) {
      // まだファイルが無い(新しいリポジトリ)など: 拡張子から決められないので、すべてを対象にする
      deps.writeTextFile(configPath, GIT_GENERIC_CONFIG);
      return { kind: "created", path: configPath, content: GIT_GENERIC_CONFIG, roots: [] };
    }
    const plan = planInclude(
      { files, readHead: (relativePath) => deps.readHead?.(path.join(rootDir, ...relativePath.split("/"))) },
      { alwaysInclude: ALWAYS_INCLUDE },
    );
    const content = renderGitGenericConfig(plan);
    deps.writeTextFile(configPath, content);
    return { kind: "created", path: configPath, content, roots: [], plan };
  }
  const roots: InitConfigRoot[] = [];
  for (const name of SOURCE_DIR_CANDIDATES) {
    if (deps.isDirectory(path.join(rootDir, name))) {
      roots.push({ path: name, kind: "src" });
    }
  }
  if (roots.length === 0 && deps.listDirectoryFiles !== undefined && deps.listDirectoryNames !== undefined) {
    // 候補名のディレクトリが無ければ、直下のディレクトリのうち言語の分かるソースを含むもの(例: Python の
    // パッケージのディレクトリ)。見つけたものは設定に書くので利用者に見える
    const names = (deps.listDirectoryNames(rootDir) ?? [])
      .filter((name) => !name.startsWith(".") && !SKIPPED_TOP_DIRECTORIES.has(name.toLowerCase()))
      .filter((name) => !TEST_DIR_CANDIDATES.includes(name))
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (deps.isFile(path.join(rootDir, name, "pyvenv.cfg"))) {
        continue;
      }
      const planned = planRoot(rootDir, name, deps);
      if (planned?.plan !== undefined && planned.plan.languages.length > 0) {
        roots.push({ path: name, kind: "src", ...planned });
      }
    }
  } else {
    for (const root of roots) {
      Object.assign(root, planRoot(rootDir, root.path, deps));
    }
  }
  for (const name of TEST_DIR_CANDIDATES) {
    if (deps.isDirectory(path.join(rootDir, name))) {
      roots.push({ path: name, kind: "test", ...planRoot(rootDir, name, deps) });
    }
  }
  if (!roots.some((root) => root.kind === "src")) {
    return {
      kind: "error",
      message: [
        `${rootDir} にソースのディレクトリ(${SOURCE_DIR_CANDIDATES.join(" / ")}、または言語の分かるソースを含むディレクトリ)が見つかりません。推測では作らないので、${CONFIG_FILE_NAME} を手で作ってください。例:`,
        EXAMPLE_CONFIG,
      ].join("\n"),
    };
  }
  const content = renderConfig(roots);
  deps.writeTextFile(configPath, content);
  return { kind: "created", path: configPath, content, roots };
}

/** extraRoots の 1 つのディレクトリの include / exclude を中のファイルから決める(走査できなければ undefined) */
function planRoot(
  rootDir: string,
  name: string,
  deps: InitConfigDeps,
): Pick<InitConfigRoot, "plan" | "skippedDirs"> | undefined {
  const listed = deps.listDirectoryFiles?.(path.join(rootDir, name));
  if (listed === undefined) {
    return undefined;
  }
  const plan = planInclude({
    files: listed.files,
    readHead: (relativePath) => deps.readHead?.(path.join(rootDir, name, ...relativePath.split("/"))),
  });
  return {
    plan: plan.include.length > 0 ? plan : undefined,
    skippedDirs: listed.skippedDirs.length > 0 ? listed.skippedDirs : undefined,
  };
}

function formatKiloChars(bytes: number): string {
  return bytes < 1000 ? `${bytes}` : `${Math.round(bytes / 1000)}K`;
}

/**
 * 拡張子から決めた include / exclude の説明(init と --init-config の表示用。1 要素 1 行、字下げなし)。
 * @param scope 何から決めたか(例: "git が管理しているファイル"・"src/")
 */
export function describeIncludePlan(plan: IncludePlan, scope: string): string[] {
  const lines: string[] = [];
  lines.push(
    plan.languages.length === 0
      ? `言語: (${scope}に言語の分かるソースがありません)`
      : `言語: ${plan.languages.map((language) => `${language.name} ${language.count} 件`).join(" / ")}`,
  );
  lines.push(`include: ${plan.include.join(", ")}`);
  if (plan.excluded.length > 0) {
    lines.push(
      `exclude: ${plan.excluded
        .map((entry) => `${entry.pattern}(${entry.reason}${entry.count > 0 ? ` ${entry.count} 件` : ""})`)
        .join(" / ")}`,
    );
  }
  if (plan.omitted.length > 0) {
    const shown = plan.omitted.slice(0, 8);
    const rest = plan.omitted.length - shown.length;
    lines.push(
      `入れないもの: ${[
        ...shown.map((entry) => `${entry.label} ${entry.count} 件(${entry.reason}。例: ${entry.example})`),
        ...(rest > 0 ? [`ほか ${rest} 種類`] : []),
      ].join(" / ")}`,
    );
  }
  return lines;
}

/** git の一覧から決めたときの、パックの大きさの目安(貼り付けの上限との比較) */
export function describePackSize(plan: IncludePlan, pasteLimit: number, overhead: number): string[] {
  const estimate = plan.includedBytes + overhead;
  const head = `ファイルの中身: ${plan.includedCount} 件・約 ${formatKiloChars(plan.includedBytes)} 文字`;
  if (estimate <= pasteLimit) {
    return [`${head}(手順文などを足しても、貼り付けの上限の目安 約 ${formatKiloChars(pasteLimit)} 文字に収まる見込み)`];
  }
  return [
    `${head}。手順文などを足すと貼り付けの上限の目安(約 ${formatKiloChars(pasteLimit)} 文字)を超える見込みで、その場合はパックを添付で渡します(本文用テキストがクリップボードに入ります)`,
    `大きいもの: ${plan.largest.map((file) => `${file.relativePath}(約 ${formatKiloChars(file.size)} 文字)`).join(" / ")}。要らなければ exclude に足してください`,
  ];
}

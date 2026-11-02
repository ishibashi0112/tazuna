/**
 * .vbproj のビルド環境の要約(<environment>。手順文 v10、2026-11-02)。
 *
 * パックには .vbproj 本体が入らないため、AI には Visual Basic の言語の版・.NET Framework の版・
 * Option の設定・参照が見えなかった。VS2013 世代(Visual Basic 12.0)では文字列補間 $"..."・
 * NameOf・?. がビルドエラーになるのに、手順文は「Option Strict On を前提に」と決め打ちだった
 * (2026-10-26 の手順文の見直しの改善候補 1、設計書 §25.7)。
 *
 * 値は静的に読んだもの(parseVbproj の environment)をそのまま載せる。言語の版の指定
 * (LangVersion)が無い旧スタイルのプロジェクトだけは、ToolsVersion の Visual Studio の既定の版と
 * 「みなす」と明記して上限を書く(推測したことを宣言する。原則 3)。新しい Visual Studio で
 * ビルドしていても古い構文は通るため、低い方に倒して困ることはない。
 *
 * C# の .csproj(tazuna 0.17.0〜)も同じ形で載せる。言語の版は、LangVersion が無ければ旧スタイルは
 * ToolsVersion の Visual Studio の既定、SDK スタイルはターゲット フレームワークの既定の版と「みなす」と明記する
 * (SDK はターゲット フレームワークで既定の C# の版を決める)。VB には無い Nullable・ImplicitUsings と、
 * プロジェクト全体の using(<Using Include>)を載せる。VB だけのときの出力は C# 対応の前と同じ。
 *
 * 純粋関数。I/O なし。
 */

import { projectFilesLabel, type ProjectLanguage } from "../projectLanguage.ts";
import type { ProjectEnvironment, ProjectStyle } from "../types.ts";

export interface EnvironmentSource {
  /** 表示名(.sln 上のプロジェクト名) */
  label: string;
  /** 表示用の .vbproj / .csproj のパス(ルート相対・/ 区切り) */
  projectPath: string;
  /** プロジェクトの言語(省略時は VB) */
  language?: ProjectLanguage | undefined;
  style: ProjectStyle;
  environment?: ProjectEnvironment | undefined;
}

/** ToolsVersion → その形式を作る Visual Studio と、その既定の Visual Basic の版 */
const TOOLS_VERSIONS: Readonly<Record<string, { studio: string; vb: number; note?: string }>> = {
  "2.0": { studio: "Visual Studio 2005", vb: 8 },
  "3.5": { studio: "Visual Studio 2008", vb: 9 },
  "4.0": { studio: "Visual Studio 2010 / 2012", vb: 10, note: "古い方の Visual Studio 2010" },
  "12.0": { studio: "Visual Studio 2013", vb: 12 },
  "14.0": { studio: "Visual Studio 2015", vb: 14 },
  "15.0": { studio: "Visual Studio 2017", vb: 15 },
  current: { studio: "Visual Studio 2019 以降", vb: 16 },
};

/** 版ごとに増えた主な構文(上限より新しいものを「使えない」として挙げる。15.0 より後は細かいので載せない) */
const VB_FEATURES: ReadonlyArray<{ vb: number; features: readonly string[] }> = [
  { vb: 9, features: ["LINQ", "ラムダ式", "If 演算子", "Option Infer の型推論"] },
  { vb: 10, features: ["自動実装プロパティ", "コレクション初期化子 From", "暗黙の行継続", "複数行のラムダ・Sub ラムダ"] },
  { vb: 11, features: ["Async / Await", "Iterator / Yield"] },
  {
    vb: 14,
    features: [
      '文字列補間 $"..."',
      "NameOf",
      "Null 条件演算子 ?.",
      "複数行の文字列リテラル",
      "ReadOnly 自動実装プロパティ",
    ],
  },
  { vb: 15, features: ["タプル", "2 進数リテラル &B"] },
];

/** ToolsVersion → その形式を作る Visual Studio と、その既定の C# の版(VS2019 以降は .NET Framework の既定の 7.3) */
const CS_TOOLS_VERSIONS: Readonly<Record<string, { studio: string; cs: number; note?: string }>> = {
  "2.0": { studio: "Visual Studio 2005", cs: 2 },
  "3.5": { studio: "Visual Studio 2008", cs: 3 },
  "4.0": { studio: "Visual Studio 2010 / 2012", cs: 4, note: "古い方の Visual Studio 2010" },
  "12.0": { studio: "Visual Studio 2013", cs: 5 },
  "14.0": { studio: "Visual Studio 2015", cs: 6 },
  "15.0": { studio: "Visual Studio 2017", cs: 7 },
  current: { studio: "Visual Studio 2019 以降", cs: 7.3, note: "Visual Studio 2019 以降(.NET Framework)" },
};

/**
 * 版ごとに増えた主な構文(上限より新しいものを「使えない」として挙げる。AI が書きがちなものに絞る。
 * 12 より後は細かいので載せない)
 */
const CS_FEATURES: ReadonlyArray<{ cs: number; features: readonly string[] }> = [
  { cs: 3, features: ["LINQ", "ラムダ式", "var", "拡張メソッド", "自動実装プロパティ", "オブジェクト初期化子"] },
  { cs: 4, features: ["dynamic", "名前付き引数", "省略可能な引数"] },
  { cs: 5, features: ["async / await"] },
  {
    cs: 6,
    features: ['文字列補間 $"..."', "nameof", "Null 条件演算子 ?.", "式形式のメンバー =>", "get だけの自動実装プロパティ"],
  },
  { cs: 7, features: ["タプル", "out var", "is による型パターン", "ローカル関数", "2 進数リテラル 0b"] },
  { cs: 7.1, features: ["default リテラル"] },
  { cs: 8, features: ["switch 式", "null 許容参照型", "using 宣言", "??=", "インデックスと範囲 ^ .."] },
  { cs: 9, features: ["record", "init アクセサー", "ターゲット型の new()", "トップレベル ステートメント"] },
  { cs: 10, features: ["ファイル スコープの名前空間 namespace X;", "global using"] },
  { cs: 11, features: ['生文字列リテラル """..."""', "required メンバー"] },
  { cs: 12, features: ["プライマリ コンストラクター", "コレクション式 [...]"] },
];

/**
 * SDK スタイルで LangVersion が無いときの既定の C# の版(ターゲット フレームワークで決まる)。
 * 分からないもの(MSBuild 式など)は undefined
 */
function defaultCsVersionOf(framework: string): number | undefined {
  const tfm = framework.trim().toLowerCase();
  const modern = /^net(\d+)\.(\d+)(?:-[a-z0-9.]+)?$/.exec(tfm);
  if (modern !== null) {
    const major = Number(modern[1]);
    // net5.0 → C# 9、以降 1 つずつ(net10.0 → C# 14)
    return major >= 5 ? major + 4 : undefined;
  }
  if (/^net(?:coreapp3\.\d|standard2\.1)$/.test(tfm)) {
    return 8;
  }
  if (/^(?:net[1-4]\d*|netstandard[12]\.\d|netcoreapp[12]\.\d)$/.test(tfm) || /^v\d/.test(tfm)) {
    return 7.3;
  }
  return undefined;
}

/** 参照・Imports を並べる上限(超えた分は件数だけ) */
const LIST_LIMIT = 40;

function formatVersion(vb: number): string {
  return Number.isInteger(vb) ? `${vb}.0` : String(vb);
}

/** C# の版の表記(7.3 / 10。整数は .0 を付けない。C# の呼び方に合わせる) */
function formatCsVersion(cs: number): string {
  return String(cs);
}

/** 上限より新しい版の構文を「14.0 以降の …、15.0 以降の …」の形で */
function unavailableFeatures(limit: number): string | undefined {
  return listUnavailable(
    VB_FEATURES.map((entry) => ({ version: entry.vb, features: entry.features })),
    limit,
    formatVersion,
  );
}

function listUnavailable(
  table: ReadonlyArray<{ version: number; features: readonly string[] }>,
  limit: number,
  format: (version: number) => string,
): string | undefined {
  const parts = table.filter((entry) => entry.version > limit).map(
    (entry) => {
      const features = entry.features.join("・");
      // 英数字で始まるときは和文との間を空ける(「11.0 以降の Async」)
      return `${format(entry.version)} 以降の${/^[\x21-\x7e]/.test(features) ? " " : ""}${features}`;
    },
  );
  return parts.length === 0 ? undefined : `${parts.join("、")} は使えない`;
}

function unavailableCsFeatures(limit: number): string | undefined {
  return listUnavailable(
    CS_FEATURES.map((entry) => ({ version: entry.cs, features: entry.features })),
    limit,
    formatCsVersion,
  );
}

function joinLimited(values: readonly string[]): string {
  if (values.length <= LIST_LIMIT) {
    return values.join(", ");
  }
  return `${values.slice(0, LIST_LIMIT).join(", ")} ほか ${values.length - LIST_LIMIT} 件`;
}

/** 構成で値が分かれるときは併記する */
function joinValues(values: readonly string[]): string {
  return values.length <= 1 ? (values[0] ?? "") : `${values.join(" / ")}(構成で分かれる)`;
}

/** Visual Basic の言語の版の行 */
function describeLanguage(source: EnvironmentSource, environment: ProjectEnvironment): string {
  const numeric = environment.langVersions
    .map((value) => Number.parseFloat(value))
    .filter((value) => Number.isFinite(value));
  if (environment.langVersions.length > 0) {
    if (numeric.length === 0) {
      return `${joinValues(environment.langVersions)}(LangVersion の指定)`;
    }
    const limit = Math.min(...numeric);
    const unavailable = unavailableFeatures(limit);
    const lower = environment.langVersions.length > 1 ? "。低い方に合わせる" : "";
    return `${formatVersion(limit)} まで(LangVersion の指定: ${environment.langVersions.join(" / ")}${lower})${unavailable === undefined ? "" : `。${unavailable}`}`;
  }
  if (source.style === "sdk") {
    return "SDK の既定(LangVersion の指定なし。SDK スタイルは Visual Studio 2017 以降の形式)";
  }
  const toolsVersion = environment.toolsVersion;
  const known = toolsVersion === undefined ? undefined : TOOLS_VERSIONS[toolsVersion.toLowerCase()];
  if (toolsVersion === undefined || known === undefined) {
    return toolsVersion === undefined
      ? "不明(ToolsVersion・LangVersion の指定なし)"
      : `不明(ToolsVersion ${toolsVersion}・LangVersion の指定なし)`;
  }
  const unavailable = unavailableFeatures(known.vb);
  return `${formatVersion(known.vb)} まで(LangVersion の指定なし。ToolsVersion ${toolsVersion} は ${known.studio} の形式のため、${known.note ?? known.studio} の既定の Visual Basic ${formatVersion(known.vb)} とみなす)${unavailable === undefined ? "" : `。${unavailable}`}`;
}

/** C# の言語の版の行 */
function describeCsLanguage(source: EnvironmentSource, environment: ProjectEnvironment): string {
  const numeric = environment.langVersions
    .map((value) => Number.parseFloat(value))
    .filter((value) => Number.isFinite(value));
  if (environment.langVersions.length > 0) {
    if (numeric.length === 0) {
      return `${joinValues(environment.langVersions)}(LangVersion の指定)`;
    }
    const limit = Math.min(...numeric);
    const unavailable = unavailableCsFeatures(limit);
    const lower = environment.langVersions.length > 1 ? "。低い方に合わせる" : "";
    return `${formatCsVersion(limit)} まで(LangVersion の指定: ${environment.langVersions.join(" / ")}${lower})${unavailable === undefined ? "" : `。${unavailable}`}`;
  }
  if (source.style === "sdk") {
    const defaults = environment.targetFrameworks.map(defaultCsVersionOf);
    if (environment.targetFrameworks.length === 0 || defaults.some((value) => value === undefined)) {
      return "SDK の既定(LangVersion の指定なし。SDK スタイルはターゲット フレームワークの既定の版になる)";
    }
    const limit = Math.min(...(defaults as number[]));
    const frameworks = environment.targetFrameworks.join(" / ");
    // 英数字の後は和文との間を空ける(「net8.0 の既定」「net48 / net6.0 のうち低い方の既定」)
    const which = environment.targetFrameworks.length > 1 ? `${frameworks} のうち低い方` : `${frameworks} `;
    const unavailable = unavailableCsFeatures(limit);
    return `${formatCsVersion(limit)} まで(LangVersion の指定なし。SDK スタイルはターゲット フレームワークの既定の版になるため、${which}の既定の C# ${formatCsVersion(limit)} とみなす)${unavailable === undefined ? "" : `。${unavailable}`}`;
  }
  const toolsVersion = environment.toolsVersion;
  const known = toolsVersion === undefined ? undefined : CS_TOOLS_VERSIONS[toolsVersion.toLowerCase()];
  if (toolsVersion === undefined || known === undefined) {
    return toolsVersion === undefined
      ? "不明(ToolsVersion・LangVersion の指定なし)"
      : `不明(ToolsVersion ${toolsVersion}・LangVersion の指定なし)`;
  }
  const unavailable = unavailableCsFeatures(known.cs);
  return `${formatCsVersion(known.cs)} まで(LangVersion の指定なし。ToolsVersion ${toolsVersion} は ${known.studio} の形式のため、${known.note ?? known.studio} の既定の C# ${formatCsVersion(known.cs)} とみなす)${unavailable === undefined ? "" : `。${unavailable}`}`;
}

/** C# の Nullable・ImplicitUsings の行 */
function describeCsOptions(environment: ProjectEnvironment): string[] {
  const lines: string[] = [];
  const enabled = (values: readonly string[]): boolean =>
    values.some((value) => ["enable", "true"].includes(value.trim().toLowerCase()));
  if (environment.nullable.length > 0) {
    lines.push(
      `Nullable: ${joinValues(environment.nullable)}${enabled(environment.nullable) ? "(null 許容参照型が有効。null になり得る参照型には ? を付ける)" : ""}`,
    );
  }
  if (environment.implicitUsings.length > 0) {
    lines.push(
      `ImplicitUsings: ${joinValues(environment.implicitUsings)}${enabled(environment.implicitUsings) ? "(System・System.IO・System.Linq など SDK の既定の名前空間は using を書かなくても使える)" : ""}`,
    );
  }
  return lines;
}

function describeFramework(environment: ProjectEnvironment): string | undefined {
  if (environment.targetFrameworks.length === 0) {
    return undefined;
  }
  const legacy = environment.targetFrameworks.every((value) => /^v\d/i.test(value));
  return legacy
    ? `.NET Framework: ${joinValues(environment.targetFrameworks)}`
    : `ターゲット フレームワーク: ${joinValues(environment.targetFrameworks)}`;
}

function describeOptions(environment: ProjectEnvironment): string | undefined {
  const parts = (
    [
      ["Strict", environment.optionStrict],
      ["Explicit", environment.optionExplicit],
      ["Infer", environment.optionInfer],
      ["Compare", environment.optionCompare],
    ] as const
  )
    .filter(([, values]) => values.length > 0)
    .map(([name, values]) => `${name} ${joinValues(values)}`);
  return parts.length === 0 ? undefined : `Option: ${parts.join(" / ")}(ファイル先頭の Option 文があればそちらが優先)`;
}

function describeSource(source: EnvironmentSource): string[] {
  if (source.language === "cs") {
    return describeCsSource(source);
  }
  const head = `- ${source.label}(${source.projectPath})`;
  const environment = source.environment;
  if (environment === undefined) {
    return [head, "  - .vbproj を XML として読めなかったため不明"];
  }
  const lines = [
    `  - 形式: ${source.style === "sdk" ? "SDK スタイル" : `旧スタイル${environment.toolsVersion === undefined ? "" : `(ToolsVersion ${environment.toolsVersion})`}`}`,
    `  - Visual Basic: ${describeLanguage(source, environment)}`,
  ];
  const framework = describeFramework(environment);
  if (framework !== undefined) {
    lines.push(`  - ${framework}`);
  }
  const options = describeOptions(environment);
  if (options !== undefined) {
    lines.push(`  - ${options}`);
  }
  if (environment.rootNamespaces.length > 0) {
    lines.push(
      `  - ルート名前空間: ${joinValues(environment.rootNamespaces)}(ファイルに Namespace を書かなくても、この名前空間に入る)`,
    );
  }
  if (environment.imports.length > 0) {
    lines.push(`  - プロジェクト全体の Imports: ${joinLimited(environment.imports)}`);
  }
  if (environment.references.length > 0) {
    lines.push(`  - 参照: ${joinLimited(environment.references)}`);
  }
  return [head, ...lines];
}

function describeCsSource(source: EnvironmentSource): string[] {
  const head = `- ${source.label}(${source.projectPath})`;
  const environment = source.environment;
  if (environment === undefined) {
    return [head, "  - .csproj を XML として読めなかったため不明"];
  }
  const lines = [
    `  - 形式: ${source.style === "sdk" ? "SDK スタイル" : `旧スタイル${environment.toolsVersion === undefined ? "" : `(ToolsVersion ${environment.toolsVersion})`}`}`,
    `  - C#: ${describeCsLanguage(source, environment)}`,
  ];
  const framework = describeFramework(environment);
  if (framework !== undefined) {
    lines.push(`  - ${framework}`);
  }
  lines.push(...describeCsOptions(environment).map((line) => `  - ${line}`));
  if (environment.rootNamespaces.length > 0) {
    lines.push(
      `  - 既定の名前空間: ${joinValues(environment.rootNamespaces)}(C# は各ファイルの namespace 宣言で名前空間が決まる。新しいファイルには同じフォルダの既存ファイルと同じ形で namespace を書く)`,
    );
  }
  if (environment.imports.length > 0) {
    lines.push(`  - プロジェクト全体の using(global using): ${joinLimited(environment.imports)}`);
  }
  if (environment.references.length > 0) {
    lines.push(`  - 参照: ${joinLimited(environment.references)}`);
  }
  return [head, ...lines];
}

/** <environment> ブロック(閉じタグまで。末尾の改行なし)。プロジェクトが無ければ undefined */
export function renderEnvironmentBlock(sources: readonly EnvironmentSource[]): string | undefined {
  if (sources.length === 0) {
    return undefined;
  }
  return [
    "<environment>",
    `${projectFilesLabel(sources.map((source) => source.language ?? "vb"))} から読み取ったビルド環境(静的に読んだ値。Condition は評価せず、構成で値が分かれるときは併記):`,
    ...sources.flatMap(describeSource),
    "</environment>",
  ].join("\n");
}

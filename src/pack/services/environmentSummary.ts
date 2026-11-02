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
 * 純粋関数。I/O なし。
 */

import type { ProjectEnvironment, ProjectStyle } from "../types.ts";

export interface EnvironmentSource {
  /** 表示名(.sln 上のプロジェクト名) */
  label: string;
  /** 表示用の .vbproj のパス(ルート相対・/ 区切り) */
  projectPath: string;
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

/** 参照・Imports を並べる上限(超えた分は件数だけ) */
const LIST_LIMIT = 40;

function formatVersion(vb: number): string {
  return Number.isInteger(vb) ? `${vb}.0` : String(vb);
}

/** 上限より新しい版の構文を「14.0 以降の …、15.0 以降の …」の形で */
function unavailableFeatures(limit: number): string | undefined {
  const parts = VB_FEATURES.filter((entry) => entry.vb > limit).map(
    (entry) => {
      const features = entry.features.join("・");
      // 英数字で始まるときは和文との間を空ける(「11.0 以降の Async」)
      return `${formatVersion(entry.vb)} 以降の${/^[\x21-\x7e]/.test(features) ? " " : ""}${features}`;
    },
  );
  return parts.length === 0 ? undefined : `${parts.join("、")} は使えない`;
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

/** <environment> ブロック(閉じタグまで。末尾の改行なし)。プロジェクトが無ければ undefined */
export function renderEnvironmentBlock(sources: readonly EnvironmentSource[]): string | undefined {
  if (sources.length === 0) {
    return undefined;
  }
  return [
    "<environment>",
    ".vbproj から読み取ったビルド環境(静的に読んだ値。Condition は評価せず、構成で値が分かれるときは併記):",
    ...sources.flatMap(describeSource),
    "</environment>",
  ].join("\n");
}

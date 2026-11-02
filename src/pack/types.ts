import type { ProjectLanguage } from "./projectLanguage.ts";

/**
 * パーサー出力・診断のドメイン型。
 * 引き継ぎ仕様書 §10 の型設計案に準拠する。
 * VS Code API には依存しない(純粋ロジック層)。
 */

/** .vbproj の ItemGroup 内で扱う項目種別 */
export type ProjectItemKind =
  | "Compile"
  | "EmbeddedResource"
  | "Content"
  | "None"
  | "ProjectReference"
  | "Reference"
  | "COMReference"
  | "Folder";

/**
 * 項目の解決状態。
 * 複数該当する場合の優先順位:
 * unresolved-expression > wildcard > conditional > missing > resolved
 */
export type ProjectItemStatus =
  | "resolved"
  | "missing"
  | "unresolved-expression"
  | "wildcard"
  | "conditional";

/** .vbproj から抽出・正規化した 1 項目 */
export interface ProjectItem {
  kind: ProjectItemKind;
  /** Include 属性の生の値(区切り文字も原文のまま) */
  include: string;
  /** 解決済みの物理絶対パス。MSBuild 式・ワイルドカードを含む場合は undefined */
  sourcePath?: string | undefined;
  /** 表示用の論理パス。Link があれば Link、なければ Include(`\` 区切りに正規化) */
  logicalPath: string;
  link?: string | undefined;
  dependentUpon?: string | undefined;
  subType?: string | undefined;
  /** Item または親 ItemGroup の Condition。両方ある場合は AND 結合 */
  condition?: string | undefined;
  /** sourcePath が解決済みで、かつ実ファイルが存在するか */
  exists: boolean;
  status: ProjectItemStatus;
  unresolvedReason?: string | undefined;
  /** Designer.vb / .resx / 自動生成メタデータ等、誤編集警告の対象か */
  isSensitive: boolean;
  /** Include・Condition 以外の全メタデータ(未知のものも保持する) */
  metadata: Readonly<Record<string, string>>;
}

/** 解析中に検出した警告・情報(不明な項目を黙って捨てないための受け皿) */
export interface ParseDiagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  /** 関連する項目の Include 値(項目に紐づく診断のみ) */
  itemInclude?: string | undefined;
}

/**
 * .vbproj の形式。
 * - legacy: 旧スタイル(ToolsVersion / xmlns 付き。Compile を明示列挙)
 * - sdk: SDK スタイル(`<Project Sdk="...">` または `<Import Sdk="...">`。
 *   Compile を書かず `**\/*.vb` が暗黙に含まれる)
 */
export type ProjectStyle = "legacy" | "sdk";

/**
 * .vbproj / .csproj から静的に読んだビルド環境(手順文 v10。<environment> の材料)。
 * プロパティは出現順の値をすべて残す(Condition 付きの PropertyGroup で値が分かれることがあるため。
 * Condition は評価しない)。指定の無いものは空配列
 */
export interface ProjectEnvironment {
  /** <Project ToolsVersion="..."> */
  toolsVersion?: string | undefined;
  /** 旧スタイルの TargetFrameworkVersion(v4.5 など)と SDK スタイルの TargetFramework / TargetFrameworks */
  targetFrameworks: string[];
  langVersions: string[];
  optionStrict: string[];
  optionExplicit: string[];
  optionInfer: string[];
  optionCompare: string[];
  /** C# の null 許容参照型(<Nullable>) */
  nullable: string[];
  /** C# の暗黙の using(<ImplicitUsings>) */
  implicitUsings: string[];
  rootNamespaces: string[];
  /**
   * プロジェクト全体の名前空間の取り込み。VB は ItemGroup の <Import Include="...">(Imports)、
   * C# は <Using Include="...">(global using。Static は「static 名前」、Alias は「別名 = 名前」)
   */
  imports: string[];
  /** 参照(Reference / ProjectReference / PackageReference / COMReference)を表示用に整えたもの */
  references: string[];
}

/** parseVbproj の戻り値(.vbproj と .csproj の両方) */
export interface VbprojParseResult {
  /** 解析対象 .vbproj / .csproj の絶対パス */
  projectPath: string;
  /** プロジェクトの言語(拡張子から決める。.csproj 以外は vb) */
  language: ProjectLanguage;
  /** .vbproj のあるディレクトリ(相対パス解決の基準) */
  projectDir: string;
  projectStyle: ProjectStyle;
  /**
   * SDK スタイルで既定の Compile グロブ(`**\/*.vb`、C# は `**\/*.cs`)を展開したか。
   * legacy、または EnableDefaultCompileItems=false のときは false。
   * true のとき items には展開した項目が resolved として含まれる
   * (MSBuild の完全評価ではない旨を出力側で明記する)
   */
  defaultCompileGlobExpanded: boolean;
  items: ProjectItem[];
  diagnostics: ParseDiagnostic[];
  /** ビルド環境(XML として読めなかったときは undefined) */
  environment?: ProjectEnvironment | undefined;
}

// ---------------------------------------------------------------------------
// .sln 解析(引き継ぎ仕様書 §18)。Project 行の抽出のみの最小対応
// ---------------------------------------------------------------------------

/** .sln から抽出した 1 プロジェクト定義 */
export interface SolutionProject {
  /** .sln 上の表示名 */
  name: string;
  /** .sln に書かれた相対パス(原文のまま) */
  relativePath: string;
  /** .sln のディレクトリ基準で解決した絶対パス */
  absolutePath: string;
  projectGuid: string;
  projectTypeGuid: string;
  /** プロジェクトファイルの拡張子から決めた言語 */
  language: ProjectLanguage;
  /** 実ファイルが存在するか */
  exists: boolean;
}

/** parseSln の戻り値 */
export interface SlnParseResult {
  solutionPath: string;
  solutionDir: string;
  /** .vbproj / .csproj のプロジェクトのみ(Solution Folder・他言語はスキップし診断へ) */
  projects: SolutionProject[];
  diagnostics: ParseDiagnostic[];
}

// ---------------------------------------------------------------------------
// 論理ツリー(引き継ぎ仕様書 §10)。vscode.TreeItem には依存しない
// ---------------------------------------------------------------------------

export interface BaseNode {
  /** ツリー内で一意な ID(TreeItem.id にそのまま使う) */
  id: string;
  label: string;
  children: LegacyTreeNode[];
}

export interface SolutionNode extends BaseNode {
  type: "solution";
  solutionPath: string;
}

export interface ProjectNode extends BaseNode {
  type: "project";
  projectPath: string;
}

export interface FolderNode extends BaseNode {
  type: "folder";
  /** `\` 区切りの論理フォルダパス */
  logicalPath: string;
}

export interface FileNode extends BaseNode {
  type: "file";
  item: ProjectItem;
}

export interface WarningNode extends BaseNode {
  type: "warning";
  message: string;
}

export type LegacyTreeNode =
  | SolutionNode
  | ProjectNode
  | FolderNode
  | FileNode
  | WarningNode;

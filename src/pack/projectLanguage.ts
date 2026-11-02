/**
 * .sln に入るプロジェクトの言語(Visual Basic の .vbproj と C# の .csproj。C# は tazuna 0.17.0 から)。
 *
 * プロジェクトファイルの形式(旧スタイル / SDK スタイル、ItemGroup の Compile)は言語によらず同じで、
 * 違うのはソースの拡張子・SDK の既定の Compile グロブ・Designer のファイル名・言語の版の決まり方だけ。
 * VB だけのソリューションの出力は C# 対応の前と同じに保つため、表記は含まれる言語から作る
 * (projectFilesLabel)。
 */

export type ProjectLanguage = "vb" | "cs";

export interface LanguageInfo {
  /** プロジェクトファイルの拡張子(.vbproj / .csproj) */
  projectExtension: string;
  /** ソースの拡張子(.vb / .cs) */
  sourceExtension: string;
  /** 表示名(Visual Basic / C#) */
  displayName: string;
  /** SDK スタイルの既定の Compile グロブ(Microsoft.NET.Sdk の既定) */
  defaultCompileGlob: string;
  /** フォームの Designer ファイルの接尾辞(小文字) */
  designerSuffix: string;
}

export const LANGUAGES: Readonly<Record<ProjectLanguage, LanguageInfo>> = {
  vb: {
    projectExtension: ".vbproj",
    sourceExtension: ".vb",
    displayName: "Visual Basic",
    defaultCompileGlob: "**/*.vb",
    designerSuffix: ".designer.vb",
  },
  cs: {
    projectExtension: ".csproj",
    sourceExtension: ".cs",
    displayName: "C#",
    defaultCompileGlob: "**/*.cs",
    designerSuffix: ".designer.cs",
  },
};

/** 対応しているプロジェクトファイル(.vbproj / .csproj) */
export const PROJECT_FILE = /\.(vbproj|csproj)$/i;

/** 対応している入力(.sln とプロジェクトファイル) */
export const TARGET_FILE = /\.(sln|vbproj|csproj)$/i;

/** プロジェクトファイルの言語(対応していない拡張子は undefined) */
export function projectLanguageOf(filePath: string): ProjectLanguage | undefined {
  if (/\.vbproj$/i.test(filePath)) {
    return "vb";
  }
  if (/\.csproj$/i.test(filePath)) {
    return "cs";
  }
  return undefined;
}

/** 言語の並び(VB を先に。表記を安定させる) */
function ordered(languages: Iterable<ProjectLanguage>): ProjectLanguage[] {
  const set = new Set(languages);
  return (["vb", "cs"] as const).filter((language) => set.has(language));
}

/**
 * 含まれる言語のプロジェクトファイルの表記(".vbproj" / ".csproj" / ".vbproj / .csproj")。
 * 言語が無いときは VB(C# 対応の前の表記)
 */
export function projectFilesLabel(languages: Iterable<ProjectLanguage>): string {
  const list = ordered(languages);
  return (list.length === 0 ? ["vb" as const] : list).map((language) => LANGUAGES[language].projectExtension).join(" / ");
}

/** 含まれる言語の表示名("Visual Basic" / "C#" / "Visual Basic / C#")。言語が無いときは VB */
export function languageNamesLabel(languages: Iterable<ProjectLanguage>): string {
  const list = ordered(languages);
  return (list.length === 0 ? ["vb" as const] : list).map((language) => LANGUAGES[language].displayName).join(" / ");
}

/** ファイル名が Designer ファイル(X.Designer.vb / X.Designer.cs)なら、その言語 */
export function designerLanguageOf(fileName: string): ProjectLanguage | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(LANGUAGES.vb.designerSuffix)) {
    return "vb";
  }
  if (lower.endsWith(LANGUAGES.cs.designerSuffix)) {
    return "cs";
  }
  return undefined;
}

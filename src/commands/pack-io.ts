/**
 * pack / build / init が共有するファイル I/O と、入力(.sln / .vbproj / .csproj / generic 構成)とルートの決め方。
 * src/pack/ の解析コアは deps 注入で I/O を持たないため、実際のファイルシステムをここでつなぐ。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { LEGACY_STATE_DIRECTORY, STATE_DIRECTORY } from "../brand.ts";
import { decodeSourceBuffer } from "../pack/services/repomixExporter.ts";
import { collectGitFiles } from "../pack/services/extraRootsCollector.ts";
import type { PlannerFile } from "../pack/includePlanner.ts";
import { GitignoreEvaluator } from "../pack/services/gitignoreService.ts";
import { configFileNameIn, loadSlnmixConfig, readConfigFile, describeConfigConflict } from "../pack/slnmixConfig.ts";
import { describeRootReason, resolveRoot } from "../pack/rootResolver.ts";
import { resolveTarget } from "../pack/targetResolver.ts";
import type { ParseDiagnostic } from "../pack/types.ts";
import { listGitFiles } from "../infra/git.ts";
import { err } from "../infra/term.ts";

export interface FsDeps {
  fileExists(absolutePath: string): boolean;
  listFileNames(absolutePath: string): string[] | undefined;
  listFilesRecursive(absoluteDir: string): string[] | undefined;
}

export const FS_DEPS: FsDeps = {
  fileExists: (absolutePath) => fs.existsSync(absolutePath),
  listFileNames: (absolutePath) => {
    try {
      return fs
        .readdirSync(absolutePath, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      return undefined;
    }
  },
  // SDK スタイルの既定グロブ展開用。シンボリックリンクは辿らない(循環防止)。
  // bin / obj 等の除外はパーサー側で行う(ここは列挙のみ)
  listFilesRecursive: (absoluteDir) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const results: string[] = [];
    const walk = (dir: string, dirEntries: fs.Dirent[]): void => {
      for (const entry of dirEntries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          try {
            walk(full, fs.readdirSync(full, { withFileTypes: true }));
          } catch {
            // 読めないディレクトリは飛ばす(取れた分だけ出す)
          }
        } else if (entry.isFile()) {
          results.push(full);
        }
      }
    };
    walk(absoluteDir, entries);
    return results;
  },
};

/** 通常のファイルのサイズ(バイト)。ファイルでなければ undefined */
export function fileSizeOf(absolutePath: string): number | undefined {
  try {
    const stat = fs.statSync(absolutePath);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

export { listGitFiles };

/**
 * git の一覧から、パック自身の出力(ownOutputs。絶対パス)と、適用の履歴・PC ごとの設定(.tazuna/・
 * 旧版の .petari/)を除く(.gitignore に書いていなくても。履歴は書き換え前後のファイルの写しと
 * changes.md なので、入れると同じコードが重複する)
 */
export function withoutOwnFiles(rootDir: string, files: readonly string[], ownOutputs: readonly string[]): string[] {
  const own = new Set(ownOutputs.map((p) => path.relative(rootDir, p).split(path.sep).join("/").toLowerCase()));
  const stateDirectories = [STATE_DIRECTORY, LEGACY_STATE_DIRECTORY].map((d) => `${d.toLowerCase()}/`);
  return files.filter((file) => {
    const lower = file.toLowerCase();
    return !own.has(lower) && !stateDirectories.some((d) => lower.startsWith(d));
  });
}

/**
 * init が include を決めるための、git が管理しているファイル(パックと同じ既定の除外を済ませたもの。
 * 既定の出力名・.gitignore / .repomixignore・バイナリの拡張子・ロックファイル・大きいもの)。
 * git のリポジトリでない・一覧できなければ undefined
 */
export function listPackableGitFiles(rootDir: string, ownOutputs: readonly string[]): PlannerFile[] | undefined {
  const listed = listGitFiles(rootDir);
  if (!listed.ok) {
    return undefined;
  }
  const gitignore = createGitignoreEvaluator(rootDir);
  const collected = collectGitFiles(rootDir, withoutOwnFiles(rootDir, listed.files, ownOutputs), {
    fileSize: fileSizeOf,
    ignoreReasonFor: (absolutePath) => gitignore.ignoreReasonFor(absolutePath),
  });
  return collected.files.map((file) => ({
    relativePath: file.relativePath,
    size: fileSizeOf(file.absolutePath) ?? 0,
  }));
}

/** init の走査で中に入らないディレクトリ(パックの既定の除外にあるもの) */
const ALWAYS_SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "__pycache__"]);
/** 中に入らず、パックでも外すよう exclude に書くディレクトリ(ビルドの出力) */
const BUILD_OUTPUT_DIRECTORIES = new Set(["bin", "obj", "target"]);

export interface DirectoryFiles {
  /** ディレクトリからの相対パス(`/` 区切り) */
  files: PlannerFile[];
  /** 中に入らなかったディレクトリのうち、パックの走査では入るもの(exclude に書く) */
  skippedDirs: Array<{ relativePath: string; reason: string }>;
}

/**
 * git の外での init 用: ディレクトリの中のファイル(再帰)。ドットで始まるディレクトリ・Python の仮想環境
 * (pyvenv.cfg のあるもの)・ビルドの出力(bin / obj / target)・node_modules などには入らない。
 * シンボリックリンクは辿らない。読めなければ undefined
 */
export function listDirectoryFilesForInit(absoluteDir: string): DirectoryFiles | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const result: DirectoryFiles = { files: [], skippedDirs: [] };
  const walk = (dir: string, relative: string, dirEntries: fs.Dirent[]): void => {
    for (const entry of dirEntries) {
      const full = path.join(dir, entry.name);
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (ALWAYS_SKIPPED_DIRECTORIES.has(lower)) {
          continue;
        }
        if (fs.existsSync(path.join(full, "pyvenv.cfg"))) {
          result.skippedDirs.push({ relativePath: rel, reason: "Python の仮想環境" });
          continue;
        }
        if (entry.name.startsWith(".")) {
          result.skippedDirs.push({ relativePath: rel, reason: "ドットで始まるディレクトリ(ツールの設定・キャッシュなど)" });
          continue;
        }
        if (BUILD_OUTPUT_DIRECTORIES.has(lower)) {
          result.skippedDirs.push({ relativePath: rel, reason: "ビルドの出力" });
          continue;
        }
        try {
          walk(full, rel, fs.readdirSync(full, { withFileTypes: true }));
        } catch {
          // 読めないディレクトリは飛ばす
        }
      } else if (entry.isFile()) {
        result.files.push({ relativePath: rel, size: fileSizeOf(full) ?? 0 });
      }
    }
  };
  walk(absoluteDir, "", entries);
  return result;
}

/** ファイルの先頭(4KB)を文字コード自動判定で読む。読めなければ undefined */
export function readFileHead(absolutePath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(absolutePath, "r");
    const buffer = Buffer.alloc(4096);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return decodeSourceBuffer(buffer.subarray(0, length));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

export function listDirectoryNames(absolutePath: string): string[] | undefined {
  try {
    return fs
      .readdirSync(absolutePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
}

export function isDirectoryPath(absolutePath: string): boolean {
  try {
    return fs.statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

export function isFilePath(absolutePath: string): boolean {
  try {
    return fs.statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/** ソース/プロジェクトファイルを文字コード自動判定(BOM / UTF-8 / CP932)で読む */
export function readSourceTextFile(absolutePath: string): string | undefined {
  try {
    return decodeSourceBuffer(fs.readFileSync(absolutePath));
  } catch {
    return undefined;
  }
}

/** .gitignore / .repomixignore の判定(パックとビルドで同じものを使う) */
export function createGitignoreEvaluator(rootDir: string): GitignoreEvaluator {
  return new GitignoreEvaluator(
    {
      readTextFileIfExists: (absolutePath) => {
        try {
          return fs.readFileSync(absolutePath, "utf8");
        } catch {
          return undefined;
        }
      },
      directoryExists: (absolutePath) => {
        try {
          return fs.statSync(absolutePath).isDirectory();
        } catch {
          return false;
        }
      },
    },
    rootDir,
  );
}

export function printDiagnostics(label: string, diagnostics: ParseDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "info") {
      continue; // CLI では警告以上のみ表示(出力本文の skipped_files に詳細が載る)
    }
    err(`[${diagnostic.severity}] ${label}: ${diagnostic.message}`);
  }
}

export type TargetAndRoot =
  /** usageHint: 入力の指定の誤り(使い方の案内を添える) */
  | { kind: "error"; message: string; usageHint: boolean }
  /** targetPath が undefined なら generic 構成(.sln / .vbproj / .csproj を使わない) */
  | { kind: "ok"; targetPath: string | undefined; rootDir: string };

/**
 * 入力(.sln / .vbproj / .csproj / ディレクトリ / 省略)とルートを決める(パックとビルドで同じ)。
 * solution: --root > 上位の設定ファイルの場所 > 上位の .git の場所 > 入力と同じ場所(rootResolver.ts)
 * generic: 設定ファイルの場所に固定(--root は使えない。基準が設定と食い違うため)
 */
/** ルートに設定ファイルが新旧の名前で両方あれば止める(どちらを使うか決められない) */
function withConfigCheck(result: TargetAndRoot & { kind: "ok" }): TargetAndRoot {
  if (readConfigFile(result.rootDir, { readTextFile: readSourceTextFile }).kind === "conflict") {
    return { kind: "error", message: describeConfigConflict(result.rootDir), usageHint: false };
  }
  return result;
}

/**
 * 入力(省略時は自動検出)の .sln / .vbproj / .csproj を、何も出力せずに求める(--print-procedure で
 * プロジェクトの言語を知るため)。見つからない・generic 構成なら undefined
 */
export function findTargetQuietly(inputArg: string | undefined): string | undefined {
  const resolution = resolveTarget(inputArg, process.cwd(), {
    isDirectory: isDirectoryPath,
    isFile: isFilePath,
    listFileNames: FS_DEPS.listFileNames,
    readConfigTarget: (directory) =>
      loadSlnmixConfig(directory, { readTextFile: readSourceTextFile }).config.target,
    isGenericConfig: (directory) =>
      loadSlnmixConfig(directory, { readTextFile: readSourceTextFile }).config.kind === "generic",
  });
  return resolution.kind === "file" ? resolution.path : undefined;
}

export function resolveTargetAndRoot(
  inputArg: string | undefined,
  rootArg: string | undefined,
  options: { legacyPaths: boolean },
): TargetAndRoot {
  const resolution = resolveTarget(inputArg, process.cwd(), {
    isDirectory: isDirectoryPath,
    isFile: isFilePath,
    listFileNames: FS_DEPS.listFileNames,
    // 引数なし(またはディレクトリ指定)のとき、その場所の設定ファイルの target を使う
    readConfigTarget: (directory) =>
      loadSlnmixConfig(directory, { readTextFile: readSourceTextFile }).config.target,
    // 同じ場所の設定が kind: "generic" なら .sln / .vbproj / .csproj を探さない
    isGenericConfig: (directory) =>
      loadSlnmixConfig(directory, { readTextFile: readSourceTextFile }).config.kind === "generic",
  });
  if (resolution.kind === "error") {
    return { kind: "error", message: resolution.message, usageHint: true };
  }
  if (resolution.kind === "generic") {
    const configName = configFileNameIn(resolution.rootDir, isFilePath);
    if (rootArg !== undefined && path.resolve(process.cwd(), rootArg) !== resolution.rootDir) {
      return {
        kind: "error",
        message: `kind: "generic" の構成では --root は使えません(ルートは ${configName} の場所: ${resolution.rootDir})。`,
        usageHint: false,
      };
    }
    if (options.legacyPaths) {
      return {
        kind: "error",
        message: 'kind: "generic" の構成では --legacy-paths は使えません(論理パスがありません)。',
        usageHint: false,
      };
    }
    err(`対象: generic 構成(${configName} の kind。.sln / .vbproj / .csproj は使いません)`);
    err(`ルート: ${resolution.rootDir}`);
    return withConfigCheck({ kind: "ok", targetPath: undefined, rootDir: resolution.rootDir });
  }
  const targetPath = resolution.path;
  if (resolution.autoDetected) {
    err(`対象: ${targetPath}(${resolution.source === "config" ? "設定ファイルの target" : "自動検出"})`);
  }
  const root = resolveRoot(targetPath, rootArg, process.cwd(), {
    isDirectory: isDirectoryPath,
    isFile: isFilePath,
    exists: (p) => fs.existsSync(p),
  });
  if (root.kind === "error") {
    return { kind: "error", message: root.message, usageHint: false };
  }
  if (root.rootDir !== path.dirname(targetPath)) {
    err(`ルート: ${root.rootDir}(${describeRootReason(root.reason)})`);
  }
  return withConfigCheck({ kind: "ok", targetPath, rootDir: root.rootDir });
}

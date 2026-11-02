/**
 * tazuna init が書く include / exclude を、実際にあるファイルから決める(generic 構成。v0.18.0)。
 *
 * 入力は git が管理しているファイルの一覧(パックと同じ既定の除外を済ませたもの)か、git の外では
 * extraRoots にするディレクトリの中のファイル。拡張子とファイル名で種類を分け、次のようにする:
 *
 * - include に書く: 言語の分かるソース・設定とビルドのファイル・文書(拡張子ごとの `**\/*.<拡張子>`、
 *   拡張子の無い既知の名前は `**\/<名前>`、shebang のある拡張子なしのスクリプトはそのパス)
 * - include に書かない: データ(.csv・ノートブックなど。個人情報を含み得る・大きい)・鍵や認証情報の
 *   ファイル(.pem・.npmrc など。中身は伏せるが、ファイルごと出さない)・種類の分からないもの
 * - exclude に書く: include に一致するもののうち、他から取り込んだもの(vendor/ など)・圧縮済み
 *   (.min.js など)・生成コード(先頭に「generated」と「DO NOT EDIT」などの印があるもの)・
 *   include の拡張子と同じ名前の鍵や認証情報のファイル(credentials.json など)
 *
 * 決めたものは設定ファイルに書くので、利用者に見え、書き換えられる(推測で黙って対象を決めない)。
 * 純粋関数(ファイルシステムに触れない。先頭の読み出しは呼び出し側の関数)。
 */

import * as path from "node:path";
import { globToRegExp } from "./globMatcher.ts";

export interface PlannerFile {
  /** 基準のディレクトリ(ルートか extraRoots の path)からの相対パス。`/` 区切り */
  relativePath: string;
  /** 大きさ(バイト)。中身の大きさの目安に使う */
  size: number;
}

export interface PlannerInput {
  files: readonly PlannerFile[];
  /**
   * ファイルの先頭(生成コードの印と shebang の判定、NUL を含むバイナリの見分け)。読めなければ undefined。
   * include に入れる種類のファイルにだけ呼ぶ
   */
  readHead(relativePath: string): string | undefined;
}

export interface PlannedLanguage {
  name: string;
  count: number;
}

export interface PlannedOmission {
  /** 表示名(拡張子かファイル名) */
  label: string;
  /** なぜ入れないか */
  reason: string;
  count: number;
  /** 例(最初の 1 件) */
  example: string;
}

export interface PlannedExclusion {
  pattern: string;
  reason: string;
  count: number;
}

export interface IncludePlan {
  include: string[];
  exclude: string[];
  languages: PlannedLanguage[];
  /** include に書かなかったもの */
  omitted: PlannedOmission[];
  /** exclude に書いたもの */
  excluded: PlannedExclusion[];
  /** include に一致し exclude に一致しないファイルの数 */
  includedCount: number;
  /** その大きさの合計(バイト。文字数の目安) */
  includedBytes: number;
  /** その中で大きいもの(最大 3 件、大きい順) */
  largest: PlannerFile[];
}

/** 拡張子(小文字・ドットなし) → 言語の表示名 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  py: "Python",
  pyi: "Python",
  pyw: "Python",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  groovy: "Groovy",
  cs: "C#",
  csx: "C#",
  vb: "VB.NET",
  fs: "F#",
  fsi: "F#",
  fsx: "F#",
  go: "Go",
  rs: "Rust",
  c: "C",
  h: "C / C++",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++",
  hh: "C++",
  hxx: "C++",
  m: "Objective-C",
  mm: "Objective-C",
  swift: "Swift",
  rb: "Ruby",
  rake: "Ruby",
  gemspec: "Ruby",
  php: "PHP",
  phtml: "PHP",
  pl: "Perl",
  pm: "Perl",
  sh: "シェル",
  bash: "シェル",
  zsh: "シェル",
  ksh: "シェル",
  ps1: "PowerShell",
  psm1: "PowerShell",
  psd1: "PowerShell",
  bat: "バッチ",
  cmd: "バッチ",
  sql: "SQL",
  r: "R",
  dart: "Dart",
  lua: "Lua",
  ex: "Elixir",
  exs: "Elixir",
  erl: "Erlang",
  hrl: "Erlang",
  hs: "Haskell",
  clj: "Clojure",
  cljs: "Clojure",
  cljc: "Clojure",
  jl: "Julia",
  vue: "Vue",
  svelte: "Svelte",
  astro: "Astro",
  html: "HTML",
  htm: "HTML",
  xhtml: "HTML",
  css: "CSS",
  scss: "CSS",
  sass: "CSS",
  less: "CSS",
  styl: "CSS",
  cbl: "COBOL",
  cob: "COBOL",
  cpy: "COBOL",
  pas: "Delphi",
  dpr: "Delphi",
  bas: "VB6 / VBA",
  cls: "VB6 / VBA",
  frm: "VB6 / VBA",
  asp: "ASP",
  aspx: "ASP.NET",
  ascx: "ASP.NET",
  master: "ASP.NET",
  cshtml: "ASP.NET",
  vbhtml: "ASP.NET",
  razor: "ASP.NET",
  jsp: "JSP",
  ejs: "テンプレート",
  hbs: "テンプレート",
  handlebars: "テンプレート",
  mustache: "テンプレート",
  njk: "テンプレート",
  jinja: "テンプレート",
  jinja2: "テンプレート",
  j2: "テンプレート",
  liquid: "テンプレート",
  twig: "テンプレート",
  erb: "テンプレート",
  haml: "テンプレート",
  slim: "テンプレート",
  pug: "テンプレート",
  proto: "Protocol Buffers",
  graphql: "GraphQL",
  gql: "GraphQL",
  tf: "Terraform",
  hcl: "Terraform",
  prisma: "Prisma",
  tpl: "テンプレート",
  tmpl: "テンプレート",
  gohtml: "テンプレート",
  vbs: "VBScript",
  vba: "VB6 / VBA",
  xaml: "XAML",
  axaml: "XAML",
  bzl: "Bazel",
  nix: "Nix",
  zig: "Zig",
  ml: "OCaml",
  mli: "OCaml",
  elm: "Elm",
  sol: "Solidity",
};

/** 設定とビルドのファイルの拡張子 */
const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "xml",
  "xsd",
  "xsl",
  "xslt",
  "config",
  "gradle",
  "plist",
  "cmake",
  "mk",
  "mak",
  "sln",
  "csproj",
  "vbproj",
  "fsproj",
  "props",
  "targets",
  "resx",
  "settings",
]);

/** 文書の拡張子 */
const DOC_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown", "mdx", "rst", "txt", "adoc", "asciidoc"]);

/** データの拡張子(個人情報を含み得る・大きい・変更の対象になりにくい) */
const DATA_EXTENSIONS: Readonly<Record<string, string>> = {
  csv: "データ",
  tsv: "データ",
  psv: "データ",
  jsonl: "データ",
  ndjson: "データ",
  geojson: "データ",
  log: "ログ",
  dump: "データ",
  bak: "バックアップ",
  dat: "データ",
  ipynb: "ノートブック(出力を含み大きい)",
  parquet: "データ",
  avro: "データ",
  sqlite: "データベース",
  sqlite3: "データベース",
  db: "データベース",
  mdb: "データベース",
  accdb: "データベース",
  dbf: "データベース",
  har: "通信の記録",
};

/** 鍵・証明書・認証情報のファイルの拡張子(中身は伏せるが、ファイルごと出さない) */
const SECRET_EXTENSIONS: ReadonlySet<string> = new Set([
  "pem",
  "key",
  "crt",
  "cer",
  "der",
  "p7b",
  "p8",
  "p12",
  "pfx",
  "jks",
  "keystore",
  "ppk",
  "snk",
  "pvk",
  "gpg",
  "pgp",
  "asc",
  "kdbx",
  "ovpn",
  "tfvars",
  "tfstate",
]);

/** 鍵・認証情報のファイル名(小文字) */
const SECRET_FILE_NAMES: ReadonlySet<string> = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".htpasswd",
  ".pgpass",
  ".dockercfg",
  ".s3cfg",
  ".boto",
  "credentials",
  "terraform.tfstate.backup",
]);

/** この名前(拡張子を除いて小文字)の設定・文書のファイルは認証情報とみなす */
const SECRET_FILE_STEMS: ReadonlySet<string> = new Set([
  "secret",
  "secrets",
  "credential",
  "credentials",
  "client_secret",
  "client_secrets",
  "service-account",
  "service_account",
  "serviceaccount",
  "serviceaccountkey",
]);

/** 拡張子の無い(またはドットで始まる)既知のファイル名(小文字 → include に書く名前) */
const KNOWN_FILE_NAMES: Readonly<Record<string, string>> = {
  makefile: "Makefile",
  gnumakefile: "GNUmakefile",
  containerfile: "Containerfile",
  jenkinsfile: "Jenkinsfile",
  vagrantfile: "Vagrantfile",
  procfile: "Procfile",
  gemfile: "Gemfile",
  rakefile: "Rakefile",
  brewfile: "Brewfile",
  podfile: "Podfile",
  cartfile: "Cartfile",
  pipfile: "Pipfile",
  justfile: "Justfile",
  gradlew: "gradlew",
  mvnw: "mvnw",
  license: "LICENSE",
  licence: "LICENCE",
  notice: "NOTICE",
  authors: "AUTHORS",
  codeowners: "CODEOWNERS",
  contributing: "CONTRIBUTING",
  changelog: "CHANGELOG",
  readme: "README",
  copying: "COPYING",
  build: "BUILD",
  workspace: "WORKSPACE",
  "go.mod": "go.mod",
  "go.work": "go.work",
  ".gitignore": ".gitignore",
  ".gitattributes": ".gitattributes",
  ".gitmodules": ".gitmodules",
  ".dockerignore": ".dockerignore",
  ".editorconfig": ".editorconfig",
  ".prettierrc": ".prettierrc",
  ".prettierignore": ".prettierignore",
  ".eslintrc": ".eslintrc",
  ".eslintignore": ".eslintignore",
  ".babelrc": ".babelrc",
  ".browserslistrc": ".browserslistrc",
  ".stylelintrc": ".stylelintrc",
  ".npmignore": ".npmignore",
  ".nvmrc": ".nvmrc",
  ".node-version": ".node-version",
  ".python-version": ".python-version",
  ".ruby-version": ".ruby-version",
  ".tool-versions": ".tool-versions",
  ".flake8": ".flake8",
  ".pylintrc": ".pylintrc",
  ".rubocop": ".rubocop",
  ".clang-format": ".clang-format",
  ".clang-tidy": ".clang-tidy",
  ".repomixignore": ".repomixignore",
};

/** 他から取り込んだコードのディレクトリ名(大文字小文字はこのとおり) */
const VENDOR_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "vendor",
  "third_party",
  "third-party",
  "bower_components",
  "jspm_packages",
  "Pods",
  "Carthage",
]);

/** 生成コードによくある名前の終わり(一致すれば exclude をこのパターンで書く) */
const GENERATED_SUFFIXES: readonly string[] = [
  ".pb.go",
  "_pb2.py",
  "_pb2.pyi",
  "_pb2_grpc.py",
  ".pb.cc",
  ".pb.h",
  ".pb.swift",
  "_pb.js",
  "_pb.d.ts",
  "_grpc_pb.js",
  ".g.dart",
  ".freezed.dart",
  ".gen.go",
  ".gen.ts",
  ".generated.ts",
  ".generated.cs",
  ".g.cs",
  ".Designer.cs",
  ".Designer.vb",
];

const MINIFIED = /\.min\.(js|mjs|cjs|css)$/i;

/** 先頭の何行を生成コードの印として見るか */
const HEADER_LINES = 15;

/**
 * 生成コードの印。誤って手書きのコードを外さないよう、強い印だけを見る:
 * `@generated` / `<auto-generated` か、「generated」と「do not edit / modify / change」の両方
 * (Go の `Code generated ... DO NOT EDIT.`、protoc の `Generated by the protocol buffer compiler.  DO NOT EDIT!` など)。
 * Django のマイグレーション(`# Generated by Django ...`)のように手で直すこともあるものは印にしない
 */
export function looksGenerated(head: string): boolean {
  const header = head.split(/\r?\n/).slice(0, HEADER_LINES).join("\n");
  if (/@generated\b|<auto-generated\b/i.test(header)) {
    return true;
  }
  return /\bgenerated\b/i.test(header) && /\b(?:do not|don't|must not) (?:edit|modify|change)\b/i.test(header);
}

const SHEBANG_LANGUAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/python/, "Python"],
  [/\b(?:node|deno|bun)\b/, "JavaScript"],
  [/ruby/, "Ruby"],
  [/perl/, "Perl"],
  [/php/, "PHP"],
  [/pwsh|powershell/, "PowerShell"],
];

function shebangLanguage(head: string): string | undefined {
  const first = head.split(/\r?\n/, 1)[0] ?? "";
  if (!first.startsWith("#!")) {
    return undefined;
  }
  return SHEBANG_LANGUAGES.find(([pattern]) => pattern.test(first))?.[1] ?? "シェル";
}

const UNKNOWN_REASON = "種類が分からない";

type Category =
  | { kind: "language"; language: string; glob: string }
  | { kind: "config"; glob: string }
  | { kind: "docs"; glob: string }
  | { kind: "name"; glob: string }
  | { kind: "omit"; label: string; reason: string };

/** 拡張子(小文字・ドットなし)。ドットで始まる名前や拡張子の無い名前は "" */
function extensionOf(name: string): string {
  const ext = path.posix.extname(name);
  return ext === "" || ext === name ? "" : ext.slice(1).toLowerCase();
}

function stemOf(name: string): string {
  const ext = path.posix.extname(name);
  return (ext === "" || ext === name ? name : name.slice(0, -ext.length)).toLowerCase();
}

/** 中身を読まずに決まる種類(shebang の判定が要るものは undefined) */
function categorize(name: string): Category | undefined {
  const lower = name.toLowerCase();
  const ext = extensionOf(name);
  if (SECRET_FILE_NAMES.has(lower) || SECRET_EXTENSIONS.has(ext) || lower.endsWith(".tfstate.backup")) {
    return { kind: "omit", label: ext === "" ? name : `.${ext}`, reason: "鍵・証明書・認証情報のファイル" };
  }
  if (Object.hasOwn(DATA_EXTENSIONS, ext)) {
    return { kind: "omit", label: `.${ext}`, reason: DATA_EXTENSIONS[ext] ?? "データ" };
  }
  if (lower.startsWith("dockerfile")) {
    return { kind: "name", glob: "**/Dockerfile*" };
  }
  const known = KNOWN_FILE_NAMES[lower];
  if (known !== undefined) {
    return { kind: "name", glob: `**/${known}` };
  }
  const language = LANGUAGE_BY_EXTENSION[ext];
  if (language !== undefined) {
    return { kind: "language", language, glob: `**/*.${ext}` };
  }
  if (CONFIG_EXTENSIONS.has(ext) || DOC_EXTENSIONS.has(ext)) {
    if (SECRET_FILE_STEMS.has(stemOf(name))) {
      return { kind: "omit", label: name, reason: "鍵・証明書・認証情報のファイル" };
    }
    return CONFIG_EXTENSIONS.has(ext) ? { kind: "config", glob: `**/*.${ext}` } : { kind: "docs", glob: `**/*.${ext}` };
  }
  if (ext === "") {
    return undefined;
  }
  return { kind: "omit", label: `.${ext}`, reason: UNKNOWN_REASON };
}

/** relativePath の中で最も浅い、他から取り込んだコードのディレクトリ(`a/vendor` など) */
function vendorDirectoryOf(relativePath: string): { dir: string; name: string } | undefined {
  const segments = relativePath.split("/");
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] ?? "";
    if (VENDOR_DIRECTORY_NAMES.has(segment)) {
      return { dir: segments.slice(0, i + 1).join("/"), name: segment };
    }
  }
  return undefined;
}

function generatedPatternOf(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  const suffix = GENERATED_SUFFIXES.find((s) => lower.endsWith(s.toLowerCase()));
  return suffix === undefined ? relativePath : `**/*${suffix}`;
}

/** include の並び: 言語(件数の多い順)→ 設定・文書(拡張子の順)→ 既知の名前 → パス */
const GROUP_ORDER: Readonly<Record<string, number>> = { language: 0, config: 1, docs: 1, name: 2, path: 3 };

/**
 * @param options.alwaysInclude ファイルが無くても include に書くもの(tazuna の docs/ 連携が書く
 *   Markdown など)
 */
export function planInclude(input: PlannerInput, options: { alwaysInclude?: readonly string[] } = {}): IncludePlan {
  const heads = new Map<string, string | undefined>();
  const readHead = (relativePath: string): string | undefined => {
    if (!heads.has(relativePath)) {
      heads.set(relativePath, input.readHead(relativePath));
    }
    return heads.get(relativePath);
  };

  // 1. 種類を分ける
  interface Candidate {
    file: PlannerFile;
    glob: string;
    group: string;
    language?: string | undefined;
  }
  const candidates: Candidate[] = [];
  const omittedFiles: { file: PlannerFile; label: string; reason: string }[] = [];
  for (const file of input.files) {
    const name = path.posix.basename(file.relativePath);
    let category = categorize(name);
    if (category?.kind === "omit" && category.reason !== UNKNOWN_REASON) {
      // 鍵・データは中身を読まずに外す
      omittedFiles.push({ file, label: category.label, reason: category.reason });
      continue;
    }
    const head = readHead(file.relativePath);
    if (head === undefined || head.includes("\u0000")) {
      // 読めないもの・バイナリはパックにも入らない
      continue;
    }
    if (category === undefined) {
      const language = shebangLanguage(head);
      if (language === undefined) {
        if (head.trim() !== "") {
          omittedFiles.push({ file, label: name, reason: UNKNOWN_REASON });
        }
        continue;
      }
      category = { kind: "language", language, glob: file.relativePath };
    }
    if (category.kind === "omit") {
      if (head.trim() !== "") {
        omittedFiles.push({ file, label: category.label, reason: category.reason });
      }
      continue;
    }
    candidates.push({
      file,
      glob: category.glob,
      group: category.kind === "language" && category.glob === file.relativePath ? "path" : category.kind,
      language: category.kind === "language" ? category.language : undefined,
    });
  }

  // 2. include に入る種類のうち外すもの(取り込んだコード・圧縮済み・生成コード)
  // 同じ名前の取り込んだコードのディレクトリが複数の場所にあれば `**/<名前>/**` にまとめる
  const vendorDirs = new Map<string, Set<string>>();
  for (const { file } of candidates) {
    const vendor = vendorDirectoryOf(file.relativePath);
    if (vendor !== undefined) {
      const dirs = vendorDirs.get(vendor.name) ?? new Set<string>();
      dirs.add(vendor.dir);
      vendorDirs.set(vendor.name, dirs);
    }
  }
  const excludedCandidates: { file: PlannerFile; pattern: string; reason: string }[] = [];
  const survivors: Candidate[] = [];
  for (const candidate of candidates) {
    const { file, language } = candidate;
    const vendor = vendorDirectoryOf(file.relativePath);
    if (vendor !== undefined) {
      const many = (vendorDirs.get(vendor.name)?.size ?? 0) > 1;
      excludedCandidates.push({ file, pattern: many ? `**/${vendor.name}/**` : `${vendor.dir}/**`, reason: "他から取り込んだコード" });
      continue;
    }
    const minified = MINIFIED.exec(file.relativePath);
    if (minified !== null) {
      excludedCandidates.push({ file, pattern: `**/*.min.${(minified[1] ?? "js").toLowerCase()}`, reason: "圧縮済み" });
      continue;
    }
    // 生成コードの印はソースだけで見る(文書の「編集しないで」の注意書きなどで外さない)
    if (language !== undefined) {
      const head = readHead(file.relativePath);
      if (head !== undefined && looksGenerated(head)) {
        excludedCandidates.push({ file, pattern: generatedPatternOf(file.relativePath), reason: "生成コード" });
        continue;
      }
    }
    survivors.push(candidate);
  }

  // 3. include は残ったものの種類から(外したものにしか無い拡張子は書かない)
  const includeEntries = new Map<string, { group: string; count: number }>();
  for (const { glob, group } of survivors) {
    const entry = includeEntries.get(glob) ?? { group, count: 0 };
    entry.count += 1;
    includeEntries.set(glob, entry);
  }
  for (const glob of options.alwaysInclude ?? []) {
    if (!includeEntries.has(glob)) {
      includeEntries.set(glob, { group: glob.startsWith("**/*.") ? "docs" : glob.startsWith("**/") ? "name" : "path", count: 0 });
    }
  }
  const include = [...includeEntries.entries()]
    .map(([glob, entry]) => ({ glob, ...entry }))
    .sort((a, b) => {
      const groupDiff = (GROUP_ORDER[a.group] ?? 9) - (GROUP_ORDER[b.group] ?? 9);
      if (groupDiff !== 0) {
        return groupDiff;
      }
      if (a.group === "language" && a.count !== b.count) {
        return b.count - a.count;
      }
      return a.glob.toLowerCase().localeCompare(b.glob.toLowerCase());
    })
    .map((entry) => entry.glob);
  const includeRegExps = include.map(globToRegExp);
  const matchesInclude = (relativePath: string): boolean => includeRegExps.some((re) => re.test(relativePath));

  // 4. exclude は include に一致してしまうものだけ書く
  const exclusions = new Map<string, PlannedExclusion>();
  const addExclusion = (pattern: string, reason: string): void => {
    const current = exclusions.get(pattern);
    if (current === undefined) {
      exclusions.set(pattern, { pattern, reason, count: 1 });
    } else {
      current.count += 1;
    }
  };
  for (const { file, pattern, reason } of excludedCandidates) {
    if (matchesInclude(file.relativePath)) {
      addExclusion(pattern, reason);
    }
  }
  // include の拡張子に一致してしまう、入れないファイル(credentials.json など)はパスで外す
  const omissions = new Map<string, PlannedOmission>();
  for (const { file, label, reason } of omittedFiles) {
    if (matchesInclude(file.relativePath)) {
      addExclusion(file.relativePath, reason);
    }
    const key = `${label.toLowerCase()}\u0000${reason}`;
    const current = omissions.get(key);
    if (current === undefined) {
      omissions.set(key, { label, reason, count: 1, example: file.relativePath });
    } else {
      current.count += 1;
    }
  }

  const languageCounts = new Map<string, number>();
  for (const { language } of survivors) {
    if (language !== undefined) {
      languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    }
  }
  const included = survivors.map((candidate) => candidate.file);
  // exclude の並び: 理由ごと(取り込んだコード → 圧縮済み → 生成コード → その他)、同じ理由の中はパターンの順
  const reasonOrder = ["他から取り込んだコード", "圧縮済み", "生成コード"];
  const rank = (reason: string): number => {
    const index = reasonOrder.indexOf(reason);
    return index === -1 ? reasonOrder.length : index;
  };
  const excluded = [...exclusions.values()].sort(
    (a, b) => rank(a.reason) - rank(b.reason) || a.pattern.toLowerCase().localeCompare(b.pattern.toLowerCase()),
  );
  return {
    include,
    exclude: excluded.map((entry) => entry.pattern),
    languages: [...languageCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    omitted: [...omissions.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    excluded,
    includedCount: included.length,
    includedBytes: included.reduce((sum, file) => sum + file.size, 0),
    largest: [...included].sort((a, b) => b.size - a.size).slice(0, 3),
  };
}

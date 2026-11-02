/**
 * 書き方ごとの伏せ方 (v0.19.0)。0.18.0 で人が決めた短いパスワードが漏れていた書き方
 * (YAML などの `キー: 値`・Oracle の `ユーザー/パスワード@DB`・SQL の IDENTIFIED BY / PASSWORD・
 * PHP / Ruby の `=>` と添字・秘密の名前を最初の引数に渡す関数) と、伏せすぎないことの確認。
 * 洗い出しのスクリプトは /mnt/project-files/plans/mask-gaps/ (2026-11-02)
 */

import { describe, expect, it } from "vitest";
import { planChangeSet, type FileState, type NewFileConfig } from "../src/core/applier.ts";
import { buildFailureReport } from "../src/core/report.ts";
import type { ChangeSet, FileChange, ReplaceBlock } from "../src/types.ts";
import { maskCredentials, maskedViews } from "../src/core/mask.ts";
import { sourceLanguageOf } from "../src/core/source-lexer.ts";

/** パックと同じ選び方で伏せる (.vb は VB、言語の分かる拡張子はその言語、ほかは汎用テキスト) */
const pack = (path: string, text: string, strict = true): string =>
  maskCredentials(text, {
    vbSource: /\.vb$/i.test(path),
    language: sourceLanguageOf(path),
    strict,
    path,
  }).content;

const SECRET = "Hunter2pass";

/** [パス, 内容, 伏せた後の内容] */
type Expected = [path: string, text: string, masked: string];

const leaks: Expected[] = [
  // YAML・.properties・setup.cfg などの引用符のない `キー: 値`
  ["config.yml", `db:\n  password: ${SECRET}\n`, "db:\n  password: [MASKED]\n"],
  [
    "docker-compose.yml",
    `services:\n  db:\n    environment:\n      MYSQL_ROOT_PASSWORD: ${SECRET}\n`,
    "services:\n  db:\n    environment:\n      MYSQL_ROOT_PASSWORD: [MASKED]\n",
  ],
  ["application.yml", `spring:\n  datasource:\n    password: ${SECRET} # dev\n`, "spring:\n  datasource:\n    password: [MASKED] # dev\n"],
  ["application.yml", `spring.datasource.password: ${SECRET}\n`, "spring.datasource.password: [MASKED]\n"],
  ["config.yaml", `oauth:\n  client_secret: ${SECRET}\n`, "oauth:\n  client_secret: [MASKED]\n"],
  ["config.yaml", `slack:\n  token: ${SECRET}\n`, "slack:\n  token: [MASKED]\n"],
  ["config.yaml", `api_key: ${SECRET}\n`, "api_key: [MASKED]\n"],
  ["config.yaml", `- password: ${SECRET}\n`, "- password: [MASKED]\n"],
  ["config.yaml", `password: &pw ${SECRET}\n`, "password: &pw [MASKED]\n"],
  ["config.yaml", "password: @dm1n!\nadmin_password: %Hunter2\n", "password: [MASKED]\nadmin_password: [MASKED]\n"],
  ["config.yaml", `password: |\n  ${SECRET}\n  second line\nnext: 1\n`, "password: |\n  [MASKED]\nnext: 1\n"],
  ["k8s.yaml", `kind: Secret\nstringData:\n  password: ${SECRET}\n`, "kind: Secret\nstringData:\n  password: [MASKED]\n"],
  ["ci.yml", `env:\n  DB_PASSWORD: ${SECRET}\n`, "env:\n  DB_PASSWORD: [MASKED]\n"],
  ["setup.cfg", `[db]\npassword: ${SECRET}\n`, "[db]\npassword: [MASKED]\n"],
  ["application.properties", `db.password: ${SECRET}\n`, "db.password: [MASKED]\n"],
  ["README.md", `\`\`\`yaml\npassword: ${SECRET}\n\`\`\`\n`, "```yaml\npassword: [MASKED]\n```\n"],
  // Oracle の ユーザー/パスワード@DB (sqlplus / exp / imp / expdp / rman と SQL*Plus の CONNECT)
  ["run.bat", `sqlplus scott/${SECRET}@orcl @script.sql\n`, "sqlplus scott/[MASKED]@orcl @script.sql\n"],
  ["run.sh", `sqlplus -s -L scott/${SECRET}@//db:1521/orcl @dir/x.sql\n`, "sqlplus -s -L scott/[MASKED]@//db:1521/orcl @dir/x.sql\n"],
  ["run.bat", `sqlplus "sys/${SECRET}@orcl as sysdba"\n`, 'sqlplus "sys/[MASKED]@orcl as sysdba"\n'],
  ["run.bat", `sqlplus.exe scott/"${SECRET}"@orcl\n`, 'sqlplus.exe scott/"[MASKED]"@orcl\n'],
  ["exp.bat", `exp scott/${SECRET} file=dump/x.dmp\n`, "exp scott/[MASKED] file=dump/x.dmp\n"],
  ["exp.bat", `expdp scott/${SECRET}@orcl directory=d dumpfile=x.dmp\n`, "expdp scott/[MASKED]@orcl directory=d dumpfile=x.dmp\n"],
  // userid= は接続文字列のユーザー ID として行末までを伏せる (0.18.0 から。; の無い値は行末まで読む)
  ["exp.bat", `imp userid=scott/${SECRET} file=x.dmp\n`, "imp userid=[MASKED]\n"],
  ["bk.sh", `rman target sys/${SECRET}@db catalog rman/${SECRET}@cat\n`, "rman target sys/[MASKED]@db catalog rman/[MASKED]@cat\n"],
  ["setup.sql", `CONNECT scott/${SECRET}@orcl\n`, "CONNECT scott/[MASKED]@orcl\n"],
  ["setup.sql", `conn system/${SECRET} as sysdba;\n`, "conn system/[MASKED] as sysdba;\n"],
  ["bk.rman", `connect target sys/${SECRET}@db\n`, "connect target sys/[MASKED]@db\n"],
  [
    "Module1.vb",
    `Module M\n  Sub F()\n    Shell("sqlplus scott/${SECRET}@orcl @x.sql")\n  End Sub\nEnd Module\n`,
    'Module M\n  Sub F()\n    Shell("sqlplus scott/[MASKED]@orcl @x.sql")\n  End Sub\nEnd Module\n',
  ],
  [
    "Module1.vb",
    `Module M\n  Sub F()\n    Process.Start("sqlplus.exe", "scott/${SECRET}@orcl @x.sql")\n  End Sub\nEnd Module\n`,
    'Module M\n  Sub F()\n    Process.Start("sqlplus.exe", "scott/[MASKED]@orcl @x.sql")\n  End Sub\nEnd Module\n',
  ],
  // SQL の IDENTIFIED BY / PASSWORD
  ["init.sql", `CREATE USER app IDENTIFIED BY ${SECRET};\n`, "CREATE USER app IDENTIFIED BY [MASKED];\n"],
  ["init.sql", `CREATE USER 'app'@'%' IDENTIFIED BY '${SECRET}';\n`, "CREATE USER 'app'@'%' IDENTIFIED BY '[MASKED]';\n"],
  ["init.sql", `create user if not exists 'app'@'%' identified by '${SECRET}';\n`, "create user if not exists 'app'@'%' identified by '[MASKED]';\n"],
  ["link.sql", `create database link l connect to scott identified by ${SECRET} using 'orcl';\n`, "create database link l connect to scott identified by [MASKED] using 'orcl';\n"],
  [
    "init.sql",
    `ALTER USER app IDENTIFIED WITH mysql_native_password BY '${SECRET}';\n`,
    "ALTER USER app IDENTIFIED WITH mysql_native_password BY '[MASKED]';\n",
  ],
  ["init.sql", `CREATE USER app WITH PASSWORD '${SECRET}';\n`, "CREATE USER app WITH PASSWORD '[MASKED]';\n"],
  ["init.sql", `ALTER ROLE app WITH LOGIN ENCRYPTED PASSWORD '${SECRET}';\n`, "ALTER ROLE app WITH LOGIN ENCRYPTED PASSWORD '[MASKED]';\n"],
  ["init.sql", `alter user app password '${SECRET}';\n`, "alter user app password '[MASKED]';\n"],
  [
    "Module1.vb",
    `Module M\n  Sub F()\n    cmd.CommandText = "CREATE USER app IDENTIFIED BY ${SECRET}"\n  End Sub\nEnd Module\n`,
    'Module M\n  Sub F()\n    cmd.CommandText = "CREATE USER app IDENTIFIED BY [MASKED]"\n  End Sub\nEnd Module\n',
  ],
  ["Db.java", `class A { String s = "CREATE USER app IDENTIFIED BY ${SECRET}"; }\n`, 'class A { String s = "CREATE USER app IDENTIFIED BY [MASKED]"; }\n'],
  // PHP / Ruby の => と添字
  ["config.php", `<?php\nreturn [\n    'password' => '${SECRET}',\n];\n`, "<?php\nreturn [\n    'password' => '[MASKED]',\n];\n"],
  ["config.php", `<?php\n$cfg = ["password" => "${SECRET}"];\n`, '<?php\n$cfg = ["password" => "[MASKED]"];\n'],
  ["config.php", `<?php\n$config['db']['password'] = '${SECRET}';\n`, "<?php\n$config['db']['password'] = '[MASKED]';\n"],
  ["config.rb", `opts = { :password => '${SECRET}' }\n`, "opts = { :password => '[MASKED]' }\n"],
  ["settings.py", `os.environ["DB_PASSWORD"] = "${SECRET}"\n`, 'os.environ["DB_PASSWORD"] = "[MASKED]"\n'],
  ["db.ts", `cfg["apiKey"] = '${SECRET}';\n`, "cfg[\"apiKey\"] = '[MASKED]';\n"],
  // 秘密の名前を最初の引数に渡す関数 (定数の定義・環境変数が無いときの既定値)
  ["wp-config.php", `<?php\ndefine( 'DB_PASSWORD', '${SECRET}' );\n`, "<?php\ndefine( 'DB_PASSWORD', '[MASKED]' );\n"],
  ["database.php", `<?php\n'password' => env('DB_PASSWORD', '${SECRET}'),\n`, "<?php\n'password' => env('DB_PASSWORD', '[MASKED]'),\n"],
  ["settings.py", `pw = os.environ.get("DB_PASSWORD", "${SECRET}")\n`, 'pw = os.environ.get("DB_PASSWORD", "[MASKED]")\n'],
  ["settings.py", `pw = os.getenv('SECRET_KEY', '${SECRET}')\n`, "pw = os.getenv('SECRET_KEY', '[MASKED]')\n"],
  ["Db.java", `class A { String p = System.getProperty("db.password", "${SECRET}"); }\n`, 'class A { String p = System.getProperty("db.password", "[MASKED]"); }\n'],
];

describe("書き方ごとの伏せ方: 0.18.0 で漏れていた形を伏せる", () => {
  for (const [path, text, masked] of leaks) {
    const line = text.split("\n").find((l) => l.includes(SECRET))?.trim() ?? text;
    it(`${path}: ${line}`, () => {
      expect(pack(path, text)).toBe(masked);
      // strict なし (--no-strict-mask) でも伏せる (高エントロピーの判定によらない)
      expect(pack(path, text, false)).not.toContain(SECRET);
      // 適用側の伏せた表示にもパックと同じものがある (パックから写した SEARCH を照合できる)。
      // 複数行の値 (YAML の | の値) はパックで 1 行にまとめるため除く
      if (masked.split("\n").length === text.split("\n").length) {
        const views = maskedViews(text.split("\n"), path).map((view) => view.map((line) => line.text).join("\n"));
        expect(views).toContain(masked);
      }
    });
  }
});

/** 伏せないもの (内容がそのまま残る) */
const kept: Array<[path: string, text: string]> = [
  // YAML の値でないもの・差し込み・参照・真偽値・入れ子・表示の文言
  ["config.yml", "db:\n  password: ${DB_PASSWORD}\n"],
  ["config.yml", "db:\n  password: {{ vault_db_password }}\n"],
  ["database.yml", "production:\n  password: <%= ENV['DB_PASSWORD'] %>\n"],
  ["config.yml", "password: *db_password\n"],
  ["config.yml", "password: !vault |\n  $ANSIBLE_VAULT;1.1;AES256\n  6162636465\n"],
  ["config.yml", "auth:\n  password: true\n  token: ~\n  secret: null\n"],
  ["config.yml", "password:\n  min_length: 8\n  require_digit: yes\n"],
  ["config.yml", "password_min_length: 8\npassword_expire_days: 90\n"],
  ["ja.yml", "ja:\n  password: パスワード\n  password_confirmation: パスワード (確認)\n"],
  ["en.yml", "en:\n  password: Password\n  hint: Enter your password\n  password_hint: Enter your password\n"],
  ["openapi.yml", "properties:\n  password:\n    type: string\n    format: password\n"],
  ["config.yml", "slack:\n  token: required\n"],
  ["config.yml", "user: deploy\nusername: admin\n"],
  // 文書に書いたコードの型の注釈・フィールド
  ["README.md", "```ts\ninterface User {\n  password: string;\n  token: string\n}\n```\n"],
  ["README.md", "```rust\nstruct Config {\n    password: String,\n    api_key: Option<String>,\n}\n```\n"],
  ["README.md", "```sql\npassword: varchar(255)\n```\n"],
  // コードのファイル (字句解析のない言語) のオブジェクト・構造体のフィールドは `キー: 値` として読まない
  ["Login.vue", "<script>\nexport default {\n  data() {\n    return {\n      password: hashedPassword\n    }\n  }\n}\n</script>\n"],
  ["user.rb", "User.create(\n  name: name,\n  password: generated\n)\n"],
  ["main.rs", "let c = Config {\n    password: pw\n};\n"],
  ["Main.kt", "login(\n    password: pw\n)\n"],
  ["db.ts", "const c = {\n  password: hashedPassword\n};\ninterface U {\n  password: string\n}\n"],
  ["settings.py", "DATABASES = dict(\n    password=pw,\n)\ndef f(password: str) -> None: ...\n"],
  // Oracle: パスワードの無いログオン・OS 認証・変数・スクリプトのパス・文章
  ["run.bat", "sqlplus / as sysdba @x.sql\n"],
  ["run.bat", "sqlplus /nolog @x.sql\n"],
  ["run.bat", "sqlplus scott@orcl @dir/x.sql\n"],
  ["run.sh", "sqlplus -s $DB_USER/$DB_PASS@$DB_SID @x.sql\n"],
  ["run.bat", "sqlplus %DB_USER%/%DB_PASS%@%DB% @x.sql\n"],
  ["x.sql", "CONNECT &1/&2@&3\n"],
  ["README.md", "Connect to/from the server with the exp/imp tools.\n"],
  ["README.md", "connect target/auxiliary databases first\n"],
  // SQL: 差し込み・バインド変数・連結・説明の書き方・外部認証
  ["init.sql", "CREATE USER app IDENTIFIED BY &pw;\nCREATE USER app IDENTIFIED BY :new_password;\nCREATE USER app IDENTIFIED EXTERNALLY;\n"],
  ["README.md", "CREATE USER name IDENTIFIED BY <password>;\nALTER USER name IDENTIFIED BY password;\n"],
  [
    "Module1.vb",
    'Module M\n  Sub F()\n    cmd.CommandText = "CREATE USER " & u & " IDENTIFIED BY " & pw\n  End Sub\nEnd Module\n',
  ],
  ["Db.java", 'class A { String s = "ALTER USER x IDENTIFIED BY " + pw; String t = "IDENTIFIED BY \'" + pw + "\'"; }\n'],
  ["init.sql", "-- reset the password 'often'\nSELECT password FROM users WHERE id = 1;\n"],
  ["redis.conf", "# of classes. Every class is identified by a single character:\n"],
  ["README.md", "Scan sources are uniquely identified by their name (identified by the IP as above).\n"],
  // GitHub Actions・Azure Pipelines の秘密の参照と、Laravel のモデルの型変換
  ["ci.yml", "env:\n  api_key: ${{secrets.DD_API_KEY}}\n  FOD_PASSWORD: ${{ secrets.FOD_PAT }}\n  DB_PASSWORD: $(DbPassword)\n"],
  ["application.yml", "spring:\n  datasource:\n    password: @db.password@\n"],
  // 引用符で囲んだ '%env(X)%' は 0.18.0 から伏せる (KEY_LITERAL。安全側のまま)
  ["services.yaml", "parameters:\n  mailer_password: %mailer_password%\n  smtp_password: %env(SMTP_PASSWORD)%\n"],
  ["README.md", "password: <your-password>\n"],
  ["User.php", "<?php\nreturn [\n    'email_verified_at' => 'datetime',\n    'password' => 'hashed',\n];\n"],
  // PHP: 検証の規則・式・ハッシュの関数・表示の文言・列の定義
  ["UserRequest.php", "<?php\nreturn [\n    'password' => 'required|string|min:8|confirmed',\n    'token' => 'required',\n];\n"],
  ["UserController.php", "<?php\n$u->fill([\n    'password' => Hash::make($request->password),\n    'password_confirmation' => $request->password_confirmation,\n]);\n"],
  ["migration.php", "<?php\n$table->string('password');\n$table->string('password', 255);\n"],
  ["form.php", "<?php\necho Form::label('password', 'Password');\necho Form::label('password', 'パスワード');\necho $form->field('password', 'Your password');\n"],
  ["app.js", "const f = (token) => 'Bearer ' + token;\nlocalStorage.setItem('token', token);\n"],
];

describe("書き方ごとの伏せ方: 伏せすぎない", () => {
  for (const [path, text] of kept) {
    it(`${path}: ${text.split("\n").find((l) => l.trim() !== "" && !l.startsWith("<"))?.trim() ?? text}`, () => {
      expect(pack(path, text)).toBe(text);
    });
  }
});

// ---------------------------------------------------------------------------
// 適用側: パックから写した伏せ字の行を元の値に戻して書く・失敗レポートの抜粋に値を出さない
// ---------------------------------------------------------------------------

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array | null): string => new TextDecoder().decode(b ?? new Uint8Array());
const NEW_FILE: NewFileConfig = { encoding: "utf8", eol: "lf" };
const state = (s: string): FileState => ({ exists: true, symlink: false, bytes: utf8(s) });
const block = (search: string[], replace: string[], index = 1): ReplaceBlock => ({ search, replace, line: 1, index });
const replace = (path: string, ...blocks: ReplaceBlock[]): FileChange => ({ op: "replace", path, line: 1, blocks });
const cs = (...files: FileChange[]): ChangeSet => ({ header: "概要", files });

describe("書き方ごとの伏せ方: 適用側", () => {
  const compose = [
    "services:",
    "  db:",
    "    image: mysql:8",
    "    environment:",
    `      MYSQL_ROOT_PASSWORD: ${SECRET}`,
    "      MYSQL_DATABASE: app",
    "",
  ].join("\n");
  const run = [`sqlplus scott/${SECRET}@orcl @setup.sql`, "echo done", ""].join("\n");

  it("YAML: パックから写した `キー: [MASKED]` の行を元の値に戻して書く", () => {
    const packed = pack("compose.yml", compose).split("\n");
    expect(packed[4]).toBe("      MYSQL_ROOT_PASSWORD: [MASKED]");
    const p = planChangeSet(
      cs(replace("compose.yml", block(packed.slice(4, 6), [packed[4] as string, "      MYSQL_DATABASE: shop"]))),
      new Map([["compose.yml", state(compose)]]),
      NEW_FILE,
    );
    expect(p.ok).toBe(true);
    expect(decode(p.outcomes[0]?.afterBytes ?? null)).toBe(compose.replace("MYSQL_DATABASE: app", "MYSQL_DATABASE: shop"));
  });

  it("Oracle: パックから写した sqlplus の行を元の値に戻して書く", () => {
    const packed = pack("run.bat", run).split("\n");
    expect(packed[0]).toBe("sqlplus scott/[MASKED]@orcl @setup.sql");
    const p = planChangeSet(
      cs(replace("run.bat", block(packed.slice(0, 2), [packed[0] as string, "echo finished"]))),
      new Map([["run.bat", state(run)]]),
      NEW_FILE,
    );
    expect(p.ok).toBe(true);
    expect(decode(p.outcomes[0]?.afterBytes ?? null)).toBe(run.replace("echo done", "echo finished"));
  });

  it("失敗レポートの抜粋に YAML・Oracle の値を出さない", () => {
    const p = planChangeSet(
      cs(
        // 近い行の抜粋が付くよう、1 行だけ違う SEARCH にする
        replace("compose.yml", block(["    environment:", "      MYSQL_ROOT_PASSWORD: wrong", "      MYSQL_DATABASE: app"], ["x"])),
        replace("run.bat", block(["sqlplus scott/wrong@orcl @setup.sql", "echo done"], ["x"])),
      ),
      new Map([
        ["compose.yml", state(compose)],
        ["run.bat", state(run)],
      ]),
      NEW_FILE,
    );
    const report = buildFailureReport(p.failures);
    expect(report).toContain("MYSQL_ROOT_PASSWORD: [MASKED]");
    expect(report).toContain("sqlplus scott/[MASKED]@orcl");
    expect(report).not.toContain(SECRET);
  });
});

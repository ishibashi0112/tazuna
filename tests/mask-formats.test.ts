/**
 * 書き方ごとの伏せ方 (v0.19.0)。0.18.0 で人が決めた短いパスワードが漏れていた書き方
 * (YAML などの `キー: 値`・Oracle の `ユーザー/パスワード@DB`・SQL の IDENTIFIED BY / PASSWORD・
 * PHP / Ruby の `=>` と添字・秘密の名前を最初の引数に渡す関数) と、伏せすぎないことの確認。
 * v0.20.0 で、VB 以外のコードの形 (setter・既定値・比較・定番の関数の位置の引数)・コマンド (curl・
 * ConvertTo-SecureString・Invoke-Sqlcmd・sqlcmd /P・net.exe use)・Gradle・<param>・Settings.Designer.cs を足した。
 * 洗い出しのスクリプトは /mnt/project-files/plans/mask-gaps/ (2026-11-02 / 2026-11-03 の probe-beyond-sample.ts)
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

// ---------------------------------------------------------------------------
// v0.20.0: VB 以外のコードの形 (setter・builder・既定値・比較・位置で渡す定番の関数)、コマンドの引数
// (curl・ConvertTo-SecureString・Invoke-Sqlcmd・sqlcmd /P・net.exe use)、Gradle・<param>・Settings.Designer.cs
// ---------------------------------------------------------------------------

const leaks020: Expected[] = [
  // 既定値 (環境変数が無いとき)
  ["db.ts", `const pw = process.env.DB_PASSWORD || "${SECRET}";\n`, 'const pw = process.env.DB_PASSWORD || "[MASKED]";\n'],
  ["db.ts", `const pw = process.env.DB_PASSWORD ?? '${SECRET}';\n`, "const pw = process.env.DB_PASSWORD ?? '[MASKED]';\n"],
  ["db.ts", `const password: string = process.env.PW ?? "${SECRET}";\n`, 'const password: string = process.env.PW ?? "[MASKED]";\n'],
  ["config.js", `module.exports = {\n  password: process.env.PW || "${SECRET}",\n};\n`, 'module.exports = {\n  password: process.env.PW || "[MASKED]",\n};\n'],
  ["db.ts", `const pw = process.env.A || process.env.DB_PASSWORD || "${SECRET}";\n`, 'const pw = process.env.A || process.env.DB_PASSWORD || "[MASKED]";\n'],
  ["db.ts", `const pw = process.env["DB_PASSWORD"]! || "${SECRET}";\n`, 'const pw = process.env["DB_PASSWORD"]! || "[MASKED]";\n'],
  ["Mail.cs", `var pw = Environment.GetEnvironmentVariable("DB_PASSWORD") ?? "${SECRET}";\n`, 'var pw = Environment.GetEnvironmentVariable("DB_PASSWORD") ?? "[MASKED]";\n'],
  ["app.py", `pw = os.getenv("DB_PASSWORD") or "${SECRET}"\n`, 'pw = os.getenv("DB_PASSWORD") or "[MASKED]"\n'],
  ["App.kt", `val password: String = System.getenv("X") ?: "${SECRET}"\n`, 'val password: String = System.getenv("X") ?: "[MASKED]"\n'],
  [
    "Mail.vb",
    `Module M\n  Sub F()\n    Dim pw = If(Environment.GetEnvironmentVariable("DB_PASSWORD"), "${SECRET}")\n  End Sub\nEnd Module\n`,
    'Module M\n  Sub F()\n    Dim pw = If(Environment.GetEnvironmentVariable("DB_PASSWORD"), "[MASKED]")\n  End Sub\nEnd Module\n',
  ],
  // setter・builder
  ["Db.java", `class A { void f() { ds.setPassword("${SECRET}"); } }\n`, 'class A { void f() { ds.setPassword("[MASKED]"); } }\n'],
  ["Db.java", `class A { void f() { b.password("${SECRET}").build(); } }\n`, 'class A { void f() { b.password("[MASKED]").build(); } }\n'],
  ["Db.java", `class A { void f() { c.withPassword("${SECRET}"); } }\n`, 'class A { void f() { c.withPassword("[MASKED]"); } }\n'],
  ["Db.cs", `class A { void F() { c.SetPassword("${SECRET}"); } }\n`, 'class A { void F() { c.SetPassword("[MASKED]"); } }\n'],
  ["test_user.py", `user.set_password("${SECRET}")\n`, 'user.set_password("[MASKED]")\n'],
  ["db.js", "module.exports = { apiKey: `" + SECRET + "` };\n", "module.exports = { apiKey: `[MASKED]` };\n"],
  // 比較
  ["Form1.cs", `class A { void F() { if (txtPassword.Text == "${SECRET}") { } } }\n`, 'class A { void F() { if (txtPassword.Text == "[MASKED]") { } } }\n'],
  ["Login.java", `class A { boolean f() { return password.equals("${SECRET}"); } }\n`, 'class A { boolean f() { return password.equals("[MASKED]"); } }\n'],
  ["Login.java", `class A { boolean f() { return "${SECRET}".equals(password); } }\n`, 'class A { boolean f() { return "[MASKED]".equals(password); } }\n'],
  ["login.ts", `if (form.password.value !== "${SECRET}") {}\n`, 'if (form.password.value !== "[MASKED]") {}\n'],
  // パスワードを位置で渡す定番の関数
  ["Mail.cs", `smtp.Credentials = new NetworkCredential("admin", "${SECRET}");\n`, 'smtp.Credentials = new NetworkCredential("admin", "[MASKED]");\n'],
  ["Mail.cs", `await client.AuthenticateAsync("me@example.com", "${SECRET}");\n`, 'await client.AuthenticateAsync("me@example.com", "[MASKED]");\n'],
  [
    "Mail.vb",
    `Module M\n  Sub F()\n    client.Authenticate("me@example.com", "${SECRET}")\n  End Sub\nEnd Module\n`,
    'Module M\n  Sub F()\n    client.Authenticate("me@example.com", "[MASKED]")\n  End Sub\nEnd Module\n',
  ],
  [
    "Db.java",
    `class A { void f() { Connection c = DriverManager.getConnection(url, "scott", "${SECRET}"); } }\n`,
    'class A { void f() { Connection c = DriverManager.getConnection(url, "scott", "[MASKED]"); } }\n',
  ],
  [
    "Db.java",
    `class A {\n  Connection c = DriverManager.getConnection(\n      url,\n      "scott",\n      "${SECRET}");\n}\n`,
    'class A {\n  Connection c = DriverManager.getConnection(\n      url,\n      "scott",\n      "[MASKED]");\n}\n',
  ],
  [
    "Mail.java",
    `class A { Object g() { return new PasswordAuthentication("me", "${SECRET}".toCharArray()); } }\n`,
    'class A { Object g() { return new PasswordAuthentication("me", "[MASKED]".toCharArray()); } }\n',
  ],
  ["db.php", `<?php\n$db = mysqli_connect("localhost", "root", "${SECRET}", "app");\n`, '<?php\n$db = mysqli_connect("localhost", "root", "[MASKED]", "app");\n'],
  ["db.php", `<?php\n$pdo = new PDO($dsn, "root", "${SECRET}");\n`, '<?php\n$pdo = new PDO($dsn, "root", "[MASKED]");\n'],
  ["app.py", `conn = pymysql.connect("localhost", "root", "${SECRET}", "db")\n`, 'conn = pymysql.connect("localhost", "root", "[MASKED]", "db")\n'],
  ["db.ts", `const s = new Sequelize("db", "root", "${SECRET}", { dialect: "mysql" });\n`, 'const s = new Sequelize("db", "root", "[MASKED]", { dialect: "mysql" });\n'],
  // コマンドの引数
  ["deploy.sh", `curl -u admin:${SECRET} https://x\n`, "curl -u admin:[MASKED] https://x\n"],
  ["deploy.sh", `curl -s --user "admin:${SECRET}" https://x\n`, 'curl -s --user "admin:[MASKED]" https://x\n'],
  ["deploy.ps1", `$sec = ConvertTo-SecureString "${SECRET}" -AsPlainText -Force\n`, '$sec = ConvertTo-SecureString "[MASKED]" -AsPlainText -Force\n'],
  ["deploy.ps1", `$sec = ConvertTo-SecureString -String '${SECRET}' -AsPlainText -Force\n`, "$sec = ConvertTo-SecureString -String '[MASKED]' -AsPlainText -Force\n"],
  ["deploy.ps1", `$sec = '${SECRET}' | ConvertTo-SecureString -AsPlainText -Force\n`, "$sec = '[MASKED]' | ConvertTo-SecureString -AsPlainText -Force\n"],
  [
    "deploy.ps1",
    `Invoke-Sqlcmd -ServerInstance srv -Username sa -Password ${SECRET} -Query "SELECT 1"\n`,
    'Invoke-Sqlcmd -ServerInstance srv -Username sa -Password [MASKED] -Query "SELECT 1"\n',
  ],
  ["deploy.bat", `sqlcmd /S srv /U sa /P ${SECRET}\n`, "sqlcmd /S srv /U sa /P [MASKED]\n"],
  ["deploy.bat", `net.exe use \\\\srv\\share ${SECRET} /user:admin\n`, "net.exe use \\\\srv\\share [MASKED] /user:admin\n"],
  // Gradle・<param>・Settings.Designer.cs
  ["build.gradle", `publishing { credentials { password '${SECRET}' } }\n`, "publishing { credentials { password '[MASKED]' } }\n"],
  ["build.gradle", `credentials {\n    username 'deploy'\n    password "${SECRET}"\n}\n`, 'credentials {\n    username \'deploy\'\n    password "[MASKED]"\n}\n'],
  ["build.gradle", `credentials {\r\n    password '${SECRET}'\r\n}\r\n`, "credentials {\r\n    password '[MASKED]'\r\n}\r\n"],
  [
    "Mail.vb",
    `Module M\n  Sub F()\n    Dim password = If (GetSetting("x"), "${SECRET}")\n  End Sub\nEnd Module\n`,
    'Module M\n  Sub F()\n    Dim password = If (GetSetting("x"), "[MASKED]")\n  End Sub\nEnd Module\n',
  ],
  ["web.xml", `<param name="password" value="${SECRET}"/>\n`, '<param name="password" value="[MASKED]"/>\n'],
  ["beans.xml", `<property name="password" value="${SECRET}"/>\n`, '<property name="password" value="[MASKED]"/>\n'],
  [
    "Settings.Designer.cs",
    `[global::System.Configuration.DefaultSettingValueAttribute("${SECRET}")]\npublic string DbPassword {\n    get { return ((string)(this["DbPassword"])); }\n}\n`,
    '[global::System.Configuration.DefaultSettingValueAttribute("[MASKED]")]\npublic string DbPassword {\n    get { return ((string)(this["DbPassword"])); }\n}\n',
  ],
];

describe("書き方ごとの伏せ方: 0.19.0 で漏れていた形を伏せる (v0.20.0)", () => {
  for (const [path, text, masked] of leaks020) {
    const line = text.split("\n").find((l) => l.includes(SECRET))?.trim() ?? text;
    it(`${path}: ${line}`, () => {
      expect(pack(path, text)).toBe(masked);
      expect(pack(path, text, false)).not.toContain(SECRET);
      const views = maskedViews(text.split("\n"), path).map((view) => view.map((l) => l.text).join("\n"));
      expect(views).toContain(masked);
    });
  }
});

const kept020: Array<[path: string, text: string]> = [
  // 既定値: 秘密系でない名前・表示の文言・空・token の普通の語・型
  ["db.ts", 'const env = process.env.NODE_ENV || "development";\n'],
  ["db.ts", 'const label = t("password") || "Password";\nconst hint = t("password.hint") || "Enter8chars";\n'],
  ["db.ts", 'const t = token ?? "anonymous";\nconst p = process.env.DB_PASSWORD || "";\n'],
  ["Form.ts", 'interface P { password?: "hidden" | "shown" }\n'],
  ["app.py", 'mode = os.getenv("MODE") or "production"\n'],
  // 比較: 秘密系でない名前 (入力の種類・項目の名前)
  ["login.ts", 'if (field.type === "password") {}\nif (e.target.name === "password") {}\nif (password === "") {}\n'],
  ["Login.java", 'class A { boolean f() { return type.equals("password") || "text".equals(mode); } }\n'],
  // setter・builder: 動作の名前・取得・テストの t.pass・フック
  ["Auth.java", 'class A { void f() { getPassword("db"); validatePassword("abc12345"); hashPassword("x1"); } }\n'],
  ["test.js", 't.pass("all good");\nt.pass("done");\nconst s = useSecret("db-secret-name");\n'],
  ["Db.java", 'class A { void f() { ds.setPassword(System.getenv("DB_PASSWORD")); b.password(pw); } }\n'],
  // コマンドの引数: 変数・パスワードの無い -u・説明の書き方・-AsPlainText の無いもの・変数の値
  ["deploy.sh", 'curl -u "$USER:$PASS" https://x\ncurl -u admin https://x\ncurl -u <user>:<password> https://x\n'],
  ["deploy.ps1", "$sec = ConvertTo-SecureString $encrypted -Key $key\n$sec = ConvertTo-SecureString $pw -AsPlainText -Force\n"],
  ["README.md", "ConvertTo-SecureString stringValue -AsPlainText\nUse ConvertTo-SecureString with the -AsPlainText switch.\n"],
  [
    "Mail.vb",
    'Module M\n  Sub F()\n    Dim name = If(GetSetting("UserName"), "guest")\n    Dim pw = If(isProd, "prodPass1", "devPass1")\n  End Sub\nEnd Module\n',
  ],
  ["deploy.ps1", "Invoke-Sqlcmd -ServerInstance srv -Username sa -Password $pw\nInvoke-Sqlcmd -Password $cred.GetNetworkCredential().Password\n"],
  ["deploy.bat", "sqlcmd -S srv -i /Users/me/x.sql\n"],
  // 位置で渡す関数: 変数・引数の数の違うもの
  ["Db.java", "class A { void f() { DriverManager.getConnection(url, user, password); pool.getConnection(cb); } }\n"],
  ["db.php", '<?php\n$pdo = new PDO($dsn, $user, $pass);\n$pdo = new PDO("mysql:host=x", "root", "$pass");\n'],
  // Gradle・<param>・Settings.Designer.cs: 式・差し込み・秘密系でない名前・空
  ["build.gradle", "credentials {\n    password findProperty('repoPassword')\n}\ndependencies {\n    implementation 'org.x:y:1.0'\n}\n"],
  ["beans.xml", '<property name="password" value="${jdbc.password}"/>\n<property name="passwordEncoder" ref="encoder"/>\n<param name="token" value=""/>\n'],
  ["Settings.Designer.cs", '[global::System.Configuration.DefaultSettingValueAttribute("30")]\npublic int Timeout {\n    get { return 0; }\n}\n'],
];

describe("書き方ごとの伏せ方: 伏せすぎない (v0.20.0)", () => {
  for (const [path, text] of kept020) {
    it(`${path}: ${text.split("\n")[0]?.trim() ?? text}`, () => {
      expect(pack(path, text)).toBe(text);
    });
  }
});

describe("書き方ごとの伏せ方: 適用側 (v0.20.0)", () => {
  const java = ["class A {", "  void f() {", `    ds.setPassword("${SECRET}");`, "    ds.setUser(\"app\");", "  }", "}", ""].join("\n");
  const ps = [`$sec = ConvertTo-SecureString "${SECRET}" -AsPlainText -Force`, "Write-Host done", ""].join("\n");

  it("Java: パックから写した setter の行を元の値に戻して書く", () => {
    const packed = pack("Db.java", java).split("\n");
    expect(packed[2]).toBe('    ds.setPassword("[MASKED]");');
    const p = planChangeSet(
      cs(replace("Db.java", block(packed.slice(2, 4), [packed[2] as string, '    ds.setUser("shop");']))),
      new Map([["Db.java", state(java)]]),
      NEW_FILE,
    );
    expect(p.ok).toBe(true);
    expect(decode(p.outcomes[0]?.afterBytes ?? null)).toBe(java.replace('setUser("app")', 'setUser("shop")'));
  });

  it("PowerShell: パックから写した ConvertTo-SecureString の行を元の値に戻して書く", () => {
    const packed = pack("deploy.ps1", ps).split("\n");
    expect(packed[0]).toBe('$sec = ConvertTo-SecureString "[MASKED]" -AsPlainText -Force');
    const p = planChangeSet(
      cs(replace("deploy.ps1", block(packed.slice(0, 2), [packed[0] as string, "Write-Host finished"]))),
      new Map([["deploy.ps1", state(ps)]]),
      NEW_FILE,
    );
    expect(p.ok).toBe(true);
    expect(decode(p.outcomes[0]?.afterBytes ?? null)).toBe(ps.replace("Write-Host done", "Write-Host finished"));
  });

  it("失敗レポートの抜粋に setter・ConvertTo-SecureString の値を出さない", () => {
    const p = planChangeSet(
      cs(
        replace("Db.java", block(["  void f() {", '    ds.setPassword("wrong");', '    ds.setUser("app");'], ["x"])),
        replace("deploy.ps1", block(['$sec = ConvertTo-SecureString "wrong" -AsPlainText -Force', "Write-Host done"], ["x"])),
      ),
      new Map([
        ["Db.java", state(java)],
        ["deploy.ps1", state(ps)],
      ]),
      NEW_FILE,
    );
    const report = buildFailureReport(p.failures);
    expect(report).toContain('ds.setPassword("[MASKED]")');
    expect(report).toContain('ConvertTo-SecureString "[MASKED]"');
    expect(report).not.toContain(SECRET);
  });
});

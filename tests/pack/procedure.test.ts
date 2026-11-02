/**
 * 内蔵作業手順文(assets/procedure)の単体テスト。
 * 4 モードの出力は tests/fixtures/pack/procedure/<mode>.md(docs 連携なし)、
 * <mode>.docs.md(docs 連携あり)、<mode>.tests.md(自動テストあり)、
 * <mode>.docs.tests.md(両方)のスナップショットで固定する。
 * 文面を意図的に変えたときは PROCEDURE_VERSION を上げ、スナップショットを更新する。
 * テストの無いプロジェクト向けの本文(<mode>.md / <mode>.docs.md)は v5 と
 * 同一に保つ(テスト戦略メモ §8。版数の行だけが変わる)。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DB_SECTIONS,
  DOCS_SECTIONS,
  isProcedureMode,
  LAYOUT_TEXT,
  MODE_SECTIONS,
  MODE_SECTIONS_BY_LAYOUT,
  PROCEDURE_MODES,
  PROCEDURE_TEMPLATE,
  PROCEDURE_VERSION,
  renderBuiltinProcedure,
  renderProcedureTemplate,
  TEST_SECTIONS,
  TEST_SECTIONS_BY_LAYOUT,
} from "../../src/pack/assets/procedure.ts";

const FIXTURES_ROOT = path.resolve(import.meta.dirname, "..", "fixtures", "pack");

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_ROOT, "procedure", name), "utf8");
}

suite("procedure: スナップショット", () => {
  for (const mode of PROCEDURE_MODES) {
    test(`${mode} モード(generic 構成)がスナップショットと一致する`, () => {
      assert.strictEqual(
        renderBuiltinProcedure(mode, { layout: "generic" }),
        fixture(`${mode}.generic.md`),
      );
    });
    test(`${mode} モード(generic 構成 + docs + 自動テスト)がスナップショットと一致する`, () => {
      assert.strictEqual(
        renderBuiltinProcedure(mode, { layout: "generic", docs: true, tests: true }),
        fixture(`${mode}.generic.docs.tests.md`),
      );
    });
    test(`${mode} モード: layout 省略は "solution" と同じ`, () => {
      assert.strictEqual(
        renderBuiltinProcedure(mode, { layout: "solution" }),
        renderBuiltinProcedure(mode),
      );
    });
    test(`${mode} モードの内蔵既定文がスナップショットと一致する`, () => {
      assert.strictEqual(renderBuiltinProcedure(mode), fixture(`${mode}.md`));
    });
    test(`${mode} モード(docs 連携あり)がスナップショットと一致する`, () => {
      assert.strictEqual(
        renderBuiltinProcedure(mode, { docs: true }),
        fixture(`${mode}.docs.md`),
      );
    });
    test(`${mode} モード(自動テストあり)がスナップショットと一致する`, () => {
      assert.strictEqual(
        renderBuiltinProcedure(mode, { tests: true }),
        fixture(`${mode}.tests.md`),
      );
    });
    test(`${mode} モード(docs 連携 + 自動テストあり)がスナップショットと一致する`, () => {
      assert.strictEqual(
        renderBuiltinProcedure(mode, { docs: true, tests: true }),
        fixture(`${mode}.docs.tests.md`),
      );
    });
  }

  for (const mode of PROCEDURE_MODES) {
    test(`${mode} モード(C# のプロジェクトだけ)がスナップショットと一致する`, () => {
      assert.strictEqual(renderBuiltinProcedure(mode, { languages: ["cs"] }), fixture(`${mode}.cs.md`));
    });
    test(`${mode} モード(VB と C# の混在 + docs + 自動テスト)がスナップショットと一致する`, () => {
      assert.strictEqual(
        renderBuiltinProcedure(mode, { languages: ["vb", "cs"], docs: true, tests: true }),
        fixture(`${mode}.vb-cs.md`),
      );
    });
    test(`${mode} モード: Visual Basic だけ・言語の省略・空は C# 対応の前と同じ本文`, () => {
      const plain = renderBuiltinProcedure(mode);
      assert.strictEqual(renderBuiltinProcedure(mode, { languages: ["vb"] }), plain);
      assert.strictEqual(renderBuiltinProcedure(mode, { languages: ["vb", "vb"] }), plain);
      assert.strictEqual(renderBuiltinProcedure(mode, { languages: [] }), plain);
      assert.ok(!plain.includes("C#"));
      assert.ok(!plain.includes(".csproj"));
    });
    test(`${mode} モード: generic 構成は言語を見ない`, () => {
      assert.strictEqual(
        renderBuiltinProcedure(mode, { layout: "generic", languages: ["cs"] }),
        renderBuiltinProcedure(mode, { layout: "generic" }),
      );
    });
  }

  test("C# の本文: Visual Basic 固有の語句が残らず、イベントの結び付けの置き場所を書く", () => {
    for (const mode of PROCEDURE_MODES) {
      const cs = renderBuiltinProcedure(mode, { languages: ["cs"] });
      for (const phrase of ["VB.NET", "Visual Basic", "Designer.vb", ".vbproj", "Option Strict", "Handles"]) {
        assert.ok(!cs.includes(phrase), `${mode}: C# の本文に「${phrase}」がある`);
      }
      assert.ok(cs.includes("InitializeComponent() の後に += で書き"));
      assert.ok(cs.includes("結び付け済みのイベントを重ねて結び付けないでください"));
      assert.ok(cs.startsWith(`<!-- tazuna procedure v${PROCEDURE_VERSION} (mode: ${mode}, language: C#) -->`));
    }
  });

  test("VB と C# の混在: 両方の語句を併記する", () => {
    const mixed = renderBuiltinProcedure("full", { languages: ["cs", "vb"] });
    for (const phrase of [
      "VB.NET / C#",
      "Designer.vb / Designer.cs",
      ".vbproj / .csproj",
      "Option Strict",
      "Nullable",
      "Handles 句と +=",
      "(mode: full, language: VB / C#)",
    ]) {
      assert.ok(mixed.includes(phrase), `混在の本文に「${phrase}」がない`);
    }
  });

  test("docs 連携なしの本文は docs あり本文の先頭部分と一致し、末尾に 2 節だけ足される", () => {
    for (const mode of PROCEDURE_MODES) {
      const plain = renderBuiltinProcedure(mode);
      const withDocs = renderBuiltinProcedure(mode, { docs: true });
      assert.strictEqual(withDocs, plain + DOCS_SECTIONS);
      assert.ok(!plain.includes("## 文書(docs/)の扱い"));
      assert.ok(withDocs.includes("## 文書(docs/)の扱い"));
      assert.ok(withDocs.includes("## チャットの継続と引継ぎ"));
    }
  });

  test("自動テストありは末尾に「自動テスト」の 1 節だけ足され、docs の節の後に来る", () => {
    for (const mode of PROCEDURE_MODES) {
      const plain = renderBuiltinProcedure(mode);
      const withTests = renderBuiltinProcedure(mode, { tests: true });
      const withBoth = renderBuiltinProcedure(mode, { docs: true, tests: true });
      assert.strictEqual(withTests, plain + TEST_SECTIONS);
      assert.strictEqual(withBoth, plain + DOCS_SECTIONS + TEST_SECTIONS);
      assert.ok(!plain.includes("## 自動テスト"));
      assert.ok(!renderBuiltinProcedure(mode, { docs: true }).includes("## 自動テスト"));
      assert.ok(withTests.includes("## 自動テスト"));
      assert.strictEqual(withTests.split("## 自動テスト").length, 2);
    }
  });

  test("テストなしの本文は v5 と同一(版数の行を除く)", () => {
    // v5 のスナップショットはこの版数置換だけで v6 に更新した。v6 で足したものは
    // すべて {{TEST_SECTIONS}} の中にあり、テストなしでは空文字になる。
    // v7(layout)も solution 構成では版数の行だけが変わる
    for (const mode of PROCEDURE_MODES) {
      const plain = renderBuiltinProcedure(mode);
      assert.ok(plain.startsWith(`<!-- tazuna procedure v${PROCEDURE_VERSION} (mode: `));
      assert.ok(!plain.includes("テスト"), `${mode}: テストなしの本文にテストの記述がある`);
      assert.ok(!plain.includes("data-testid"));
    }
  });

  test("自動テストの節: 3 層の置き場、観点表、data-testid、自己検証の 2 項目、design の完了条件", () => {
    assert.ok(TEST_SECTIONS.startsWith("\n## 自動テスト\n\n- "));
    assert.ok(TEST_SECTIONS.endsWith("\n"));
    for (const phrase of [
      "e2e/screen/",
      "e2e/api/",
      "e2e/host/",
      "*.test.ts",
      "| 読み取り元 | 観点 | 層 |",
      "Arrange(前提データ) / Act(操作) / Assert(確認)",
      "testId 接頭辞",
      'data-testid="<画面>-<役割>"',
      "変更した振る舞いにテストがあるか(ないなら理由)",
      "画面に追加した要素に data-testid を付けたか",
      "設計書 §9 の各バッチの完了条件を「自動テスト」と「手動確認」に分け",
      "e2e/<層>/<画面>.spec.ts",
    ]) {
      assert.ok(TEST_SECTIONS.includes(phrase), `自動テストの節に「${phrase}」がない`);
    }
    assert.strictEqual(
      TEST_SECTIONS.split("\n").filter((line) => line.startsWith("|")).length,
      8,
      "観点表はヘッダ + 区切り + 6 行",
    );
  });
});

suite("procedure: DB の確認(v8)・動作検証(v9)", () => {
  test("full モード(DB の確認あり)がスナップショットと一致する", () => {
    assert.strictEqual(renderBuiltinProcedure("full", { db: true }), fixture("full.db.md"));
  });

  test("DB の確認ありは末尾に「DB の確認」の 1 節だけ足され、docs・テストの節の後に来る(どの構成・モードでも)", () => {
    for (const layout of ["solution", "generic"] as const) {
      for (const mode of PROCEDURE_MODES) {
        const plain = renderBuiltinProcedure(mode, { layout });
        const all = renderBuiltinProcedure(mode, { layout, docs: true, tests: true });
        assert.strictEqual(renderBuiltinProcedure(mode, { layout, db: true }), plain + DB_SECTIONS);
        assert.strictEqual(renderBuiltinProcedure(mode, { layout, docs: true, tests: true, db: true }), all + DB_SECTIONS);
        assert.ok(!all.includes("## DB の確認"));
      }
    }
  });

  test("DB の確認の節: SELECT だけ、checks/*.sql を create、実行コマンド、見出しになるコメント、行数の上限", () => {
    assert.ok(DB_SECTIONS.startsWith("\n## DB の確認(テスト用 DB)\n\n- "));
    assert.ok(DB_SECTIONS.endsWith("\n"));
    for (const phrase of [
      "<db_schema>",
      "推測しないでください",
      "npx ashiato schema --tables",
      "checks/<内容が分かる名前>.sql として create",
      "npx ashiato query checks/<名前>.sql",
      "書いてよいのは SELECT(WITH を含む)だけです",
      "1 文も実行されません",
      "-- コメントで 1 行",
      "先頭 50 行まで",
      "DB の事実として扱い",
    ]) {
      assert.ok(DB_SECTIONS.includes(phrase), `DB の確認の節に「${phrase}」がない`);
    }
  });

  test("動作検証の節(v9): checks/*.verify.md を create、実行コマンド、ashiato verify が読める書式", () => {
    const verify = DB_SECTIONS.slice(DB_SECTIONS.indexOf("\n## 動作検証(テスト用 DB)\n\n- "));
    assert.ok(verify.length < DB_SECTIONS.length, "動作検証の節がない");
    for (const phrase of [
      "checks/<内容が分かる名前>.verify.md として create",
      "npx ashiato verify checks/<名前>.verify.md",
      "「## 1. すること」の見出し",
      "「期待する DB の変化:」の 1 行",
      "「- テーブル名: 追加 1 行 (列=値, 列=値)」",
      "→ (更新後の列=値, ...)",
      "「- テーブル名: 変化なし」",
      "列=*",
      "列+=数 / 列-=数",
      "「- ほかのテーブル: 問わない」",
      "'...' で囲みます",
      "rewrite で出し直してください",
    ]) {
      assert.ok(verify.includes(phrase), `動作検証の節に「${phrase}」がない`);
    }
  });
});

suite("procedure: 描画", () => {
  test("プレースホルダが残らず、先頭コメントにバージョンとモードが入る", () => {
    for (const mode of PROCEDURE_MODES) {
      const rendered = renderBuiltinProcedure(mode);
      assert.ok(!rendered.includes("{{"), `${mode}: プレースホルダが残っている`);
      assert.ok(
        rendered.startsWith(
          `<!-- tazuna procedure v${PROCEDURE_VERSION} (mode: ${mode}) -->\n`,
        ),
      );
      assert.ok(rendered.endsWith("\n"));
    }
  });

  test("テンプレートには {{MODE}} / {{MODE_SECTIONS}} / {{DOCS_SECTIONS}} / {{TEST_SECTIONS}} / {{DB_SECTIONS}} が 1 回ずつあり、docs → テスト → DB の順で末尾", () => {
    assert.strictEqual(PROCEDURE_TEMPLATE.split("{{MODE}}").length, 2);
    assert.strictEqual(PROCEDURE_TEMPLATE.split("{{MODE_SECTIONS}}").length, 2);
    assert.strictEqual(PROCEDURE_TEMPLATE.split("{{DOCS_SECTIONS}}").length, 2);
    assert.strictEqual(PROCEDURE_TEMPLATE.split("{{TEST_SECTIONS}}").length, 2);
    assert.strictEqual(PROCEDURE_TEMPLATE.split("{{DB_SECTIONS}}").length, 2);
    assert.ok(PROCEDURE_TEMPLATE.endsWith("{{DOCS_SECTIONS}}{{TEST_SECTIONS}}{{DB_SECTIONS}}"));
  });

  test("db: \"placeholder\" は {{DB_SECTIONS}} を残し、実行時に設定に応じて置換される", () => {
    const printed = renderBuiltinProcedure("full", { docs: "placeholder", tests: "placeholder", db: "placeholder" });
    assert.ok(printed.endsWith("{{DOCS_SECTIONS}}{{TEST_SECTIONS}}{{DB_SECTIONS}}"));
    assert.strictEqual(renderProcedureTemplate(printed, "full", { db: true }), renderBuiltinProcedure("full", { db: true }));
    assert.strictEqual(renderProcedureTemplate(printed, "full"), renderBuiltinProcedure("full"));
  });

  test("docs / tests: \"placeholder\" は {{DOCS_SECTIONS}} / {{TEST_SECTIONS}} を残す(--print-procedure 用)", () => {
    const printed = renderBuiltinProcedure("full", { docs: "placeholder", tests: "placeholder" });
    assert.ok(printed.endsWith("{{DOCS_SECTIONS}}{{TEST_SECTIONS}}"));
    assert.ok(!printed.includes("{{MODE"));
    // 残したプレースホルダは実行時に設定に応じて置換される(procedure.md の運用)
    assert.strictEqual(renderProcedureTemplate(printed, "full", { docs: true }), renderBuiltinProcedure("full", { docs: true }));
    assert.strictEqual(renderProcedureTemplate(printed, "full", { tests: true }), renderBuiltinProcedure("full", { tests: true }));
    assert.strictEqual(renderProcedureTemplate(printed, "full", { docs: true, tests: true }), renderBuiltinProcedure("full", { docs: true, tests: true }));
    assert.strictEqual(renderProcedureTemplate(printed, "full"), renderBuiltinProcedure("full"));
    // 片方だけ placeholder にもできる
    const docsOnly = renderBuiltinProcedure("full", { docs: "placeholder" });
    assert.ok(docsOnly.endsWith("{{DOCS_SECTIONS}}"));
    assert.ok(!docsOnly.includes("{{TEST_SECTIONS}}"));
  });

  test("design: 調査 / 設計書 / 確認事項 / 継続判定の 4 節でコード変更を出させない", () => {
    const headings = MODE_SECTIONS.design.match(/^### .+$/gm);
    assert.deepStrictEqual(headings, [
      "### 1. 調査",
      "### 2. 設計書",
      "### 3. 確認事項",
      "### 4. 継続判定",
    ]);
    assert.ok(MODE_SECTIONS.design.includes("コードの変更はこのモードでは出しません"));
    assert.ok(MODE_SECTIONS.design.includes("status=ready"));
    assert.ok(MODE_SECTIONS.design.includes("必須"));
    assert.ok(MODE_SECTIONS.design.includes("後回し"));
  });

  test("full: 調査 / 方針 / 変更 / 自己検証の 4 節", () => {
    const headings = MODE_SECTIONS.full.match(/^### .+$/gm);
    assert.deepStrictEqual(headings, [
      "### 1. 調査",
      "### 2. 方針",
      "### 3. 変更",
      "### 4. 自己検証",
    ]);
  });

  test("plan: 調査 / 方針 / 質問の 3 節で changes.md を出させない", () => {
    const headings = MODE_SECTIONS.plan.match(/^### .+$/gm);
    assert.deepStrictEqual(headings, ["### 1. 調査", "### 2. 方針", "### 3. 質問"]);
    assert.ok(MODE_SECTIONS.plan.includes("changes.md を出さないでください"));
    assert.ok(!MODE_SECTIONS.plan.includes("changes.md を出してください"));
  });

  test("implement: 方針の確認 / 変更 / 自己検証の 3 節で調査を省く", () => {
    const headings = MODE_SECTIONS.implement.match(/^### .+$/gm);
    assert.deepStrictEqual(headings, [
      "### 1. 方針の確認",
      "### 2. 変更",
      "### 3. 自己検証",
    ]);
    assert.ok(MODE_SECTIONS.implement.includes("<plan>"));
    assert.ok(!MODE_SECTIONS.implement.includes("### 1. 調査"));
  });

  test("full と implement の自己検証は同じ文面", () => {
    const verify = (text: string) => text.slice(text.indexOf("自己検証"));
    assert.strictEqual(
      verify(MODE_SECTIONS.full),
      verify(MODE_SECTIONS.implement),
    );
  });

  test("renderProcedureTemplate: プレースホルダのないテンプレートはそのまま", () => {
    const custom = "# 独自の手順\n\n好きに書く\n";
    assert.strictEqual(renderProcedureTemplate(custom, "plan"), custom);
  });

  test("renderProcedureTemplate: 複数回のプレースホルダもすべて置換する", () => {
    const custom = "mode={{MODE}}\n{{MODE_SECTIONS}}\nagain {{MODE}}\n";
    const rendered = renderProcedureTemplate(custom, "implement");
    assert.strictEqual(
      rendered,
      `mode=implement\n${MODE_SECTIONS.implement}\nagain implement\n`,
    );
  });

  test("isProcedureMode", () => {
    assert.ok(isProcedureMode("full"));
    assert.ok(isProcedureMode("plan"));
    assert.ok(isProcedureMode("implement"));
    assert.ok(isProcedureMode("design"));
    assert.ok(!isProcedureMode("Full"));
    assert.ok(!isProcedureMode(""));
  });
});

suite("procedure: 構成の種類(layout、v7)", () => {
  test("solution のプレースホルダ置換後の文面は v6 と同じ語句を保つ(型の規則は v10 で <environment> を見る形に変えた)", () => {
    const text = renderBuiltinProcedure("full", { tests: true });
    for (const phrase of [
      "一般的な VB.NET / React のコード",
      "<ui_summary> は Designer.vb からの要約です",
      ".vbproj は編集しないでください",
      "「どのフォームか」",
      "Option Strict が Off のプロジェクトでも、型変換は明示してください",
      "<environment> に書かれた Visual Basic と .NET Framework の版",
      "Handles 句",
      "Shift_JIS",
      "e2e/screen/",
    ]) {
      assert.ok(text.includes(phrase), `${phrase} がありません`);
    }
    assert.ok(!text.includes("{{LAYOUT:"), "プレースホルダが残っています");
  });

  test("generic の文面に VB.NET / WinForms 固有の記述が残らない", () => {
    for (const mode of PROCEDURE_MODES) {
      const text = renderBuiltinProcedure(mode, { layout: "generic", docs: true, tests: true });
      for (const phrase of [
        "VB.NET",
        "Designer",
        ".vbproj",
        "フォームか",
        "Option Strict",
        "<environment>",
        "Handles",
        "Shift_JIS",
        "e2e/screen/",
        "db.snapshot",
        "{{LAYOUT:",
      ]) {
        assert.ok(!text.includes(phrase), `${mode}: ${phrase} が残っています`);
      }
      assert.ok(text.startsWith(`<!-- tazuna procedure v${PROCEDURE_VERSION} (mode: ${mode}, layout: generic) -->\n`));
    }
  });

  test("generic でも共通の節(パックの読み方 / 回答の構成 / 判断の原則)と新規ファイルの規則は残る", () => {
    const text = renderBuiltinProcedure("full", { layout: "generic" });
    for (const phrase of [
      "## パックの読み方",
      "## 回答の構成",
      "## 判断の原則",
      "### 4. 自己検証",
      "新規ファイルは changes.md の create で出してください。パスは <file_summary> に示す物理パスの規則で書いてください",
      "<contract_summary> がある場合",
      "[MASKED] は伏せ字です",
      "骨格のみ(skeleton)",
    ]) {
      assert.ok(text.includes(phrase), `${phrase} がありません`);
    }
  });

  test("テンプレートの {{LAYOUT:...}} は LAYOUT_TEXT の両構成に同じキーで定義されている", () => {
    const names = [...PROCEDURE_TEMPLATE.matchAll(/\{\{LAYOUT:([A-Z_]+)\}\}/g)].map((m) => m[1]);
    assert.ok(names.length > 0);
    for (const name of names) {
      assert.ok(name !== undefined && name in LAYOUT_TEXT.solution, `solution に ${name} がありません`);
      assert.ok(name !== undefined && name in LAYOUT_TEXT.generic, `generic に ${name} がありません`);
    }
    assert.deepStrictEqual(Object.keys(LAYOUT_TEXT.solution).sort(), Object.keys(LAYOUT_TEXT.generic).sort());
  });

  test("MODE_SECTIONS / TEST_SECTIONS は solution 構成のもの(後方互換)。generic との差は自己検証とテストの置き場の行だけ", () => {
    assert.strictEqual(MODE_SECTIONS, MODE_SECTIONS_BY_LAYOUT.solution);
    assert.strictEqual(TEST_SECTIONS, TEST_SECTIONS_BY_LAYOUT.solution);
    // plan / design は自己検証を持たないので構成で変わらない
    assert.strictEqual(MODE_SECTIONS_BY_LAYOUT.generic.plan, MODE_SECTIONS_BY_LAYOUT.solution.plan);
    assert.strictEqual(MODE_SECTIONS_BY_LAYOUT.generic.design, MODE_SECTIONS_BY_LAYOUT.solution.design);
    assert.notStrictEqual(MODE_SECTIONS_BY_LAYOUT.generic.full, MODE_SECTIONS_BY_LAYOUT.solution.full);
    assert.notStrictEqual(MODE_SECTIONS_BY_LAYOUT.generic.implement, MODE_SECTIONS_BY_LAYOUT.solution.implement);
    assert.ok(MODE_SECTIONS_BY_LAYOUT.generic.full.includes("- 新規ファイルは create で出している"));
  });

  test("procedure.md(カスタム文)にプレースホルダが無ければ layout は影響しない", () => {
    const custom = "# 自前の手順\n{{MODE}} で動く\n";
    assert.strictEqual(
      renderProcedureTemplate(custom, "full", { layout: "generic" }),
      renderProcedureTemplate(custom, "full"),
    );
  });
});

suite("procedure: v10(コメント方針・<environment>・自己検証の表)", () => {
  const COMMENT_HEADING = "\n## コード中のコメント\n\n- ";

  test("どの構成・モードでも「コード中のコメント」の節が「判断の原則」の直後に 1 回だけある", () => {
    for (const layout of ["solution", "generic"] as const) {
      for (const mode of PROCEDURE_MODES) {
        const text = renderBuiltinProcedure(mode, { layout, docs: true, tests: true, db: true });
        assert.strictEqual(text.split(COMMENT_HEADING).length, 2, `${layout}/${mode}`);
        const principles = text.indexOf("\n## 判断の原則\n");
        const comments = text.indexOf(COMMENT_HEADING);
        assert.ok(principles >= 0 && principles < comments, `${layout}/${mode}: 判断の原則の後にない`);
        const between = text.slice(principles + 1, comments);
        assert.ok(!between.slice(3).includes("\n## "), `${layout}/${mode}: 間に別の節がある`);
        const docs = text.indexOf("\n## 文書(docs/)の扱い");
        assert.ok(comments < docs, `${layout}/${mode}: docs の節より前にない`);
      }
    }
  });

  test("コメントの節: なぜだけ・経緯は changes.md へ・コメントアウトで残さない・修正履歴を手本にしない・範囲内の食い違いは直す", () => {
    const text = renderBuiltinProcedure("full");
    const section = text.slice(text.indexOf(COMMENT_HEADING));
    for (const phrase of [
      "「なぜそうするか」",
      "「何をしているか」は書かないでください",
      "changes.md の CHANGES の概要に書いてください",
      "古いコードをコメントアウトして残さないでください",
      "既存コードにある修正履歴のコメント(日付・担当者・START / END の印など)は、書き方の手本にしないでください",
      "変更する範囲の外のコメントには触れないでください",
    ]) {
      assert.ok(section.includes(phrase), `コメントの節に「${phrase}」がない`);
    }
    assert.ok(text.includes("ただしコメントは次の「コード中のコメント」に従います"));
  });

  test("自己検証の表から「空行・インデント込みで逐語一致か」を外し、呼んでいるものの実在を確かめる列にした", () => {
    for (const layout of ["solution", "generic"] as const) {
      for (const mode of ["full", "implement"] as const) {
        const text = MODE_SECTIONS_BY_LAYOUT[layout][mode];
        assert.ok(!text.includes("空行・インデント込みで逐語一致か"), `${layout}/${mode}`);
        assert.ok(
          text.includes(
            "| ファイル | ブロック | パック内に全文があるか | ファイル内で一意か | 呼んでいる既存のメソッド・プロパティ・コントロール・列がパック内にあるか |",
          ),
          `${layout}/${mode}`,
        );
        assert.ok(text.includes("コメントアウトした古いコードが入っていない"), `${layout}/${mode}`);
      }
    }
  });

  test("方針の段(full / plan)で、呼ぶ既存のものをパック内で確かめさせる", () => {
    for (const mode of ["full", "plan"] as const) {
      assert.ok(
        MODE_SECTIONS[mode].includes("変更で呼ぶ既存のメソッド・プロパティ・コントロール・列は、パック内で定義を確かめたものだけにしてください"),
        mode,
      );
    }
  });

  test("solution の自己検証にだけ <environment> の版の確認がある", () => {
    const line = "- <environment> の Visual Basic と .NET Framework の版で使えない構文・API を使っていない";
    assert.ok(MODE_SECTIONS_BY_LAYOUT.solution.full.includes(line));
    assert.ok(MODE_SECTIONS_BY_LAYOUT.solution.implement.includes(line));
    assert.ok(!MODE_SECTIONS_BY_LAYOUT.generic.full.includes("<environment>"));
  });
});

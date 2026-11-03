/**
 * dbChecks(AI チャットだけでの DB 確認)の単体テスト。ファイルシステムは fake を注入する。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import * as path from "node:path";
import { describeDbSchema, renderDbSchemaBlock, resolveDbSchema, schemaHasData } from "../../src/pack/dbChecks.ts";

const ROOT = path.resolve("/work/project");

suite("dbChecks", () => {
  test("ルートの docs/db/schema.md があれば読み、なければ undefined", () => {
    const file = path.resolve(ROOT, "docs", "db", "schema.md");
    const found = resolveDbSchema(ROOT, { readTextFile: (p) => (p === file ? "# DB\n" : undefined) });
    assert.deepStrictEqual(found, { relativePath: "docs/db/schema.md", content: "# DB\n" });
    assert.strictEqual(resolveDbSchema(ROOT, { readTextFile: () => undefined }), undefined);
  });

  test("<db_schema> ブロック: path 属性・説明の 1 行・本文(末尾の改行は 1 つ)", () => {
    assert.strictEqual(
      renderDbSchemaBlock({ relativePath: "docs/db/schema.md", content: "# DB\n\n### dbo.orders\n" }),
      '<db_schema path="docs/db/schema.md">\nテスト用 DB のテーブル定義(ashiato schema の出力。行の値は含まない)。確認用の SQL はこの定義に合わせて書く。\n\n# DB\n\n### dbo.orders\n</db_schema>\n',
    );
  });

  // ashiato schema --data が書く説明の行(ashiato の src/chat/schema.ts の dataIntro)
  const DATA_JA = "# DB のテーブル定義\n\nSQL Server のカタログから `ashiato schema` が書き出しました(参照のみ)。\n\n`--data` で 2026-11-03 時点のデータの姿も書き足しています。件数・参照…\n\n## テーブル\n";
  const DATA_EN = "# Database tables\n\nWritten by `ashiato schema`.\n\nWith `--data`, it also describes the rows as of 2026-11-03: row counts…\n\n## Tables\n";

  test("データの姿つき(ashiato schema --data の出力)を見分ける(日本語・英語)", () => {
    assert.strictEqual(schemaHasData(DATA_JA), true);
    assert.strictEqual(schemaHasData(DATA_EN), true);
    assert.strictEqual(schemaHasData("# DB のテーブル定義\n\n列・型・主キー・コメントです。\n"), false);
    // 行の途中に現れる語では見分けない(コメントに --data と書いた列など)
    assert.strictEqual(schemaHasData("| note | text | YES | `--data` で渡す |\n"), false);
    const file = path.resolve(ROOT, "docs", "db", "schema.md");
    const found = resolveDbSchema(ROOT, { readTextFile: (p) => (p === file ? DATA_JA : undefined) });
    assert.deepStrictEqual(found, { relativePath: "docs/db/schema.md", content: DATA_JA, hasData: true });
  });

  test("<db_schema> ブロック: データの姿つきなら説明の 1 行で値を含むことと、SQL で確かめないことを書く", () => {
    const block = renderDbSchemaBlock({ relativePath: "docs/db/schema.md", content: DATA_JA, hasData: true });
    assert.ok(
      block.startsWith(
        '<db_schema path="docs/db/schema.md">\nテスト用 DB のテーブル定義と、書き出した日のデータの姿(ashiato schema --data の出力。区分の値・範囲・見本の行などの値を含み、隠した列の値は含まない)。確認用の SQL はこの定義に合わせて書き、ここで分かることは SQL で確かめない。\n\n# DB のテーブル定義\n',
      ),
    );
    assert.ok(!block.includes("行の値は含まない"));
  });

  test("表示: あり(文字数)/ なし", () => {
    assert.strictEqual(describeDbSchema({ relativePath: "docs/db/schema.md", content: "x".repeat(1234) }), "あり(docs/db/schema.md、1,234 文字)");
    assert.strictEqual(describeDbSchema(undefined), "なし(docs/db/schema.md がありません)");
    assert.strictEqual(
      describeDbSchema({ relativePath: "docs/db/schema.md", content: "x".repeat(10), hasData: true }),
      "あり(docs/db/schema.md、10 文字、データの姿つき)",
    );
  });
});

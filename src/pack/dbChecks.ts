/**
 * AI チャットだけでの DB 確認・動作検証(手順文 v8 / v9、2026-10-13)。
 *
 * ルート直下の docs/db/schema.md(ashiato schema の出力。テスト用 DB の
 * テーブル定義で、行の値は含まない)があるときだけ、パックに <db_schema> として
 * 入れ、手順文に「DB の確認」「動作検証」の節を足す(procedure.ts の DB_SECTIONS)。
 * AI は確認用の SELECT を checks/*.sql で、操作と期待する DB の変化を
 * checks/*.verify.md で出し、ユーザーが ashiato query / ashiato verify で
 * 実行して結果をチャットに貼る。slnmix 自身は DB に接続しない。
 *
 * ashiato schema --data の出力(データの姿つき。手順文 v12)なら、<db_schema> の説明と手順文の
 * 「DB の確認」の節をそれに合わせる(hasData。値を含むため、渡す前に読むのはユーザー)。
 *
 * 本文用テキストには入れない(テーブルが多いと貼付の上限を超えるため。
 * 添付の中のデータは検索で参照される)。ファイルシステムは deps 注入。
 */

import * as path from "node:path";
import { DB_SCHEMA_PATH } from "./assets/procedure.ts";

export interface DbSchemaEntry {
  /** ルート相対・`/` 区切り */
  relativePath: string;
  content: string;
  /** ashiato schema --data の出力(件数・区分の値・範囲などのデータの姿を含む)か */
  hasData?: boolean;
}

/**
 * ashiato schema --data が書く説明の行(ashiato の src/chat/schema.ts の TEXT.ja / en の dataIntro)の書き出し。
 * --data なしの出力には無い
 */
const DATA_INTRO = /^(?:`--data` で |With `--data`, )/m;

/** schema.md がデータの姿つき(ashiato schema --data の出力)か */
export function schemaHasData(content: string): boolean {
  return DATA_INTRO.test(content);
}

export interface DbChecksDeps {
  readTextFile(absolutePath: string): string | undefined;
}

/** ルートの docs/db/schema.md を読む。なければ undefined(DB の確認は無効) */
export function resolveDbSchema(rootDir: string, deps: DbChecksDeps): DbSchemaEntry | undefined {
  const content = deps.readTextFile(path.resolve(rootDir, ...DB_SCHEMA_PATH.split("/")));
  if (content === undefined) return undefined;
  return schemaHasData(content)
    ? { relativePath: DB_SCHEMA_PATH, content, hasData: true }
    : { relativePath: DB_SCHEMA_PATH, content };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * <db_schema> ブロック(閉じタグ・末尾改行込み)。
 * @param transform 認証情報マスク等(文書と同じ変換を通す)
 */
export function renderDbSchemaBlock(
  schema: DbSchemaEntry,
  transform: (text: string) => string = (t) => t,
): string {
  const body = transform(schema.content).replace(/\r?\n$/, "");
  const intro =
    schema.hasData === true
      ? "テスト用 DB のテーブル定義と、書き出した日のデータの姿(ashiato schema --data の出力。区分の値・範囲・見本の行などの値を含み、隠した列の値は含まない)。確認用の SQL はこの定義に合わせて書き、ここで分かることは SQL で確かめない。"
      : "テスト用 DB のテーブル定義(ashiato schema の出力。行の値は含まない)。確認用の SQL はこの定義に合わせて書く。";
  return `<db_schema path="${escapeAttribute(schema.relativePath)}">\n${intro}\n\n${body}\n</db_schema>\n`;
}

/** CLI の 1 行表示用 */
export function describeDbSchema(schema: DbSchemaEntry | undefined): string {
  return schema === undefined
    ? `なし(${DB_SCHEMA_PATH} がありません)`
    : `あり(${schema.relativePath}、${schema.content.length.toLocaleString("en-US")} 文字${schema.hasData === true ? "、データの姿つき" : ""})`;
}

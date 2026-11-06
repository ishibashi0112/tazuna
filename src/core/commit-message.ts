/**
 * changes.md の概要 (## CHANGES と最初の ### FILE: の間) からコミットメッセージを作る (純粋関数)。
 * 1 回の適用 = 1 コミット (config の git.commitEachApply と tazuna commit) で使う。
 *
 * - 件名: 概要の最初の内容のある行。最初の「。」の前まで、長ければ切り詰める。規約文 v6 から、概要の 1 行目は
 *   AI が件名として書く (40 文字以内の「〜を追加」の形)。「変更概要:」のような見出しは外す
 * - 本文: 概要の全文 (件名がその行そのものなら、その次の行から)。Mermaid などのコードブロックと
 *   「影響ファイル:」の一覧は除く (ファイルの一覧はコミット自体に残る)
 * - 末尾: 履歴 ID のトレーラー (コミットと tazuna の履歴を突き合わせるため)
 *
 * 概要は AI の書いたテキストなので、制御文字 (改行とタブを除く) と双方向制御文字を除く
 */
import { TOOL_NAME } from "../brand.ts";

/** 件名の長さの上限 (文字数) */
export const SUBJECT_MAX_CHARS = 60;

/** コミットメッセージの末尾に付けるトレーラーの名前 */
export const HISTORY_TRAILER = "Tazuna-History";

// 改行 (\n) とタブ以外の C0、DEL、C1、双方向制御文字 (Trojan Source)
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g;

export interface CommitMessage {
  subject: string;
  /** git commit -F に渡す全文 (件名・空行・本文・空行・トレーラー。末尾は改行) */
  message: string;
}

function cleanSummary(header: string): string[] {
  const lines = header.replace(/\r\n?/g, "\n").replace(UNSAFE_CHARS, "").split("\n");
  const kept: string[] = [];
  let fence: string | null = null;
  let inFileList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (fence !== null) {
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch !== null) {
      fence = fenceMatch[1] as string;
      continue;
    }
    if (/^影響ファイル\s*[:：]/.test(trimmed)) {
      inFileList = true;
      continue;
    }
    if (inFileList) {
      if (/^[-*+]\s/.test(trimmed)) continue;
      inFileList = false;
    }
    kept.push(line);
  }
  // 前後の空行を落とし、続く空行は 1 つにまとめる
  const collapsed: string[] = [];
  for (const line of kept) {
    if (line.trim() === "" && (collapsed.length === 0 || collapsed[collapsed.length - 1]?.trim() === "")) continue;
    collapsed.push(line);
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1]?.trim() === "") collapsed.pop();
  return collapsed;
}

/**
 * 概要の見出しのような書き出し (「**変更概要**」「## 概要」「変更概要: 」)。AI がよく付けるが件名にはならないので外す。
 * 見出しだけの行は空の行として扱う
 */
const SUMMARY_LABEL = /^(?:変更の?概要|変更内容|概要|要約|summary)\s*(?:[:：]\s*|$)/i;

/** Markdown の見出し・箇条書き・引用・強調の記号と、概要の見出しを件名から外す */
function plainSubject(line: string): string {
  return line
    .trim()
    .replace(/^(#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, "")
    .replace(/\*\*|__/g, "")
    .trim()
    .replace(SUMMARY_LABEL, "")
    .trim();
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * @param header ChangeSet.header (概要)
 * @param historyId 適用の履歴 ID
 * @param fileCount コミットするファイル数 (概要が空のときの件名に使う)
 */
export function buildCommitMessage(header: string, historyId: string, fileCount: number): CommitMessage {
  const lines = cleanSummary(header);
  const firstIndex = lines.findIndex((l) => plainSubject(l) !== "");
  let subject: string;
  let body: string[];
  if (firstIndex === -1) {
    subject = `${TOOL_NAME} で changes.md を適用 (${fileCount} ファイル)`;
    body = [];
  } else {
    const first = plainSubject(lines[firstIndex] as string);
    const period = first.indexOf("。");
    const head = period > 0 ? first.slice(0, period) : first;
    const rest = period > 0 ? first.slice(period + 1).trim() : "";
    subject = truncate(head, SUBJECT_MAX_CHARS);
    // 件名が最初の行 (の 1 文) そのものなら本文はその次の行から。途中で切ったなら、情報を落とさないよう
    // その行から本文に入れる
    const cut = rest !== "" || subject !== head;
    body = cut ? lines.slice(firstIndex) : lines.slice(firstIndex + 1);
    while (body.length > 0 && body[0]?.trim() === "") body.shift();
  }
  const parts = [subject];
  if (body.length > 0) parts.push("", ...body);
  parts.push("", `${HISTORY_TRAILER}: ${historyId}`);
  return { subject, message: `${parts.join("\n")}\n` };
}

/** まとめてコミットする 1 回分 */
export interface CommitEntry {
  header: string;
  historyId: string;
  fileCount: number;
}

/**
 * 前回のコミットの後に当てた複数の changes.md を 1 つにまとめたメッセージ (tazuna commit)。
 * 件名は最初の回の件名、本文は各回の件名の箇条書き、末尾に各回の履歴 ID のトレーラー。1 回だけなら buildCommitMessage と同じ
 */
export function buildBatchCommitMessage(entries: readonly CommitEntry[]): CommitMessage {
  const [first, ...rest] = entries;
  if (first === undefined) return buildCommitMessage("", "", 0);
  if (rest.length === 0) return buildCommitMessage(first.header, first.historyId, first.fileCount);
  const subjects = entries.map((e) => buildCommitMessage(e.header, e.historyId, e.fileCount).subject);
  const subject = subjects[0] as string;
  const lines = [
    subject,
    "",
    ...subjects.map((s) => `- ${s}`),
    "",
    ...entries.map((e) => `${HISTORY_TRAILER}: ${e.historyId}`),
  ];
  return { subject, message: `${lines.join("\n")}\n` };
}

/**
 * 件名を利用者の指定 (tazuna commit -m) に替える。改行と制御文字は除く。空になれば null
 */
export function withSubject(message: CommitMessage, subject: string): CommitMessage | null {
  const cleaned = subject.replace(/[\r\n]+/g, " ").replace(UNSAFE_CHARS, "").trim();
  if (cleaned === "") return null;
  const newline = message.message.indexOf("\n");
  const rest = newline === -1 ? "\n" : message.message.slice(newline);
  return { subject: cleaned, message: `${cleaned}${rest}` };
}

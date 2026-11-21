/**
 * tazuna watch の画面からのパック (p) と、前回のパックで貼るものをもう一度コピーする (c)。
 * 貼るものの決め方は tazuna pack と同じ (pack/handoff.ts の planHandoff。パックが貼付上限の目安以内なら
 * パック全体、超えるなら本文用テキスト)。読むのはルートの既定の出力 (repomix-output.xml と .prompt.md) で、
 * パックの中身は作ったときに伏せてあるものをそのまま使う (ここで新しく読むソースはない)。
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PACK_COMMAND } from "../brand.ts";
import { GENERATED_OUTPUTS } from "../pack/initProject.ts";
import { PASTE_LIMIT_CHARS, type HandoffPlan } from "../pack/handoff.ts";
import { listHistoryIds, readManifest } from "../infra/history.ts";
import type { ClipboardResult } from "../infra/clipboard.ts";

const PACK_FILE = GENERATED_OUTPUTS[0] ?? "repomix-output.xml";
const PROMPT_FILE = GENERATED_OUTPUTS[1] ?? "repomix-output.prompt.md";

/**
 * 本文用テキストを同じパックのものとみなす、パックの更新時刻との差 (ミリ秒)。tazuna pack はパックの直後に
 * 本文用テキストを書く。--no-prompt で作ったパックの横に前の回の本文用テキストが残っていても使わない
 * (FAT・ネットワークドライブの 2 秒単位の更新時刻でも同じ回のものを外さないよう、2 秒の幅を持たせる)
 */
const PROMPT_SAME_RUN_MS = 2_000;

export interface LastPack {
  /** パックのファイル名 (案内用) */
  packName: string;
  promptName: string;
  /** パックの中身 (BOM を除く。tazuna pack が書いたもの) */
  pack: string;
  /** 同じ回に書いた本文用テキスト (無い・前の回のものなら undefined) */
  prompt: string | undefined;
  /** パックを書いた時刻 */
  packAt: Date;
  /** パックを書いた後に tazuna で当てた回数 (巻き戻したものを除く) */
  appliedSince: number;
}

const withoutBom = (text: string): string => text.replace(/^﻿/, "");

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 履歴 ID の先頭 (YYYY-MM-DD_HHmm。infra/history.ts の createHistoryId と同じ形・ローカル時刻) */
function historyIdPrefix(at: Date): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}_${pad2(at.getHours())}${pad2(at.getMinutes())}`;
}

/**
 * パックを書いた後に当てた回数。manifest は非信頼入力なので、読めない・形が違うものは数えない
 * (案内の 1 行に使うだけで、何も止めない)
 */
export function countAppliesSince(root: string, since: Date): number {
  const prefix = historyIdPrefix(since);
  let count = 0;
  for (const id of listHistoryIds(root)) {
    if (id < prefix) continue;
    let manifest: unknown;
    try {
      manifest = readManifest(root, id);
    } catch {
      continue;
    }
    if (typeof manifest !== "object" || manifest === null) continue;
    const { appliedAt, files, undoneAt } = manifest as { appliedAt?: unknown; files?: unknown; undoneAt?: unknown };
    if (typeof appliedAt !== "string" || !Array.isArray(files) || undoneAt !== undefined) continue;
    const at = new Date(appliedAt);
    if (Number.isNaN(at.getTime()) || at.getTime() <= since.getTime()) continue;
    if (files.some((file) => typeof file === "object" && file !== null && (file as { applied?: unknown }).applied === true)) {
      count++;
    }
  }
  return count;
}

/** ルートの既定の出力から、前回のパックを読む (無ければ null) */
export function readLastPack(root: string): LastPack | null {
  const packPath = join(root, PACK_FILE);
  const promptPath = join(root, PROMPT_FILE);
  let packMtime: number;
  let pack: string;
  try {
    packMtime = statSync(packPath).mtimeMs;
    pack = withoutBom(readFileSync(packPath, "utf8"));
  } catch {
    return null;
  }
  let prompt: string | undefined;
  try {
    if (statSync(promptPath).mtimeMs >= packMtime - PROMPT_SAME_RUN_MS) {
      prompt = withoutBom(readFileSync(promptPath, "utf8"));
    }
  } catch {
    prompt = undefined;
  }
  const packAt = new Date(packMtime);
  return {
    packName: PACK_FILE,
    promptName: PROMPT_FILE,
    pack,
    prompt,
    packAt,
    appliedSince: countAppliesSince(root, packAt),
  };
}

/** 作った時刻の表示 (同じ日なら時刻だけ) */
function madeAtLabel(at: Date, now: Date): string {
  const hm = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  return at.toDateString() === now.toDateString() ? hm : `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
}

const kiloChars = (text: string): number => Math.max(1, Math.round(text.length / 1000));

export interface CopyReport {
  /** ターミナルのタイトル */
  title: string;
  headline: string;
  details: string[];
}

/**
 * c (もう一度コピー) の結果の知らせ方。純粋関数
 * @param last 前回のパック (無ければ null)
 * @param plan 貼るもの (planHandoff の結果。last が null なら null)
 * @param copied クリップボードに書いた結果 (書いていなければ null)
 */
export function describeCopy(
  last: Pick<LastPack, "packName" | "promptName" | "packAt" | "appliedSince"> | null,
  plan: HandoffPlan | null,
  copied: ClipboardResult | null,
  now: Date,
): CopyReport {
  if (last === null || plan === null) {
    return {
      title: "✗ パックがありません",
      headline: `✗ 前回のパック (${PACK_FILE}) が見つかりません`,
      details: ["p を打って Enter でパックを作れます (貼るものはそのときクリップボードに入ります)"],
    };
  }
  if (plan.kind === "none") {
    return {
      title: "✗ 本文用テキストがありません",
      headline: `✗ パックが貼付上限の目安 (約 ${PASTE_LIMIT_CHARS / 1000}K 文字) を超えていて、本文用テキスト (${last.promptName}) がありません`,
      details: [
        `${last.packName} を添付してください。p を打って Enter でパックを作り直すと、本文用テキストも作ります`,
      ],
    };
  }
  const what = plan.kind === "paste-pack" ? last.packName : last.promptName;
  if (copied === null || !copied.ok) {
    return {
      title: "✗ コピーできませんでした",
      headline: `✗ クリップボードにコピーできませんでした${copied === null || copied.ok ? "" : ` (${copied.message})`}`,
      details: [`貼るものは ${what} にあります (ファイルを開いて全体をコピーしてください)`],
    };
  }
  const made = `${madeAtLabel(last.packAt, now)} に作ったパックのものです`;
  const stale =
    last.appliedSince > 0
      ? [
          `このパックを作った後に changes.md を ${last.appliedSince} 回当てています。` +
            `今のコードを渡すなら p を打って Enter でパックを作り直してください (${PACK_COMMAND} と同じ)`,
        ]
      : [];
  return plan.kind === "paste-pack"
    ? {
        title: "✓ パック全体をコピー",
        headline: `✓ パック全体 (約 ${kiloChars(plan.text)}K 文字) をクリップボードにコピーしました → Copilot Chat の本文に貼って送信してください (添付は不要)`,
        details: [made, ...stale],
      }
    : {
        title: "✓ 本文用テキストをコピー",
        headline: `✓ 本文用テキスト (約 ${kiloChars(plan.text)}K 文字) をクリップボードにコピーしました → ${last.packName} を添付し、本文に貼って送信してください`,
        details: [made, ...stale],
      };
}

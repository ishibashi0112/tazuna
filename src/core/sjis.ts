/**
 * Shift_JIS (CP932) エンコーダ (§8)。
 * デコードは Node 組み込み TextDecoder("shift_jis") を使い、エンコードは
 * その TextDecoder から生成した逆引きテーブル (sjis-table.ts) で行う。
 * 生成原理上、sjisEncode したバイト列のデコード結果は必ず元の文字列に一致する。
 */
import { SJIS_CHARS, SJIS_TRAILS } from "./sjis-table.ts";

const PLACEHOLDER = "�";

/**
 * WHATWG encoding 仕様でエンコーダから除外されるポインタ範囲 (lead 0xED-0xEF)。
 * NEC 選定 IBM 拡張。同じ文字が IBM 拡張 (lead 0xFA-0xFC) にもあり、
 * Windows のエンコーダは IBM 側を選ぶため、こちらは「他に無い場合のみ」使う。
 */
const NEC_IBM_START = 8272;
const NEC_IBM_END = 8835;

function pointerToBytes(p: number): [number, number] {
  const li = Math.floor(p / SJIS_TRAILS);
  const ti = p % SJIS_TRAILS;
  const lead = li < 0x1f ? 0x81 + li : 0xe0 + (li - 0x1f);
  const trail = ti < 0x3f ? 0x40 + ti : 0x80 + (ti - 0x3f);
  return [lead, trail];
}

let encodeMap: Map<string, number> | null = null;

function getEncodeMap(): Map<string, number> {
  if (encodeMap !== null) return encodeMap;
  const map = new Map<string, number>();
  const record = (p: number): void => {
    const ch = SJIS_CHARS[p] as string;
    if (ch === PLACEHOLDER || map.has(ch)) return;
    const [lead, trail] = pointerToBytes(p);
    map.set(ch, (lead << 8) | trail);
  };
  for (let p = 0; p < SJIS_CHARS.length; p++) {
    if (p < NEC_IBM_START || p > NEC_IBM_END) record(p);
  }
  for (let p = NEC_IBM_START; p <= NEC_IBM_END; p++) record(p);
  encodeMap = map;
  return map;
}

export interface SjisEncodeResult {
  bytes: Uint8Array;
  /** Shift_JIS に変換できなかった文字 (重複除去済み)。空でなければ bytes は不完全 */
  unencodable: string[];
}

export function sjisEncode(text: string): SjisEncodeResult {
  const map = getEncodeMap();
  const out: number[] = [];
  const bad = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) {
      // ASCII。U+005C はバックスラッシュ (SJIS では ¥ 表示) としてそのまま
      out.push(cp);
      continue;
    }
    if (cp === 0xa5) {
      // ¥ → 0x5C (Windows 慣習・WHATWG エンコーダと同じ)
      out.push(0x5c);
      continue;
    }
    if (cp === 0x203e) {
      // ‾ (オーバーライン) → 0x7E
      out.push(0x7e);
      continue;
    }
    if (cp >= 0xff61 && cp <= 0xff9f) {
      // 半角カナ
      out.push(0xa1 + (cp - 0xff61));
      continue;
    }
    const two = map.get(ch);
    if (two === undefined) {
      bad.add(ch);
      continue;
    }
    out.push(two >> 8, two & 0xff);
  }
  return { bytes: Uint8Array.from(out), unencodable: [...bad] };
}

/** text に Shift_JIS へ変換できない文字が含まれるか (検証用・§8) */
export function sjisUnencodable(text: string): string[] {
  return sjisEncode(text).unencodable;
}

/**
 * JIS X 0208 の同じ文字に、Unicode への対応表によって別のコードポイントが当てられているもの。
 * キーは JIS の対応表 (macOS・JIS X 0213・EUC-JP の多くの実装など) の側、値は Windows の Shift_JIS (CP932)
 * の側で、TextDecoder("shift_jis") のデコード結果は値の側になる。AI は「〜」(U+301C) のようにキーの側を
 * 書くことが多く、そのままでは Shift_JIS へ変換できない。Shift_JIS のファイルに書く文字・照合する文字は
 * 値の側にそろえる (foldToCp932)。sjisEncode 自体は変換しない (ファイル名を .vbproj に書くときなど、
 * 実際の名前と違う文字にしてはいけない所があるため)。
 * 0x815F (U+005C と U+FF3C) は ASCII のバックスラッシュのため対象外
 */
export const CP932_EQUIVALENTS: ReadonlyMap<string, string> = new Map([
  ["\u301c", "\uff5e"], // 〜 WAVE DASH → ～ FULLWIDTH TILDE (0x8160)
  ["\u2016", "\u2225"], // ‖ DOUBLE VERTICAL LINE → ∥ PARALLEL TO (0x8161)
  ["\u2212", "\uff0d"], // − MINUS SIGN → － FULLWIDTH HYPHEN-MINUS (0x817C)
  ["\u00a2", "\uffe0"], // ¢ CENT SIGN → ￠ FULLWIDTH CENT SIGN (0x8191)
  ["\u00a3", "\uffe1"], // £ POUND SIGN → ￡ FULLWIDTH POUND SIGN (0x8192)
  ["\u00ac", "\uffe2"], // ¬ NOT SIGN → ￢ FULLWIDTH NOT SIGN (0x81CA)
  ["\u2014", "\u2015"], // — EM DASH → ― HORIZONTAL BAR (0x815C)
]);

const CP932_FOLD_PATTERN = new RegExp(`[${[...CP932_EQUIVALENTS.keys()].join("")}]`, "gu");

/** CP932_EQUIVALENTS のキーの文字を値の文字にする。変えた文字 (元の文字。出現ごと) も返す */
export function foldToCp932(text: string): { text: string; folded: string[] } {
  const folded: string[] = [];
  const out = text.replace(CP932_FOLD_PATTERN, (ch) => {
    folded.push(ch);
    return CP932_EQUIVALENTS.get(ch) ?? ch;
  });
  return { text: out, folded };
}

/** 文字の一覧を「– (U+2013)」の形で並べる (見分けにくい文字を AI にも利用者にも特定できるように) */
export function describeChars(chars: readonly string[]): string {
  return chars
    .map((ch) => `${ch} (U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")})`)
    .join(" ");
}

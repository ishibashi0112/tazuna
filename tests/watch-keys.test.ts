import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeWatchGuide, describeWatchInput, describeWatchKeys, describeWatchResult, watchCommand } from "../src/commands/watch.ts";
import { countAppliesSince, describeCopy, readLastPack } from "../src/commands/watch-pack.ts";
import { interpretWatchInput, type WatchInput } from "../src/core/watch-keys.ts";
import type { ClipboardResult } from "../src/infra/clipboard.ts";
import { listenWatchInput } from "../src/infra/watch-keys.ts";

describe("interpretWatchInput (watch の画面で打つコマンド)", () => {
  it("p / c / b / h を 1 文字で受け付け、大文字・全角 (IME がオンのとき) も同じに扱う", () => {
    expect(interpretWatchInput(["p"])).toEqual({ kind: "command", command: "pack" });
    expect(interpretWatchInput(["C"])).toEqual({ kind: "command", command: "copy" });
    expect(interpretWatchInput(["ｂ"])).toEqual({ kind: "command", command: "build" });
    expect(interpretWatchInput(["Ｐ"])).toEqual({ kind: "command", command: "pack" });
    expect(interpretWatchInput([" h "])).toEqual({ kind: "command", command: "help" });
    expect(interpretWatchInput(["？"])).toEqual({ kind: "command", command: "help" });
  });

  it("Enter だけは何もしない。コマンドでない 1 行は unknown", () => {
    expect(interpretWatchInput([""])).toEqual({ kind: "empty" });
    expect(interpretWatchInput(["", "  "])).toEqual({ kind: "empty" });
    expect(interpretWatchInput(["pack"])).toEqual({ kind: "unknown", text: "pack" });
    expect(interpretWatchInput(["ぱ"])).toEqual({ kind: "unknown", text: "ぱ" });
  });

  it("内容のある行がまとめて 2 行以上届いたら貼り付けとみなし、中の p や c に反応しない", () => {
    expect(interpretWatchInput(["Dim a = 1", "p", "c"])).toEqual({ kind: "pasted", lines: 3 });
    expect(interpretWatchInput(["p", "", "c"])).toEqual({ kind: "pasted", lines: 2 });
    // 空行が挟まっても 1 行だけならその行
    expect(interpretWatchInput(["", "p"])).toEqual({ kind: "command", command: "pack" });
  });
});

describe("listenWatchInput (行の読み取り)", () => {
  it("打った行を 1 回ずつ、まとめて届いた行は 1 回の入力として渡し、close の後は渡さない", async () => {
    const input = new PassThrough();
    const got: WatchInput[] = [];
    const listener = listenWatchInput(input, (x) => got.push(x), 20);
    input.write("p\r\n");
    await new Promise((r) => setTimeout(r, 60));
    input.write("line1\nline2\nc\n");
    await new Promise((r) => setTimeout(r, 60));
    listener.close();
    input.write("b\n");
    await new Promise((r) => setTimeout(r, 60));
    expect(got).toEqual([
      { kind: "command", command: "pack" },
      { kind: "pasted", lines: 3 },
    ]);
  });
});

describe("案内の文面", () => {
  it("一覧は b をビルドできるときだけ載せる", () => {
    expect(describeWatchKeys({ build: true }).join("\n")).toContain("b  ビルドする (tazuna build と同じ");
    expect(describeWatchKeys({ build: false }).join("\n")).not.toContain("ビルド");
    expect(describeWatchKeys({ build: false }).join("\n")).toContain("c  前回のパックで貼るものを、もう一度クリップボードへ");
  });

  it("結果の後の 1 行は、コマンドを受け付けるときだけ打てるものを並べる", () => {
    expect(describeWatchGuide({ keys: false, build: true })).toBe("引き続き待っています (Ctrl+C で終了)");
    expect(describeWatchGuide({ keys: true, build: true })).toContain("p パックを作る / c 貼るものをもう一度コピー / b ビルド / h 一覧");
    expect(describeWatchGuide({ keys: true, build: false })).not.toContain("ビルド");
  });

  it("貼り付けと打ち間違いは、何もしていないことを書く", () => {
    expect(describeWatchInput({ kind: "pasted", lines: 4 })).toContain("4 行がまとめて入力されたため、貼り付けとみなして何もしていません");
    expect(describeWatchInput({ kind: "unknown", text: "x".repeat(30) })).toBe(`「${"x".repeat(20)}…」はコマンドではありません`);
    expect(describeWatchInput({ kind: "command", command: "pack" })).toBeNull();
  });

  it("適用の後の案内は、b を打てるときはビルドのキーを添える", () => {
    const applied = { kind: "applied" as const, files: 1, reportCopied: false };
    expect(describeWatchResult(applied, { path: "c.md", tidy: null, rootOption: null, buildKey: true }).details[0]).toContain(
      "確認してから、b を打って Enter でビルドしてください",
    );
    expect(describeWatchResult(applied, { path: "c.md", tidy: null, rootOption: null }).details[0]).toContain("確認してからビルドしてください");
  });
});

describe("describeCopy (c の結果)", () => {
  const now = new Date(2026, 10, 21, 16, 30);
  const last = { packName: "repomix-output.xml", promptName: "repomix-output.prompt.md", packAt: new Date(2026, 10, 21, 16, 5), appliedSince: 0 };
  const ok: ClipboardResult = { ok: true };

  it("小さいパックはパック全体、大きいパックは本文用テキストをコピーしたと書く (tazuna pack と同じ)", () => {
    const small = describeCopy(last, { kind: "paste-pack", text: "x".repeat(85_000) }, ok, now);
    expect(small.headline).toBe("✓ パック全体 (約 85K 文字) をクリップボードにコピーしました → Copilot Chat の本文に貼って送信してください (添付は不要)");
    expect(small.details).toEqual(["16:05 に作ったパックのものです"]);
    const big = describeCopy(last, { kind: "paste-prompt", text: "y".repeat(30_000) }, ok, now);
    expect(big.headline).toContain("本文用テキスト (約 30K 文字) をクリップボードにコピーしました → repomix-output.xml を添付し");
  });

  it("パックの後に当てていれば、作り直すよう添える", () => {
    const report = describeCopy({ ...last, appliedSince: 2 }, { kind: "paste-prompt", text: "y" }, ok, now);
    expect(report.details[1]).toContain("このパックを作った後に changes.md を 2 回当てています");
    expect(report.details[1]).toContain("p を打って Enter でパックを作り直してください");
  });

  it("前の日のパックは日付も書く", () => {
    const report = describeCopy({ ...last, packAt: new Date(2026, 10, 20, 9, 1) }, { kind: "paste-pack", text: "x" }, ok, now);
    expect(report.details[0]).toBe("11/20 09:01 に作ったパックのものです");
  });

  it("パックが無い・本文用テキストが無い・コピーできないときは、そう書く", () => {
    expect(describeCopy(null, null, null, now).headline).toBe("✗ 前回のパック (repomix-output.xml) が見つかりません");
    expect(describeCopy(last, { kind: "none" }, null, now).headline).toContain("本文用テキスト (repomix-output.prompt.md) がありません");
    const failed = describeCopy(last, { kind: "paste-prompt", text: "y" }, { ok: false, message: "PowerShell が見つかりません" }, now);
    expect(failed.headline).toBe("✗ クリップボードにコピーできませんでした (PowerShell が見つかりません)");
    expect(failed.details[0]).toContain("repomix-output.prompt.md にあります");
  });
});

describe("readLastPack / countAppliesSince", () => {
  function project(): string {
    return mkdtempSync(join(tmpdir(), "tazuna-lastpack-"));
  }

  it("BOM を除いて読み、前の回の本文用テキスト (--no-prompt で作ったパックの横に残ったもの) は使わない", () => {
    const root = project();
    expect(readLastPack(root)).toBeNull();
    writeFileSync(join(root, "repomix-output.xml"), "﻿<pack/>", "utf8");
    writeFileSync(join(root, "repomix-output.prompt.md"), "﻿本文", "utf8");
    const fresh = readLastPack(root);
    expect(fresh?.pack).toBe("<pack/>");
    expect(fresh?.prompt).toBe("本文");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(root, "repomix-output.prompt.md"), old, old);
    expect(readLastPack(root)?.prompt).toBeUndefined();
  });

  it("パックの後に当てた回だけを数える (巻き戻したもの・書かなかったもの・壊れた manifest は数えない)", () => {
    const root = project();
    const packAt = new Date(2026, 10, 21, 16, 5, 30);
    const history = join(root, ".tazuna", "history");
    const manifest = (id: string, body: unknown): void => {
      mkdirSync(join(history, id), { recursive: true });
      writeFileSync(join(history, id, "manifest.json"), typeof body === "string" ? body : JSON.stringify(body), "utf8");
    };
    const applied = (at: Date, extra: object = {}): object => ({
      appliedAt: at.toISOString(),
      files: [{ path: "a.vb", applied: true }],
      ...extra,
    });
    manifest("2026-11-21_1600", applied(new Date(2026, 10, 21, 16, 0)));
    manifest("2026-11-21_1605", applied(new Date(2026, 10, 21, 16, 5, 10)));
    manifest("2026-11-21_1605-2", applied(new Date(2026, 10, 21, 16, 5, 50)));
    manifest("2026-11-21_1610", applied(new Date(2026, 10, 21, 16, 10), { undoneAt: "2026-11-21T07:11:00.000Z" }));
    manifest("2026-11-21_1612", { appliedAt: new Date(2026, 10, 21, 16, 12).toISOString(), files: [{ path: "a.vb", applied: false }] });
    manifest("2026-11-21_1613", "{ broken");
    manifest("2026-11-21_1620", applied(new Date(2026, 10, 21, 16, 20)));
    expect(countAppliesSince(root, packAt)).toBe(2);
  });
});

describe("watchCommand の画面のコマンド", () => {
  let output: string[];
  beforeEach(() => {
    output = [];
    const capture = (chunk: unknown): boolean => {
      output.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const text = (): string => output.join("");
  async function waitFor(cond: () => boolean, label: string): Promise<void> {
    const until = Date.now() + 5000;
    while (!cond()) {
      if (Date.now() > until) throw new Error(`timeout: ${label}\n${text()}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  function setup(): { dir: string; downloads: string } {
    const dir = mkdtempSync(join(tmpdir(), "tazuna-watch-keys-"));
    const downloads = mkdtempSync(join(tmpdir(), "tazuna-watch-keys-dl-"));
    mkdirSync(join(dir, ".tazuna"), { recursive: true });
    writeFileSync(join(dir, ".tazuna", "config.json"), JSON.stringify({ downloadsDir: downloads, clipReportOnFailure: false }), "utf8");
    return { dir, downloads };
  }

  async function start(
    dir: string,
    seams: { pack?: (argv: string[]) => number; build?: (argv: string[]) => number; buildAvailable?: boolean },
  ): Promise<{ input: PassThrough; clipboard: string[]; stop: () => Promise<number> }> {
    const ac = new AbortController();
    const input = new PassThrough();
    const clipboard: string[] = [];
    const running = watchCommand(["--root", dir], {
      signal: ac.signal,
      intervalMs: 10,
      tidyDelayMs: 0,
      input,
      writeClipboard: (t) => {
        clipboard.push(t);
        return { ok: true };
      },
      ...seams,
    });
    await waitFor(() => text().includes("画面で 1 文字打って Enter"), "start");
    return {
      input,
      clipboard,
      stop: async () => {
        ac.abort();
        return running;
      },
    };
  }

  it("開始時にキーの一覧を出し、p でパックを作り、c でそのパックの貼るものをもう一度コピーする", async () => {
    const { dir } = setup();
    const calls: string[][] = [];
    const w = await start(dir, {
      buildAvailable: false,
      pack: (argv) => {
        calls.push(argv);
        writeFileSync(join(dir, "repomix-output.xml"), "﻿" + "x".repeat(130_000), "utf8");
        writeFileSync(join(dir, "repomix-output.prompt.md"), "﻿本文用テキスト", "utf8");
        return 0;
      },
    });
    expect(text()).toContain("p  パックを作る (この端末で tazuna pack と打つのと同じ");
    expect(text()).not.toContain("b  ビルドする");

    w.input.write("p\n");
    await waitFor(() => text().includes("✓ パックを作りました"), "packed");
    // --root 付きで始めた watch は、そのルートのパック
    expect(calls).toEqual([[dir, "--root", dir]]);
    expect(text()).toContain(`パックを作ります (tazuna pack "${dir}" --root "${dir}")`);
    expect(text()).toContain("引き続き待っています ― 打って Enter: p パックを作る / c 貼るものをもう一度コピー / h 一覧");

    w.input.write("c\n");
    await waitFor(() => w.clipboard.length === 1, "copied");
    // パックが貼付上限の目安を超えるので、本文用テキスト (tazuna pack がコピーするものと同じ)
    expect(w.clipboard).toEqual(["本文用テキスト"]);
    expect(text()).toContain("✓ 本文用テキスト (約 1K 文字) をクリップボードにコピーしました → repomix-output.xml を添付し");
    expect(await w.stop()).toBe(0);
  });

  it("パックの失敗・例外で監視を止めない。b はビルドを行い、適用の案内にもキーを添える", async () => {
    const { dir } = setup();
    let builds = 0;
    const w = await start(dir, {
      buildAvailable: true,
      pack: () => {
        throw new Error("こわれた設定");
      },
      build: () => {
        builds++;
        return 1;
      },
    });
    expect(text()).toContain("b  ビルドする (tazuna build と同じ");
    w.input.write("p\n");
    await waitFor(() => text().includes("✗ パックを作れませんでした"), "pack failed");
    expect(text()).toContain("tazuna: こわれた設定");
    w.input.write("b\n");
    await waitFor(() => text().includes("✗ ビルドできませんでした"), "build failed");
    expect(builds).toBe(1);
    expect(text()).toContain("b ビルド / h 一覧");
    expect(await w.stop()).toBe(0);
  });

  it("貼り付けた複数行には反応せず、コマンドでない行には一覧を出す", async () => {
    const { dir } = setup();
    let packs = 0;
    const w = await start(dir, {
      buildAvailable: false,
      pack: () => {
        packs++;
        return 0;
      },
    });
    w.input.write("Public Sub Main()\np\nc\nEnd Sub\n");
    await waitFor(() => text().includes("貼り付けとみなして何もしていません"), "pasted");
    w.input.write("x\n");
    await waitFor(() => text().includes("「x」はコマンドではありません"), "unknown");
    w.input.write("c\n");
    await waitFor(() => text().includes("前回のパック (repomix-output.xml) が見つかりません"), "no pack");
    expect(packs).toBe(0);
    expect(w.clipboard).toEqual([]);
    expect(await w.stop()).toBe(0);
  });
});

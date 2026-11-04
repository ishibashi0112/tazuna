import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeWatchResult, watchCommand } from "../src/commands/watch.ts";
import { hasChangesHeading } from "../src/core/parser.ts";
import { initialWatchState, observeWatch, type WatchedFile } from "../src/core/watch.ts";
import type { Manifest } from "../src/infra/history.ts";

const f = (path: string, mtimeMs: number, size = 10): WatchedFile => ({ path, mtimeMs, size });

describe("observeWatch (§4.7 新着検出)", () => {
  it("開始時に既にあるファイルは渡さない", () => {
    const state = initialWatchState([f("a.md", 1)]);
    expect(observeWatch(state, [f("a.md", 1)])).toEqual([]);
    expect(observeWatch(state, [f("a.md", 1)])).toEqual([]);
  });

  it("新着は同じ時刻・サイズを 2 回続けて観測してから 1 度だけ渡す", () => {
    const state = initialWatchState([]);
    expect(observeWatch(state, [f("b.md", 5, 3)])).toEqual([]);
    // 書き込み中 (サイズが伸びている) はまだ渡さない
    expect(observeWatch(state, [f("b.md", 6, 8)])).toEqual([]);
    expect(observeWatch(state, [f("b.md", 6, 8)])).toEqual([f("b.md", 6, 8)]);
    expect(observeWatch(state, [f("b.md", 6, 8)])).toEqual([]);
  });

  it("0 バイトのファイルは渡さない (Firefox が先に作る空ファイル)", () => {
    const state = initialWatchState([]);
    expect(observeWatch(state, [f("c.md", 1, 0)])).toEqual([]);
    expect(observeWatch(state, [f("c.md", 1, 0)])).toEqual([]);
    expect(observeWatch(state, [f("c.md", 2, 40)])).toEqual([]);
    expect(observeWatch(state, [f("c.md", 2, 40)])).toEqual([f("c.md", 2, 40)]);
  });

  it("渡したファイルは内容が変わったら、既存のファイルも更新されたら渡し直す", () => {
    const state = initialWatchState([f("old.md", 1)]);
    observeWatch(state, [f("old.md", 1), f("d.md", 2)]);
    expect(observeWatch(state, [f("old.md", 1), f("d.md", 2)])).toEqual([f("d.md", 2)]);
    observeWatch(state, [f("old.md", 9), f("d.md", 3)]);
    expect(observeWatch(state, [f("old.md", 9), f("d.md", 3)])).toEqual([f("d.md", 3), f("old.md", 9)]);
  });

  it("消えたファイルは忘れ、同じ名前で現れたら新着として扱う", () => {
    const state = initialWatchState([f("e.md", 1)]);
    expect(observeWatch(state, [])).toEqual([]);
    observeWatch(state, [f("e.md", 1)]);
    expect(observeWatch(state, [f("e.md", 1)])).toEqual([f("e.md", 1)]);
  });

  it("同時に届いたものは古い順に渡す", () => {
    const state = initialWatchState([]);
    const files = [f("new.md", 20), f("older.md", 10)];
    observeWatch(state, files);
    expect(observeWatch(state, files).map((x) => x.path)).toEqual(["older.md", "new.md"]);
  });
});

describe("hasChangesHeading", () => {
  it("## CHANGES と寛容パースのレベル違いを認め、変更履歴の見出しは認めない", () => {
    expect(hasChangesHeading("前置き\n## CHANGES\n")).toBe(true);
    expect(hasChangesHeading("### CHANGES\r\n")).toBe(true);
    expect(hasChangesHeading("# Changelog\n## [1.0.0]\n- CHANGES: 修正\n")).toBe(false);
  });
});

const CHANGES = [
  "## CHANGES",
  "",
  "カウンタの初期値を変更。",
  "",
  "### FILE: legacy.vb (replace)",
  "<<<<<<< SEARCH",
  "Dim count As Integer = 1",
  "=======",
  "Dim count As Integer = 100",
  ">>>>>>> REPLACE",
  "",
].join("\n");

const FAILING = CHANGES.replace("Dim count As Integer = 1\n", "Dim missing As Integer = 1\n");

describe("watchCommand (§4.7)", () => {
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

  function setup(): { dir: string; downloads: string } {
    const dir = mkdtempSync(join(tmpdir(), "tazuna-watch-"));
    const downloads = mkdtempSync(join(tmpdir(), "tazuna-watch-dl-"));
    writeFileSync(join(dir, "legacy.vb"), "Module M\nDim count As Integer = 1\nEnd Module\n", "utf8");
    mkdirSync(join(dir, ".tazuna"), { recursive: true });
    writeFileSync(
      join(dir, ".tazuna", "config.json"),
      JSON.stringify({ downloadsDir: downloads, clipReportOnFailure: false }),
      "utf8",
    );
    return { dir, downloads };
  }

  async function waitFor(cond: () => boolean, label: string): Promise<void> {
    const until = Date.now() + 5000;
    while (!cond()) {
      if (Date.now() > until) throw new Error(`timeout: ${label}\n${output.join("")}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** 監視を始め、開始時の一覧を取り終えるまで待つ */
  async function start(dir: string): Promise<{ stop: () => Promise<number> }> {
    const ac = new AbortController();
    const running = watchCommand(["--root", dir], { signal: ac.signal, intervalMs: 10 });
    await waitFor(() => output.join("").includes("到着を待っています"), "start");
    return {
      stop: async () => {
        ac.abort();
        return running;
      },
    };
  }

  const count = (needle: string): number => output.join("").split(needle).length - 1;

  it("届いた changes.md を確認なしで適用し、Downloads から履歴へ移動する", async () => {
    const { dir, downloads } = setup();
    const w = await start(dir);
    writeFileSync(join(downloads, "changes.md"), CHANGES, "utf8");
    await waitFor(() => !existsSync(join(downloads, "changes.md")), "applied");
    expect(await w.stop()).toBe(0);

    expect(readFileSync(join(dir, "legacy.vb"), "utf8")).toContain("Dim count As Integer = 100");
    const ids = readdirSync(join(dir, ".tazuna", "history"));
    expect(ids).toHaveLength(1);
    const manifest = JSON.parse(
      readFileSync(join(dir, ".tazuna", "history", ids[0] as string, "manifest.json"), "utf8"),
    ) as Manifest;
    expect(manifest.source).toEqual({ type: "downloads", path: join(downloads, "changes.md") });
    expect(output.join("")).toContain("監視を終了しました");
  });

  it("開始前からある changes.md は当てない", async () => {
    const { dir, downloads } = setup();
    writeFileSync(join(downloads, "changes.md"), CHANGES, "utf8");
    const w = await start(dir);
    await new Promise((r) => setTimeout(r, 100));
    expect(await w.stop()).toBe(0);
    expect(existsSync(join(downloads, "changes.md"))).toBe(true);
    expect(readFileSync(join(dir, "legacy.vb"), "utf8")).toContain("Dim count As Integer = 1\n");
    expect(output.join("")).toContain("既にある 1 件は対象外");
  });

  const unapplied = (dir: string): string[] => {
    const at = join(dir, ".tazuna", "unapplied");
    return existsSync(at) ? readdirSync(at) : [];
  };

  it("失敗した changes.md は 1 度だけレポートして unapplied/ へ移し、次に届いたものは適用する", async () => {
    const { dir, downloads } = setup();
    const w = await start(dir);
    writeFileSync(join(downloads, "changes.md"), FAILING, "utf8");
    await waitFor(() => count("検証に失敗しました") === 1 && output.join("").includes("引き続き待っています"), "failed");
    await new Promise((r) => setTimeout(r, 100));
    expect(count("検証に失敗しました")).toBe(1);
    expect(output.join("")).toContain("✗ 適用できませんでした");
    // Downloads に溜めない (次の返答も同じ名前で保存される)
    expect(existsSync(join(downloads, "changes.md"))).toBe(false);
    const moved = unapplied(dir);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}_changes\.md$/);
    expect(readFileSync(join(dir, ".tazuna", "unapplied", moved[0] as string), "utf8")).toBe(FAILING);

    writeFileSync(join(downloads, "changes.md"), CHANGES, "utf8");
    await waitFor(() => !existsSync(join(downloads, "changes.md")) && output.join("").includes("✓ 適用しました"), "applied");
    expect(await w.stop()).toBe(0);
    expect(readFileSync(join(dir, "legacy.vb"), "utf8")).toContain("Dim count As Integer = 100");
    expect(unapplied(dir)).toHaveLength(1);
  });

  it("プロジェクト直下の失敗した changes.md は動かさない (手で直して当て直せるように)", async () => {
    const { dir } = setup();
    const w = await start(dir);
    writeFileSync(join(dir, "changes.md"), FAILING, "utf8");
    await waitFor(() => output.join("").includes("引き続き待っています"), "failed");
    expect(await w.stop()).toBe(0);
    expect(existsSync(join(dir, "changes.md"))).toBe(true);
    expect(unapplied(dir)).toEqual([]);
  });

  it("すべて適用済みの changes.md は書かずに unapplied/ へ移す", async () => {
    const { dir, downloads } = setup();
    writeFileSync(join(dir, "legacy.vb"), "Module M\nDim count As Integer = 100\nEnd Module\n", "utf8");
    const w = await start(dir);
    writeFileSync(join(downloads, "changes.md"), CHANGES, "utf8");
    await waitFor(() => output.join("").includes("引き続き待っています"), "already");
    expect(await w.stop()).toBe(0);
    expect(output.join("")).toContain("すべて適用済みでした");
    expect(existsSync(join(downloads, "changes.md"))).toBe(false);
    expect(unapplied(dir)).toHaveLength(1);
    expect(existsSync(join(dir, ".tazuna", "history"))).toBe(false);
  });

  it("二重適用で止めたものは unapplied/ へ移し、当て直すコマンドを移した先のパスで示す", async () => {
    const { dir, downloads } = setup();
    const w = await start(dir);
    writeFileSync(join(downloads, "changes.md"), CHANGES, "utf8");
    await waitFor(() => output.join("").includes("✓ 適用しました"), "applied");
    // その後に手で戻した (git checkout 等) ところへ、同じ changes.md をもう一度ダウンロードした
    writeFileSync(join(dir, "legacy.vb"), "Module M\nDim count As Integer = 1\nEnd Module\n", "utf8");
    writeFileSync(join(downloads, "changes.md"), CHANGES, "utf8");
    await waitFor(() => output.join("").includes("当てずに止めました"), "duplicate");
    await waitFor(() => unapplied(dir).length === 1, "moved");
    expect(await w.stop()).toBe(0);
    expect(readFileSync(join(dir, "legacy.vb"), "utf8")).toContain("Dim count As Integer = 1\n");
    const movedPath = join(dir, ".tazuna", "unapplied", unapplied(dir)[0] as string);
    expect(output.join("")).toContain(`tazuna "${movedPath}" --force`);
    // 手で実行したとき向けの「--force を付けて再実行」は watch では出さない
    expect(output.join("")).not.toContain("再実行してください");
  });

  it("--dry-run は失敗した changes.md も動かさない", async () => {
    const { dir, downloads } = setup();
    const ac = new AbortController();
    const running = watchCommand(["--root", dir, "--dry-run"], { signal: ac.signal, intervalMs: 10 });
    await waitFor(() => output.join("").includes("到着を待っています"), "start");
    writeFileSync(join(downloads, "changes.md"), FAILING, "utf8");
    await waitFor(() => output.join("").includes("引き続き待っています"), "failed");
    ac.abort();
    expect(await running).toBe(0);
    expect(existsSync(join(downloads, "changes.md"))).toBe(true);
    expect(unapplied(dir)).toEqual([]);
  });

  const hasGit = spawnSync("git", ["--version"]).status === 0;
  const gitInit = (dir: string): void => {
    spawnSync("git", ["init", "-q", "."], { cwd: dir });
  };
  /** 別のリポジトリ (OrderForm.vb を持つ) のチャットの changes.md */
  const OTHER_REPO = [
    "## CHANGES",
    "",
    "受注画面の初期値を変更。",
    "",
    "### FILE: src/Orders/OrderForm.vb (replace)",
    "<<<<<<< SEARCH",
    "Dim a As Integer = 1",
    "=======",
    "Dim a As Integer = 2",
    ">>>>>>> REPLACE",
    "",
  ].join("\n");

  it.skipIf(!hasGit)("別のリポジトリ向けらしい changes.md は当てず、レポートも出さずに Downloads に残す", async () => {
    const { dir, downloads } = setup();
    gitInit(dir);
    const w = await start(dir);
    writeFileSync(join(downloads, "changes.md"), OTHER_REPO, "utf8");
    await waitFor(() => output.join("").includes("引き続き待っています"), "other-repo");
    expect(await w.stop()).toBe(0);
    const text = output.join("");
    expect(text).toContain("別のリポジトリ向けの changes.md のようです");
    expect(text).not.toContain("検証に失敗しました");
    expect(text).toContain(`tazuna "${join(downloads, "changes.md")}"`);
    expect(existsSync(join(downloads, "changes.md"))).toBe(true);
    expect(unapplied(dir)).toEqual([]);
  });

  it.skipIf(!hasGit)("同じ名前のファイルがリポジトリにあれば (フォルダの書き違い)、従来どおり失敗レポートを出す", async () => {
    const { dir, downloads } = setup();
    gitInit(dir);
    mkdirSync(join(dir, "src", "Order"), { recursive: true });
    writeFileSync(join(dir, "src", "Order", "OrderForm.vb"), "Dim a As Integer = 1\n", "utf8");
    const w = await start(dir);
    writeFileSync(join(downloads, "changes.md"), OTHER_REPO, "utf8");
    await waitFor(() => output.join("").includes("引き続き待っています"), "failed");
    expect(await w.stop()).toBe(0);
    expect(output.join("")).toContain("検証に失敗しました");
    expect(output.join("")).not.toContain("別のリポジトリ向け");
    expect(unapplied(dir)).toHaveLength(1);
  });

  it("プロジェクト直下の CHANGES.md (変更履歴) は当てない", async () => {
    const { dir } = setup();
    const w = await start(dir);
    writeFileSync(join(dir, "CHANGES.md"), "# Changelog\n\n## 1.0.0\n- 初版\n", "utf8");
    await waitFor(() => output.join("").includes("見出しがないため"), "skipped");
    expect(await w.stop()).toBe(0);
    expect(existsSync(join(dir, "CHANGES.md"))).toBe(true);
    expect(existsSync(join(dir, ".tazuna", "history"))).toBe(false);
  });
});

describe("describeWatchResult (§4.7 結果の知らせ方)", () => {
  const file = { path: "/dl/changes (1).md", movedTo: null, moveError: null };

  it("失敗はレポートを貼るよう促し、コピーできなかったときはそう書く", () => {
    const copied = describeWatchResult({ kind: "failed", files: 0, reportCopied: true }, file);
    expect(copied.headline).toContain("クリップボードにコピー済み");
    expect(copied.title).toContain("失敗");
    const notCopied = describeWatchResult({ kind: "failed", files: 0, reportCopied: false }, file);
    expect(notCopied.headline).not.toContain("コピー済み");
  });

  it("移せなかったときは元の場所に残っていると書く", () => {
    const r = describeWatchResult(
      { kind: "already-applied", files: 0, reportCopied: false },
      { ...file, moveError: "EBUSY" },
    );
    expect(r.details.join("\n")).toContain("/dl/changes (1).md に残っています");
  });

  it("適用はファイル数をタイトルに入れる", () => {
    expect(describeWatchResult({ kind: "applied", files: 3, reportCopied: false }, file).title).toBe("✓ 適用 3 ファイル");
  });
});

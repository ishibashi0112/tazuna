/**
 * tazuna watch の画面で打ったコマンドを読む (1 文字 + Enter。解釈は core/watch-keys.ts)。
 *
 * readline を terminal: false で使い、端末の行入力 (Windows のコンソールの行編集・エコー、Unix の canonical モード) に
 * 任せる。raw モードにしないので Ctrl+C はこれまでどおり SIGINT になり、Git Bash (mintty) のように標準入力が
 * パイプの端末でも同じに動く。短い間隔でまとめて届いた行は 1 回の入力として渡す (画面への貼り付けを見分けるため)。
 */
import { createInterface } from "node:readline";
import { interpretWatchInput, type WatchInput } from "../core/watch-keys.ts";

/** 貼り付けを 1 回の入力とみなす間隔 (ミリ秒)。人が打つ Enter の間隔より十分短く、貼り付けの行の間隔より長い */
const BURST_MS = 50;

export interface WatchInputListener {
  /** 読むのをやめる (watch の終了時。プロセスが標準入力を待って終わらなくならないように) */
  close(): void;
}

export function listenWatchInput(
  input: NodeJS.ReadableStream,
  onInput: (input: WatchInput) => void,
  burstMs: number = BURST_MS,
): WatchInputListener {
  const rl = createInterface({ input, terminal: false, crlfDelay: Infinity });
  let pending: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    timer = undefined;
    const lines = pending;
    pending = [];
    onInput(interpretWatchInput(lines));
  };
  rl.on("line", (line) => {
    pending.push(line);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, burstMs);
  });
  // 標準入力が閉じても (パイプの終わり・/dev/null) watch は続ける。コマンドが打てなくなるだけ
  rl.on("close", () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      flush();
    }
  });
  return {
    close: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = [];
      rl.removeAllListeners("line");
      rl.removeAllListeners("close");
      rl.close();
    },
  };
}

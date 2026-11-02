/**
 * WinForms Designer.vb / Designer.cs の要約(UI サマリー)。
 *
 * デザイナー自動生成コード(InitializeComponent)を軽量解析し、
 * 「どんなコントロールが何という名前で存在し、表示テキストは何か、
 * どのコンテナの中にあるか」だけを抽出する。座標・サイズ・フォント等の
 * レイアウト詳細は捨てる。AI へ渡す出力のトークン量を抑えつつ、
 * 本体コード(Me.btnSave 等)の理解に必要な情報を残すのが目的。
 *
 * VB の完全な構文解析は行わない(行単位の正規表現マッチ)。
 * 解析できない行は無視する。要約である以上、取りこぼしは許容し、
 * 原文が必要な場合は Designer 原文を含めるオプション側で対応する。
 *
 * C# の Designer.cs(tazuna 0.17.0〜。parseDesignerCs)も同じ形で要約する。`this.` の有無(.NET 6 以降の
 * デザイナーは付けない)と、型名を前に書く宣言の違いだけを吸収する。C# はイベントの結び付け
 * (`this.btnSave.Click += new System.EventHandler(this.btnSave_Click);`)が Designer.cs にあり、
 * VB の Handles 句のように本体のコードからは見えないため、イベントとハンドラー名も要約に入れる。
 */

/** 抽出したコントロール 1 件(children は Controls.Add 等による入れ子) */
export interface DesignerControl {
  name: string;
  /** 表示用の型名(System.Windows.Forms. 前置は短縮済み) */
  typeName: string;
  /** Text プロパティの文字列リテラル(リテラル以外は取得しない) */
  text?: string | undefined;
  /** Designer で結び付けたイベント(C# の +=)。出現順 */
  events?: DesignerEvent[] | undefined;
  children: DesignerControl[];
}

/** イベントとハンドラー(Click → btnSave_Click) */
export interface DesignerEvent {
  event: string;
  handler: string;
}

export interface DesignerSummary {
  /** Partial Class 名(見つからなければ undefined) */
  className?: string | undefined;
  /** フォーム自身の Text(タイトルバー文字列) */
  formText?: string | undefined;
  /** フォーム直下(または親を特定できなかった)コントロール。宣言順 */
  rootControls: DesignerControl[];
  /** フォーム自身のイベント(C# の this.Load += ...)。出現順 */
  formEvents?: DesignerEvent[] | undefined;
  /** 宣言から抽出したコントロール総数 */
  controlCount: number;
}

/** メンバー宣言: Friend WithEvents btnSave As System.Windows.Forms.Button */
const DECLARATION =
  /^\s*(?:Friend|Public|Private|Protected)(?:\s+Friend)?\s+(?:Shadows\s+)?(?:WithEvents\s+)?([A-Za-z_]\w*)\s+As\s+([A-Za-z_][\w.]*)\s*(?:'.*)?$/;

/** コントロールの Text 代入: Me.btnSave.Text = "保存" */
const CONTROL_TEXT =
  /^\s*Me\.([A-Za-z_]\w*)\.Text\s*=\s*"((?:[^"]|"")*)"/;

/** フォーム自身の Text 代入: Me.Text = "受注入力" */
const FORM_TEXT = /^\s*Me\.Text\s*=\s*"((?:[^"]|"")*)"/;

/** 入れ子: Me.pnlHeader.Controls.Add(Me.lblCustomer) / Me.Controls.Add(...) */
const CONTROLS_ADD =
  /\bMe(?:\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*))?\.Controls\.Add\(Me\.([A-Za-z_]\w*)\)/;

/**
 * 一括追加: Me.mnuMain.Items.AddRange(New ... {Me.mnuFile, Me.mnuEdit})
 * Controls(VS2003 世代) / Items / DropDownItems(メニュー・ツールバー)を対象
 */
const ADD_RANGE =
  /\bMe(?:\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*))?\.(?:Controls|Items|DropDownItems)\.AddRange\([^{]*\{([^}]*)\}/;

/** Partial Class OrderForm(属性行・コメント行は対象外) */
const CLASS_NAME = /\bClass\s+([A-Za-z_]\w*)/;

/** 宣言から除外する型(コンポーネント管理用のインフラ) */
function isInfrastructureType(typeName: string): boolean {
  return typeName.startsWith("System.ComponentModel.");
}

function shortenTypeName(typeName: string): string {
  const prefix = "System.Windows.Forms.";
  return typeName.startsWith(prefix) ? typeName.slice(prefix.length) : typeName;
}

function unescapeVbString(literal: string): string {
  return literal.replace(/""/g, '"');
}

/**
 * Designer.vb のソースを要約する。
 * コントロール宣言が 1 件も見つからなければ controlCount = 0 を返す
 * (呼び出し側はその場合サマリーを出力しない)。
 */
export function parseDesignerVb(source: string): DesignerSummary {
  // VB の行継続(` _`)を結合してから行単位で処理する(VS2003 世代の
  // 複数行 AddRange 対策)
  const joined = source.replace(/[ \t]_\r?\n[ \t]*/g, " ");
  const lines = joined.split(/\r?\n/);

  let className: string | undefined;
  let formText: string | undefined;
  const declared = new Map<string, { typeName: string; text?: string }>();
  /** 子コントロール名 → 親コントロール名(undefined = フォーム直下と判明) */
  const parentOf = new Map<string, string | undefined>();

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("'")) {
      continue;
    }
    if (className === undefined && !trimmed.startsWith("<")) {
      const classMatch = CLASS_NAME.exec(line);
      if (classMatch !== null) {
        className = classMatch[1] ?? "";
      }
    }
    const declaration = DECLARATION.exec(line);
    if (declaration !== null) {
      const name = declaration[1] ?? "";
      const typeName = declaration[2] ?? "";
      if (name !== "components" && !isInfrastructureType(typeName)) {
        declared.set(name, { typeName: shortenTypeName(typeName) });
      }
      continue;
    }
    const controlText = CONTROL_TEXT.exec(line);
    if (controlText !== null) {
      const entry = declared.get(controlText[1] ?? "");
      if (entry !== undefined && entry.text === undefined) {
        entry.text = unescapeVbString(controlText[2] ?? "");
      }
      continue;
    }
    const formTextMatch = FORM_TEXT.exec(line);
    if (formTextMatch !== null && formText === undefined) {
      formText = unescapeVbString(formTextMatch[1] ?? "");
      continue;
    }
    const add = CONTROLS_ADD.exec(line);
    if (add !== null) {
      recordParent(parentOf, declared, add[1] ?? "", [add[2] ?? ""]);
      continue;
    }
    const addRange = ADD_RANGE.exec(line);
    if (addRange !== null) {
      const children = [...(addRange[2] ?? "").matchAll(/Me\.([A-Za-z_]\w*)/g)].map(
        (m) => m[1] ?? "",
      );
      recordParent(parentOf, declared, addRange[1] ?? "", children);
    }
  }

  // 宣言順にノードを作り、親が特定できたものだけ入れ子にする
  const nodes = new Map<string, DesignerControl>();
  for (const [name, entry] of declared) {
    const node: DesignerControl = { name, typeName: entry.typeName, children: [] };
    if (entry.text !== undefined) {
      node.text = entry.text;
    }
    nodes.set(name, node);
  }
  const rootControls: DesignerControl[] = [];
  for (const [name, node] of nodes) {
    const parentName = parentOf.get(name);
    const parent = parentName === undefined ? undefined : nodes.get(parentName);
    if (parent !== undefined && parent !== node) {
      parent.children.push(node);
    } else {
      rootControls.push(node);
    }
  }

  const summary: DesignerSummary = {
    rootControls,
    controlCount: declared.size,
  };
  if (className !== undefined) {
    summary.className = className;
  }
  if (formText !== undefined) {
    summary.formText = formText;
  }
  return summary;
}

/**
 * 親チェーン(例: "pnlHeader" / "SplitContainer1.Panel1" / undefined=フォーム直下)
 * を宣言済みコントロール名へ解決して記録する。既に親が付いた子は上書きしない
 */
function recordParent(
  parentOf: Map<string, string | undefined>,
  declared: Map<string, { typeName: string }>,
  parentChain: string | undefined,
  children: string[],
): void {
  let parentName: string | undefined;
  if (parentChain !== undefined) {
    if (declared.has(parentChain)) {
      parentName = parentChain;
    } else {
      // SplitContainer1.Panel1 のような内部パネルは先頭要素へ寄せる
      const firstSegment = parentChain.split(".")[0] ?? "";
      parentName = declared.has(firstSegment) ? firstSegment : undefined;
    }
  }
  for (const child of children) {
    if (!parentOf.has(child) && child !== parentName) {
      parentOf.set(child, parentName);
    }
  }
}

/** サマリーを「- name: Type — Text "..."」のインデント付き行にする */
export function renderDesignerControlLines(
  controls: readonly DesignerControl[],
  depth = 0,
  lines: string[] = [],
): string[] {
  for (const control of controls) {
    const textPart = control.text === undefined ? "" : ` — Text "${control.text}"`;
    const eventsPart =
      control.events === undefined || control.events.length === 0 ? "" : ` — イベント ${formatDesignerEvents(control.events)}`;
    lines.push(`${"  ".repeat(depth)}- ${control.name}: ${control.typeName}${textPart}${eventsPart}`);
    renderDesignerControlLines(control.children, depth + 1, lines);
  }
  return lines;
}

/** イベントの一覧を「Click → btnSave_Click, Enter → txt_Enter」の形にする */
export function formatDesignerEvents(events: readonly DesignerEvent[]): string {
  return events.map((e) => `${e.event} → ${e.handler}`).join(", ");
}

// ---------------------------------------------------------------------------
// C# の Designer.cs(tazuna 0.17.0〜)
// ---------------------------------------------------------------------------

/** フィールド宣言: private System.Windows.Forms.Button btnSave; / private Button btnSave; */
const CS_DECLARATION =
  /^\s*(?:(?:private|internal|public|protected)\s+)+(?:readonly\s+)?([A-Za-z_][\w.]*(?:<[\w.,\s<>]*>)?)\s+([A-Za-z_]\w*)\s*(?:=\s*null\s*)?;/;

/** C# の文字列リテラル("..." のエスケープ付き、または @"..." の逐語的文字列) */
const CS_STRING = String.raw`(?:"((?:[^"\\]|\\.)*)"|@"((?:[^"]|"")*)")`;

/** コントロールの Text 代入: this.btnSave.Text = "保存"; / btnSave.Text = "保存"; */
const CS_CONTROL_TEXT = new RegExp(String.raw`^\s*(?:this\.)?([A-Za-z_]\w*)\.Text\s*=\s*${CS_STRING}\s*;`);

/** フォーム自身の Text 代入: this.Text = "受注入力"; / Text = "受注入力"; */
const CS_FORM_TEXT = new RegExp(String.raw`^\s*(?:this\.)?Text\s*=\s*${CS_STRING}\s*;`);

/** 入れ子: this.pnlHeader.Controls.Add(this.lblCustomer); / Controls.Add(btnSave); */
const CS_CONTROLS_ADD =
  /^\s*(?:this\.)?(?:([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*?)\.)?Controls\.Add\(\s*(?:this\.)?([A-Za-z_]\w*)\s*\)\s*;/;

/** 一括追加: this.mnuMain.Items.AddRange(new ToolStripItem[] { this.mnuFile, this.mnuEdit }); */
const CS_ADD_RANGE =
  /^\s*(?:this\.)?(?:([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*?)\.)?(?:Controls|Items|DropDownItems)\.AddRange\([^{]*\{([^}]*)\}/;

/**
 * イベントの結び付け: this.btnSave.Click += new System.EventHandler(this.btnSave_Click);
 * / btnSave.Click += btnSave_Click; / this.Load += new System.EventHandler(this.OrderForm_Load);
 */
const CS_EVENT =
  /^\s*(?:this\.)?(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\s*\+=\s*(?:new\s+[A-Za-z_][\w.<>]*\s*\(\s*)?(?:this\.)?([A-Za-z_]\w*)\s*\)?\s*;/;

/** partial class OrderForm */
const CS_CLASS_NAME = /\bclass\s+([A-Za-z_]\w*)/;

function unescapeCsString(regular: string | undefined, verbatim: string | undefined): string {
  if (verbatim !== undefined) {
    return verbatim.replace(/""/g, '"');
  }
  return (regular ?? "").replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
    if (c.length === 5) {
      return String.fromCharCode(Number.parseInt(c.slice(1), 16));
    }
    switch (c) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "0":
        return "\0";
      default:
        return c;
    }
  });
}

/**
 * 文字列・文字リテラルの外の ( と ) の数の差(複数行にまたがる AddRange をつなぐため)。
 * // のコメントは数えない
 */
function parenDepthDelta(line: string): number {
  let depth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "/" && line[i + 1] === "/") {
      break;
    }
    if (c === "@" && line[i + 1] === '"') {
      i += 2;
      while (i < line.length && !(line[i] === '"' && line[i + 1] !== '"')) {
        i += line[i] === '"' ? 2 : 1;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < line.length && line[i] !== c) {
        i += line[i] === "\\" ? 2 : 1;
      }
      continue;
    }
    if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
    }
  }
  return depth;
}

/** 括弧が閉じるまでの行を 1 行につなぐ(VS は AddRange の要素を 1 つずつ改行して書く) */
function joinCsStatements(source: string): string[] {
  const out: string[] = [];
  let pending: string | undefined;
  let depth = 0;
  for (const raw of source.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (pending === undefined) {
      if (trimmed.startsWith("//")) {
        continue;
      }
      depth = parenDepthDelta(raw);
      if (depth > 0) {
        pending = raw;
      } else {
        out.push(raw);
      }
      continue;
    }
    if (trimmed.startsWith("//")) {
      continue;
    }
    pending += ` ${trimmed}`;
    depth += parenDepthDelta(raw);
    if (depth <= 0) {
      out.push(pending);
      pending = undefined;
    }
  }
  if (pending !== undefined) {
    out.push(pending);
  }
  return out;
}

/**
 * Designer.cs のソースを要約する(parseDesignerVb と同じ形)。
 * コントロールのフィールド宣言が 1 件も見つからなければ controlCount = 0 を返す
 */
export function parseDesignerCs(source: string): DesignerSummary {
  let className: string | undefined;
  let formText: string | undefined;
  const declared = new Map<string, { typeName: string; text?: string; events: DesignerEvent[] }>();
  const parentOf = new Map<string, string | undefined>();
  const formEvents: DesignerEvent[] = [];
  /** 宣言より前に出てくる Text・イベント(C# はフィールド宣言がファイルの末尾にある) */
  const texts = new Map<string, string>();
  const events: { control: string | undefined; event: DesignerEvent }[] = [];

  for (const line of joinCsStatements(source)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("[") || trimmed.startsWith("#")) {
      continue;
    }
    if (className === undefined) {
      const classMatch = CS_CLASS_NAME.exec(line);
      if (classMatch !== null && !/^\s*\/\//.test(line)) {
        className = classMatch[1] ?? "";
      }
    }
    const declaration = CS_DECLARATION.exec(line);
    if (declaration !== null) {
      const typeName = declaration[1] ?? "";
      const name = declaration[2] ?? "";
      if (name !== "components" && !isInfrastructureType(typeName)) {
        declared.set(name, { typeName: shortenTypeName(typeName), events: [] });
      }
      continue;
    }
    // this.Text(フォーム自身)を先に見る(CS_CONTROL_TEXT は this をコントロール名として読めてしまう)
    const formTextMatch = CS_FORM_TEXT.exec(line);
    if (formTextMatch !== null) {
      if (formText === undefined) {
        formText = unescapeCsString(formTextMatch[1], formTextMatch[2]);
      }
      continue;
    }
    const controlText = CS_CONTROL_TEXT.exec(line);
    if (controlText !== null) {
      const name = controlText[1] ?? "";
      if (name !== "this" && !texts.has(name)) {
        texts.set(name, unescapeCsString(controlText[2], controlText[3]));
      }
      continue;
    }
    const add = CS_CONTROLS_ADD.exec(line);
    if (add !== null) {
      const parent = add[1] === "this" ? undefined : add[1];
      recordParentLater(parentOf, parent, [add[2] ?? ""]);
      continue;
    }
    const addRange = CS_ADD_RANGE.exec(line);
    if (addRange !== null) {
      const parent = addRange[1] === "this" ? undefined : addRange[1];
      const children = (addRange[2] ?? "")
        .split(",")
        .map((part) => part.trim().replace(/^this\./, ""))
        .filter((part) => /^[A-Za-z_]\w*$/.test(part));
      recordParentLater(parentOf, parent, children);
      continue;
    }
    const event = CS_EVENT.exec(line);
    if (event !== null) {
      events.push({
        control: event[1] === "this" ? undefined : event[1],
        event: { event: event[2] ?? "", handler: event[3] ?? "" },
      });
    }
  }

  for (const [name, text] of texts) {
    const entry = declared.get(name);
    if (entry !== undefined && entry.text === undefined) {
      entry.text = text;
    }
  }
  for (const { control, event } of events) {
    if (control === undefined) {
      formEvents.push(event);
      continue;
    }
    declared.get(control)?.events.push(event);
  }
  // 親の名前を宣言済みのコントロールへ解決する(SplitContainer1.Panel1 は先頭の要素へ寄せる)
  const resolvedParentOf = new Map<string, string | undefined>();
  for (const [child, chain] of parentOf) {
    let parentName: string | undefined;
    if (chain !== undefined) {
      if (declared.has(chain)) {
        parentName = chain;
      } else {
        const firstSegment = chain.split(".")[0] ?? "";
        parentName = declared.has(firstSegment) ? firstSegment : undefined;
      }
    }
    if (child !== parentName) {
      resolvedParentOf.set(child, parentName);
    }
  }

  const nodes = new Map<string, DesignerControl>();
  for (const [name, entry] of declared) {
    const node: DesignerControl = { name, typeName: entry.typeName, children: [] };
    if (entry.text !== undefined) {
      node.text = entry.text;
    }
    if (entry.events.length > 0) {
      node.events = entry.events;
    }
    nodes.set(name, node);
  }
  const rootControls: DesignerControl[] = [];
  for (const [name, node] of nodes) {
    const parentName = resolvedParentOf.get(name);
    const parent = parentName === undefined ? undefined : nodes.get(parentName);
    if (parent !== undefined && parent !== node) {
      parent.children.push(node);
    } else {
      rootControls.push(node);
    }
  }

  const summary: DesignerSummary = { rootControls, controlCount: declared.size };
  if (className !== undefined) {
    summary.className = className;
  }
  if (formText !== undefined) {
    summary.formText = formText;
  }
  if (formEvents.length > 0) {
    summary.formEvents = formEvents;
  }
  return summary;
}

/** 親の候補を記録する(C# は宣言が後ろにあるため、名前の解決は最後に行う)。既に親が付いた子は上書きしない */
function recordParentLater(
  parentOf: Map<string, string | undefined>,
  parentChain: string | undefined,
  children: string[],
): void {
  for (const child of children) {
    if (!parentOf.has(child)) {
      parentOf.set(child, parentChain);
    }
  }
}

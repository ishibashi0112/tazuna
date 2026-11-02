/**
 * .vbproj のビルド環境の読み取り(vbprojParser の environment)と <environment> の描画
 * (services/environmentSummary.ts)の単体テスト。手順文 v10。
 */

import { suite, test } from "vitest";
import * as assert from "node:assert";
import { renderEnvironmentBlock } from "../../src/pack/services/environmentSummary.ts";
import type { ProjectEnvironment } from "../../src/pack/types.ts";
import { parseVbproj } from "../../src/pack/vbprojParser.ts";

const NO_FILES = { fileExists: () => true, listFilesRecursive: () => [] };

function environmentOf(xml: string): ProjectEnvironment {
  const result = parseVbproj(xml, "/repo/App/App.vbproj", NO_FILES);
  assert.ok(result.environment !== undefined);
  return result.environment;
}

const LEGACY_VS2013 = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="12.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <RootNamespace>SalesApp</RootNamespace>
    <TargetFrameworkVersion>v4.5</TargetFrameworkVersion>
  </PropertyGroup>
  <PropertyGroup Condition=" '$(Configuration)|$(Platform)' == 'Debug|AnyCPU' ">
    <OutputPath>bin\\Debug\\</OutputPath>
  </PropertyGroup>
  <PropertyGroup>
    <OptionExplicit>On</OptionExplicit>
  </PropertyGroup>
  <PropertyGroup>
    <OptionCompare>Binary</OptionCompare>
  </PropertyGroup>
  <PropertyGroup>
    <OptionStrict>Off</OptionStrict>
  </PropertyGroup>
  <PropertyGroup>
    <OptionInfer>On</OptionInfer>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="System" />
    <Reference Include="FarPoint.Win.Spread, Version=8.0.3505.2008, Culture=neutral, PublicKeyToken=327c3516b1b18457, processorArchitecture=MSIL">
      <HintPath>..\\lib\\FarPoint.Win.Spread.dll</HintPath>
    </Reference>
    <Reference Include="system" />
  </ItemGroup>
  <ItemGroup>
    <Import Include="Microsoft.VisualBasic" />
    <Import Include="System.Data" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="..\\Common\\Common.vbproj">
      <Project>{11111111-2222-3333-4444-555555555555}</Project>
      <Name>CommonLib</Name>
    </ProjectReference>
    <ProjectReference Include="..\\Util\\Util.vbproj" />
    <COMReference Include="Excel" />
  </ItemGroup>
  <ItemGroup>
    <Compile Include="Form1.vb" />
  </ItemGroup>
</Project>
`;

suite("vbprojParser: ビルド環境(environment)", () => {
  test("旧スタイル: ToolsVersion・TargetFrameworkVersion・Option・ルート名前空間・Imports・参照", () => {
    const environment = environmentOf(LEGACY_VS2013);
    assert.deepStrictEqual(environment, {
      toolsVersion: "12.0",
      targetFrameworks: ["v4.5"],
      langVersions: [],
      optionStrict: ["Off"],
      optionExplicit: ["On"],
      optionInfer: ["On"],
      optionCompare: ["Binary"],
      nullable: [],
      implicitUsings: [],
      rootNamespaces: ["SalesApp"],
      imports: ["Microsoft.VisualBasic", "System.Data"],
      references: [
        "System",
        "FarPoint.Win.Spread 8.0.3505.2008",
        "CommonLib(プロジェクト参照)",
        "Util(プロジェクト参照)",
        "Excel(COM)",
      ],
    });
  });

  test("参照の HintPath・PublicKeyToken は載せない(厳密名は名前と版だけ)", () => {
    const text = JSON.stringify(environmentOf(LEGACY_VS2013));
    assert.ok(!text.includes("HintPath"));
    assert.ok(!text.includes("lib"));
    assert.ok(!text.includes("327c3516b1b18457"));
  });

  test("Condition 付きの PropertyGroup で分かれた値は出現順にすべて残す(重複は 1 つ)", () => {
    const environment = environmentOf(`<Project ToolsVersion="14.0">
  <PropertyGroup Condition=" '$(Configuration)' == 'Debug' "><LangVersion>14</LangVersion></PropertyGroup>
  <PropertyGroup Condition=" '$(Configuration)' == 'Release' "><LangVersion>12</LangVersion></PropertyGroup>
  <PropertyGroup Condition=" '$(Configuration)' == 'Test' "><LangVersion>14</LangVersion></PropertyGroup>
</Project>`);
    assert.deepStrictEqual(environment.langVersions, ["14", "12"]);
  });

  test("SDK スタイル: TargetFrameworks を ; で分け、PackageReference の版は属性でも子要素でも読む", () => {
    const environment = environmentOf(`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net48;net8.0-windows</TargetFrameworks>
    <LangVersion>latest</LangVersion>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Dapper" Version="2.1.35" />
    <PackageReference Include="NLog"><Version>5.3.4</Version></PackageReference>
    <PackageReference Include="Serilog" />
  </ItemGroup>
</Project>`);
    assert.strictEqual(environment.toolsVersion, undefined);
    assert.deepStrictEqual(environment.targetFrameworks, ["net48", "net8.0-windows"]);
    assert.deepStrictEqual(environment.langVersions, ["latest"]);
    assert.deepStrictEqual(environment.references, ["Dapper 2.1.35(NuGet)", "NLog 5.3.4(NuGet)", "Serilog(NuGet)"]);
  });

  test("XML として読めなければ environment は無い", () => {
    const result = parseVbproj("<Project", "/repo/App/App.vbproj", NO_FILES);
    assert.strictEqual(result.environment, undefined);
  });
});

function render(xml: string, style: "legacy" | "sdk" = "legacy"): string {
  const block = renderEnvironmentBlock([
    { label: "App", projectPath: "App/App.vbproj", style, environment: environmentOf(xml) },
  ]);
  assert.ok(block !== undefined);
  return block;
}

suite("environmentSummary: <environment> の描画", () => {
  test("VS2013 形式: Visual Basic 12.0 とみなしたことを書き、14.0 以降の構文を使えないと挙げる", () => {
    const block = render(LEGACY_VS2013);
    assert.ok(block.startsWith("<environment>\n.vbproj から読み取ったビルド環境"));
    assert.ok(block.endsWith("\n</environment>"));
    for (const line of [
      "- App(App/App.vbproj)",
      "  - 形式: 旧スタイル(ToolsVersion 12.0)",
      "  - Visual Basic: 12.0 まで(LangVersion の指定なし。ToolsVersion 12.0 は Visual Studio 2013 の形式のため、Visual Studio 2013 の既定の Visual Basic 12.0 とみなす)。14.0 以降の文字列補間 $\"...\"・NameOf・Null 条件演算子 ?.・複数行の文字列リテラル・ReadOnly 自動実装プロパティ、15.0 以降のタプル・2 進数リテラル &B は使えない",
      "  - .NET Framework: v4.5",
      "  - Option: Strict Off / Explicit On / Infer On / Compare Binary(ファイル先頭の Option 文があればそちらが優先)",
      "  - ルート名前空間: SalesApp(ファイルに Namespace を書かなくても、この名前空間に入る)",
      "  - プロジェクト全体の Imports: Microsoft.VisualBasic, System.Data",
      "  - 参照: System, FarPoint.Win.Spread 8.0.3505.2008, CommonLib(プロジェクト参照), Util(プロジェクト参照), Excel(COM)",
    ]) {
      assert.ok(block.split("\n").includes(line), `行がありません: ${line}`);
    }
  });

  test("ToolsVersion 4.0 は古い方の VS2010(Visual Basic 10.0)とみなし、Async / Await も使えないと挙げる", () => {
    const block = render(`<Project ToolsVersion="4.0"><PropertyGroup><TargetFrameworkVersion>v4.0</TargetFrameworkVersion></PropertyGroup></Project>`);
    assert.ok(block.includes("Visual Basic: 10.0 まで(LangVersion の指定なし。ToolsVersion 4.0 は Visual Studio 2010 / 2012 の形式のため、古い方の Visual Studio 2010 の既定の Visual Basic 10.0 とみなす)。11.0 以降の Async / Await"));
  });

  test("LangVersion の指定はそちらを使い、構成で分かれれば低い方に合わせる", () => {
    const block = render(`<Project ToolsVersion="15.0">
  <PropertyGroup Condition="a"><LangVersion>15</LangVersion></PropertyGroup>
  <PropertyGroup Condition="b"><LangVersion>14</LangVersion></PropertyGroup>
</Project>`);
    assert.ok(block.includes("Visual Basic: 14.0 まで(LangVersion の指定: 15 / 14。低い方に合わせる)。15.0 以降のタプル・2 進数リテラル &B は使えない"));
  });

  test("LangVersion が 15.0 以上・latest なら使えない構文を挙げない", () => {
    assert.ok(render(`<Project><PropertyGroup><LangVersion>16.9</LangVersion></PropertyGroup></Project>`).includes("Visual Basic: 16.9 まで(LangVersion の指定: 16.9)\n"));
    assert.ok(render(`<Project><PropertyGroup><LangVersion>Latest</LangVersion></PropertyGroup></Project>`).includes("Visual Basic: Latest(LangVersion の指定)\n"));
  });

  test("SDK スタイルで LangVersion が無ければ SDK の既定と書き、上限は書かない", () => {
    const block = render(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup></Project>`, "sdk");
    assert.ok(block.includes("  - 形式: SDK スタイル\n"));
    assert.ok(block.includes("  - Visual Basic: SDK の既定(LangVersion の指定なし。SDK スタイルは Visual Studio 2017 以降の形式)\n"));
    assert.ok(block.includes("  - ターゲット フレームワーク: net48\n"));
    assert.ok(!block.includes("使えない"));
  });

  test("知らない ToolsVersion・指定なしは不明と書き、推測しない", () => {
    assert.ok(render(`<Project ToolsVersion="99.0"><PropertyGroup /></Project>`).includes("Visual Basic: 不明(ToolsVersion 99.0・LangVersion の指定なし)"));
    assert.ok(render(`<Project><PropertyGroup><OutputType>WinExe</OutputType></PropertyGroup></Project>`).includes("Visual Basic: 不明(ToolsVersion・LangVersion の指定なし)"));
  });

  test("指定の無い Option・Imports・参照の行は出さない", () => {
    const block = render(`<Project ToolsVersion="12.0"></Project>`);
    assert.ok(!block.includes("Option:"));
    assert.ok(!block.includes("Imports"));
    assert.ok(!block.includes("参照:"));
    assert.ok(!block.includes("ルート名前空間"));
  });

  test("参照が多ければ 40 件で切って件数を書く", () => {
    const references = Array.from({ length: 45 }, (_, i) => `<Reference Include="Lib${i}" />`).join("");
    const block = render(`<Project ToolsVersion="12.0"><ItemGroup>${references}</ItemGroup></Project>`);
    assert.ok(block.includes("Lib39 ほか 5 件"));
    assert.ok(!block.includes("Lib40"));
  });

  test("複数のプロジェクトを順に並べ、読めなかったものは不明と書く。プロジェクトが無ければ undefined", () => {
    const block = renderEnvironmentBlock([
      { label: "A", projectPath: "A/A.vbproj", style: "legacy", environment: environmentOf(`<Project ToolsVersion="12.0"></Project>`) },
      { label: "B", projectPath: "B/B.vbproj", style: "legacy", environment: undefined },
    ]);
    assert.ok(block !== undefined);
    assert.ok(block.indexOf("- A(A/A.vbproj)") < block.indexOf("- B(B/B.vbproj)"));
    assert.ok(block.includes("- B(B/B.vbproj)\n  - .vbproj を XML として読めなかったため不明"));
    assert.strictEqual(renderEnvironmentBlock([]), undefined);
  });
});

function csEnvironmentOf(xml: string): ProjectEnvironment {
  const result = parseVbproj(xml, "/repo/App/App.csproj", NO_FILES);
  assert.strictEqual(result.language, "cs");
  assert.ok(result.environment !== undefined);
  return result.environment;
}

function renderCs(xml: string, style: "legacy" | "sdk" = "legacy"): string {
  const block = renderEnvironmentBlock([
    { label: "App", projectPath: "App/App.csproj", style, language: "cs", environment: csEnvironmentOf(xml) },
  ]);
  assert.ok(block !== undefined);
  return block;
}

suite("environmentSummary: C# の .csproj", () => {
  test("旧スタイル VS2013: C# 5 とみなし、6 以降の構文を使えないと挙げる。.vbproj の語句は出さない", () => {
    const block = renderCs(
      `<Project ToolsVersion="12.0"><PropertyGroup><TargetFrameworkVersion>v4.5</TargetFrameworkVersion><RootNamespace>App</RootNamespace></PropertyGroup>
       <ItemGroup><Reference Include="System" /><Import Include="System.Linq" /></ItemGroup></Project>`,
    );
    assert.ok(block.startsWith("<environment>\n.csproj から読み取ったビルド環境"));
    assert.ok(
      block.includes(
        "  - C#: 5 まで(LangVersion の指定なし。ToolsVersion 12.0 は Visual Studio 2013 の形式のため、Visual Studio 2013 の既定の C# 5 とみなす)。6 以降の文字列補間",
      ),
    );
    assert.ok(block.includes("  - .NET Framework: v4.5"));
    assert.ok(block.includes("  - 既定の名前空間: App(C# は各ファイルの namespace 宣言で名前空間が決まる"));
    // <Import> は Visual Basic の項目なので C# では読まない
    assert.ok(!block.includes("System.Linq"));
    assert.ok(!block.includes("Visual Basic"));
    assert.ok(!block.includes("Option"));
  });

  test("ToolsVersion 15.0 は C# 7、Current は .NET Framework の既定の 7.3 とみなす", () => {
    assert.ok(renderCs(`<Project ToolsVersion="15.0"></Project>`).includes("C#: 7 まで"));
    const current = renderCs(`<Project ToolsVersion="Current"></Project>`);
    assert.ok(current.includes("C#: 7.3 まで"));
    assert.ok(current.includes("8 以降の switch 式"));
    assert.ok(!current.includes("7.1 以降"));
  });

  test("SDK スタイル: ターゲット フレームワークの既定の版(複数なら低い方)", () => {
    const one = renderCs(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0-windows</TargetFramework></PropertyGroup></Project>`, "sdk");
    assert.ok(one.includes("C#: 12 まで(LangVersion の指定なし。SDK スタイルはターゲット フレームワークの既定の版になるため、net8.0-windows の既定の C# 12 とみなす)"));
    const many = renderCs(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net48;net6.0</TargetFrameworks></PropertyGroup></Project>`, "sdk");
    assert.ok(many.includes("C#: 7.3 まで(LangVersion の指定なし。SDK スタイルはターゲット フレームワークの既定の版になるため、net48 / net6.0 のうち低い方の既定の C# 7.3 とみなす)"));
    const core3 = renderCs(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>netcoreapp3.1</TargetFramework></PropertyGroup></Project>`, "sdk");
    assert.ok(core3.includes("C#: 8 まで"));
    const net10 = renderCs(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>`, "sdk");
    assert.ok(net10.includes("C#: 14 まで"));
  });

  test("SDK スタイルで既定の版が分からなければ推測しない", () => {
    const block = renderCs(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>$(Tfm)</TargetFramework></PropertyGroup></Project>`, "sdk");
    assert.ok(block.includes("C#: SDK の既定(LangVersion の指定なし。SDK スタイルはターゲット フレームワークの既定の版になる)"));
  });

  test("LangVersion の指定はそちらを使う(数でなければそのまま書く)", () => {
    assert.ok(renderCs(`<Project ToolsVersion="12.0"><PropertyGroup><LangVersion>7.3</LangVersion></PropertyGroup></Project>`).includes("C#: 7.3 まで(LangVersion の指定: 7.3)"));
    assert.ok(renderCs(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><LangVersion>latest</LangVersion></PropertyGroup></Project>`, "sdk").includes("C#: latest(LangVersion の指定)"));
  });

  test("Nullable・ImplicitUsings・<Using>(Static・Alias。Remove は載せない)・PackageReference", () => {
    const block = renderCs(
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>disable</ImplicitUsings></PropertyGroup>
       <ItemGroup><Using Include="System.Data" /><Using Include="App.Util" Static="true" /><Using Include="System.Text.Json" Alias="Json" /><Using Remove="System.Net.Http" />
       <PackageReference Include="Dapper" Version="2.1.35" /></ItemGroup></Project>`,
      "sdk",
    );
    assert.ok(block.includes("  - Nullable: enable(null 許容参照型が有効。null になり得る参照型には ? を付ける)"));
    assert.ok(block.includes("  - ImplicitUsings: disable\n"));
    assert.ok(block.includes("  - プロジェクト全体の using(global using): System.Data, static App.Util, Json = System.Text.Json"));
    assert.ok(!block.includes("System.Net.Http"));
    assert.ok(block.includes("Dapper 2.1.35"));
  });

  test("VB と C# のプロジェクトを並べると見出しは両方の拡張子になる", () => {
    const block = renderEnvironmentBlock([
      { label: "A", projectPath: "A/A.vbproj", style: "legacy", environment: environmentOf(`<Project ToolsVersion="12.0"></Project>`) },
      { label: "B", projectPath: "B/B.csproj", style: "legacy", language: "cs", environment: undefined },
    ]);
    assert.ok(block !== undefined);
    assert.ok(block.startsWith("<environment>\n.vbproj / .csproj から読み取ったビルド環境"));
    assert.ok(block.includes("  - Visual Basic: 12.0 まで"));
    assert.ok(block.includes("- B(B/B.csproj)\n  - .csproj を XML として読めなかったため不明"));
  });
});

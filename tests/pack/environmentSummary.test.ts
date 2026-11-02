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

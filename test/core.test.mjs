import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLinks,
  flattenBookmarks,
  flattenNodes,
  folderViewerPath,
  childNodes,
  buildLinkGraph,
  buildLinksForTarget,
  isImeKeyEvent,
  isBookmarkletUrl,
  bookmarkletSource,
  buildMatchContext,
  buildLinkSuggestions,
  findMatchingDescriptionLine,
  findTextMatches,
  buildOmniboxSuggestions,
  omniboxBookmarkContent,
  omniboxNodeContent,
  parseOmniboxBookmarkContent,
  parseOmniboxNodeContent,
  parseDescriptionLines,
  removedNodeIds,
  resolveLinkTarget,
  resolveOmniboxBookmark,
  resolveOmniboxNode,
  searchBookmarks,
  searchNodes,
  shouldInsertIndent
} from "../core.mjs";
import {
  describeEditorLine,
  linkCompletionInsertion,
  resolveLinkWrapAfterInput,
  wrapSelectionAsLink
} from "../editor-model.mjs";

const bookmarks = [
  { id: "1", title: "ChatGPT", url: "https://chatgpt.com/", dateAdded: 100 },
  { id: "2", title: "Cosense", url: "https://scrapbox.io/", dateAdded: 300 },
  { id: "3", title: "my input method", url: "https://example.com/input", dateAdded: 200 }
];

test("Cosense形式のリンクを重複なく抽出する", () => {
  assert.deepEqual(extractLinks("[日本語入力]\n [Mozc]\n[mozc]\n[]"), ["日本語入力", "Mozc"]);
});

test("フォルダ階層からブックマークだけを取り出す", () => {
  const tree = [{ id: "0", title: "", children: [{ id: "f", title: "仕事", children: [bookmarks[0]] }] }];
  assert.deepEqual(flattenBookmarks(tree), [{ ...bookmarks[0], folder: "仕事" }]);
});

test("Chromeフォルダを親子関係を保った共通ノードへ変換する", () => {
  const tree = [{ id: "0", title: "", children: [{
    id: "f",
    title: "仕事",
    children: [{ ...bookmarks[0], parentId: "f" }]
  }] }];
  const nodes = flattenNodes(tree);
  assert.deepEqual(nodes.map(({ id, type, parentId }) => ({ id, type, parentId })), [
    { id: "f", type: "folder", parentId: "0" },
    { id: "1", type: "bookmark", parentId: "f" }
  ]);
  assert.deepEqual(childNodes(nodes, "f").map(({ id }) => id), ["1"]);
});

test("フォルダの移動と名称変更後も同じIDでメタデータを参照する", () => {
  const before = flattenNodes([{ id: "0", title: "", children: [{ id: "f", title: "旧名" }] }]);
  const after = flattenNodes([{ id: "0", title: "", children: [{ id: "p", title: "親", children: [{ id: "f", title: "新名" }] }] }]);
  const metadata = { f: { description: "維持される説明" } };
  assert.equal(metadata[before.find(({ id }) => id === "f").id].description, "維持される説明");
  assert.equal(metadata[after.find(({ id }) => id === "f").id].description, "維持される説明");
});

test("削除フォルダと配下ノードのIDを再帰的に収集する", () => {
  assert.deepEqual(removedNodeIds("f", {
    id: "f",
    children: [{ id: "c", children: [{ id: "b" }] }]
  }), ["f", "c", "b"]);
});

test("フォルダIDをビューワーURLへ安全に埋め込む", () => {
  assert.equal(folderViewerPath("id / 日本語"), "viewer.html?folderId=id%20%2F%20%E6%97%A5%E6%9C%AC%E8%AA%9E");
});

test("未検索時は追加日時の新しい順になる", () => {
  assert.deepEqual(searchBookmarks(bookmarks, {}, "").map(({ id }) => id), ["2", "3", "1"]);
});

test("タイトルを大文字小文字を区別せず部分一致検索する", () => {
  assert.deepEqual(searchBookmarks(bookmarks, {}, "GPT").map(({ id }) => id), ["1"]);
  assert.deepEqual(searchBookmarks(bookmarks, {}, "sense").map(({ id }) => id), ["2"]);
  assert.deepEqual(searchBookmarks(bookmarks, {}, "input").map(({ id }) => id), ["3"]);
});

test("説明文とリンク文字列を検索する", () => {
  const metadata = { "1": { description: "[生成AI]のサービス\n [OpenAI]" } };
  assert.deepEqual(searchBookmarks(bookmarks, metadata, "生成AI").map(({ id }) => id), ["1"]);
  assert.deepEqual(searchBookmarks(bookmarks, metadata, "openai").map(({ id }) => id), ["1"]);
});

test("検索語に一致した元文字列の範囲を返す", () => {
  assert.deepEqual(findTextMatches("ChatGPTとchatgpt", "GPT"), [
    { from: 4, to: 7 },
    { from: 12, to: 15 }
  ]);
  assert.deepEqual(findTextMatches("Ｃｏｓｅｎｓｅ", "cosense"), [{ from: 0, to: 7 }]);
  assert.equal(findMatchingDescriptionLine("概要\n [生成AI]のサービス", "生成ai"), "[生成AI]のサービス");
});

test("検索一致箇所の前後8文字を表示用に切り出す", () => {
  assert.deepEqual(buildMatchContext(
    { title: "長いタイトル", url: "https://example.com/abcdefghijklmnopGPTqrstuvwxyz" },
    {},
    "GPT"
  ), {
    text: "…ijklmnopGPTqrstuvwx…",
    matches: [{ from: 9, to: 12 }]
  });

  assert.deepEqual(buildMatchContext(
    { title: "ChatGPT", url: "https://example.com" },
    {},
    "GPT"
  ), {
    text: "ChatGPT",
    matches: [{ from: 4, to: 7 }]
  });
});

test("オムニバー用の説明文脈からリンク記法の括弧を除く", () => {
  assert.deepEqual(buildMatchContext(
    { title: "ChatGPT", url: "https://chatgpt.com" },
    { description: "[生成AI]のサービス" },
    "生成",
    8,
    true
  ), {
    text: "生成AIのサービス",
    matches: [{ from: 0, to: 2 }]
  });
});

test("リンク入力候補をブックマーク名と既存リンクから生成する", () => {
  const metadata = {
    "1": { description: "[生成AI]\n[ChatGPT]" },
    "2": { description: "[日本語入力]" }
  };
  assert.deepEqual(buildLinkSuggestions(bookmarks, metadata), [
    { label: "ChatGPT", detail: "ブックマーク" },
    { label: "Cosense", detail: "ブックマーク" },
    { label: "my input method", detail: "ブックマーク" },
    { label: "生成AI", detail: "リンク" },
    { label: "日本語入力", detail: "リンク" }
  ]);
});

test("リンク入力候補にフォルダを含める", () => {
  const nodes = [...bookmarks, { id: "f", type: "folder", title: "開発ツール", url: "" }];
  assert.equal(buildLinkSuggestions(nodes, {})[3].detail, "フォルダ");
});

test("完全一致と前方一致を部分一致より優先する", () => {
  const candidates = [
    { id: "a", title: "About GPT tools", url: "https://a.example", dateAdded: 3 },
    { id: "b", title: "GPT tools", url: "https://b.example", dateAdded: 2 },
    { id: "c", title: "GPT", url: "https://c.example", dateAdded: 1 }
  ];
  assert.deepEqual(searchBookmarks(candidates, {}, "gpt").map(({ id }) => id), ["c", "b", "a"]);
});

test("オムニバー候補でも既存の検索順位と説明文検索を使う", () => {
  const metadata = { "1": { description: "[生成AI]" } };
  assert.deepEqual(buildOmniboxSuggestions(bookmarks, metadata, "生成AI", 6), [{
    content: "mybm-node:bookmark:1",
    description: "ChatGPT<dim>｜</dim><match>生成AI</match><dim>｜</dim><dim>https://chatgpt.com/</dim>"
  }]);
});

test("フォルダ名とフォルダ説明文をOmnibox候補へ表示する", () => {
  const folders = [{ id: "f / 1", type: "folder", title: "開発ツール", url: "", dateAdded: 400 }];
  const metadata = { "f / 1": { description: "[ブラウザ開発]関連" } };
  assert.deepEqual(searchNodes(folders, metadata, "ブラウザ開発").map(({ id }) => id), ["f / 1"]);
  assert.deepEqual(buildOmniboxSuggestions(folders, metadata, "開発ツール"), [{
    content: "mybm-node:folder:f%20%2F%201",
    description: "開発ツール<dim>｜</dim><match>開発ツール</match><dim>｜</dim><dim>フォルダ</dim>"
  }]);
});

test("オムニバー候補のIDを安全に往復する", () => {
  const content = omniboxBookmarkContent("id / 日本語");
  assert.equal(parseOmniboxBookmarkContent(content), "id / 日本語");
  assert.equal(parseOmniboxBookmarkContent("検索文字列"), null);
  assert.equal(parseOmniboxBookmarkContent("mybm-bookmark:%E0%A4%A"), null);
});

test("Omniboxノードの種別とIDを安全に往復する", () => {
  const content = omniboxNodeContent({ type: "folder", id: "id / 日本語" });
  assert.deepEqual(parseOmniboxNodeContent(content), { type: "folder", id: "id / 日本語" });
  assert.deepEqual(parseOmniboxNodeContent("mybm-bookmark:1"), { type: "bookmark", id: "1" });
  assert.equal(parseOmniboxNodeContent("mybm-node:folder"), null);
});

test("オムニバーの候補選択と検索語確定をブックマークへ解決する", () => {
  const metadata = { "1": { description: "[生成AI]" } };
  assert.equal(resolveOmniboxBookmark(bookmarks, metadata, "mybm-bookmark:2")?.id, "2");
  assert.equal(resolveOmniboxBookmark(bookmarks, metadata, "生成AI")?.id, "1");
  assert.equal(resolveOmniboxBookmark(bookmarks, metadata, "存在しない"), null);
});

test("Omniboxで確定したフォルダをIDから解決する", () => {
  const nodes = [...bookmarks, { id: "f", type: "folder", title: "開発ツール", url: "", dateAdded: 1 }];
  assert.equal(resolveOmniboxNode(nodes, {}, "mybm-node:folder:f")?.id, "f");
  assert.equal(resolveOmniboxNode(nodes, {}, "開発ツール")?.type, "folder");
});

test("オムニバー候補の表示文字列をエスケープする", () => {
  const unsafe = [{ id: "x", title: "A < B & C", url: "https://example.com/?a=1&b=2", dateAdded: 1 }];
  assert.equal(
    buildOmniboxSuggestions(unsafe, {}, "<")[0].description,
    "A &lt; B &amp; C<dim>｜</dim>A <match>&lt;</match> B &amp; C<dim>｜</dim><dim>https://example.com/?a=1&amp;b=2</dim>"
  );
});

test("IME変換中のEnterとTabを編集操作として扱わない", () => {
  assert.equal(isImeKeyEvent({ key: "Enter", isComposing: true, keyCode: 13 }), true);
  assert.equal(isImeKeyEvent({ key: "Enter", isComposing: false, keyCode: 229 }), true);
  assert.equal(shouldInsertIndent({ key: "Tab", isComposing: true, keyCode: 229 }), false);
});

test("通常入力ではTabだけにインデントを挿入する", () => {
  assert.equal(shouldInsertIndent({ key: "Tab", isComposing: false, keyCode: 9 }), true);
  assert.equal(shouldInsertIndent({ key: "Enter", isComposing: false, keyCode: 13 }), false);
});

test("順リンクと逆リンクを区別せずLinksへまとめる", () => {
  const linkedBookmarks = [
    { id: "a", title: "A", url: "https://a.example", dateAdded: 3 },
    { id: "b", title: "B", url: "https://b.example", dateAdded: 2 },
    { id: "c", title: "C", url: "https://c.example", dateAdded: 1 }
  ];
  const linkedMetadata = {
    a: { description: "[B]\n[仮想]" },
    c: { description: "[A]" }
  };
  const graph = buildLinkGraph(linkedBookmarks, linkedMetadata);

  assert.deepEqual(graph.get("node:a"), ["B", "仮想", "C"]);
  assert.deepEqual(graph.get("node:b"), ["A"]);
  assert.deepEqual(graph.get("virtual:仮想"), ["A"]);
});

test("対象ノードのLinksだけを全体グラフと同じ結果で生成する", () => {
  const linkedBookmarks = [
    { id: "a", title: "A", url: "https://a.example", dateAdded: 3 },
    { id: "b", title: "B", url: "https://b.example", dateAdded: 2 },
    { id: "c", title: "C", url: "https://c.example", dateAdded: 1 }
  ];
  const linkedMetadata = {
    a: { description: "[B]\n[仮想]" },
    c: { description: "[A]" }
  };
  const target = { type: "bookmark", node: linkedBookmarks[0] };

  assert.deepEqual(
    buildLinksForTarget(linkedBookmarks, linkedMetadata, target),
    buildLinkGraph(linkedBookmarks, linkedMetadata).get("node:a")
  );
});

test("リンク名から一意なブックマークと仮想ノードを解決する", () => {
  assert.deepEqual(resolveLinkTarget("ChatGPT", bookmarks), { type: "bookmark", node: bookmarks[0] });
  assert.deepEqual(resolveLinkTarget("生成AI", bookmarks), { type: "virtual", title: "生成AI", matches: [] });

  const duplicate = [...bookmarks, { ...bookmarks[0], id: "4" }];
  const ambiguous = resolveLinkTarget("chatgpt", duplicate);
  assert.equal(ambiguous.type, "virtual");
  assert.deepEqual(ambiguous.matches.map(({ id }) => id), ["1", "4"]);
});

test("フォルダをリンク先に解決し、同名ノードは自動確定しない", () => {
  const folder = { id: "f", type: "folder", title: "開発", url: "" };
  assert.deepEqual(resolveLinkTarget("開発", [folder]), { type: "folder", node: folder });
  const ambiguous = resolveLinkTarget("開発", [folder, { ...bookmarks[0], title: "開発" }]);
  assert.equal(ambiguous.type, "virtual");
  assert.deepEqual(ambiguous.matches.map(({ id }) => id), ["f", "1"]);
});

test("フォルダへの順リンクと被リンクを生成する", () => {
  const folder = { id: "f", type: "folder", title: "開発", url: "" };
  const nodes = [folder, { ...bookmarks[0], type: "bookmark" }];
  const metadata = {
    f: { description: "[ChatGPT]" },
    "1": { description: "[開発]" }
  };
  assert.deepEqual(buildLinksForTarget(nodes, metadata, { type: "folder", node: folder }), ["ChatGPT"]);
  assert.deepEqual(buildLinkGraph(nodes, metadata).get("node:f"), ["ChatGPT"]);
});

test("説明文の行頭空白を箇条書き階層として解析する", () => {
  assert.deepEqual(parseDescriptionLines("日本語入力\n [Mozc]\n\t[Google日本語入力]\n　　変換エンジン"), [
    { depth: 0, prefix: "", text: "日本語入力" },
    { depth: 1, prefix: " ", text: "[Mozc]" },
    { depth: 1, prefix: "\t", text: "[Google日本語入力]" },
    { depth: 2, prefix: "　　", text: "変換エンジン" }
  ]);
});

test("初期表示時からインデント行に箇条書き装飾を生成する", () => {
  assert.deepEqual(describeEditorLine("  [Mozc]", true), {
    bullet: true,
    depth: 2,
    prefixLength: 2,
    links: []
  });
});

test("選択行だけリンク記法を表示する", () => {
  assert.deepEqual(describeEditorLine(" [Mozc]", false).links, [
    { from: 1, to: 7, label: "Mozc" }
  ]);
  assert.deepEqual(describeEditorLine(" [Mozc]", true).links, []);
});

test("リンク候補確定時に閉じ括弧を重複させない", () => {
  assert.deepEqual(linkCompletionInsertion("Mozc", ""), {
    insert: "Mozc]",
    movePastExistingBracket: false
  });
  assert.deepEqual(linkCompletionInsertion("Mozc", "]"), {
    insert: "Mozc",
    movePastExistingBracket: true
  });
});

test("選択文字列をリンク記法で囲む", () => {
  assert.deepEqual(wrapSelectionAsLink("生成AIのサービス", 0, 4), {
    from: 0,
    to: 4,
    insert: "[生成AI]",
    cursor: 6
  });
  assert.equal(wrapSelectionAsLink("生成AI", 2, 2), null);
  assert.equal(wrapSelectionAsLink("生成\nAI", 0, 5), null);
});

test("IM確定後の左角括弧置換を選択文字列のリンクへ正規化する", () => {
  assert.deepEqual(resolveLinkWrapAfterInput("Codexも利用中", "[も利用中", 0, 5), {
    from: 0,
    to: 1,
    insert: "[Codex]",
    cursor: 7
  });
  assert.deepEqual(resolveLinkWrapAfterInput("Codexも利用中", "[[も利用中", 0, 5), {
    from: 0,
    to: 2,
    insert: "[Codex]",
    cursor: 7
  });
  assert.deepEqual(resolveLinkWrapAfterInput("Codexも利用中", "[[]も利用中", 0, 5), {
    from: 0,
    to: 3,
    insert: "[Codex]",
    cursor: 7
  });
  assert.equal(resolveLinkWrapAfterInput("Codexも利用中", "Aも利用中", 0, 5), null);
});

test("myimが未選択位置へ生成した重複括弧だけを正規化する", () => {
  assert.deepEqual(resolveLinkWrapAfterInput("利用中", "[[]利用中", 0, 0), {
    from: 0,
    to: 3,
    insert: "[]",
    cursor: 1
  });
  assert.deepEqual(resolveLinkWrapAfterInput("利用中", "[[利用中", 0, 0), {
    from: 0,
    to: 2,
    insert: "[",
    cursor: 1
  });
  assert.equal(resolveLinkWrapAfterInput("利用中", "[利用中", 0, 0), null);
  assert.equal(resolveLinkWrapAfterInput("利用中", "[]利用中", 0, 0), null);
});

test("javascript URLをブックマークレットとして判定してコードを取り出す", () => {
  assert.equal(isBookmarkletUrl("javascript:alert(1)"), true);
  assert.equal(isBookmarkletUrl(" JAVASCRIPT:alert(1)"), true);
  assert.equal(isBookmarkletUrl("https://example.com"), false);
  assert.equal(bookmarkletSource("javascript:void%200"), "void 0");
});

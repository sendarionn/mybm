import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLinks,
  flattenBookmarks,
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
  parseOmniboxBookmarkContent,
  parseDescriptionLines,
  resolveLinkTarget,
  resolveOmniboxBookmark,
  searchBookmarks,
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
    content: "mybm-bookmark:1",
    description: "ChatGPT<dim>｜</dim><match>生成AI</match><dim>｜</dim><dim>https://chatgpt.com/</dim>"
  }]);
});

test("オムニバー候補のIDを安全に往復する", () => {
  const content = omniboxBookmarkContent("id / 日本語");
  assert.equal(parseOmniboxBookmarkContent(content), "id / 日本語");
  assert.equal(parseOmniboxBookmarkContent("検索文字列"), null);
  assert.equal(parseOmniboxBookmarkContent("mybm-bookmark:%E0%A4%A"), null);
});

test("オムニバーの候補選択と検索語確定をブックマークへ解決する", () => {
  const metadata = { "1": { description: "[生成AI]" } };
  assert.equal(resolveOmniboxBookmark(bookmarks, metadata, "mybm-bookmark:2")?.id, "2");
  assert.equal(resolveOmniboxBookmark(bookmarks, metadata, "生成AI")?.id, "1");
  assert.equal(resolveOmniboxBookmark(bookmarks, metadata, "存在しない"), null);
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

  assert.deepEqual(graph.get("bookmark:a"), ["B", "仮想", "C"]);
  assert.deepEqual(graph.get("bookmark:b"), ["A"]);
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
  const target = { type: "bookmark", bookmark: linkedBookmarks[0] };

  assert.deepEqual(
    buildLinksForTarget(linkedBookmarks, linkedMetadata, target),
    buildLinkGraph(linkedBookmarks, linkedMetadata).get("bookmark:a")
  );
});

test("リンク名から一意なブックマークと仮想ノードを解決する", () => {
  assert.deepEqual(resolveLinkTarget("ChatGPT", bookmarks), { type: "bookmark", bookmark: bookmarks[0] });
  assert.deepEqual(resolveLinkTarget("生成AI", bookmarks), { type: "virtual", title: "生成AI", matches: [] });

  const duplicate = [...bookmarks, { ...bookmarks[0], id: "4" }];
  const ambiguous = resolveLinkTarget("chatgpt", duplicate);
  assert.equal(ambiguous.type, "virtual");
  assert.deepEqual(ambiguous.matches.map(({ id }) => id), ["1", "4"]);
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

import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLinks,
  flattenBookmarks,
  flattenNodes,
  isPendingFolderTargetFresh,
  pendingFolderTargetKey,
  childNodes,
  descendantNodes,
  buildLinkGraph,
  buildLinksForTarget,
  hasMetadataSaveConflict,
  metadataEntryForDescription,
  mergeRenamedLinksIntoEditedDescription,
  migrateMetadataLinkReferences,
  renameLinkedReferences,
  renameMetadataLinks,
  resolveLinkReferences,
  resolveLinkedLabel,
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
  searchFolderNodes,
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

test("フォルダ内検索は子孫だけを既存検索順位で検索する", () => {
  const nodes = [
    { id: "root", type: "folder", title: "開発", parentId: "0", url: "" },
    { id: "direct", type: "bookmark", title: "GitHub", parentId: "root", url: "https://github.com", dateAdded: 1 },
    { id: "child", type: "folder", title: "エディタ", parentId: "root", url: "" },
    { id: "grandchild", type: "bookmark", title: "VS Code", parentId: "child", url: "https://code.visualstudio.com", dateAdded: 2 },
    { id: "outside", type: "bookmark", title: "VS Code outside", parentId: "other", url: "https://outside.example", dateAdded: 3 }
  ];
  const metadata = { grandchild: { description: "[開発環境]" } };
  assert.deepEqual(descendantNodes(nodes, "root").map(({ id }) => id), ["direct", "child", "grandchild"]);
  assert.deepEqual(searchFolderNodes(nodes, metadata, "root", "VS Code").map(({ id }) => id), ["grandchild"]);
  assert.deepEqual(searchFolderNodes(nodes, metadata, "root", "開発環境").map(({ id }) => id), ["grandchild"]);
  assert.deepEqual(searchFolderNodes(nodes, metadata, "root", "").map(({ id }) => id), ["direct", "child"]);
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

test("Omniboxの一時フォルダ指定をウィンドウ別かつ期限付きで扱う", () => {
  assert.equal(pendingFolderTargetKey(42), "pendingFolderTarget:42");
  assert.equal(isPendingFolderTargetFresh({ folderId: "f", createdAt: 1000 }, 2000), true);
  assert.equal(isPendingFolderTargetFresh({ folderId: "f", createdAt: 1000 }, 32000), false);
  assert.equal(isPendingFolderTargetFresh(null, 2000), false);
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

test("既存説明文では一意なリンクだけをノードIDへ移行する", () => {
  const nodes = [
    { id: "bookmark", type: "bookmark", title: "GitHub", url: "https://github.com" },
    { id: "folder", type: "folder", title: "開発", url: "" },
    { id: "duplicate", type: "folder", title: "GitHub", url: "" }
  ];
  const migration = migrateMetadataLinkReferences({
    source: { bookmarkId: "source", description: "[開発] [GitHub] [未解決]", updatedAt: 1 }
  }, nodes);
  assert.equal(migration.changed, true);
  assert.deepEqual(migration.metadata.source.linkReferences, [
    { label: "開発", occurrence: 0, targetId: "folder" }
  ]);
  assert.equal(migration.metadata.source.description, "[開発] [GitHub] [未解決]");
});

test("ノード名称変更でIDが一致するリンク記法だけを更新する", () => {
  const metadata = {
    a: metadataEntryForDescription("a", "通常文の開発ツール\n[開発ツール]\n[開発ツール]\n[ 変更しない ]", [
      { id: "target", type: "folder", title: "開発ツール", url: "" }
    ]),
    b: metadataEntryForDescription("b", "参照 [開発ツール]", [
      { id: "target", type: "folder", title: "開発ツール", url: "" }
    ])
  };
  const renamed = renameMetadataLinks(metadata, "target", "Development Tools");
  assert.equal(
    renamed.metadata.a.description,
    "通常文の開発ツール\n[Development Tools]\n[Development Tools]\n[ 変更しない ]"
  );
  assert.equal(renamed.metadata.b.description, "参照 [Development Tools]");
  assert.equal(renamed.changes.length, 2);
  assert.deepEqual(renamed.metadata.a.linkReferences, [
    { label: "Development Tools", occurrence: 0, targetId: "target" },
    { label: "Development Tools", occurrence: 1, targetId: "target" }
  ]);
  const target = { id: "target", type: "folder", title: "Development Tools", url: "" };
  const sources = [
    target,
    { id: "a", type: "bookmark", title: "参照元A", url: "https://a.example" },
    { id: "b", type: "bookmark", title: "参照元B", url: "https://b.example" }
  ];
  assert.deepEqual(
    buildLinksForTarget(sources, renamed.metadata, { type: "folder", node: target }),
    ["参照元A", "参照元B"]
  );
  assert.deepEqual(searchNodes(sources, renamed.metadata, "Development Tools").map(({ id }) => id), ["target", "a", "b"]);
});

test("曖昧リンクと未解決リンクは名称変更で更新しない", () => {
  const metadata = {
    source: { bookmarkId: "source", description: "[GitHub] [仮想]", updatedAt: 1, linkReferences: [] }
  };
  const renamed = renameMetadataLinks(metadata, "target", "New GitHub");
  assert.equal(renamed.metadata.source.description, "[GitHub] [仮想]");
  assert.deepEqual(renamed.changes, []);
});

test("確定済みIDは同名ノードが増えてもLinksの参照先を維持する", () => {
  const target = { id: "target", type: "folder", title: "開発", url: "" };
  const duplicate = { id: "duplicate", type: "bookmark", title: "開発", url: "https://example.com" };
  const source = { id: "source", type: "bookmark", title: "参照元", url: "https://source.example" };
  const entry = metadataEntryForDescription("source", "[開発]", [target, source]);
  assert.deepEqual(
    buildLinksForTarget([target, duplicate, source], { source: entry }, { type: "folder", node: target }),
    ["参照元"]
  );
  assert.deepEqual(
    buildLinksForTarget([target, duplicate, source], { source: entry }, { type: "bookmark", node: duplicate }),
    []
  );
  assert.deepEqual(resolveLinkedLabel("開発", entry, [target, duplicate, source]), {
    type: "folder",
    node: target
  });
});

test("確定済みリンク先が削除されても同名ノードへ自動付け替えしない", () => {
  const remaining = { id: "remaining", type: "folder", title: "開発", url: "" };
  const source = { id: "source", type: "bookmark", title: "参照元", url: "https://source.example" };
  const entry = {
    bookmarkId: "source",
    description: "[開発]",
    linkReferences: [{ label: "開発", occurrence: 0, targetId: "deleted" }]
  };
  assert.deepEqual(resolveLinkedLabel("開発", entry, [remaining, source]), {
    type: "virtual",
    title: "開発",
    matches: []
  });
  assert.deepEqual(
    buildLinksForTarget([remaining, source], { source: entry }, { type: "folder", node: remaining }),
    []
  );
  assert.deepEqual(resolveLinkReferences("[開発]", [remaining, source], entry.linkReferences), entry.linkReferences);
});

test("連続した名称変更でも同じノードIDへ追従する", () => {
  const nodes = [{ id: "target", type: "bookmark", title: "A", url: "https://example.com" }];
  const initial = { source: metadataEntryForDescription("source", "[A]", nodes) };
  const first = renameMetadataLinks(initial, "target", "B").metadata;
  const second = renameMetadataLinks(first, "target", "C").metadata;
  assert.equal(second.source.description, "[C]");
  assert.deepEqual(second.source.linkReferences, [{ label: "C", occurrence: 0, targetId: "target" }]);
  assert.equal(second.source.revision, 3);
});

test("編集中の文章へ名称変更を統合して通常入力を維持する", () => {
  const references = [{ label: "旧名", occurrence: 0, targetId: "target" }];
  const merged = mergeRenamedLinksIntoEditedDescription(
    "[旧名]を参照",
    "追記した文章\n[旧名]を参照",
    references,
    "target",
    "新名"
  );
  assert.equal(merged.description, "追記した文章\n[新名]を参照");
  assert.equal(merged.conflict, false);
});

test("編集中に同名リンクが増減した場合は自動統合せず競合にする", () => {
  const references = [{ label: "旧名", occurrence: 0, targetId: "target" }];
  const merged = mergeRenamedLinksIntoEditedDescription(
    "[旧名]を参照",
    "[旧名]を追加\n[旧名]を参照",
    references,
    "target",
    "新名"
  );
  assert.equal(merged.description, "[旧名]を追加\n[旧名]を参照");
  assert.equal(merged.conflict, true);
});

test("URLだけの変更ではリンク参照を変更しない", () => {
  const references = resolveLinkReferences("[対象]", [
    { id: "target", type: "bookmark", title: "対象", url: "https://old.example" }
  ]);
  assert.deepEqual(references, [{ label: "対象", occurrence: 0, targetId: "target" }]);
});

test("連続入力は直前の送信内容が保存済みならrevision差を許可する", () => {
  const current = { description: "入力A", revision: 2 };
  assert.equal(hasMetadataSaveConflict(current, 1, "入力A"), false);
  assert.equal(hasMetadataSaveConflict(current, 1, "別の内容"), true);
  assert.equal(hasMetadataSaveConflict(current, 2, "別の内容"), false);
});

test("新規ノードの初回メモ保存でnullの既存エントリを受け入れる", () => {
  const entry = metadataEntryForDescription("folder", "初回メモ", [], null);
  assert.equal(entry.bookmarkId, "folder");
  assert.equal(entry.description, "初回メモ");
  assert.equal(entry.revision, 1);
  assert.deepEqual(entry.linkReferences, []);
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

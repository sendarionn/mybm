import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLinks,
  flattenBookmarks,
  buildLinkGraph,
  isImeKeyEvent,
  isBookmarkletUrl,
  bookmarkletSource,
  parseDescriptionLines,
  resolveLinkTarget,
  searchBookmarks,
  shouldInsertIndent
} from "../core.mjs";
import { describeEditorLine } from "../editor-model.mjs";

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

test("完全一致と前方一致を部分一致より優先する", () => {
  const candidates = [
    { id: "a", title: "About GPT tools", url: "https://a.example", dateAdded: 3 },
    { id: "b", title: "GPT tools", url: "https://b.example", dateAdded: 2 },
    { id: "c", title: "GPT", url: "https://c.example", dateAdded: 1 }
  ];
  assert.deepEqual(searchBookmarks(candidates, {}, "gpt").map(({ id }) => id), ["c", "b", "a"]);
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

test("javascript URLをブックマークレットとして判定してコードを取り出す", () => {
  assert.equal(isBookmarkletUrl("javascript:alert(1)"), true);
  assert.equal(isBookmarkletUrl(" JAVASCRIPT:alert(1)"), true);
  assert.equal(isBookmarkletUrl("https://example.com"), false);
  assert.equal(bookmarkletSource("javascript:void%200"), "void 0");
});

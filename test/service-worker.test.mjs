import test from "node:test";
import assert from "node:assert/strict";
import { buildLinksForTarget, flattenNodes } from "../core.mjs";

const tree = [{ id: "0", title: "", children: [{
  id: "1",
  title: "ブックマーク バー",
  children: [
    { id: "folder", title: "開発", children: [] },
    { id: "bookmark", title: "ChatGPT", url: "https://chatgpt.com" }
  ]
}] }];

const storageValues = {};
const messageListeners = [];
const listener = () => ({ addListener() {} });

globalThis.chrome = {
  action: {},
  bookmarks: { getTree: async () => structuredClone(tree), onChanged: listener(), onRemoved: listener() },
  omnibox: { onInputChanged: listener(), onInputEntered: listener(), setDefaultSuggestion() {} },
  runtime: {
    onInstalled: listener(),
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    sendMessage: async () => undefined
  },
  storage: {
    local: {
      async get(keys) {
        return Object.fromEntries(keys.filter((key) => key in storageValues).map((key) => [key, structuredClone(storageValues[key])]));
      },
      async set(next) {
        Object.assign(storageValues, structuredClone(next));
      }
    },
    session: { async set() {} }
  },
  tabs: {}
};

await import("../service-worker.js");

function resetStorage(initial = {}) {
  for (const key of Object.keys(storageValues)) delete storageValues[key];
  Object.assign(storageValues, structuredClone(initial));
}

function save(nodeId, description, { previousDescription = "", baseRevision = 0 } = {}) {
  return new Promise((resolve) => {
    const handled = messageListeners[0](
      { type: "saveMetadataEntry", nodeId, description, previousDescription, baseRevision },
      {},
      resolve
    );
    assert.equal(handled, true);
  });
}

test("メタデータがないブックマークへ初めてメモを保存する", async () => {
  resetStorage();
  const response = await save("bookmark", "初回メモ");
  assert.equal(response.ok, true);
  assert.equal(storageValues.metadata.bookmark.description, "初回メモ");
  assert.equal(storageValues.metadata.bookmark.revision, 1);
});

test("メタデータがないフォルダへ初めてメモを保存する", async () => {
  resetStorage({ metadata: { bookmark: { description: "既存", revision: 3 } } });
  const response = await save("folder", "フォルダのメモ");
  assert.equal(response.ok, true);
  assert.equal(storageValues.metadata.folder.revision, 1);
  assert.equal(storageValues.metadata.bookmark.description, "既存");
});

test("保存済みエントリがnullでも初回保存として扱う", async () => {
  resetStorage({ metadata: { bookmark: null, folder: { description: "既存", revision: 1 } } });
  const response = await save("bookmark", "nullから保存");
  assert.equal(response.ok, true);
  assert.equal(storageValues.metadata.bookmark.revision, 1);
});

test("保存済みメモを編集するとrevisionが増える", async () => {
  resetStorage();
  await save("bookmark", "最初");
  const response = await save("bookmark", "編集後", { previousDescription: "最初", baseRevision: 1 });
  assert.equal(response.ok, true);
  assert.equal(storageValues.metadata.bookmark.description, "編集後");
  assert.equal(storageValues.metadata.bookmark.revision, 2);
});

test("空のメモを保存するとエントリだけを削除する", async () => {
  resetStorage({ metadata: {
    bookmark: { description: "消す", revision: 1 },
    folder: { description: "残す", revision: 1 }
  } });
  const response = await save("bookmark", "", { previousDescription: "消す", baseRevision: 1 });
  assert.equal(response.ok, true);
  assert.equal(response.entry, null);
  assert.equal("bookmark" in storageValues.metadata, false);
  assert.equal(storageValues.metadata.folder.description, "残す");
});

test("連続保存は順に処理されrevisionが連番になる", async () => {
  resetStorage();
  const responses = await Promise.all([
    save("bookmark", "a"),
    save("bookmark", "ab", { previousDescription: "a", baseRevision: 0 }),
    save("bookmark", "abc", { previousDescription: "ab", baseRevision: 0 })
  ]);
  assert.deepEqual(responses.map(({ ok }) => ok), [true, true, true]);
  assert.equal(storageValues.metadata.bookmark.description, "abc");
  assert.equal(storageValues.metadata.bookmark.revision, 3);
});

test("別経路で更新されたメモは競合として上書きしない", async () => {
  resetStorage({ metadata: { bookmark: { description: "名称変更後", revision: 2 } } });
  const response = await save("bookmark", "古い編集", { previousDescription: "元の内容", baseRevision: 1 });
  assert.equal(response.ok, false);
  assert.equal(response.conflict, true);
  assert.equal(storageValues.metadata?.bookmark.description, "名称変更後");
});

test("保存後に再読み込みしてもメモとリンクと被リンクを保持する", async () => {
  resetStorage();
  await save("bookmark", "[開発] で使う");
  await save("bookmark", "[開発] で毎日使う", { previousDescription: "[開発] で使う", baseRevision: 1 });
  const { readMetadata } = await import("../storage.mjs");
  const metadata = await readMetadata(chrome.storage.local);
  assert.equal(metadata.bookmark.description, "[開発] で毎日使う");
  assert.equal(metadata.bookmark.linkReferences[0].targetId, "folder");
  assert.deepEqual(storageValues.metadataBackup, storageValues.metadata);
  const nodes = flattenNodes(tree);
  const folder = nodes.find(({ id }) => id === "folder");
  assert.deepEqual(buildLinksForTarget(nodes, metadata, { type: "folder", node: folder }), ["ChatGPT"]);
});

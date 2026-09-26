import {
  bookmarkletSource,
  buildOmniboxSuggestions,
  flattenBookmarks,
  isBookmarkletUrl,
  resolveOmniboxBookmark
} from "./core.mjs";
import {
  preserveMetadataForUpdate,
  readMetadata,
  writeMetadata
} from "./storage.mjs";

let omniboxRequest = 0;

async function loadBookmarksAndMetadata() {
  const [tree, metadata] = await Promise.all([
    chrome.bookmarks.getTree(),
    readMetadata(chrome.storage.local)
  ]);
  return {
    bookmarks: flattenBookmarks(tree),
    metadata
  };
}

async function executeBookmarklet(bookmark) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("実行対象のタブがありません");
  await chrome.userScripts.execute({
    target: { tabId: tab.id },
    world: "MAIN",
    injectImmediately: true,
    js: [{ code: bookmarkletSource(bookmark.url) }]
  });
}

async function openBookmark(bookmark, disposition) {
  if (isBookmarkletUrl(bookmark.url)) {
    await executeBookmarklet(bookmark);
    return;
  }

  if (disposition === "currentTab") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { url: bookmark.url });
      return;
    }
  }

  await chrome.tabs.create({
    url: bookmark.url,
    active: disposition !== "newBackgroundTab"
  });
}

chrome.omnibox.setDefaultSuggestion({ description: "mybmでブックマークを検索" });

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  const request = ++omniboxRequest;
  loadBookmarksAndMetadata()
    .then(({ bookmarks, metadata }) => {
      if (request !== omniboxRequest) return;
      const suggestions = buildOmniboxSuggestions(bookmarks, metadata, text);
      const first = suggestions[0];
      chrome.omnibox.setDefaultSuggestion({
        description: first?.description || "一致するブックマークなし"
      });
      suggest(suggestions);
    })
    .catch((error) => console.error("mybm omnibox search failed", error));
});

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  loadBookmarksAndMetadata()
    .then(({ bookmarks, metadata }) => {
      const bookmark = resolveOmniboxBookmark(bookmarks, metadata, text);
      if (bookmark) return openBookmark(bookmark, disposition);
      return undefined;
    })
    .catch((error) => console.error("mybm omnibox open failed", error));
});

chrome.runtime.onInstalled.addListener(() => {
  preserveMetadataForUpdate(chrome.storage.local)
    .catch((error) => console.error("mybm metadata migration failed", error));
});

chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  const metadata = await readMetadata(chrome.storage.local);
  const removedIds = [id];

  function collectIds(nodes = []) {
    for (const node of nodes) {
      removedIds.push(node.id);
      collectIds(node.children);
    }
  }

  if (removeInfo.node?.children) collectIds(removeInfo.node.children);
  let changed = false;
  for (const removedId of removedIds) {
    if (metadata[removedId]) {
      delete metadata[removedId];
      changed = true;
    }
  }
  if (changed) await writeMetadata(chrome.storage.local, metadata);
});

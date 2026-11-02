import {
  bookmarkletSource,
  buildOmniboxSuggestions,
  flattenNodes,
  hasMetadataSaveConflict,
  isBookmarkletUrl,
  metadataEntryForDescription,
  migrateMetadataLinkReferences,
  pendingFolderTargetKey,
  renameMetadataLinks,
  removedNodeIds,
  resolveOmniboxNode
} from "./core.mjs";
import {
  readMetadata,
  removeMetadataEntries,
  writeMetadata
} from "./storage.mjs";

let omniboxRequest = 0;
let metadataMutationQueue = Promise.resolve();

function queueMetadataMutation(task) {
  const result = metadataMutationQueue.then(task, task);
  metadataMutationQueue = result.catch((error) => {
    console.error("mybm metadata mutation failed", error);
  });
  return result;
}

async function loadNodes() {
  return flattenNodes(await chrome.bookmarks.getTree());
}

async function migrateMetadata() {
  const nodes = await loadNodes();
  const metadata = await readMetadata(chrome.storage.local);
  const migration = migrateMetadataLinkReferences(metadata, nodes);
  if (migration.changed) await writeMetadata(chrome.storage.local, migration.metadata);
  return migration.metadata;
}

async function loadBookmarksAndMetadata() {
  const [tree, metadata] = await Promise.all([
    chrome.bookmarks.getTree(),
    readMetadata(chrome.storage.local)
  ]);
  return {
    nodes: flattenNodes(tree),
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

async function openFolder(folder, disposition) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.windowId)) throw new Error("ポップアップを開くウィンドウがありません");
  const key = pendingFolderTargetKey(tab.windowId);
  const pending = { folderId: folder.id, createdAt: Date.now(), disposition };
  await chrome.storage.session.set({ [key]: pending });
  try {
    await chrome.action.openPopup({ windowId: tab.windowId });
  } catch (error) {
    await chrome.storage.session.set({
      [key]: { ...pending, openError: true }
    });
    throw error;
  }
}

chrome.omnibox.setDefaultSuggestion({ description: "mybmでブックマークを検索" });

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  const request = ++omniboxRequest;
  loadBookmarksAndMetadata()
    .then(({ nodes, metadata }) => {
      if (request !== omniboxRequest) return;
      const suggestions = buildOmniboxSuggestions(nodes, metadata, text);
      const first = suggestions[0];
      chrome.omnibox.setDefaultSuggestion({
        description: first?.description || "一致するノードなし"
      });
      suggest(suggestions);
    })
    .catch((error) => console.error("mybm omnibox search failed", error));
});

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  loadBookmarksAndMetadata()
    .then(({ nodes, metadata }) => {
      const node = resolveOmniboxNode(nodes, metadata, text);
      if (node?.type === "folder") return openFolder(node, disposition);
      if (node) return openBookmark(node, disposition);
      return undefined;
    })
    .catch((error) => console.error("mybm omnibox open failed", error));
});

chrome.runtime.onInstalled.addListener(async () => {
  await queueMetadataMutation(migrateMetadata);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "saveMetadataEntry") return false;
  queueMetadataMutation(async () => {
    const nodes = await loadNodes();
    const stored = await readMetadata(chrome.storage.local);
    const migration = migrateMetadataLinkReferences(stored, nodes);
    const metadata = migration.metadata;
    const currentEntry = metadata[message.nodeId] || null;
    if (hasMetadataSaveConflict(
      currentEntry,
      message.baseRevision,
      message.previousDescription
    )) {
      return { ok: false, conflict: true, entry: currentEntry };
    }
    if (message.description) {
      metadata[message.nodeId] = metadataEntryForDescription(
        message.nodeId,
        message.description,
        nodes,
        currentEntry
      );
    } else {
      delete metadata[message.nodeId];
    }
    await writeMetadata(chrome.storage.local, metadata);
    return { ok: true, entry: metadata[message.nodeId] || null };
  })
    .then(sendResponse)
    .catch((error) => {
      console.error("mybm save failed", error);
      sendResponse({ ok: false, error: String(error) });
    });
  return true;
});

chrome.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  if (typeof changeInfo.title !== "string") return;
  await queueMetadataMutation(async () => {
    const nodes = await loadNodes();
    const stored = await readMetadata(chrome.storage.local);
    const migration = migrateMetadataLinkReferences(stored, nodes);
    const renamed = renameMetadataLinks(migration.metadata, id, changeInfo.title);
    if (migration.changed || renamed.changes.length) {
      await writeMetadata(chrome.storage.local, renamed.metadata);
    }
    if (renamed.changes.length) {
      await chrome.runtime.sendMessage({
        type: "linkedNodeRenamed",
        targetId: id,
        title: changeInfo.title,
        changes: renamed.changes
      }).catch(() => undefined);
    }
  });
});

chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  await queueMetadataMutation(async () => {
    const metadata = await readMetadata(chrome.storage.local);
    const changed = removeMetadataEntries(metadata, removedNodeIds(id, removeInfo.node));
    if (changed) await writeMetadata(chrome.storage.local, metadata);
  });
});

queueMetadataMutation(migrateMetadata);

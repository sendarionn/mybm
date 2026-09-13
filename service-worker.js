chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  const { metadata = {} } = await chrome.storage.local.get("metadata");
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
  if (changed) await chrome.storage.local.set({ metadata });
});

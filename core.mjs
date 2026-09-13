const LINK_PATTERN = /\[([^\[\]\n]+)\]/g;
const BOOKMARKLET_PATTERN = /^\s*javascript:/i;

export function isBookmarkletUrl(url = "") {
  return BOOKMARKLET_PATTERN.test(url);
}

export function bookmarkletSource(url = "") {
  const source = url.replace(BOOKMARKLET_PATTERN, "");
  try {
    return decodeURIComponent(source);
  } catch {
    return source;
  }
}

export function extractLinks(description = "") {
  const links = [];
  const seen = new Set();

  for (const match of description.matchAll(LINK_PATTERN)) {
    const value = match[1].trim();
    const key = value.toLocaleLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      links.push(value);
    }
  }

  return links;
}

export function parseDescriptionLines(description = "") {
  return description.split("\n").map((line) => {
    const prefix = line.match(/^[ \t　]+/u)?.[0] || "";
    return { depth: [...prefix].length, prefix, text: line.slice(prefix.length) };
  });
}

export function flattenBookmarks(nodes, parentPath = []) {
  const result = [];

  for (const node of nodes) {
    if (node.url) {
      result.push({
        id: node.id,
        title: node.title || node.url,
        url: node.url,
        dateAdded: node.dateAdded || 0,
        folder: parentPath.join(" / ")
      });
    }

    if (node.children) {
      const nextPath = node.url || !node.title ? parentPath : [...parentPath, node.title];
      result.push(...flattenBookmarks(node.children, nextPath));
    }
  }

  return result;
}

function normalize(value) {
  return (value || "").normalize("NFKC").toLocaleLowerCase().trim();
}

export function resolveLinkTarget(title, bookmarks) {
  const normalizedTitle = normalize(title);
  const matches = bookmarks.filter((bookmark) => normalize(bookmark.title) === normalizedTitle);
  if (matches.length === 1) return { type: "bookmark", bookmark: matches[0] };
  return { type: "virtual", title: title.trim(), matches };
}

export function targetKey(target) {
  return target.type === "bookmark"
    ? `bookmark:${target.bookmark.id}`
    : `virtual:${normalize(target.title)}`;
}

export function buildLinkGraph(bookmarks, metadata) {
  const relations = new Map();
  const add = (key, label) => {
    if (!relations.has(key)) relations.set(key, new Set());
    relations.get(key).add(label);
  };

  for (const bookmark of bookmarks) {
    const sourceKey = `bookmark:${bookmark.id}`;
    for (const label of extractLinks(metadata[bookmark.id]?.description || "")) {
      const target = resolveLinkTarget(label, bookmarks);
      const destinationKey = targetKey(target);
      add(sourceKey, label);
      add(destinationKey, bookmark.title);
    }
  }

  return new Map([...relations].map(([key, labels]) => [key, [...labels]]));
}

function fieldScore(value, query, base) {
  const text = normalize(value);
  if (!text) return null;
  if (text === query) return base;
  if (text.startsWith(query)) return base + 10;
  const index = text.indexOf(query);
  if (index < 0) return null;
  const previous = index === 0 ? "" : text[index - 1];
  return /[^\p{L}\p{N}]/u.test(previous) ? base + 20 : base + 30;
}

export function searchBookmarks(bookmarks, metadata, rawQuery) {
  const query = normalize(rawQuery);
  if (!query) {
    return [...bookmarks].sort((a, b) => b.dateAdded - a.dateAdded);
  }

  return bookmarks
    .map((bookmark) => {
      const description = metadata[bookmark.id]?.description || "";
      const scores = [
        fieldScore(bookmark.title, query, 0),
        fieldScore(bookmark.url, query, 40),
        fieldScore(description, query, 70),
        ...extractLinks(description).map((link) => fieldScore(link, query, 60))
      ].filter((score) => score !== null);

      return scores.length ? { bookmark, score: Math.min(...scores) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score || b.bookmark.dateAdded - a.bookmark.dateAdded)
    .map(({ bookmark }) => bookmark);
}

export function isImeKeyEvent(event) {
  return Boolean(event.isComposing || event.keyCode === 229);
}

export function shouldInsertIndent(event) {
  return event.key === "Tab" && !isImeKeyEvent(event);
}

export function describeEditorLine(text, active) {
  const prefix = text.match(/^[ \t　]+/u)?.[0] || "";
  const links = active
    ? []
    : [...text.matchAll(/\[([^\[\]\n]+)\]/g)].map((match) => ({
      from: match.index,
      to: match.index + match[0].length,
      label: match[1].trim()
    }));
  return {
    bullet: Boolean(prefix),
    depth: [...prefix].length,
    prefixLength: prefix.length,
    links
  };
}

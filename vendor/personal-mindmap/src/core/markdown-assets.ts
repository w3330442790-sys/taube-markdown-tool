export const MARKDOWN_TABLE_TEMPLATE = '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |';

/** Content that needs a visible note card to be useful on the canvas. */
export function hasMarkdownAssets(note: string | undefined): boolean {
  if (!note) return false;
  let fence: string | undefined;
  const lines = note.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (/^\s*<table(?:\s|>)/i.test(line) || /(?:^|[^\\])!\[\[[^\]]+\]\]|(?:^|[^\\])!\[[^\]]*\]\(/.test(line)) return true;
    if (line.includes('|') && /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1] ?? '')) return true;
  }
  return false;
}

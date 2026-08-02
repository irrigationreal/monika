export function fencedCodeBlock(content: string, before = '', after = ''): string {
  let longestBacktickRun = 0;
  for (const match of content.matchAll(/`+/g)) {
    longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
  }

  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  const leadingBoundary = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
  const trailingBoundary = after.length > 0 && !after.startsWith('\n') ? '\n' : '';
  return `${leadingBoundary}${fence}\n${content}\n${fence}${trailingBoundary}`;
}

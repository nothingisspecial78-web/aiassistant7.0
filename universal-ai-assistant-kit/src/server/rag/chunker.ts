export interface DocChunkInput {
  chunkIndex: number;
  source: string;
  heading: string;
  content: string;
}

export function estimateTokens(text: string): number {
  return Math.ceil(String(text || '').length / 4);
}

export function chunkMarkdownDocument(
  source: string,
  markdown: string,
  maxChars = 900,
  overlapChars = 150
): DocChunkInput[] {
  const normalized = markdown.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const lines = normalized.split('\n');
  const sections: Array<{ heading: string; text: string }> = [];
  let currentHeading = source.replace(/\.md$/i, '');
  let buffer: string[] = [];

  for (const line of lines) {
    const headingMatch = /^#{1,3}\s+(.+)$/.exec(line.trim());
    if (headingMatch) {
      if (buffer.length > 0) {
        const text = buffer.join('\n').trim();
        if (text) sections.push({ heading: currentHeading, text });
        buffer = [];
      }
      currentHeading = headingMatch[1].trim();
    }
    buffer.push(line);
  }
  if (buffer.length > 0) {
    const text = buffer.join('\n').trim();
    if (text) sections.push({ heading: currentHeading, text });
  }

  const chunks: DocChunkInput[] = [];
  let globalIdx = 0;

  for (const sec of sections) {
    if (sec.text.length <= maxChars) {
      chunks.push({
        chunkIndex: globalIdx++,
        source,
        heading: sec.heading,
        content: sec.text,
      });
      continue;
    }

    let start = 0;
    while (start < sec.text.length) {
      const end = Math.min(start + maxChars, sec.text.length);
      const slice = sec.text.slice(start, end).trim();
      if (slice) {
        chunks.push({
          chunkIndex: globalIdx++,
          source,
          heading: sec.heading,
          content: slice,
        });
      }
      if (end >= sec.text.length) break;
      start = Math.max(start + 1, end - overlapChars);
    }
  }

  return chunks;
}

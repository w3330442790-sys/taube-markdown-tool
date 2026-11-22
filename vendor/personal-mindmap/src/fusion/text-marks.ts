import type { MindDoc, Topic } from '../core/types';

export type TextMarkFormat = 'highlight' | 'underline' | 'strikethrough' | 'bold' | 'text-color';
export interface SourceTextMark {
  from: number;
  to: number;
  text: string;
  format: TextMarkFormat;
  color?: string;
}
export interface TopicTextMarks {
  id: string;
  text: string;
  marks: SourceTextMark[];
}

export function projectTextMarks(source: string, doc: MindDoc, marks: SourceTextMark[]): TopicTextMarks[] {
  const valid = marks.filter(mark => Number.isInteger(mark.from) && Number.isInteger(mark.to) &&
    mark.from >= 0 && mark.to > mark.from && mark.to <= source.length &&
    source.slice(mark.from, mark.to) === mark.text);
  if (!valid.length) return [];

  const lines = source.split('\n');
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const result: TopicTextMarks[] = [];
  const visit = (topic: Topic) => {
    const line = (topic.markdown as { sourceLine?: number } | undefined)?.sourceLine;
    if (line !== undefined && topic.text) {
      const prefix = /^(?:#{1,6}[ \t]+|[ \t]*(?:[-*+]|\d+[.)])[ \t]+)/.exec(lines[line] ?? '')?.[0];
      if (prefix && lines[line].startsWith(topic.text, prefix.length)) {
        const start = offsets[line] + prefix.length;
        const end = start + topic.text.length;
        const local = valid.filter(mark => mark.from < end && mark.to > start).map(mark => ({
          ...mark,
          from: Math.max(start, mark.from) - start,
          to: Math.min(end, mark.to) - start,
        }));
        if (local.length) result.push({ id: topic.id, text: topic.text, marks: local });
      }
    }
    topic.children?.forEach(visit);
  };
  visit(doc.root);
  doc.floating?.forEach(visit);
  return result;
}

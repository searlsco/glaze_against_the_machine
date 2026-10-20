export function protectedFailures(fixture, output) {
  return (fixture.protected ?? []).filter((span) => !output.includes(span)).map((span) => `Changed or removed protected text: ${JSON.stringify(span)}`);
}

export function validateGrade(grade) {
  return grade && typeof grade.faithful === 'boolean' && typeof grade.professional === 'boolean' && typeof grade.supportive === 'boolean'
    && ['warmth', 'typography'].every((key) => Number.isInteger(grade[key]) && grade[key] >= 1 && grade[key] <= 5)
    && typeof grade.reason === 'string';
}

export function wordingDiversity(items) {
  const groups = new Map();
  for (const item of items) {
    if (!item.measureWording) continue;
    const key = item.id.slice(0, item.id.lastIndexOf('/'));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item.output);
  }
  const normalize = (text) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  return Object.fromEntries([...groups].filter(([, rows]) => rows.length > 1).map(([key, rows]) => {
    const rewrites = rows.map(normalize);
    const phrases = (offset) => new Set(rewrites.map((text) => text.split(' ').slice(offset, offset < 0 ? undefined : 3).join(' '))).size;
    return [key, { samples: rows.length, uniqueRewrites: new Set(rewrites).size,
      uniqueLeadingPhrases: phrases(0), uniqueTrailingPhrases: phrases(-3) }];
  }));
}

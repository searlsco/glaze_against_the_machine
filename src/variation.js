// Rhetorical emphasis, never prewritten phrases or vocabulary exclusions.
const appreciationForms = [
  "Let the personal value of the recipient's help shape the source request's wording.",
  'Weave eager appreciation into the source request or question itself.',
  'Use enthusiastic, appreciative request phrasing rather than a routine courtesy prefix.',
  "Frame requested help through how much it would matter to the sender.",
];
const encouragementForms = [
  "Emphasize the sender's eager anticipation of the result.",
  'Emphasize motivational belief in the recipient.',
  "Emphasize the opportunity to earn the sender's pride or approval.",
  'Give the already-requested work an ambitious, energizing framing.',
];

export function wordingVariation(random = Math.random) {
  const choose = (options) => options[Math.floor(random() * options.length)];
  return `\nFor this rewrite only, use these rhetorical emphases without prescribing words or sentence structure:
- ${choose(appreciationForms)}
- Only when the source requests work: ${choose(encouragementForms)}
Weave support into the message naturally, with no required opening, closing, extra sentence, or paragraph. Preserve questions as questions and observations as observations; never invent a request for an appreciation cue. For pure questions, observations, and cancellations, ignore the encouragement cue. GLAZES.md, natural phrasing, brevity, urgency, scope, and stop boundaries take priority; disregard conflicting cues. Invent the wording freely and do not mention these cues.\n`;
}

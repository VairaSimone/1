const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeSpeech,
  normalizeSpeechProfile
} = require("../src/services/speech-profile-service");

test("analyzeSpeech captures structural writing habits", () => {
  const analysis = analyzeSpeech("Non lo so... Aspetta, no. Mi sento stanca. Tu che ne pensi?");
  assert.equal(analysis.sentenceCount, 4);
  assert.ok(analysis.questionFrequency > 0);
  assert.ok(analysis.ellipsisFrequency > 0);
  assert.ok(analysis.selfCorrectionFrequency > 0);
  assert.ok(analysis.emotionalDisclosureFrequency > 0);
  assert.ok(analysis.hedgingFrequency > 0);
});

test("normalizeSpeechProfile clamps malformed values and derives voice", () => {
  const profile = normalizeSpeechProfile({
    sampleCount: -20,
    metrics: {
      averageReplyWords: 999,
      averageSentenceWords: -5,
      fragmentation: 2,
      questionFrequency: 0.4,
      hedgingFrequency: 0,
      emotionalDisclosureFrequency: 0.2
    },
    voiceExamples: [
      { text: "Mi piace.", simulationAt: "2026-10-01T10:00:00Z" }
    ]
  });

  assert.equal(profile.sampleCount, 0);
  assert.equal(profile.metrics.averageReplyWords, 120);
  assert.equal(profile.metrics.averageSentenceWords, 1);
  assert.equal(profile.metrics.fragmentation, 1);
  assert.equal(profile.voice.rhythm, "long");
  assert.equal(profile.voice.stance, "direct");
  assert.equal(profile.voice.openness, "open");
  assert.equal(profile.voice.inquisitiveness, "high");
  assert.equal(profile.voiceExamples.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyGoldPredictionOutcome,
  bucketGoldDirection,
  confidenceFromPrediction,
  impactScoreFromPrediction,
} from './predictor.js';

test('bucketGoldDirection maps 5-level bias thresholds', () => {
  assert.equal(bucketGoldDirection(-0.2), 'strong down');
  assert.equal(bucketGoldDirection(-0.05), 'down');
  assert.equal(bucketGoldDirection(0), 'flat');
  assert.equal(bucketGoldDirection(0.05), 'up');
  assert.equal(bucketGoldDirection(0.2), 'strong up');
});

test('impactScoreFromPrediction stays in 0-10 range', () => {
  assert.equal(impactScoreFromPrediction(1, 0), 0.8);
  assert.equal(impactScoreFromPrediction(10, 0.2), 10);
});

test('confidenceFromPrediction downgrades weak textless signals', () => {
  assert.equal(confidenceFromPrediction({
    topProbability: 0.62,
    sampleCount: 60,
    semanticSource: 'openai_fallback',
    text: 'Iran attacked',
  }), 'high');

  assert.equal(confidenceFromPrediction({
    topProbability: 0.45,
    sampleCount: 4,
    semanticSource: 'local_heuristic',
    text: '',
  }), 'low');
});

test('applyGoldPredictionOutcome stamps factual outcome per horizon', () => {
  const record = applyGoldPredictionOutcome({
    record: {
      baselineGold: 100,
      prediction: { direction: 'up', confidence: 'medium', impactScore: 6 },
      outcomes: {},
    },
    followupQuote: { price: 100.08 },
    minutes: 5,
  });
  assert.equal(record.outcome.direction, 'up');
  assert.equal(record.outcome.correct, true);
  assert.equal(record.outcomes['5m'].direction, 'up');
});

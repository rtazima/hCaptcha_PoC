import { describe, expect, it } from 'vitest';
import {
  FEATURE_COUNT,
  FEATURE_VERSION,
  computeCorpusStats,
  emptyCorpusStats,
  extractFeatures,
  type FeatureVector,
} from '../src/biometrics/features.js';
import { buildTemplate } from '../src/biometrics/template.js';
import {
  DEFAULT_MATCH_PARAMS,
  identify,
  matchScore,
  similarityFromDistance,
} from '../src/biometrics/match.js';
import { generateSample, makeBotProfile, makeProfile, makeRng } from '../src/simulator/synth.js';

let sessionCounter = 0;
function nextSession(): string {
  sessionCounter += 1;
  return `sessao-teste-${String(sessionCounter).padStart(6, '0')}`;
}

function vectorsFor(profileSeed: number, count: number, rngSeed = 99): FeatureVector[] {
  const profileRng = makeRng(profileSeed);
  const profile = makeProfile(`p-${profileSeed}`, profileRng);
  const rng = makeRng(rngSeed);
  return Array.from({ length: count }, () =>
    extractFeatures(generateSample(profile, rng, { sessionId: nextSession() })).vector,
  );
}

describe('similarityFromDistance', () => {
  it('é monotonicamente decrescente e vale 0.5 no ponto médio', () => {
    const p = DEFAULT_MATCH_PARAMS;
    expect(similarityFromDistance(p.calibrationMidpoint, p)).toBeCloseTo(0.5, 6);
    expect(similarityFromDistance(0, p)).toBeGreaterThan(0.99);
    expect(similarityFromDistance(6, p)).toBeLessThan(0.01);
    let previous = 1;
    for (let d = 0; d <= 4; d += 0.25) {
      const s = similarityFromDistance(d, p);
      expect(s).toBeLessThanOrEqual(previous);
      previous = s;
    }
  });
});

describe('matchScore', () => {
  it('dá distância zero e similaridade máxima ao próprio centróide', () => {
    const vectors = vectorsFor(1, 6);
    const template = buildTemplate(vectors);
    const corpus = computeCorpusStats([vectors]);
    const centroidAsProbe: FeatureVector = {
      version: FEATURE_VERSION,
      values: template.centroid,
    };

    const match = matchScore(template, centroidAsProbe, corpus)!;
    expect(match.distance).toBeCloseTo(0, 6);
    expect(match.similarity).toBeGreaterThan(0.99);
    expect(match.dimensionsCompared).toBeGreaterThan(30);
  });

  it('separa genuíno de impostor', () => {
    const enrolA = vectorsFor(1, 6);
    const enrolB = vectorsFor(2, 6);
    const corpus = computeCorpusStats([enrolA, enrolB]);
    const templateA = buildTemplate(enrolA);

    // amostras novas, não usadas no template
    const probeA = vectorsFor(1, 3, 555);
    const probeB = vectorsFor(2, 3, 555);

    const genuine = probeA.map((v) => matchScore(templateA, v, corpus)!.similarity);
    const impostor = probeB.map((v) => matchScore(templateA, v, corpus)!.similarity);

    const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(meanOf(genuine)).toBeGreaterThan(meanOf(impostor));
    expect(Math.min(...genuine)).toBeGreaterThan(Math.max(...impostor));
  });

  it('rejeita comportamento robótico contra template humano', () => {
    const human = vectorsFor(4, 6);
    const corpus = computeCorpusStats([human]);
    const template = buildTemplate(human);

    const rng = makeRng(31);
    const botVector = extractFeatures(
      generateSample(makeBotProfile('bot'), rng, { sessionId: nextSession() }),
    ).vector;

    const match = matchScore(template, botVector, corpus)!;
    expect(match.similarity).toBeLessThan(0.2);
    expect(match.topContributors.length).toBeGreaterThan(0);
  });

  it('devolve null quando a versão de features não bate', () => {
    const vectors = vectorsFor(5, 4);
    const template = buildTemplate(vectors);
    const corpus = emptyCorpusStats();
    expect(matchScore({ ...template, version: 999 }, vectors[0], corpus)).toBeNull();
    expect(matchScore(template, { ...vectors[0], version: 999 }, corpus)).toBeNull();
  });

  it('devolve null quando não há dimensão comparável', () => {
    const template = buildTemplate([
      { version: FEATURE_VERSION, values: new Array(FEATURE_COUNT).fill(null) },
    ]);
    const probe: FeatureVector = { version: FEATURE_VERSION, values: new Array(FEATURE_COUNT).fill(1) };
    expect(matchScore(template, probe, emptyCorpusStats())).toBeNull();
  });

  it('compara apenas as dimensões presentes nos dois lados', () => {
    const vectors = vectorsFor(6, 5);
    const corpus = computeCorpusStats([vectors]);
    const template = buildTemplate(vectors);

    const parcial: FeatureVector = {
      version: FEATURE_VERSION,
      values: vectors[0].values.map((v, i) => (i % 2 === 0 ? v : null)),
    };
    const match = matchScore(template, parcial, corpus)!;
    const completo = matchScore(template, vectors[0], corpus)!;
    expect(match.dimensionsCompared).toBeLessThan(completo.dimensionsCompared);
    expect(match.perGroup).toBeDefined();
  });

  it('limita o z-score por dimensão (robustez a outlier extremo)', () => {
    const vectors = vectorsFor(7, 5);
    const corpus = computeCorpusStats([vectors]);
    const template = buildTemplate(vectors);

    const absurdo: FeatureVector = {
      version: FEATURE_VERSION,
      values: vectors[0].values.map((v) => (v == null ? null : v + 1e9)),
    };
    const match = matchScore(template, absurdo, corpus)!;
    // com zClip=4 a distância satura perto de 4, não em infinito
    expect(match.distance).toBeLessThanOrEqual(DEFAULT_MATCH_PARAMS.zClip + 1e-6);
    expect(Number.isFinite(match.distance)).toBe(true);
    expect(match.similarity).toBeLessThan(0.001);
  });
});

describe('identify (1:N)', () => {
  it('coloca a pessoa certa em 1º lugar', () => {
    const galleryVectors = [1, 2, 3, 4, 5].map((seed) => ({
      userId: `user-${seed}`,
      vectors: vectorsFor(seed, 6),
    }));
    const corpus = computeCorpusStats(galleryVectors.map((g) => g.vectors));
    const gallery = galleryVectors.map((g) => ({
      userId: g.userId,
      displayName: g.userId,
      template: buildTemplate(g.vectors),
    }));

    for (const entry of galleryVectors) {
      const seed = Number(entry.userId.split('-')[1]);
      const probe = vectorsFor(seed, 1, 4242)[0];
      const ranked = identify(gallery, probe, corpus);
      expect(ranked[0].userId).toBe(entry.userId);
      expect(ranked).toHaveLength(gallery.length);
      // ordenação decrescente por similaridade
      for (let i = 1; i < ranked.length; i++) {
        expect(ranked[i - 1].match.similarity).toBeGreaterThanOrEqual(ranked[i].match.similarity);
      }
    }
  });

  it('devolve lista vazia para galeria vazia', () => {
    const probe = vectorsFor(9, 1)[0];
    expect(identify([], probe, emptyCorpusStats())).toEqual([]);
  });
});

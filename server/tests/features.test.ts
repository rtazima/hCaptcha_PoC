import { describe, expect, it } from 'vitest';
import {
  FEATURE_COUNT,
  FEATURE_INDEX,
  FEATURE_NAMES,
  FEATURES,
  computeCorpusStats,
  extractFeatures,
} from '../src/biometrics/features.js';
import type { RawSample } from '../src/biometrics/contract.js';
import { generateSample, makeProfile, makeRng } from '../src/simulator/synth.js';

function emptySample(overrides: Partial<RawSample> = {}): RawSample {
  return {
    sessionId: 'sessao-de-teste-0001',
    task: 'teste',
    device: { os: 'test' },
    keystrokes: [],
    taps: [],
    gestures: [],
    motion: [],
    timings: { durationMs: 0, firstInteractionMs: null },
    ...overrides,
  };
}

describe('catálogo de features', () => {
  it('tem nomes únicos e índice consistente', () => {
    expect(new Set(FEATURE_NAMES).size).toBe(FEATURE_COUNT);
    for (const [name, index] of Object.entries(FEATURE_INDEX)) {
      expect(FEATURE_NAMES[index]).toBe(name);
    }
  });

  it('define escala prior positiva para toda dimensão', () => {
    for (const feature of FEATURES) {
      expect(feature.priorScale, feature.name).toBeGreaterThan(0);
    }
  });
});

describe('extractFeatures', () => {
  it('reprova amostra vazia e não inventa valores', () => {
    const { vector, quality } = extractFeatures(emptySample());
    expect(vector.values).toHaveLength(FEATURE_COUNT);
    expect(quality.ok).toBe(false);
    expect(quality.availableGroups).toEqual(['session']);
    expect(quality.issues.length).toBeGreaterThan(0);
    // sem eventos, só o grupo de sessão pode ter algo — e nada explode
    expect(vector.values.filter((v) => v != null).length).toBeLessThan(6);
  });

  it('aprova amostra sintética completa e marca todos os grupos', () => {
    const rng = makeRng(7);
    const sample = generateSample(makeProfile('p1', rng), rng, { sessionId: 'sessao-teste-1234' });
    const { vector, quality } = extractFeatures(sample);

    expect(quality.ok).toBe(true);
    expect(quality.availableGroups.sort()).toEqual(
      ['gesture', 'keystroke', 'motion', 'session', 'tap'].sort(),
    );
    expect(quality.issues).toEqual([]);
    // nenhuma dimensão fica nula quando há dados de todos os grupos
    const missing = vector.values
      .map((v, i) => (v == null ? FEATURE_NAMES[i] : null))
      .filter(Boolean);
    expect(missing).toEqual([]);
    for (const value of vector.values) expect(Number.isFinite(value as number)).toBe(true);
  });

  it('marca grupos ausentes sem contaminar os presentes', () => {
    const rng = makeRng(11);
    const full = generateSample(makeProfile('p2', rng), rng, { sessionId: 'sessao-teste-5678' });
    const semDigitacao = extractFeatures({ ...full, keystrokes: [] });

    expect(semDigitacao.quality.availableGroups).not.toContain('keystroke');
    expect(semDigitacao.vector.values[FEATURE_INDEX.k_ft_mean_log]).toBeNull();
    expect(semDigitacao.vector.values[FEATURE_INDEX.g_vmean_mean]).not.toBeNull();
    // gestos sozinhos ainda são um grupo discriminativo
    expect(semDigitacao.quality.ok).toBe(true);
  });

  it('digitação mais lenta produz intervalo médio maior', () => {
    const rapido = emptySample({
      keystrokes: Array.from({ length: 20 }, (_, i) => ({ t: i * 120, cls: 'char' as const })),
      timings: { durationMs: 4000, firstInteractionMs: 300 },
    });
    const lento = emptySample({
      keystrokes: Array.from({ length: 20 }, (_, i) => ({ t: i * 480, cls: 'char' as const })),
      timings: { durationMs: 12000, firstInteractionMs: 300 },
    });

    const i = FEATURE_INDEX.k_ft_mean_log;
    const vRapido = extractFeatures(rapido).vector.values[i] as number;
    const vLento = extractFeatures(lento).vector.values[i] as number;
    expect(vLento).toBeGreaterThan(vRapido);
    // ritmo perfeitamente regular => desvio ~0
    expect(extractFeatures(rapido).vector.values[FEATURE_INDEX.k_ft_std_log]).toBeCloseTo(0, 5);
  });

  it('conta backspaces como classe de tecla', () => {
    const sample = emptySample({
      keystrokes: Array.from({ length: 20 }, (_, i) => ({
        t: i * 200,
        cls: i % 4 === 0 ? ('backspace' as const) : ('char' as const),
      })),
      timings: { durationMs: 5000, firstInteractionMs: 200 },
    });
    expect(extractFeatures(sample).vector.values[FEATURE_INDEX.k_backspace_ratio]).toBeCloseTo(
      0.25,
      5,
    );
  });

  it('gesto reto tem retidão maior que gesto curvo', () => {
    const straight = emptySample({
      gestures: [
        {
          points: Array.from({ length: 20 }, (_, i) => ({ t: i * 16, x: 0.1 + i * 0.03, y: 0.5 })),
        },
        {
          points: Array.from({ length: 20 }, (_, i) => ({ t: i * 16, x: 0.1 + i * 0.03, y: 0.4 })),
        },
        {
          points: Array.from({ length: 20 }, (_, i) => ({ t: i * 16, x: 0.1 + i * 0.03, y: 0.6 })),
        },
      ],
      timings: { durationMs: 4000, firstInteractionMs: 200 },
    });
    const curved = emptySample({
      gestures: straight.gestures.map((g) => ({
        points: g.points.map((p, i) => ({ ...p, y: p.y + 0.25 * Math.sin((Math.PI * i) / 19) })),
      })),
      timings: { durationMs: 4000, firstInteractionMs: 200 },
    });

    const i = FEATURE_INDEX.g_straightness_mean;
    expect(extractFeatures(straight).vector.values[i] as number).toBeGreaterThan(
      extractFeatures(curved).vector.values[i] as number,
    );
    expect(extractFeatures(curved).vector.values[FEATURE_INDEX.g_curv_mean] as number).toBeGreaterThan(
      0,
    );
  });

  it('descarta traço degenerado (poucos pontos ou duração zero)', () => {
    const sample = emptySample({
      gestures: [
        { points: [{ t: 0, x: 0.1, y: 0.1 }] },
        { points: [{ t: 0, x: 0.1, y: 0.1 }, { t: 0, x: 0.2, y: 0.2 }, { t: 0, x: 0.3, y: 0.3 }] },
      ],
      timings: { durationMs: 3000, firstInteractionMs: 100 },
    });
    const { quality } = extractFeatures(sample);
    expect(quality.counts.gestures).toBe(0);
    expect(quality.availableGroups).not.toContain('gesture');
  });
});

describe('computeCorpusStats', () => {
  it('atribui peso baixo a dimensão que só tem ruído', () => {
    const rng = makeRng(3);
    // 6 pessoas: a dimensão 0 é pura aleatoriedade; a 1 separa as pessoas
    const perUser = Array.from({ length: 6 }, (_, u) =>
      Array.from({ length: 5 }, () => ({
        version: 1,
        values: Array.from({ length: FEATURE_COUNT }, (_, dim) => {
          if (dim === 0) return rng.gauss(); // igual para todos
          if (dim === 1) return u * 3 + 0.05 * rng.gauss(); // separa pessoas
          return 0;
        }),
      })),
    );

    const stats = computeCorpusStats(perUser);
    expect(stats.users).toBe(6);
    expect(stats.weights[0]).toBeLessThan(0.3);
    expect(stats.weights[1]).toBeGreaterThan(0.9);
  });

  it('usa pesos neutros quando o corpus é pequeno demais', () => {
    const stats = computeCorpusStats([
      [{ version: 1, values: new Array(FEATURE_COUNT).fill(1) }],
      [{ version: 1, values: new Array(FEATURE_COUNT).fill(2) }],
    ]);
    expect(stats.weights.every((w) => w === 1)).toBe(true);
    // escala nunca colapsa a zero, senão o z-score explodiria
    expect(stats.scales.every((s) => s > 0)).toBe(true);
  });

  it('ignora vetores de outra versão de features', () => {
    const stats = computeCorpusStats([[{ version: 999, values: new Array(FEATURE_COUNT).fill(1) }]]);
    expect(stats.counts.every((c) => c === 0)).toBe(true);
  });
});

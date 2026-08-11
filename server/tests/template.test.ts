import { describe, expect, it } from 'vitest';
import { buildTemplate } from '../src/biometrics/template.js';
import { FEATURE_COUNT, FEATURE_VERSION, type FeatureVector } from '../src/biometrics/features.js';
import { autocorr1, diffs, iqr, mad, median, normalizedEntropy, quantile, std } from '../src/biometrics/stats.js';
import { robustSpread } from '../src/biometrics/features.js';

function vec(values: Array<number | null>): FeatureVector {
  const full: Array<number | null> = new Array(FEATURE_COUNT).fill(null);
  values.forEach((v, i) => (full[i] = v));
  return { version: FEATURE_VERSION, values: full };
}

describe('estatísticas', () => {
  it('mediana e quantis com interpolação', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([], 0.5)).toBe(0);
    expect(iqr([1, 2, 3, 4, 5])).toBe(2);
  });

  it('MAD e dispersão robusta ignoram outlier', () => {
    const limpo = [10, 11, 12, 13, 14];
    const comOutlier = [...limpo, 900];
    // o MAD quase não se move com um outlier: 1 -> 1.5
    expect(mad(comOutlier)).toBeLessThanOrEqual(2);
    // o desvio-padrão clássico explode; a dispersão robusta não
    expect(std(comOutlier)).toBeGreaterThan(std(limpo) * 10);
    expect(robustSpread(comOutlier)).toBeLessThan(std(comOutlier));
  });

  it('dispersão robusta cai para o IQR quando o MAD é zero', () => {
    // metade dos valores idênticos zera o MAD, mas há espalhamento real
    expect(robustSpread([5, 5, 5, 5, 5, 9, 13, 17])).toBeGreaterThan(0);
    expect(robustSpread([7, 7, 7, 7])).toBe(0);
  });

  it('autocorrelação e entropia em casos de borda', () => {
    expect(autocorr1([1, 1, 1, 1])).toBe(0);
    expect(autocorr1([1, 2])).toBe(0);
    expect(autocorr1([1, 2, 1, 2, 1, 2])).toBeLessThan(0);
    expect(normalizedEntropy([1, 1, 1, 1])).toBeCloseTo(1, 6);
    expect(normalizedEntropy([4, 0, 0, 0])).toBeCloseTo(0, 6);
    expect(normalizedEntropy([0, 0])).toBe(0);
  });

  it('diffs devolve as diferenças consecutivas', () => {
    expect(diffs([1, 4, 9])).toEqual([3, 5]);
    expect(diffs([5])).toEqual([]);
  });
});

describe('buildTemplate', () => {
  it('usa a mediana como centróide, resistindo a uma amostra ruim', () => {
    const template = buildTemplate([vec([10]), vec([11]), vec([12]), vec([13]), vec([500])]);
    expect(template.centroid[0]).toBe(12);
    expect(template.samples).toBe(5);
    expect(template.support[0]).toBe(5);
    expect(template.spread[0]).toBeGreaterThan(0);
    expect(Date.parse(template.builtAt)).toBeGreaterThan(0);
  });

  it('conta o suporte por dimensão e ignora nulos', () => {
    const template = buildTemplate([vec([1, 2]), vec([3, null]), vec([5, null])]);
    expect(template.centroid[0]).toBe(3);
    expect(template.support[0]).toBe(3);
    expect(template.centroid[1]).toBe(2);
    expect(template.support[1]).toBe(1);
    // uma única observação não permite estimar dispersão
    expect(template.spread[1]).toBeNull();
  });

  it('deixa nula a dimensão nunca observada', () => {
    const template = buildTemplate([vec([1]), vec([2])]);
    expect(template.centroid[5]).toBeNull();
    expect(template.support[5]).toBe(0);
  });

  it('ignora vetores de outra versão de features', () => {
    const template = buildTemplate([
      vec([1]),
      { version: 999, values: new Array(FEATURE_COUNT).fill(1000) },
    ]);
    expect(template.samples).toBe(1);
    expect(template.centroid[0]).toBe(1);
  });

  it('lida com lista vazia sem quebrar', () => {
    const template = buildTemplate([]);
    expect(template.samples).toBe(0);
    expect(template.centroid.every((v) => v === null)).toBe(true);
  });
});

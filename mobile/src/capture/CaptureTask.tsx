/**
 * Tarefa de captura usada nas três telas (cadastro, 1:1 e 1:N).
 *
 * A tarefa é sempre a mesma de propósito: digitar a MESMA frase, arrastar na
 * mesma área e tocar nos mesmos alvos. Dinâmica de digitação com texto fixo é
 * bem mais estável que com texto livre, e comparar capturas equivalentes é o
 * que torna o template comparável.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius, spacing } from '../theme';
import { Button, Card, Checklist, Notice } from '../components/ui';
import { CAPTURE_MINIMUMS, type CaptureCounts } from './recorder';
import { CaptureSurface } from './CaptureSurface';
import type { UseCaptureResult } from './useCapture';

/** Frase fixa: mesma em cadastro e verificação. */
export const CAPTURE_PHRASE = 'biometria comportamental em teste';

const TAP_TARGET_COUNT = 6;

export function CaptureTask({ capture }: { capture: UseCaptureResult }) {
  const { counts, typing, tap, motionAvailable, requestMotionPermission } = capture;
  const [tappedIndexes, setTappedIndexes] = useState<number[]>([]);

  const typedOk = counts.keystrokes >= CAPTURE_MINIMUMS.keystrokes;
  const swipeOk = counts.gestures >= CAPTURE_MINIMUMS.gestures;
  const tapOk = counts.taps >= CAPTURE_MINIMUMS.taps;
  // sem sensores acessíveis o grupo é dispensado (o servidor aceita 4 de 5
   // grupos); exigir aqui travaria o app no Safari do iOS
  const motionOk = counts.motion === 0 || counts.motion >= CAPTURE_MINIMUMS.motion;
  const motionMissing = counts.motion === 0;
  const timeOk = counts.elapsedMs >= CAPTURE_MINIMUMS.durationMs;

  return (
    <>
      <Card
        title="1. Digite a frase"
        subtitle="O que conta é o ritmo entre as teclas, não o texto. Nada do que você digita é enviado."
      >
        <View style={styles.phraseBox}>
          <Text style={styles.phrase}>{CAPTURE_PHRASE}</Text>
        </View>
        <TextInput
          testID="capture-typing"
          style={styles.input}
          value={typing.value}
          onChangeText={typing.onChangeText}
          onKeyPress={typing.onKeyPress}
          placeholder="digite aqui..."
          placeholderTextColor={colors.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          multiline
          textAlignVertical="top"
        />
        <Text style={styles.hint}>
          {counts.keystrokes}/{CAPTURE_MINIMUMS.keystrokes} teclas
          {capture.recorder.pasteCount > 0 ? '  ·  colagem detectada (evite colar)' : ''}
        </Text>
      </Card>

      <Card
        title="2. Arraste na área abaixo"
        subtitle="Velocidade, curvatura e desaceleração do dedo são a parte mais discriminativa da captura."
      >
        <CaptureSurface
          capture={capture}
          count={counts.gestures}
          required={CAPTURE_MINIMUMS.gestures}
        />
      </Card>

      <Card
        title="3. Toque nos alvos"
        subtitle="Mede o tempo de pressão e o intervalo entre toques."
      >
        <View style={styles.targets}>
          {Array.from({ length: TAP_TARGET_COUNT }, (_, index) => {
            const hit = tappedIndexes.includes(index);
            return (
              <Pressable
                key={index}
                testID={`capture-tap-${index}`}
                onPressIn={(event) => {
                  tap.onPressIn(event);
                  setTappedIndexes((previous) =>
                    previous.includes(index) ? previous : [...previous, index],
                  );
                }}
                onPressOut={tap.onPressOut}
                style={({ pressed }) => [
                  styles.target,
                  hit && styles.targetHit,
                  pressed && styles.targetPressed,
                ]}
              >
                <Text style={styles.targetText}>{index + 1}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>
          {counts.taps}/{CAPTURE_MINIMUMS.taps} toques
        </Text>
      </Card>

      {motionMissing && requestMotionPermission ? (
        <Card title="Sensores de movimento">
          <Notice
            text={
              'Este navegador só libera acelerômetro e giroscópio com sua permissão. Sem eles a ' +
              'captura funciona, mas usa 4 dos 5 grupos de sinais — o template fica mais fraco.'
            }
          />
          <Button label="Permitir sensores" onPress={() => void requestMotionPermission()} />
        </Card>
      ) : null}

      <Card title="Progresso da captura">
        <Checklist
          items={[
            { label: 'Digitação', done: typedOk, detail: `${counts.keystrokes} teclas` },
            { label: 'Arraste', done: swipeOk, detail: `${counts.gestures} gestos` },
            { label: 'Toques', done: tapOk, detail: `${counts.taps} toques` },
            {
              label: 'Movimento do aparelho',
              done: motionOk,
              detail: motionMissing
                ? motionAvailable
                  ? 'aguardando sensor…'
                  : 'indisponível (opcional)'
                : `${counts.motion} amostras`,
            },
            { label: 'Duração mínima', done: timeOk, detail: formatDuration(counts) },
          ]}
        />
      </Card>
    </>
  );
}

function formatDuration(counts: CaptureCounts): string {
  return `${(counts.elapsedMs / 1000).toFixed(1)}s`;
}

const styles = StyleSheet.create({
  phraseBox: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  phrase: { color: colors.primary, fontSize: 15, fontWeight: '600', letterSpacing: 0.3 },
  input: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 15,
    minHeight: 68,
  },
  hint: { color: colors.textDim, fontSize: 12, marginTop: spacing.sm },
  targets: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, justifyContent: 'center' },
  target: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  targetHit: { borderColor: colors.allow },
  targetPressed: { backgroundColor: colors.primaryDark },
  targetText: { color: colors.text, fontSize: 16, fontWeight: '600' },
});

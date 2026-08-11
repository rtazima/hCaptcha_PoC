import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { ApiError, api } from '../api/client';
import type { UserSummary } from '../api/contract';
import { useServerConfig } from '../ServerConfigProvider';
import { useCaptcha } from '../captcha/CaptchaProvider';
import { Badge, Button, Card, Field, Notice, Row } from '../components/ui';
import { colors, spacing } from '../theme';
import { describeError } from '../strings';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

export function HomeScreen({ navigation }: Props) {
  const { config, loading, error, baseUrl, changeBaseUrl, reload } = useServerConfig();
  const captcha = useCaptcha();
  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadUsers = useCallback(async () => {
    try {
      const response = await api.users();
      setUsers(response.users);
      setUsersError(null);
    } catch (caught) {
      setUsers([]);
      setUsersError(
        caught instanceof ApiError ? describeError(caught.code, caught.message) : String(caught),
      );
    }
  }, []);

  useEffect(() => {
    if (config) void loadUsers();
  }, [config, loadUsers]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    reload();
    await loadUsers();
    setRefreshing(false);
  }, [loadUsers, reload]);

  const enrolled = users.filter((user) => user.enrolled);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <Card
        title="hCaptcha + biometria comportamental"
        subtitle="PoC ponta a ponta: cadastro do template, verificação 1:1 e identificação 1:N, com o risco do hCaptcha invisível entrando na decisão."
      >
        <Notice
          text={
            'São dois sinais diferentes. O hCaptcha responde “é um humano legítimo agindo agora?”. ' +
            'O template comportamental responde “é a mesma pessoa de antes?”. O hCaptcha não expõe ' +
            'template nem faz match de identidade — o 1:1 e o 1:N são do motor deste projeto.'
          }
        />
      </Card>

      <Card title="Backend">
        <Field
          label="URL da API"
          value={urlDraft}
          onChangeText={setUrlDraft}
          placeholder="http://192.168.0.10:8787"
          keyboardType="url"
        />
        <Button
          label="Conectar"
          onPress={() => changeBaseUrl(urlDraft)}
          disabled={urlDraft.trim().length === 0}
        />
        {loading ? <Text style={styles.dim}>carregando configuração…</Text> : null}
        {error ? <Notice text={error} tone={colors.deny} /> : null}
        {config ? (
          <View style={styles.block}>
            <Row label="modo hCaptcha" value={config.captcha.mode} />
            <Row label="sitekey" value={config.captcha.sitekey} />
            <Row label="uso único do token" value={config.captcha.enforceSingleUse ? 'sim' : 'não'} />
            <Row label="amostras p/ cadastro" value={String(config.enrollment.samplesRequired)} />
            <Row label="limiar base (1:1)" value={config.policy.baseThreshold.toFixed(2)} />
            <Row
              label="limiar 1:N"
              value={(config.policy.baseThreshold + config.policy.identifyThresholdBoost).toFixed(2)}
            />
            <Row label="features" value={`${config.features.count} dimensões (v${config.features.version})`} />
          </View>
        ) : null}
        {config?.captcha.mode === 'test' ? (
          <Notice
            text={
              'Sitekey público de teste: nunca desafia e não devolve score. Dá para validar todo o ' +
              'encanamento, mas o risco exibido será derivado, não medido. Para risco real use um ' +
              'sitekey Enterprise configurado como Passive + Invisible.'
            }
          />
        ) : null}
        {config?.captcha.mode === 'mock' ? (
          <Notice
            text={`Modo mock: o app envia "mock:${captcha.mockRisk}" e o widget do hCaptcha nem carrega. Ajuste o risco na tela Debug.`}
          />
        ) : null}
      </Card>

      <Card title="Fluxos">
        <View style={styles.actions}>
          <Button label="Cadastro (enrollment)" onPress={() => navigation.navigate('Enroll')} />
          <Button
            label="Verificar 1:1"
            variant="ghost"
            onPress={() => navigation.navigate('Verify')}
            disabled={enrolled.length === 0}
          />
          <Button
            label="Identificar 1:N"
            variant="ghost"
            onPress={() => navigation.navigate('Identify')}
            disabled={enrolled.length === 0}
          />
          <Button label="Debug e auditoria" variant="ghost" onPress={() => navigation.navigate('Debug')} />
        </View>
        {enrolled.length === 0 ? (
          <Text style={styles.dim}>Cadastre pelo menos uma pessoa para liberar 1:1 e 1:N.</Text>
        ) : null}
      </Card>

      <Card title={`Pessoas cadastradas (${users.length})`}>
        {usersError ? <Notice text={usersError} tone={colors.deny} /> : null}
        {users.length === 0 && !usersError ? (
          <Text style={styles.dim}>Ninguém cadastrado ainda.</Text>
        ) : null}
        {users.map((user) => (
          <View key={user.userId} style={styles.user}>
            <View style={styles.userInfo}>
              <Text style={styles.userName}>{user.displayName ?? user.userId}</Text>
              <Text style={styles.userMeta}>
                {user.userId} · {user.samples} amostra{user.samples === 1 ? '' : 's'}
              </Text>
            </View>
            <Badge
              text={user.enrolled ? 'com template' : 'incompleto'}
              color={user.enrolled ? colors.allow : colors.stepUp}
            />
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  block: { marginTop: spacing.md },
  actions: { gap: spacing.sm },
  dim: { color: colors.textDim, fontSize: 13, marginTop: spacing.sm, lineHeight: 19 },
  user: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  userInfo: { flex: 1 },
  userName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  userMeta: { color: colors.textDim, fontSize: 12, marginTop: 2 },
});

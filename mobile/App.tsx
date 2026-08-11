/**
 * Raiz do app.
 *
 * Ordem dos provedores importa: ServerConfigProvider carrega /v1/config (de onde
 * vêm sitekey e modo do hCaptcha) e só então CaptchaProvider monta o widget.
 */
import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { initJourneyTracking } from '@hcaptcha/react-native-hcaptcha';

import type { RootStackParamList } from './src/navigation';
import { ServerConfigProvider, useServerConfig } from './src/ServerConfigProvider';
import { CaptchaProvider } from './src/captcha/CaptchaProvider';
import { HomeScreen } from './src/screens/HomeScreen';
import { EnrollScreen } from './src/screens/EnrollScreen';
import { VerifyScreen } from './src/screens/VerifyScreen';
import { IdentifyScreen } from './src/screens/IdentifyScreen';
import { DebugScreen } from './src/screens/DebugScreen';
import { colors } from './src/theme';

const Stack = createNativeStackNavigator<RootStackParamList>();
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

const navTheme = {
  dark: true,
  colors: {
    primary: colors.primary,
    background: colors.bg,
    card: colors.card,
    text: colors.text,
    border: colors.border,
    notification: colors.primary,
  },
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' as const },
    medium: { fontFamily: 'System', fontWeight: '500' as const },
    bold: { fontFamily: 'System', fontWeight: '700' as const },
    heavy: { fontFamily: 'System', fontWeight: '900' as const },
  },
};

/**
 * Journey tracking (Enterprise): registra transições de tela e gestos básicos
 * e envia junto com a verificação. Segundo a documentação do SDK ele NÃO captura
 * conteúdo de texto. É opcional — se a conta não for Enterprise, o sinal é
 * simplesmente ignorado do outro lado.
 */
function useJourneyTracking() {
  useEffect(() => {
    try {
      initJourneyTracking({ navigationContainerRef: navigationRef, touchCapture: true });
    } catch (error) {
      console.warn('journey tracking indisponível:', error);
    }
  }, []);
}

function Screens() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.card },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'PoC biometria' }} />
      <Stack.Screen name="Enroll" component={EnrollScreen} options={{ title: 'Cadastro' }} />
      <Stack.Screen name="Verify" component={VerifyScreen} options={{ title: 'Verificar 1:1' }} />
      <Stack.Screen name="Identify" component={IdentifyScreen} options={{ title: 'Identificar 1:N' }} />
      <Stack.Screen name="Debug" component={DebugScreen} options={{ title: 'Debug' }} />
    </Stack.Navigator>
  );
}

/**
 * Enquanto /v1/config não responde, o app segue navegável em modo mock: assim a
 * tela inicial aparece e dá para corrigir a URL do backend sem reiniciar o app.
 */
function WithCaptcha() {
  const { config, loading, error } = useServerConfig();

  if (loading && !config && !error) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.loadingText}>conectando ao backend…</Text>
      </View>
    );
  }

  return (
    <CaptchaProvider
      mode={config?.captcha.mode ?? 'mock'}
      sitekey={config?.captcha.sitekey ?? null}
      rqdata={config?.captcha.rqdata ?? null}
    >
      <Screens />
    </CaptchaProvider>
  );
}

export default function App() {
  useJourneyTracking();
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer ref={navigationRef} theme={navTheme}>
        <ServerConfigProvider>
          <WithCaptcha />
        </ServerConfigProvider>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, gap: 12 },
  loadingText: { color: colors.textDim, fontSize: 13 },
});

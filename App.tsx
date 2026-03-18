import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StyleSheet } from 'react-native';
import { RootNavigator } from './src/navigation/RootNavigator';
import { setupPlayer, useRNTPSync } from './src/services/playbackService';
import { Colors } from './src/theme';

function AppInner() {
  useRNTPSync();
  return <RootNavigator />;
}

export default function App() {
  useEffect(() => {
    setupPlayer();
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="light" backgroundColor={Colors.bgPrimary} />
      <NavigationContainer>
        <AppInner />
      </NavigationContainer>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bgPrimary },
});

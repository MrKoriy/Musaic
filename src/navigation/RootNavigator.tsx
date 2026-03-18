import React from 'react';
import { View, Text } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { TabNavigator } from './TabNavigator';
import { NowPlayingScreen } from '../screens/NowPlayingScreen';
import { PlaylistDetailScreen } from '../screens/PlaylistDetailScreen';
import { AlbumDetailScreen } from '../screens/AlbumDetailScreen';
import { AIChatScreen } from '../screens/AIChatScreen';
import { OnboardingScreen } from '../screens/OnboardingScreen';
import { RootStackParamList } from '../types';
import { Colors, Typography } from '../theme';
import { useSettingsStore } from '../stores/useSettingsStore';

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  const onboardingComplete = useSettingsStore((s) => s.onboardingComplete);

  return (
    <Stack.Navigator
      initialRouteName={onboardingComplete ? 'MainTabs' : 'Onboarding'}
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: 'transparent' },
        animation: 'slide_from_bottom',
      }}
    >
      <Stack.Screen
        name="Onboarding"
        component={OnboardingScreen}
        options={{ animation: 'fade' }}
      />
      <Stack.Screen name="MainTabs" component={TabNavigator} />
      <Stack.Screen
        name="NowPlaying"
        component={NowPlayingScreen}
        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
      />
      <Stack.Screen name="PlaylistDetail" component={PlaylistDetailScreen} />
      <Stack.Screen name="AlbumDetail" component={AlbumDetailScreen} />
      <Stack.Screen name="ArtistDetail" component={ArtistDetailPlaceholder} />
      <Stack.Screen
        name="AIChat"
        component={AIChatScreen}
        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
      />
    </Stack.Navigator>
  );
}

function ArtistDetailPlaceholder() {
  return (
    <View style={{ flex: 1, backgroundColor: Colors.bgPrimary, justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ ...Typography.headingMd, color: Colors.textPrimary }}>Artist Detail</Text>
      <Text style={{ ...Typography.body, color: Colors.textSecondary }}>Coming in Phase 3+</Text>
    </View>
  );
}

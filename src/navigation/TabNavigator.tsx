import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Home, Search, Library, User } from 'lucide-react-native';
import { Colors } from '../theme';
import { HomeScreen } from '../screens/HomeScreen';
import { SearchScreen } from '../screens/SearchScreen';
import { LibraryScreen } from '../screens/LibraryScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { MiniPlayer } from '../components/MiniPlayer';
import { TabParamList } from '../types';
import { View, StyleSheet } from 'react-native';

const Tab = createBottomTabNavigator<TabParamList>();

const TAB_BAR_HEIGHT = 56;

export function TabNavigator() {
  return (
    <View style={styles.container}>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: Colors.accentPrimary,
          tabBarInactiveTintColor: Colors.textTertiary,
          tabBarStyle: {
            backgroundColor: 'rgba(13, 13, 20, 0.92)',
            borderTopWidth: 1,
            borderTopColor: 'rgba(255,255,255,0.06)',
            height: TAB_BAR_HEIGHT,
            paddingBottom: 4,
            paddingTop: 4,
          },
          tabBarLabelStyle: {
            fontSize: 10,
            fontWeight: '500',
          },
        }}
      >
        <Tab.Screen
          name="Home"
          component={HomeScreen}
          options={{
            tabBarIcon: ({ color, size }) => <Home size={size} color={color} />,
          }}
        />
        <Tab.Screen
          name="Search"
          component={SearchScreen}
          options={{
            tabBarIcon: ({ color, size }) => <Search size={size} color={color} />,
          }}
        />
        <Tab.Screen
          name="Library"
          component={LibraryScreen}
          options={{
            tabBarIcon: ({ color, size }) => <Library size={size} color={color} />,
          }}
        />
        <Tab.Screen
          name="Profile"
          component={ProfileScreen}
          options={{
            tabBarIcon: ({ color, size }) => <User size={size} color={color} />,
          }}
        />
      </Tab.Navigator>
      {/* MiniPlayer floats above the tab bar */}
      <View style={styles.miniPlayerContainer} pointerEvents="box-none">
        <MiniPlayer />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  miniPlayerContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: TAB_BAR_HEIGHT,
  },
});

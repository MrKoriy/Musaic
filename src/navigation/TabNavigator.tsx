import React from 'react';
import { View, StyleSheet } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Home, Search, Library, User } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Spacing } from '../theme';
import { HomeScreen } from '../screens/HomeScreen';
import { SearchScreen } from '../screens/SearchScreen';
import { LibraryScreen } from '../screens/LibraryScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { MiniPlayer } from '../components/MiniPlayer';
import { TabParamList } from '../types';

const Tab = createBottomTabNavigator<TabParamList>();

// Custom tab bar that wraps the default with a MiniPlayer above it
function CustomTabBar(props: any) {
  const insets = useSafeAreaInsets();
  const { state, descriptors, navigation } = props;

  return (
    <View style={styles.tabBarContainer}>
      {/* Mini Player floats above the tab bar */}
      <MiniPlayer />

      {/* Native tab bar row */}
      <View style={[styles.nativeTabBar, { paddingBottom: insets.bottom }]}>
        {state.routes.map((route: any, index: number) => {
          const { options } = descriptors[route.key];
          const isFocused = state.index === index;
          const label = options.tabBarLabel ?? options.title ?? route.name;
          const IconComponent = options.tabBarIcon;

          function onPress() {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          }

          const color = isFocused ? Colors.accentPrimary : Colors.textTertiary;

          return (
            <View key={route.key} style={styles.tabItem}>
              <View
                style={{ alignItems: 'center', gap: 3 }}
                // eslint-disable-next-line react/display-name
              >
                <View>
                  {IconComponent?.({ color, size: 22, focused: isFocused })}
                </View>
              </View>
              {/* Touchable overlay */}
              <View
                onStartShouldSetResponder={() => { onPress(); return true; }}
                style={StyleSheet.absoluteFill}
              />
            </View>
          );
        })}
      </View>
    </View>
  );
}

export function TabNavigator() {
  return (
    <Tab.Navigator
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        headerShown: false,
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
  );
}

const styles = StyleSheet.create({
  tabBarContainer: {
    backgroundColor: 'transparent',
    borderTopWidth: 0,
  },
  nativeTabBar: {
    flexDirection: 'row',
    backgroundColor: Colors.bgSecondary,
    borderTopWidth: 1,
    borderTopColor: Colors.glassBorder,
    height: 56,
    paddingTop: Spacing.xs,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, SafeAreaView,
  TouchableOpacity, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { ChevronDown, Send, Sparkles } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation } from '@react-navigation/native';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from '../components/GlassCard';
import { api } from '../services/apiService';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

const SUGGESTIONS = [
  'What should I listen to right now?',
  'Recommend something upbeat and energetic',
  'I want something to relax to',
  'What are artists similar to my favorites?',
];

export function AIChatScreen() {
  const navigation = useNavigation();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: "Hi! I'm Musaic AI. I can help you discover music based on your taste. What are you in the mood for?",
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // Use ref for loading flag to avoid stale closure in sendMessage
  const loadingRef = useRef(false);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loadingRef.current) return;

    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', content: text.trim() };

    // Build history from current messages (via functional setter to avoid stale closure)
    let history: Array<{ role: string; content: string }> = [];
    setMessages((prev) => {
      history = prev.slice(1).map((m) => ({ role: m.role, content: m.content }));
      return [...prev, userMsg];
    });
    setInput('');
    setLoading(true);
    loadingRef.current = true;

    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

    try {
      const res = await api.chatWithAI(text.trim(), history);
      if (res.error) {
        setMessages((prev) => [...prev, {
          id: `e-${Date.now()}`,
          role: 'assistant' as const,
          content: `Sorry, I couldn't connect to the AI: ${res.error}\n\nMake sure OPENROUTER_API_KEY is set in server/.env`,
        }]);
      } else {
        setMessages((prev) => [...prev, {
          id: `a-${Date.now()}`,
          role: 'assistant' as const,
          content: res.reply,
        }]);
      }
    } catch {
      setMessages((prev) => [...prev, {
        id: `e-${Date.now()}`,
        role: 'assistant' as const,
        content: 'Connection error. Is the Musaic server running?',
      }]);
    }

    setLoading(false);
    loadingRef.current = false;
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, []);

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={['rgba(59, 46, 139, 0.25)', 'transparent']}
        style={styles.ambientCool}
        start={{ x: 1, y: 0 }}
        end={{ x: 0.4, y: 1 }}
        pointerEvents="none"
      />
      <LinearGradient
        colors={['rgba(233, 30, 140, 0.10)', 'transparent']}
        style={styles.ambientPink}
        start={{ x: 0, y: 1 }}
        end={{ x: 1, y: 0 }}
        pointerEvents="none"
      />

      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
              <ChevronDown size={24} color={Colors.textSecondary} />
            </TouchableOpacity>
            <View style={styles.headerCenter}>
              <Sparkles size={18} color={Colors.accentPrimary} />
              <Text style={styles.headerTitle}>Musaic AI</Text>
            </View>
            <View style={styles.backBtn} />
          </View>

          {/* Messages */}
          <ScrollView
            ref={scrollRef}
            style={styles.messages}
            contentContainerStyle={styles.messagesContent}
            showsVerticalScrollIndicator={false}
          >
            {messages.map((msg) => (
              <View
                key={msg.id}
                style={[styles.msgRow, msg.role === 'user' ? styles.msgRowUser : styles.msgRowAI]}
              >
                {msg.role === 'assistant' && (
                  <View style={styles.aiAvatar}>
                    <Sparkles size={14} color={Colors.accentPrimary} />
                  </View>
                )}
                <GlassCard
                  style={[styles.bubble, msg.role === 'user' ? styles.bubbleUser : styles.bubbleAI]}
                  borderRadius={Radius.lg}
                  intensity={msg.role === 'user' ? 40 : 20}
                >
                  <Text style={[styles.bubbleText, msg.role === 'user' && styles.bubbleTextUser]}>
                    {msg.content}
                  </Text>
                </GlassCard>
              </View>
            ))}

            {loading && (
              <View style={[styles.msgRow, styles.msgRowAI]}>
                <View style={styles.aiAvatar}>
                  <Sparkles size={14} color={Colors.accentPrimary} />
                </View>
                <GlassCard style={styles.bubble} borderRadius={Radius.lg} intensity={20}>
                  <ActivityIndicator size="small" color={Colors.accentPrimary} />
                </GlassCard>
              </View>
            )}

            {/* Quick suggestions (only at start) */}
            {messages.length === 1 && (
              <View style={styles.suggestions}>
                {SUGGESTIONS.map((s) => (
                  <TouchableOpacity
                    key={s}
                    style={styles.suggestion}
                    onPress={() => sendMessage(s)}
                  >
                    <GlassCard style={styles.suggestionCard} borderRadius={Radius.md} intensity={30}>
                      <Text style={styles.suggestionText}>{s}</Text>
                    </GlassCard>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </ScrollView>

          {/* Input */}
          <GlassCard style={styles.inputCard} borderRadius={Radius.full}>
            <View style={styles.inputRow}>
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder="Ask about music..."
                placeholderTextColor={Colors.textTertiary}
                style={styles.input}
                multiline
                returnKeyType="send"
                onSubmitEditing={() => sendMessage(input)}
              />
              <TouchableOpacity
                style={[styles.sendBtn, (!input.trim() || loading) && styles.sendBtnDisabled]}
                onPress={() => sendMessage(input)}
                disabled={!input.trim() || loading}
              >
                <Send size={18} color={input.trim() && !loading ? Colors.bgPrimary : Colors.textTertiary} />
              </TouchableOpacity>
            </View>
          </GlassCard>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bgPrimary },
  ambientCool: { position: 'absolute', top: 0, right: 0, width: '70%', height: '50%' },
  ambientPink: { position: 'absolute', bottom: 0, left: 0, width: '60%', height: '40%' },
  safeArea: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, paddingBottom: Spacing.sm,
  },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  headerTitle: { ...Typography.headingSm, color: Colors.textPrimary },
  messages: { flex: 1 },
  messagesContent: {
    paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xl, gap: Spacing.md,
  },
  msgRow: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.sm },
  msgRowUser: { justifyContent: 'flex-end' },
  msgRowAI: { justifyContent: 'flex-start' },
  aiAvatar: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(233, 30, 140, 0.15)',
    borderWidth: 1, borderColor: 'rgba(233, 30, 140, 0.30)',
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  bubble: { maxWidth: '75%', padding: Spacing.md },
  bubbleUser: { backgroundColor: 'rgba(233, 30, 140, 0.20)', borderColor: 'rgba(233, 30, 140, 0.35)' },
  bubbleAI: {},
  bubbleText: { ...Typography.body, color: Colors.textPrimary, lineHeight: 22 },
  bubbleTextUser: { color: Colors.textPrimary },
  suggestions: { gap: Spacing.sm, marginTop: Spacing.md },
  suggestion: {},
  suggestionCard: { padding: Spacing.md },
  suggestionText: { ...Typography.body, color: Colors.textSecondary },
  inputCard: { marginHorizontal: Spacing.lg, marginBottom: Spacing.md },
  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, gap: Spacing.sm,
  },
  input: { flex: 1, ...Typography.body, color: Colors.textPrimary, maxHeight: 100 },
  sendBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.accentPrimary,
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: 'rgba(255,255,255,0.08)' },
});

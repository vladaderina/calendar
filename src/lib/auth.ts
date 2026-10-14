import { supabase, isSupabaseAvailable } from './supabase';
import type { User } from '@supabase/supabase-js';

// ── Session state ─────────────────────────────────────────────────────────
let currentUser: User | null = null;

export type AuthResult = { ok: true } | { ok: false; message: string };

function describeAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'Неверный email или пароль';
  if (m.includes('email not confirmed')) return 'Email не подтверждён — проверьте почту';
  if (m.includes('user already registered')) return 'Такой email уже зарегистрирован';
  if (m.includes('password should be at least')) return 'Пароль слишком короткий (минимум 6 символов)';
  if (m.includes('unable to validate email')) return 'Некорректный email';
  if (m.includes('rate limit') || m.includes('too many')) return 'Слишком много попыток — подождите минуту';
  if (m.includes('fetch') || m.includes('network')) return 'Нет связи с сервером';
  return message;
}

export async function initAuth(): Promise<User | null> {
  if (!isSupabaseAvailable || !supabase) {
    console.warn('[auth] supabase not available');
    currentUser = null;
    return null;
  }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      currentUser = session.user;
      return currentUser;
    }
  } catch (err) {
    console.warn('[auth] getSession failed:', err);
  }

  currentUser = null;
  return null;
}

export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  if (!supabase) return { ok: false, message: 'Supabase не настроен' };
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, message: describeAuthError(error.message) };
  currentUser = data.user;
  return { ok: true };
}

export async function signUpWithPassword(email: string, password: string): Promise<AuthResult> {
  if (!supabase) return { ok: false, message: 'Supabase не настроен' };
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return { ok: false, message: describeAuthError(error.message) };
  if (!data.session) {
    return { ok: false, message: 'Готово! Проверьте почту и подтвердите email, затем войдите.' };
  }
  currentUser = data.user;
  return { ok: true };
}

export async function signOut(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signOut();
  currentUser = null;
}

export function getUserId(): string | null {
  return currentUser?.id ?? null;
}

export function getCurrentUser(): User | null {
  return currentUser;
}

export function onAuthChange(cb: (user: User | null) => void): () => void {
  if (!supabase) {
    cb(currentUser);
    return () => {};
  }
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user ?? null;
    cb(currentUser);
  });
  cb(currentUser);
  return () => data.subscription.unsubscribe();
}

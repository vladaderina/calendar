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

// An anonymous session (created by an older build that signed in anonymously)
// is a FULL account with its own user_id: the app skips the login screen, this
// device keeps its own dataset, and every other device — signed into a real
// email account — sees a different calendar. The session survives silently, so
// the split never heals by itself. Detect it and make the user link an email,
// which keeps the same user_id and therefore all existing rows.
export function isAnonymousSession(): boolean {
  return Boolean((currentUser as unknown as { is_anonymous?: boolean })?.is_anonymous);
}

export type LinkResult = { ok: true; message: string } | { ok: false; message: string };

// Attaching an email/password to the CURRENT (anonymous) account keeps the same
// user_id, so every task already stored under it stays in place — no export,
// no re-upload. If email confirmation is enabled in the Supabase project, the
// identity is only linked after the link in the letter is clicked; the caller
// gets a message that says so instead of a false "done".
export async function linkEmailToAccount(email: string, password: string): Promise<LinkResult> {
  if (!supabase) return { ok: false, message: 'Supabase не настроен' };
  if (password.length < 6) return { ok: false, message: 'Пароль слишком короткий (минимум 6 символов)' };
  const { data, error } = await supabase.auth.updateUser({ email, password });
  if (error) return { ok: false, message: describeAuthError(error.message) };
  if (data.user) currentUser = data.user;
  const linked = data.user?.email === email;
  return {
    ok: true,
    message: linked
      ? 'Готово: email привязан. Войдите этим адресом на другом устройстве — календарь будет общим.'
      : 'Проверьте почту и перейдите по ссылке из письма. Задачи уже сохранены за этим аккаунтом.',
  };
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

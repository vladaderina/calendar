import { supabase, isSupabaseAvailable } from './supabase';
import type { User } from '@supabase/supabase-js';

// ── Session state ─────────────────────────────────────────────────────────
// `currentUser` is the single source of truth for "who is this device". It is
// null until a session exists, which is exactly the signal AuthGate uses to
// decide between the sign-in screen and the app.
let currentUser: User | null = null;

// ── User ID strategy ───────────────────────────────────────────────────────
// 1. A real Supabase session (email/password OR anonymous) → that user's id.
// 2. No session and anonymous auth disabled → a FIXED UUID so a personal
//    single-user setup still syncs across devices.
//    Override with CAL_USER_ID in .env.
const FALLBACK_USER_ID = 'a1b2c3d4-e5f6-4712-8abc-def012345678';

export type AuthResult = { ok: true } | { ok: false; message: string };

// Human-readable text for the errors Supabase actually returns here.
function describeAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'Неверный email или пароль';
  if (m.includes('email not confirmed')) return 'Email не подтверждён — проверьте почту';
  if (m.includes('user already registered')) return 'Такой email уже зарегистрирован';
  if (m.includes('password should be at least')) return 'Пароль слишком короткий (минимум 6 символов)';
  if (m.includes('unable to validate email')) return 'Некорректный email';
  if (m.includes('anonymous sign-ins are disabled'))
    return 'Анонимный вход отключён в настройках Supabase';
  if (m.includes('rate limit') || m.includes('too many'))
    return 'Слишком много попыток — подождите минуту';
  if (m.includes('fetch') || m.includes('network')) return 'Нет связи с сервером';
  return message;
}

// ── Restore an existing session (called on app load) ──────────────────────
export async function initAuth(): Promise<User | null> {
  if (!isSupabaseAvailable || !supabase) {
    console.warn('[auth] supabase not available; using fixed user id');
    currentUser = { id: FALLBACK_USER_ID } as User;
    return currentUser;
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

  // No stored session → use the fixed UUID.
  //
  // We deliberately do NOT call signInAnonymously() here. When anonymous auth
  // is disabled in the Supabase project that call does not reject — it hangs,
  // and the pending request keeps supabase-js's internal auth lock held, which
  // deadlocks EVERY later .from() query (the app loads with an empty week even
  // though the data is in the database). The fixed id gives the same
  // single-user behaviour without ever touching that lock.
  currentUser = { id: FALLBACK_USER_ID } as User;
  return currentUser;
}

// ── Email + password ──────────────────────────────────────────────────────
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
  // With "Confirm email" ON, signUp returns no session — the user must click
  // the link in their inbox first. Tell them so instead of a blank screen.
  if (!data.session) {
    return { ok: false, message: 'Готово! Проверьте почту и подтвердите email, затем войдите.' };
  }
  currentUser = data.user;
  return { ok: true };
}

export async function signInAnonymously(): Promise<AuthResult> {
  if (!supabase) return { ok: false, message: 'Supabase не настроен' };
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) return { ok: false, message: describeAuthError(error.message) };
  currentUser = data.user;
  return { ok: true };
}

export async function signOut(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signOut();
  currentUser = null;
}

// ── Accessors ─────────────────────────────────────────────────────────────
export function getUserId(): string | null {
  if (currentUser) return currentUser.id;
  return isSupabaseAvailable ? FALLBACK_USER_ID : null;
}

export function getCurrentUser(): User | null {
  return currentUser;
}

export function isAnonymous(): boolean {
  // Supabase flags anonymous users on the user object itself.
  return Boolean(currentUser && (currentUser as any).is_anonymous);
}

// ── Change notifications ──────────────────────────────────────────────────
// Supabase drives this: token refresh, sign-out in another tab, expiry.
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

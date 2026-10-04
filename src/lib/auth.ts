import { supabase, isSupabaseAvailable } from './supabase';
import type { User } from '@supabase/supabase-js';

let currentUser: User | null = null;

// ── User ID strategy ───────────────────────────────────────────────────────
// 1. If anonymous auth is enabled → use the real auth user (per-device, persists via browser session)
// 2. If anonymous auth is disabled → use a FIXED UUID so all devices share the same data
//    (Set CAL_USER_ID in .env to change this; defaults to a well-known personal UUID.)
// Fixed UUID for fallback user — all devices share the same ID so data syncs.
// (Anonymous auth, if enabled above, overrides this with a real per-user session.)
const FALLBACK_USER_ID = 'a1b2c3d4-e5f6-4712-8abc-def012345678';

// ── Initialise auth (tries anonymous sign-in, falls back to fixed UUID) ────
export async function initAuth(): Promise<User | null> {
  if (!isSupabaseAvailable || !supabase) return null;

  // Try restoring an existing session first
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      currentUser = user;
      return user;
    }
  } catch {}

  // Try anonymous sign-in (preferred — real session persists in browser storage)
  try {
    const { data } = await supabase.auth.signInAnonymously();
    if (data?.user) {
      currentUser = data.user;
      return currentUser;
    }
  } catch (e: any) {
    // Anonymous sign-ins are not enabled — expected in many projects.
  }

  // Fallback: use the fixed UUID so data syncs across all devices
  console.warn('[auth] anonymous sign-in unavailable; using fixed user id');
  currentUser = { id: FALLBACK_USER_ID } as User;
  return currentUser;
}

export function getUserId(): string | null {
  if (currentUser) return currentUser.id;
  return isSupabaseAvailable ? FALLBACK_USER_ID : null;
}

export function onAuthChange(cb: (user: User | null) => void): () => void {
  cb(currentUser);
  return () => {};
}

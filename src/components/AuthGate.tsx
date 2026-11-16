import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import {
  initAuth,
  onAuthChange,
  signInWithPassword,
  signUpWithPassword,
  linkEmailToAccount,
} from '../lib/auth';
import { pushLocalToServer, useTasks } from '../store';

interface AuthGateProps {
  onUserLoaded: (user: User | null) => void;
  children: React.ReactNode;
}

const ANON_DISMISS_KEY = 'calendar.auth.anonDismissed.v1';

// `is_anonymous` marks a session created by the old "sign in anonymously" flow.
// Such a session looks like a normal login, so the app skipped the login screen
// and kept a private copy of the data: one calendar on the phone, another on the
// laptop, both "logged in", nothing shared. Those sessions are caught here.
const isAnon = (u: User | null) => Boolean((u as unknown as { is_anonymous?: boolean })?.is_anonymous);

export function AuthGate({ onUserLoaded, children }: AuthGateProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [anonDismissed, setAnonDismissed] = useState(() => {
    try { return sessionStorage.getItem(ANON_DISMISS_KEY) === '1'; } catch { return false; }
  });
  // A dropped connection must not look like a logout. Supabase only reports
  // "no session" when it has thrown one away; if the radio is off, the honest
  // answer is "no network", not a login form that will fail anyway.
  const [offline, setOffline] = useState(() => (typeof navigator !== 'undefined' ? !navigator.onLine : false));

  useEffect(() => {
    const goOnline = () => {
      setOffline(false);
      // Coming back from a dead link: retry the stored session once.
      void initAuth().then((u) => {
        if (u) {
          setUser(u);
          onUserLoaded(u);
        }
      });
    };
    const goOffline = () => setOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [onUserLoaded]);

  useEffect(() => {
    void initAuth().then((u) => {
      setUser(u);
      setLoaded(true);
      onUserLoaded(u);
    });

    const unsubscribe = onAuthChange((u) => {
      setUser(u);
      onUserLoaded(u);
    });
    return unsubscribe;
  }, [onUserLoaded]);

  if (!loaded) {
    return (
      <div style={loadingContainerStyle}>
        <div style={spinnerStyle} />
      </div>
    );
  }

  if (user && isAnon(user) && !anonDismissed) {
    return (
      <LinkAccountForm
        user={user}
        onSkip={() => {
          try { sessionStorage.setItem(ANON_DISMISS_KEY, '1'); } catch {}
          setAnonDismissed(true);
        }}
      />
    );
  }

  if (user) {
    return (
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        {children}
      </div>
    );
  }

  if (offline) {
    return (
      <div style={loadingContainerStyle}>
        <div style={{ maxWidth: 380, textAlign: 'center', padding: '0 24px' }}>
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>Нет связи</div>
          <div style={{ fontSize: 14, opacity: 0.7, lineHeight: 1.5, marginBottom: 20 }}>
            Устройство не в сети — календарь откроется, как только появится интернет.
            Выходить из аккаунта не нужно.
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              void initAuth().then((u) => {
                setUser(u);
                onUserLoaded(u);
                if (!u) setOffline(false);
              });
            }}
          >
            Повторить
          </button>
        </div>
      </div>
    );
  }

  return <AuthForm />;
}

// Shown when this device sits on an anonymous session: its rows live under a
// user_id nobody else can log into. Linking an email keeps that user_id (so the
// calendar stays as it is and becomes reachable from other devices); signing
// into an existing account moves this device's rows into it instead.
function LinkAccountForm({ user, onSkip }: { user: User; onSkip: () => void }) {
  const tasks = useTasks();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'link' | 'switch'>('link');
  const [message, setMessage] = useState('');
  const [okMessage, setOkMessage] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setMessage('');
    setOkMessage(false);

    if (mode === 'link') {
      const r = await linkEmailToAccount(email, password);
      setLoading(false);
      setOkMessage(r.ok);
      setMessage(r.message);
      return;
    }

    const signIn = await signInWithPassword(email, password);
    if (!signIn.ok) {
      setLoading(false);
      setMessage(signIn.message);
      return;
    }
    // Native rows of the target account are pulled by the app's normal load;
    // what this device holds must go the other way before it can be merged.
    const push = await pushLocalToServer();
    setLoading(false);
    setOkMessage(push.ok);
    setMessage(push.ok ? `Вошли в аккаунт и перенесли данные: ${push.message}` : push.message);
  };

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <div style={headerStyle}>
          <h1 style={titleStyle}>Данные пока только здесь</h1>
          <p style={subtitleStyle}>
            На этом устройстве {tasks.length} задач в отдельном профиле без email. Поэтому телефон и
            ноутбук показывают разное. Привяжите email — данные останутся на месте и появятся на
            всех устройствах.
          </p>
        </div>

        <div style={tabsStyle}>
          <button
            type="button"
            onClick={() => { setMode('link'); setMessage(''); }}
            style={{
              ...tabStyle,
              borderBottom: mode === 'link' ? '2px solid #111' : '2px solid transparent',
              color: mode === 'link' ? '#111' : '#666',
              fontWeight: mode === 'link' ? 600 : 400,
            }}
          >
            Привязать email
          </button>
          <button
            type="button"
            onClick={() => { setMode('switch'); setMessage(''); }}
            style={{
              ...tabStyle,
              borderBottom: mode === 'switch' ? '2px solid #111' : '2px solid transparent',
              color: mode === 'switch' ? '#111' : '#666',
              fontWeight: mode === 'switch' ? 600 : 400,
            }}
          >
            Войти в другой
          </button>
        </div>

        <form onSubmit={handleSubmit} style={formStyle}>
          <div style={fieldStyle}>
            <label style={labelStyle}>Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              style={inputStyle}
              disabled={loading}
              autoComplete="email"
            />
          </div>
          <div style={fieldStyle}>
            <label style={labelStyle}>Пароль</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              style={inputStyle}
              disabled={loading}
              autoComplete={mode === 'link' ? 'new-password' : 'current-password'}
            />
          </div>

          {message && (
            <div style={{
              ...messageStyle,
              background: okMessage ? '#e6f4ea' : '#fce8e6',
              color: okMessage ? '#137333' : '#c5221f',
            }}>
              {message}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email || !password}
            style={{ ...submitBtnStyle, opacity: loading || !email || !password ? 0.6 : 1 }}
          >
            {loading ? 'Загрузка...' : mode === 'link' ? 'Привязать и сохранить' : 'Войти и перенести данные'}
          </button>
        </form>

        <p style={{ ...subtitleStyle, marginTop: '16px', fontSize: '13px' }}>
          {mode === 'link'
            ? 'Этот профиль ' + (user.id ? user.id.slice(0, 8) : '') + '… станет обычным аккаунтом — задачи никуда не денутся.'
            : 'Задачи с этого устройства отправятся в указанный аккаунт. На сервере ничего не удаляется.'}
        </p>

        <button
          type="button"
          onClick={onSkip}
          style={{ ...tabStyle, marginTop: '8px', color: '#666', fontSize: '13px' }}
        >
          Продолжить без привязки
        </button>
      </div>
    </div>
  );
}

function AuthForm() {
  const [tab, setTab] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setMessage('');

    const result = tab === 'signin'
      ? await signInWithPassword(email, password)
      : await signUpWithPassword(email, password);

    setLoading(false);
    if (!result.ok) {
      setMessage(result.message);
    }
  };

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <div style={headerStyle}>
          <h1 style={titleStyle}>Календарь</h1>
          <p style={subtitleStyle}>
            {tab === 'signin' ? 'Войдите в свой аккаунт' : 'Создайте новый аккаунт'}
          </p>
        </div>

        <div style={tabsStyle}>
          <button
            type="button"
            onClick={() => { setTab('signin'); setMessage(''); }}
            style={{
              ...tabStyle,
              borderBottom: tab === 'signin' ? '2px solid #111' : '2px solid transparent',
              color: tab === 'signin' ? '#111' : '#666',
              fontWeight: tab === 'signin' ? 600 : 400,
            }}
          >
            Вход
          </button>
          <button
            type="button"
            onClick={() => { setTab('signup'); setMessage(''); }}
            style={{
              ...tabStyle,
              borderBottom: tab === 'signup' ? '2px solid #111' : '2px solid transparent',
              color: tab === 'signup' ? '#111' : '#666',
              fontWeight: tab === 'signup' ? 600 : 400,
            }}
          >
            Регистрация
          </button>
        </div>

        <form onSubmit={handleSubmit} style={formStyle}>
          <div style={fieldStyle}>
            <label style={labelStyle}>Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              style={inputStyle}
              disabled={loading}
              autoComplete="email"
            />
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>Пароль</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              style={inputStyle}
              disabled={loading}
              autoComplete={tab === 'signin' ? 'current-password' : 'new-password'}
            />
          </div>

          {message && (
            <div style={{
              ...messageStyle,
              background: message.startsWith('Готово') ? '#e6f4ea' : '#fce8e6',
              color: message.startsWith('Готово') ? '#137333' : '#c5221f',
            }}>
              {message}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email || !password}
            style={{
              ...submitBtnStyle,
              opacity: loading || !email || !password ? 0.6 : 1,
            }}
          >
            {loading ? 'Загрузка...' : tab === 'signin' ? 'Войти' : 'Зарегистрироваться'}
          </button>
        </form>
      </div>
    </div>
  );
}

// Minimalist styling matching existing UI tone
const loadingContainerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100vw',
  height: '100vh',
  background: '#fcfcfc',
  fontFamily: 'system-ui, -apple-system, sans-serif',
};

const spinnerStyle: React.CSSProperties = {
  width: '28px',
  height: '28px',
  border: '3px solid #e0e0e0',
  borderTop: '3px solid #333',
  borderRadius: '50%',
  animation: 'spin 0.8s linear infinite',
};

const containerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100vw',
  height: '100vh',
  background: '#f8f9fa',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  padding: '16px',
};

const cardStyle: React.CSSProperties = {
  background: '#ffffff',
  border: '1px solid #eaeaea',
  borderRadius: '12px',
  padding: '32px',
  width: '100%',
  maxWidth: '380px',
  boxShadow: '0 4px 24px rgba(0, 0, 0, 0.04)',
};

const headerStyle: React.CSSProperties = {
  marginBottom: '24px',
  textAlign: 'center',
};

const titleStyle: React.CSSProperties = {
  margin: '0 0 6px',
  fontSize: '22px',
  fontWeight: '600',
  color: '#1a1a1a',
  letterSpacing: '-0.3px',
};

const subtitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '14px',
  color: '#666',
};

const tabsStyle: React.CSSProperties = {
  display: 'flex',
  borderBottom: '1px solid #eaeaea',
  marginBottom: '24px',
};

const tabStyle: React.CSSProperties = {
  flex: 1,
  padding: '10px 0',
  background: 'none',
  border: 'none',
  fontSize: '14px',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
  textAlign: 'center',
};

const formStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '18px',
};

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const labelStyle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: '500',
  color: '#444',
};

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  fontSize: '14px',
  fontFamily: 'inherit',
  outline: 'none',
  transition: 'border-color 0.15s ease',
};

const messageStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: '6px',
  fontSize: '13px',
  lineHeight: '1.4',
};

const submitBtnStyle: React.CSSProperties = {
  padding: '11px 16px',
  background: '#111111',
  color: '#ffffff',
  border: 'none',
  borderRadius: '6px',
  fontSize: '14px',
  fontWeight: '500',
  cursor: 'pointer',
  transition: 'background 0.15s ease',
  marginTop: '4px',
};

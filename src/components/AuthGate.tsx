import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { initAuth, onAuthChange } from '../lib/auth';

interface AuthGateProps {
  onUserLoaded: (user: User | null) => void;
  children: React.ReactNode;
}

export function AuthGate({ onUserLoaded, children }: AuthGateProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Step 1: Restore session from storage (or fall back to fixed UUID).
    void initAuth().then((u) => {
      setUser(u);
      setLoaded(true);
      onUserLoaded(u);
    });

    // Step 2: Listen for any changes (cross-tab sign-out, token refresh, etc).
    const unsubscribe = onAuthChange((u) => {
      setUser(u);
      onUserLoaded(u);
    });
    return unsubscribe;
  }, [onUserLoaded]);

  // First render: still waiting for the session restore from storage.
  if (!loaded) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100vw',
          height: '100vh',
          background: '#f5f5f5',
          fontSize: '14px',
          color: '#666',
        }}
      >
        Загрузка...
      </div>
    );
  }

  // Session exists → show the app.
  if (user) {
    return <>{children}</>;
  }

  // No session → show sign-in/sign-up screens.
  return <AuthForm />;
}

function AuthForm() {
  const [tab, setTab] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    setLoading(true);
    setMessage('');
    const result = await (
      tab === 'signin'
        ? (await import('../lib/auth')).signInWithPassword(email, password)
        : (await import('../lib/auth')).signUpWithPassword(email, password)
    );
    setLoading(false);
    if (!result.ok) setMessage(result.message);
    // On success, onAuthChange fires and the gate re-renders.
  };

  const handleAnon = async () => {
    setLoading(true);
    setMessage('');
    const result = await (await import('../lib/auth')).signInAnonymously();
    setLoading(false);
    if (!result.ok) setMessage(result.message);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSignIn();
  };

  return (
    <div style={authFormContainerStyle}>
      <div style={authFormStyle}>
        <h1 style={titleStyle}>Календарь</h1>

        {/* Tabs */}
        <div style={tabsStyle}>
          <button
            onClick={() => setTab('signin')}
            style={{
              ...tabButtonStyle,
              background: tab === 'signin' ? '#0066cc' : '#f0f0f0',
              color: tab === 'signin' ? 'white' : '#333',
            }}
          >
            Вход
          </button>
          <button
            onClick={() => setTab('signup')}
            style={{
              ...tabButtonStyle,
              background: tab === 'signup' ? '#0066cc' : '#f0f0f0',
              color: tab === 'signup' ? 'white' : '#333',
            }}
          >
            Регистрация
          </button>
        </div>

        {/* Form */}
        <div style={formStyle}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            style={inputStyle}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <input
            type="password"
            placeholder="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            style={inputStyle}
          />
          {message && <div style={messageStyle}>{message}</div>}
          <button
            onClick={handleSignIn}
            disabled={loading || !email || !password}
            style={{ ...buttonStyle, opacity: loading || !email || !password ? 0.5 : 1 }}
          >
            {loading ? 'Загрузка...' : tab === 'signin' ? 'Войти' : 'Создать аккаунт'}
          </button>
        </div>

        {/* Divider */}
        <div style={dividerStyle}>или</div>

        {/* Anonymous */}
        <button
            onClick={handleAnon}
            disabled={loading}
            style={{ ...secondaryButtonStyle, opacity: loading ? 0.5 : 1 }}
          >
            Войти анонимно
          </button>
          <p style={smallTextStyle}>
            Без аккаунта данные хранятся локально и не синхронизируются между устройствами.
          </p>
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────
const authFormContainerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100vw',
  height: '100vh',
  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  margin: 0,
  padding: 0,
};

const authFormStyle: React.CSSProperties = {
  background: 'white',
  borderRadius: '8px',
  padding: '32px',
  width: '100%',
  maxWidth: '360px',
  boxShadow: '0 2px 16px rgba(0,0,0,0.15)',
};

const titleStyle: React.CSSProperties = {
  margin: '0 0 24px',
  fontSize: '24px',
  fontWeight: '600',
  color: '#333',
  textAlign: 'center',
};

const tabsStyle: React.CSSProperties = {
  display: 'flex',
  gap: '8px',
  marginBottom: '16px',
};

const tabButtonStyle: React.CSSProperties = {
  flex: 1,
  padding: '8px 12px',
  border: 'none',
  borderRadius: '4px',
  fontSize: '14px',
  fontWeight: '500',
  cursor: 'pointer',
  transition: 'all 200ms ease',
};

const formStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid #ddd',
  borderRadius: '4px',
  fontSize: '14px',
  fontFamily: 'inherit',
};

const buttonStyle: React.CSSProperties = {
  padding: '10px 16px',
  background: '#0066cc',
  color: 'white',
  border: 'none',
  borderRadius: '4px',
  fontSize: '14px',
  fontWeight: '500',
  cursor: 'pointer',
  transition: 'all 200ms ease',
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: '10px 16px',
  background: '#f0f0f0',
  color: '#333',
  border: 'none',
  borderRadius: '4px',
  fontSize: '14px',
  fontWeight: '500',
  cursor: 'pointer',
  transition: 'all 200ms ease',
};

const dividerStyle: React.CSSProperties = {
  textAlign: 'center',
  margin: '16px 0',
  color: '#999',
  fontSize: '12px',
};

const messageStyle: React.CSSProperties = {
  padding: '8px 12px',
  background: '#ffe0e0',
  color: '#cc0000',
  borderRadius: '4px',
  fontSize: '12px',
  lineHeight: '1.4',
};

const smallTextStyle: React.CSSProperties = {
  margin: '12px 0 0',
  fontSize: '12px',
  color: '#666',
  lineHeight: '1.4',
  textAlign: 'center',
};

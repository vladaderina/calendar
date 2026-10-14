import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { initAuth, onAuthChange, signInWithPassword, signUpWithPassword } from '../lib/auth';

interface AuthGateProps {
  onUserLoaded: (user: User | null) => void;
  children: React.ReactNode;
}

export function AuthGate({ onUserLoaded, children }: AuthGateProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loaded, setLoaded] = useState(false);

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

  if (user) {
    return (
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        {children}
      </div>
    );
  }

  return <AuthForm />;
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

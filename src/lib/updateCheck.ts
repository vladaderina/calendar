import { useEffect, useState } from 'react';

// A phone keeps the page it loaded — sometimes for weeks. When the deployed
// bundle changes, an old tab talks to an old Supabase URL with old retry rules
// and quietly diverges from the other devices, with nothing on screen saying so.
// There is no service worker here, so the only reliable signal is comparing the
// script name currently running with the one the server ships now.
function currentBundle(): string {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="assets/"]');
  return script?.getAttribute('src') ?? '';
}

export function useUpdateAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const running = currentBundle();

    const check = async () => {
      if (!running) return;
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}index.html?ts=${Date.now()}`, {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const html = await res.text();
        const match = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
        if (!match || cancelled) return;
        if (!running.includes(match[0])) setAvailable(true);
      } catch {
        // No network (or the app was opened from a cache): nothing to compare.
      }
    };

    void check();
    // A device that never leaves the app (PWA on the home screen) only reveals a
    // new deploy when it comes back to the foreground.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const timer = setInterval(() => void check(), 10 * 60 * 1000);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      clearInterval(timer);
    };
  }, []);

  return available;
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Пустой сервис-воркер (public/sw.js, без кеширования): без него Chrome на
// Android создаёт закладку вместо приложения, и иконка с домашнего экрана не
// берётся из manifest.json. Регистрируем после load, чтобы не тормозить старт,
// и со scope базового пути — иначе worker не покроет /luna-calendar-secure/.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
      // На iOS установка от этого не зависит; на Android иконка просто останется
      // закладкой — сеть и синхронизация работают как обычно.
    });
  });
}

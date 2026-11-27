import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '../components/Toast';
import { getLocale } from '../i18n';
import './mini.css';
import { MiniApp } from './App';
import { applyTheme } from './theme';

// The chosen palette before the first paint (no flash of the dark theme for light users).
applyTheme();
document.documentElement.lang = getLocale();

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <MiniApp />
    </ToastProvider>
  </StrictMode>,
);

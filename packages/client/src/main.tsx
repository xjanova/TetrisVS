import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

// Anything that escapes React still deserves a line in the console rather than
// a silent failure the player experiences as "the game froze".
window.addEventListener('error', (event) => console.error('[tetrisvs] uncaught:', event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => console.error('[tetrisvs] unhandled rejection:', event.reason));

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');

/**
 * StrictMode is ON, deliberately, even though it double-mounts every effect.
 *
 * The microphone is exactly the kind of resource that leaks when an effect's
 * cleanup is wrong, and the double mount is what makes such a leak happen on
 * every single dev reload rather than once in production. See the abort check
 * in audio/openMicrophone.ts — StrictMode is how it stays honest.
 */
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

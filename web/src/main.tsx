import { render } from 'preact';
import { App } from '@/app/App';
import { watchKeyboard } from '@/lib/media';
import { mode, startLive } from '@/lib/live/store';
import { applyTheme } from '@/lib/store/state';
import './styles/tokens.css';
import './styles/base.css';

applyTheme();
watchKeyboard();
if (mode.peek() === 'live') void startLive();

const root = document.getElementById('app');
if (root) render(<App />, root);

import { render } from 'preact';
import { App } from '@/app/App';
import { watchKeyboard } from '@/lib/media';
import { applyTheme } from '@/lib/store/state';
import './styles/tokens.css';
import './styles/base.css';

applyTheme();
watchKeyboard();

const root = document.getElementById('app');
if (root) render(<App />, root);

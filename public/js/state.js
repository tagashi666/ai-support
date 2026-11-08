// Общее изменяемое состояние панели. Модули ES не могут присваивать
// импортированным переменным, поэтому всё, что меняют несколько разделов,
// лежит в одном объекте: state.current = …, state.settings = … и т.п.
export const state = {
  token: localStorage.getItem('panelToken') || '',
  conversations: [],
  current: null,
  suggestion: null,
  filter: 'all',
  listQuery: '',
  templates: [],
  settings: null,
  inboxSources: [],
  inboxFolders: [],
  kbTab: 'kb',
  docs: { kb: [], drafts: [], interfaceScreens: [], candidates: [] },
  quoting: null,
  currentActor: null,
  pendingFiles: [],
  uploadRunning: false,
};

export const TOKEN_KEY = 'mask_token';
export const token = () => localStorage.getItem(TOKEN_KEY);

export async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token() ? { Authorization: 'Bearer ' + token() } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (r.status === 401) {
    if (!location.hash.startsWith('#/login')) {
      localStorage.removeItem(TOKEN_KEY);
      location.hash = '#/login';
    }
    throw new Error('未登录或会话已过期');
  }
  const j = await r.json().catch(() => ({ error: '响应解析失败' }));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

export const THEMES = [
  { id: 'dark', label: '夜晚', icon: 'dark_mode' },
  { id: 'light', label: '白天', icon: 'light_mode' },
  { id: 'purple', label: '莫兰迪紫', icon: 'palette' },
  { id: 'green', label: '莫兰迪绿', icon: 'eco' }
];

export function applyTheme(t) {
  document.documentElement.dataset.theme = THEMES.some((x) => x.id === t) ? t : 'dark';
}

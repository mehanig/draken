const TOKEN_KEY = 'draken_token';
const USERNAME_KEY = 'draken_username';

export function storedSession() {
  return { token: localStorage.getItem(TOKEN_KEY), username: localStorage.getItem(USERNAME_KEY) };
}

export function saveSession(token: string, username: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USERNAME_KEY, username);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USERNAME_KEY);
}

export function authorizationHeaders(): Record<string, string> {
  const { token } = storedSession();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

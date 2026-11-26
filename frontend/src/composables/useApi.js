const mutationTarget = (url, options) => {
  if (!options.method || options.method === 'GET') return null;
  if (url === '/api/vps/egress-refresh') return null;
  if (url === '/api/vps/route-test') return null;
  if (!/^\/api\/(nodes|vps|config)/.test(url) && !/^\/api\/proxy\/(config|switch)/.test(url)) return null;
  try {
    return JSON.parse(options.body || '{}').ip || new URL(url, location.origin).searchParams.get('ip') || '';
  } catch (_) {
    return '';
  }
};

export function createApiClient({ getSession, isSessionCurrent, onMutation, onUnauthorized }) {
  return async (url, options = {}) => {
    const session = getSession();
    const { silentError = false, ...requestOptions } = options;
    const request = { ...requestOptions, headers: { ...options.headers, Authorization: `Bearer ${session.key}` } };
    const response = await fetch(url, request);

    if (!isSessionCurrent(session)) throw new Error('Stale session response');
    if (response.status === 401) {
      onUnauthorized();
      throw new Error('Unauthorized');
    }
    if (!response.ok) {
      const raw = await response.text();
      let message = raw || `HTTP ${response.status}`;
      let payload = null;
      try {
        payload = JSON.parse(raw);
        message = payload.error || payload.message || message;
      } catch (_) {}
      if (!silentError) alert(`❌ 后端报错: ${message.substring(0, 300)}`);
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    const targetIp = mutationTarget(url, request);
    if (targetIp !== null) queueMicrotask(() => onMutation(targetIp));
    return response;
  };
}

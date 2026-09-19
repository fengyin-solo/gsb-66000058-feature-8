export const BASE_URL = 'http://localhost:8080/api';

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: any;
}

export async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  const config: RequestInit = {
    ...options,
    headers,
  };

  if (options.body !== undefined && options.body !== null) {
    config.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }

  const response = await fetch(`${BASE_URL}${url}`, config);

  if (!response.ok) {
    // 后端对非法状态流转返回纯文本提示（如 409），尽量解析展示给用户
    let message = `HTTP error! status: ${response.status}`;
    try {
      const errorText = await response.text();
      if (errorText) {
        const trimmed = errorText.trim();
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
          message = JSON.parse(trimmed);
        } else {
          message = trimmed;
        }
      }
    } catch {
      // 保留默认错误信息
    }
    const error = new Error(message) as Error & { status: number };
    error.status = response.status;
    throw error;
  }

  const text = await response.text();
  if (!text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

export async function responseData<T>(response: Response, fallback: string): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(response.status === 401 ? "Sua sessão expirou. Entre novamente." : data?.error || fallback);
  }
  if (data === null) throw new Error(fallback);
  return data as T;
}

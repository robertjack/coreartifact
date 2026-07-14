export async function tryImport(modulePath: string): Promise<any> {
  try {
    return await import(modulePath);
  } catch {
    return undefined;
  }
}

export function extractRoots(result: unknown): string[] {
  if (!result) return [];
  if (result instanceof Map) return Array.from(result.keys()) as string[];
  if (result instanceof Set) {
    return Array.from(result).map((v: any) => (typeof v === 'string' ? v : v.repo_root));
  }
  if (Array.isArray(result)) {
    return result.map((v: any) => (typeof v === 'string' ? v : v.repo_root));
  }
  if (typeof result === 'object') return Object.keys(result as object);
  return [];
}

import { getTimestamp } from './time'

function buildMeta<T extends Record<string, unknown> = Record<string, never>>(
  extra?: T,
): { timestamp: string } & T {
  return {
    timestamp: getTimestamp(),
    ...(extra ?? ({} as T)),
  }
}

export { buildMeta }

export type PresenceStateLike = Record<string, ReadonlyArray<unknown>>;

export function countOnlinePresences(state: PresenceStateLike): number {
  return Object.values(state).reduce((total, presences) => total + presences.length, 0);
}

export function onlinePresenceLabel(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"} online`;
}

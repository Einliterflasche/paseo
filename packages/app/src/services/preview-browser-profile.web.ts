import { createPreviewProfile, PreviewProfileError } from "./preview-profile";

export function browserPreviewProfile(serverId: string) {
  const key = `@paseo:service-preview-profile:v1:${serverId}`;
  return createPreviewProfile({
    read: () => window.localStorage.getItem(key),
    write: (value) => window.localStorage.setItem(key, value),
    createId: () => crypto.randomUUID(),
    lock(work) {
      if (!navigator.locks) return Promise.reject(new PreviewProfileError(null));
      return navigator.locks.request(key, work);
    },
  });
}

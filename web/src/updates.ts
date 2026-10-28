/** A snapshot from the native updater. Only the backend owns the install target. */
export interface UpdateSnapshot {
  revision: number
  status: 'idle' | 'checking' | 'available' | 'installing' | 'restarting' | 'error' | 'current'
  version: string
  manager: string
  notes: string
  message: string
  retry: '' | 'check' | 'install'
}

export const IDLE_UPDATE: UpdateSnapshot = {
  revision: 0,
  status: 'idle',
  version: '',
  manager: '',
  notes: '',
  message: '',
  retry: '',
}

let latest = IDLE_UPDATE

/** The snapshot the update sheet shows, read by the palette without rerendering the review. */
export const latestUpdate = () => latest

export const recordUpdate = (snapshot: UpdateSnapshot) => {
  latest = snapshot
}

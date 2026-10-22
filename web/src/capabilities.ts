/** Compile-time scope: the standard build keeps every existing feature. */
export const GO_POC = import.meta.env.MODE === 'go-poc'
export const GO_DESKTOP = import.meta.env.MODE === 'go-desktop'

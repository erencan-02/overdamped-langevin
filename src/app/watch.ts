/**
 * Tells whether a value changed since the last call, for work that is only needed after a change
 * (e.g. once per frame: `if (cameraMoved(key)) rebuild()`). Values are compared as strings; the
 * first call reports a change for any value but `initial`.
 */
export function changeDetector(initial = ''): (value: string) => boolean {
  let last = initial;
  return (value) => {
    if (value === last) return false;
    last = value;
    return true;
  };
}

/**
 * Whether this is the first time `key` is installed on `transport`, marking it
 * so if it is.
 *
 * The mark is a property on the transport, not an entry in a module's
 * WeakSet, because the same transport reaches us as more than one object:
 * pipecat's client hands out `client.transport` as a Proxy over the one the
 * page built, and a page that bundles this library twice has two WeakSets. A
 * Proxy forwards the property to the transport it wraps, and `Symbol.for` is
 * the same symbol in every copy, so the mark is seen whichever way the
 * transport arrives. A Set would see two transports, install twice, and the
 * outer install would hide from the inner one everything it consumes.
 */
export function firstInstall(transport: object, key: string): boolean {
  const mark = Symbol.for(`@voqalize/client-transport:${key}`);
  const marked = transport as Record<symbol, unknown>;
  if (marked[mark]) return false;
  Object.defineProperty(transport, mark, { value: true });
  return true;
}

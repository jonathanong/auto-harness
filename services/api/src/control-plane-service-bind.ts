type ClassPrototype = { prototype: object };

/** Copy source instance methods onto target unless the target already defines them. */
export function bindServicePrototype(target: ClassPrototype, source: ClassPrototype): void {
  for (const name of Object.getOwnPropertyNames(source.prototype)) {
    if (name === "constructor") continue;
    if (Object.hasOwn(target.prototype, name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source.prototype, name);
    if (!descriptor || typeof descriptor.value !== "function") continue;
    Object.defineProperty(target.prototype, name, descriptor);
  }
}

export function bindControlPlaneServices(
  target: ClassPrototype,
  services: readonly ClassPrototype[],
): void {
  for (const service of services) bindServicePrototype(target, service);
}

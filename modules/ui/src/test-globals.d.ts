// oxlint-disable-next-line unicorn/require-module-specifiers -- needed to make this a module so `declare global` is legal
export {};

declare global {
  /** React reads this to gate `act()` environment warnings; set by tests that mount via createRoot. */
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

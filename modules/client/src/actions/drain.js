export function isHarnessDrainOperation(value) {
  return (
    value === "start-drain" ||
    value === "get-drain" ||
    value === "wait-for-drain" ||
    value === "release-drain"
  );
}

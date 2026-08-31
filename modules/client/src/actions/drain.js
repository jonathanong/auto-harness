export function isHarnessDrainOperation(value) {
  return value === "start-drain" || value === "wait-for-drain" || value === "release-drain";
}

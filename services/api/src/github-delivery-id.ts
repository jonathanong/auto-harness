/** Same character class and length as OpenAPI `x-github-delivery`. */
export const GITHUB_DELIVERY_ID_PATTERN = "^[A-Za-z0-9._:-]{1,128}$";

const githubDeliveryId = new RegExp(GITHUB_DELIVERY_ID_PATTERN);

export function isGitHubDeliveryId(value: string): boolean {
  return githubDeliveryId.test(value);
}

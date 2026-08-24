export const MANAS_VERSION = "0.1.1";

export function releaseTag(version = MANAS_VERSION): string {
	return `v${version}`;
}

export const MANAS_VERSION = "0.1.0";

export function releaseTag(version = MANAS_VERSION): string {
	return `v${version}`;
}

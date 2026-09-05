/**
 * Loopback/private/link-local hostname checks shared by config validation and
 * the balance probe's request-time transport re-validation.
 */

export function isPrivateIpv4(hostname: string): boolean {
	const octets = hostname.split(".").map(Number);
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
		return false;
	}
	const [first, second] = octets as [number, number, number, number];
	return (
		first === 10 ||
		first === 127 ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168)
	);
}

export function isPrivateHttpHostname(hostname: string): boolean {
	const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
	if (isPrivateIpv4(normalized)) return true;

	// URL normalizes IPv6 literals, so prefix checks are sufficient for loopback,
	// RFC 4193 unique-local (fc00::/7), and RFC 4291 link-local (fe80::/10).
	return normalized.includes(":") && (
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		/^fe[89ab]/.test(normalized)
	);
}

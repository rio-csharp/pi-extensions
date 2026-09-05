// Cloudflare Worker fetch relay for the web extension's fetchRelay config.
// Deploy: Workers & Pages -> Create Worker -> paste -> add secret RELAY_TOKEN -> route fetch.example.com/*
export default {
	async fetch(request, env) {
		if (!env.RELAY_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.RELAY_TOKEN}`) {
			return new Response("unauthorized", { status: 401 });
		}
		const target = new URL(request.url).searchParams.get("url") ?? "";
		let url;
		try {
			url = new URL(target);
		} catch {
			return new Response("bad url", { status: 400 });
		}
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
			return new Response("bad url", { status: 400 });
		}
		try {
			const upstream = await fetch(url.toString(), {
				redirect: "follow",
				headers: {
					"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
					"Accept": "text/html,application/xhtml+xml,text/plain,*/*",
				},
			});
			return new Response(upstream.body, {
				status: upstream.status,
				headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "text/plain; charset=utf-8" },
			});
		} catch {
			return new Response("upstream fetch failed", { status: 502 });
		}
	},
};

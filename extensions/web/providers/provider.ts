export interface SearchResultItem {
	url: string;
	title: string;
	snippet: string;
}

export interface SearchRequest {
	url: string;
	extraArgs?: string[];
	/** Self-hosted endpoints may legitimately be plain HTTP; built-in providers stay HTTPS-only. */
	allowHttp?: boolean;
}

export interface SearchProvider {
	id: string;
	buildRequest(query: string, limit: number): SearchRequest;
	parseResults(body: string, limit: number): SearchResultItem[];
}
